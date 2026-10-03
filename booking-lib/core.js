/* AoB booking engine — shared by the Cloudflare Pages Functions in /functions/api/booking/.
   Runs on Workers (and Node 18+ for tests): only fetch, URL and crypto.subtle.

   Source of truth
   - Programs, rooms, prices, capacity: booking/programs/*.json (compiled into ./programs.js
     by tools/booking/build.py). The browser never decides what is charged.
   - Bookings: Stripe. Every booking is a PaymentIntent whose metadata carries the booking
     (aob_* keys), so no separate database is needed. Balance payments are PaymentIntents with
     aob_kind=balance and the same aob_ref.

   Environment (Cloudflare Pages → Settings → Variables and secrets)
   - STRIPE_SECRET_KEY      required for live/test payments (sk_test_… first). Without it every
                            endpoint answers in demo mode and nothing is charged.
   - STRIPE_WEBHOOK_SECRET  optional, whsec_… for /api/booking/webhook
   - ADMIN_TOKEN            required for /api/booking/admin (long random string)
   - GHL_WEBHOOK_URL        optional, GHL inbound-webhook URL that receives each paid booking */
import PROGRAMS from './programs.js';

export const STRIPE_VERSION = '2024-06-20';

/* ---------------------------------------------------------------- HTTP */
const ORIGINS = [
  'https://alchemyofbreath.com', 'https://www.alchemyofbreath.com',
  'https://website-5h3.pages.dev', 'https://standalone-preview.website-5h3.pages.dev',
];
const originOk = o => ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+\.website-5h3\.pages\.dev$/.test(o) ||
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

export function cors(request) {
  const o = request.headers.get('Origin') || '';
  return originOk(o) ? {
    'Access-Control-Allow-Origin': o, 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  } : { 'Vary': 'Origin' };
}
export const preflight = request => new Response(null, { status: 204, headers: cors(request) });
export function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(request) },
  });
}

/* ------------------------------------------------------------ programs */
export const getProgram = id => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROGRAMS, id)) ? PROGRAMS[id] : null;
export const listPrograms = () => Object.values(PROGRAMS);
export function isClosed(program, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return today > (program.booking_closes || program.dates.start);
}

/* --------------------------------------------------------------- money */
export const eur = c => '€' + (c / 100).toLocaleString('en-GB', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });

/* ------------------------------------------------------------- quoting */
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* Validate a booking request and price it from the program file.
   input: { payment: 'deposit'|'full', guests: [{first,last,email,gender,room}], whatsapp, roommate, terms } */
export function quote(program, input) {
  const errors = {};
  const payment = input && input.payment === 'full' ? 'full' : 'deposit';
  const raw = Array.isArray(input && input.guests) ? input.guests.slice(0, 50) : [];
  const max = program.max_guests_per_booking || 6;
  if (raw.length < 1) errors.guests = 'Add at least one guest.';
  if (raw.length > max) errors.guests = `You can book up to ${max} guests at a time.`;
  const rooms = Object.fromEntries(program.rooms.map(r => [r.id, r]));
  const genders = (program.genders || []).map(g => g.toLowerCase());

  const guests = raw.slice(0, max).map((g, i) => {
    g = g || {};
    const o = { first: str(g.first, 60), last: str(g.last, 60), email: str(g.email, 120).toLowerCase(), gender: str(g.gender, 40), room: str(g.room, 40) };
    if (!o.first) errors[`guests.${i}.first`] = 'Please add a first name.';
    if (!o.last) errors[`guests.${i}.last`] = 'Please add a last name.';
    if (!EMAIL.test(o.email)) errors[`guests.${i}.email`] = 'Please add a valid email address.';
    const gi = genders.indexOf(o.gender.toLowerCase());
    if (gi < 0) errors[`guests.${i}.gender`] = 'Please choose an option.'; else o.gender = program.genders[gi];
    if (!rooms[o.room]) errors[`guests.${i}.room`] = 'Please choose where this guest will stay.';
    return o;
  });

  const whatsapp = str(input && input.whatsapp, 32).replace(/[\s().-]/g, '');
  if (!/^\+\d{7,15}$/.test(whatsapp)) errors.whatsapp = 'Add your WhatsApp number with the country code, e.g. +44 7700 900123.';
  const roommate = str(input && input.roommate, 200);
  if (!(input && input.terms === true)) errors.terms = 'Please agree to the terms and conditions.';

  const counts = {};
  guests.forEach(g => { if (rooms[g.room]) counts[g.room] = (counts[g.room] || 0) + 1; });
  const lines = Object.entries(counts).map(([id, n]) => {
    const r = rooms[id];
    const units = r.unit === 'person' ? n : Math.ceil(n / (r.sleeps || 1));
    return { room: id, name: r.name, guests: n, units, unit: r.unit, unit_price_cents: r.price * 100, amount_cents: units * r.price * 100 };
  });
  const total = lines.reduce((s, l) => s + l.amount_cents, 0);
  const deposit = Math.round(total * (program.deposit && program.deposit.percent || 100) / 100);
  const dueNow = payment === 'full' ? total : deposit;
  return {
    ok: Object.keys(errors).length === 0, errors, payment, guests, whatsapp, roommate, counts, lines,
    total_cents: total, deposit_cents: deposit, due_now_cents: dueNow, balance_cents: total - dueNow,
  };
}

export function checkAvailability(program, q, avail) {
  const n = q.guests.length;
  if (n > avail.program_left) return avail.program_left > 0
    ? `Only ${avail.program_left} ${avail.program_left === 1 ? 'place is' : 'places are'} left this week.`
    : 'This week is now fully booked.';
  for (const [id, c] of Object.entries(q.counts)) {
    const a = avail.rooms[id];
    if (!a || a.left < c) {
      const r = program.rooms.find(x => x.id === id);
      return a && a.left > 0 ? `Only ${a.left} ${a.left === 1 ? 'place is' : 'places are'} left in ${r.name}.` : `${r.name} is sold out.`;
    }
  }
  return null;
}

export const publicQuote = q => ({
  payment: q.payment, guests: q.guests.length, lines: q.lines,
  total_cents: q.total_cents, deposit_cents: q.deposit_cents, due_now_cents: q.due_now_cents, balance_cents: q.balance_cents,
});

/* ------------------------------------------------------------- metadata */
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
export const roomsToString = counts => Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(',');
export function roomsFromString(s) {
  const out = {};
  String(s || '').split(',').forEach(p => { const [k, v] = p.split(':'); const n = parseInt(v, 10); if (k && n > 0) out[k] = (out[k] || 0) + n; });
  return out;
}

export function bookingMetadata(program, q, ref, extra = {}) {
  const lead = q.guests[0];
  const md = {
    aob_kind: 'booking', aob_program: program.id, aob_ref: ref, aob_payment: q.payment,
    aob_total: String(q.total_cents), aob_due_now: String(q.due_now_cents), aob_balance: String(q.balance_cents),
    aob_rooms: roomsToString(q.counts), aob_guests: String(q.guests.length),
    aob_lead_name: `${lead.first} ${lead.last}`.slice(0, 120), aob_lead_email: lead.email,
    aob_whatsapp: q.whatsapp, aob_roommate: q.roommate.slice(0, 200),
  };
  q.guests.forEach((g, i) => { md[`aob_g${i + 1}`] = [`${g.first} ${g.last}`, g.email, g.gender, g.room].join(' | ').slice(0, 490); });
  const utm = extra.utm && typeof extra.utm === 'object' ? extra.utm : {};
  UTM.forEach(k => { if (utm[k]) md[k] = str(utm[k], 200); });
  if (extra.page) md.aob_page = str(extra.page, 300);
  return md;
}

export function parseBooking(md = {}) {
  const guests = [];
  for (let i = 1; i <= 12; i++) {
    const v = md[`aob_g${i}`]; if (!v) continue;
    const [name, email, gender, room] = v.split(' | ');
    guests.push({ name, email, gender, room });
  }
  const utm = {}; UTM.forEach(k => { if (md[k]) utm[k] = md[k]; });
  return {
    ref: md.aob_ref, program: md.aob_program, payment: md.aob_payment, status: md.aob_status || 'active',
    total_cents: parseInt(md.aob_total || '0', 10), rooms: roomsFromString(md.aob_rooms),
    lead: { name: md.aob_lead_name, email: md.aob_lead_email, whatsapp: md.aob_whatsapp, roommate: md.aob_roommate || '' },
    guests, utm, page: md.aob_page || '',
  };
}

export function newRef(program) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = new Uint8Array(6);
  crypto.getRandomValues(b);
  const d = program.dates.start.replace(/-/g, '').slice(2, 6); // YYMM
  return `BC${d}-` + Array.from(b, x => A[x % A.length]).join('');
}
export const validRef = r => typeof r === 'string' && /^[A-Z0-9]{2,8}-[A-Z0-9]{4,10}$/.test(r);

/* ---------------------------------------------------------------- Stripe */
export function formEncode(obj) {
  const out = [];
  const walk = (v, key) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, key ? `${key}[${k}]` : k));
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  };
  walk(obj, '');
  return out.join('&');
}
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();

export async function stripe(env, method, path, params) {
  const init = { method, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': STRIPE_VERSION } };
  if (params && method !== 'GET') { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = formEncode(params); }
  const res = await fetch('https://api.stripe.com/v1' + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data.error && data.error.message) || `Stripe error ${res.status}`); e.status = res.status; throw e; }
  return data;
}

async function searchAll(env, query, cap = 2000) {
  const rows = []; let page;
  do {
    const r = await stripe(env, 'GET', '/payment_intents/search?' + qs({ query, limit: 100, page }));
    rows.push(...r.data);
    page = r.has_more ? r.next_page : undefined;
  } while (page && rows.length < cap);
  return rows;
}

/* Every succeeded payment for a program, keyed by PaymentIntent. Stripe's search index can lag
   about a minute, so sessions completed in the last 20 minutes are merged in from the (real-time)
   Checkout Sessions list. */
export async function programPayments(env, program) {
  const byPi = new Map();
  for (const pi of await searchAll(env, `metadata['aob_program']:'${program.id}' AND status:'succeeded'`)) {
    byPi.set(pi.id, { id: pi.id, created: pi.created, amount: pi.amount_received, customer: pi.customer, md: pi.metadata || {} });
  }
  const since = Math.floor(Date.now() / 1000) - 20 * 60;
  const recent = await stripe(env, 'GET', '/checkout/sessions?' + qs({ status: 'complete', 'created[gte]': since, limit: 100 }));
  for (const s of recent.data) {
    const md = s.metadata || {};
    if (md.aob_program !== program.id || s.payment_status !== 'paid' || !s.payment_intent || byPi.has(s.payment_intent)) continue;
    byPi.set(s.payment_intent, { id: s.payment_intent, created: s.created, amount: s.amount_total, customer: s.customer, md });
  }
  return [...byPi.values()];
}

/* Places taken per room: paid bookings (not cancelled) + open checkouts holding places. */
export async function occupancy(env, program, payments) {
  const booked = {}, holds = {};
  const add = (into, s) => Object.entries(roomsFromString(s)).forEach(([k, v]) => { into[k] = (into[k] || 0) + v; });
  for (const p of payments || await programPayments(env, program)) {
    if (p.md.aob_kind === 'booking' && p.md.aob_status !== 'cancelled') add(booked, p.md.aob_rooms);
  }
  const open = await stripe(env, 'GET', '/checkout/sessions?' + qs({ status: 'open', limit: 100 }));
  for (const s of open.data) {
    const md = s.metadata || {};
    if (md.aob_program === program.id && md.aob_kind === 'booking') add(holds, md.aob_rooms);
  }
  return { booked, holds };
}

export function availability(program, occ = { booked: {}, holds: {} }) {
  const rooms = {}; let used = 0;
  for (const r of program.rooms) {
    const taken = (occ.booked[r.id] || 0) + (occ.holds[r.id] || 0);
    used += taken;
    rooms[r.id] = { capacity: r.capacity, taken, left: Math.max(0, r.capacity - taken) };
  }
  const program_left = Math.max(0, program.program_spaces - used);
  for (const id in rooms) { rooms[id].left = Math.min(rooms[id].left, program_left); rooms[id].sold_out = rooms[id].left <= 0; }
  return { program_left, rooms };
}

/* Group a program's payments into bookings with paid / balance figures. */
export function groupBookings(program, payments) {
  const byRef = new Map();
  for (const p of payments) {
    const ref = p.md.aob_ref; if (!ref) continue;
    const b = byRef.get(ref) || { ref, payments: [], paid_cents: 0 };
    b.payments.push({ id: p.id, kind: p.md.aob_kind, amount_cents: p.amount, created: p.created });
    b.paid_cents += p.amount || 0;
    if (p.md.aob_kind === 'booking') { Object.assign(b, parseBooking(p.md)); b.created = p.created; b.booking_pi = p.id; b.customer = p.customer; }
    byRef.set(ref, b);
  }
  return [...byRef.values()].filter(b => b.booking_pi).map(b => ({
    ...b, balance_cents: Math.max(0, b.total_cents - b.paid_cents),
    room_names: Object.entries(b.rooms).map(([id, n]) => `${(program.rooms.find(r => r.id === id) || { name: id }).name} × ${n}`).join(', '),
  })).sort((a, b) => b.created - a.created);
}

/* One booking (and its balance payments) by reference. */
export async function findBooking(env, ref) {
  if (!validRef(ref)) return null;
  const pays = (await searchAll(env, `metadata['aob_ref']:'${ref}' AND status:'succeeded'`, 200))
    .map(pi => ({ id: pi.id, created: pi.created, amount: pi.amount_received, customer: pi.customer, md: pi.metadata || {} }));
  const seen = new Set(pays.map(p => p.id));
  const since = Math.floor(Date.now() / 1000) - 20 * 60;
  const recent = await stripe(env, 'GET', '/checkout/sessions?' + qs({ status: 'complete', 'created[gte]': since, limit: 100 }));
  for (const s of recent.data) {
    const md = s.metadata || {};
    if (md.aob_ref === ref && s.payment_status === 'paid' && s.payment_intent && !seen.has(s.payment_intent)) {
      pays.push({ id: s.payment_intent, created: s.created, amount: s.amount_total, customer: s.customer, md });
    }
  }
  const first = pays.find(p => p.md.aob_kind === 'booking');
  const program = first && getProgram(first.md.aob_program);
  if (!program) return null;
  const [booking] = groupBookings(program, pays);
  return booking ? { program, booking } : null;
}

export const programSummary = p => ({ id: p.id, title: p.title, edition: p.edition, dates: p.dates, venue: p.venue.name, currency: p.currency, program_spaces: p.program_spaces });

/* --------------------------------------------------------------- checkout */
export function safeReturnUrl(url, fallback) {
  try {
    const u = new URL(url);
    if (!originOk(u.origin)) return fallback;
    return u.origin + u.pathname;
  } catch { return fallback; }
}
const withQuery = (url, q) => url + (url.includes('?') ? '&' : '?') + q; // keeps {CHECKOUT_SESSION_ID} literal

export function bookingCheckoutParams(program, q, ref, md, returnUrl) {
  const title = `${program.title}, ${program.dates.short}`;
  const rooms = q.lines.map(l => `${l.name} × ${l.guests}`).join(', ');
  const name = q.payment === 'full' ? `${title} · stay and meals` : `${program.deposit.percent}% deposit · ${title}`;
  const desc = `${rooms}. Booking ${ref}.` + (q.balance_cents ? ` Balance ${eur(q.balance_cents)} to pay before arrival.` : ' Paid in full.');
  const lead = q.guests[0];
  return {
    mode: 'payment', payment_method_types: ['card'], locale: 'auto',
    customer_email: lead.email, customer_creation: 'always', client_reference_id: ref,
    line_items: [{ quantity: 1, price_data: { currency: program.currency.toLowerCase(), unit_amount: q.due_now_cents, product_data: { name, description: desc.slice(0, 500) } } }],
    metadata: md,
    payment_intent_data: { metadata: md, description: `${title} · ${ref} · ${rooms}`.slice(0, 1000), receipt_email: lead.email },
    invoice_creation: { enabled: true, invoice_data: { description: desc.slice(0, 1500), metadata: { aob_ref: ref, aob_program: program.id } } },
    custom_text: { submit: { message: (q.balance_cents ? `You're paying the ${program.deposit.percent}% deposit today. ${program.deposit.balance_note}` : `You're paying for your stay in full.`).slice(0, 1200) } },
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    success_url: withQuery(returnUrl, 'status=success&session_id={CHECKOUT_SESSION_ID}'),
    cancel_url: withQuery(returnUrl, 'status=cancelled'),
  };
}

export function balanceCheckoutParams(program, booking, balanceCents, returnUrl, hours = 0.52) {
  const title = `${program.title}, ${program.dates.short}`;
  const md = { aob_kind: 'balance', aob_program: program.id, aob_ref: booking.ref, aob_lead_name: booking.lead.name || '', aob_lead_email: booking.lead.email || '' };
  const p = {
    mode: 'payment', payment_method_types: ['card'], locale: 'auto', client_reference_id: booking.ref,
    line_items: [{ quantity: 1, price_data: { currency: program.currency.toLowerCase(), unit_amount: balanceCents, product_data: { name: `Balance · ${title}`, description: `Booking ${booking.ref}: ${booking.room_names}.`.slice(0, 500) } } }],
    metadata: md,
    payment_intent_data: { metadata: md, description: `${title} · ${booking.ref} · balance`, receipt_email: booking.lead.email || undefined },
    invoice_creation: { enabled: true, invoice_data: { description: `Balance for booking ${booking.ref}`, metadata: { aob_ref: booking.ref, aob_program: program.id } } },
    expires_at: Math.floor(Date.now() / 1000) + Math.max(31 * 60, Math.min(24 * 3600 - 60, Math.round(hours * 3600))),
    success_url: withQuery(returnUrl, `status=paid&ref=${encodeURIComponent(booking.ref)}&session_id={CHECKOUT_SESSION_ID}`),
    cancel_url: withQuery(returnUrl, `ref=${encodeURIComponent(booking.ref)}`),
  };
  if (booking.customer) p.customer = booking.customer; else p.customer_email = booking.lead.email;
  return p;
}

/* ---------------------------------------------------------------- webhook */
export async function verifyStripeSignature(payload, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i).trim(), kv.slice(i + 1)]; }).filter(([k]) => k === 't'));
  const sigs = header.split(',').filter(kv => kv.trim().startsWith('v1=')).map(kv => kv.trim().slice(3));
  const t = parseInt(parts.t, 10);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  const hex = Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => timingSafeEqual(s, hex));
}
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export function adminAuthorized(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16 && timingSafeEqual(token, env.ADMIN_TOKEN);
}
