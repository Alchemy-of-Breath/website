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
   - GHL_WEBHOOK_URL        optional, GHL inbound-webhook URL that receives each paid booking

   Payment plans: payment "plan" is a Stripe subscription (monthly, program.payment_plan.installments
   payments). The webhook sets cancel_at right after checkout so it stops after the last payment;
   the confirmation lookup and the admin dashboard re-check it as a safety net. In live mode plans
   are only offered when STRIPE_WEBHOOK_SECRET is set. */
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
  const payment = input && (input.payment === 'full' || input.payment === 'plan') ? input.payment : 'deposit';
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
  let dueNow = payment === 'full' ? total : deposit, plan = null;
  if (payment === 'plan') {
    const n = (program.payment_plan && program.payment_plan.installments) || 3;
    const inst = Math.floor(total / n);                 // equal monthly payments…
    plan = { installments: n, installment_cents: inst, first_cents: total - inst * (n - 1) }; // …any cents go on the first
    dueNow = plan.first_cents;
  }
  return {
    ok: Object.keys(errors).length === 0, errors, payment, guests, whatsapp, roommate, counts, lines, plan,
    total_cents: total, deposit_cents: deposit, due_now_cents: dueNow, balance_cents: total - dueNow,
  };
}

/* ---------------------------------------------------------- payment plan */
export function addMonths(d, k) {
  const x = new Date(d.getTime()), day = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + k);
  x.setUTCDate(Math.min(day, new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate()));
  return x;
}
/* Is the monthly plan on offer right now? (program setting, last-payment-by rule, webhook in live mode) */
export function planInfo(program, env = {}, now = new Date()) {
  const pp = program.payment_plan;
  if (!pp || !pp.installments) return { available: false, reason: 'not offered' };
  const n = pp.installments, base = { installments: n, interval: pp.interval || 'month' };
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) return { ...base, available: false, reason: 'webhook not configured' };
  if (pp.last_payment_by && addMonths(now, n - 1).toISOString().slice(0, 10) > pp.last_payment_by) {
    return { ...base, available: false, reason: 'not enough time before ' + pp.last_payment_by };
  }
  return { ...base, available: true };
}

/* ---------------------------------------------------------- availability
   Shared rooms are single-gender. Each shared room type lists its physical rooms ("units",
   all with `sleeps` beds) and any beds already taken outside this system ("occupied", with the
   occupant's gender; gender null = unknown, which keeps the rest of that room off sale until
   someone sets it). An empty room can go to women or men; once a bed is taken, the other beds
   in that room are only for the same gender. Rooms that sleep one have a simple `capacity`. */
const gkey = g => { const k = String(g || '').toLowerCase(); return k === 'female' || k === 'male' ? k : 'other'; };
export const isShared = r => !!r.same_gender && (r.sleeps || 1) > 1 && Number.isInteger(r.units);
export const roomCapacity = r => isShared(r)
  ? r.units * r.sleeps - (r.occupied || []).slice(0, r.units).reduce((s, o) => s + (o.beds || 0), 0)
  : (r.capacity || 0);

function sharedState(r, taken) {
  const b = r.sleeps, units = [];
  (r.occupied || []).slice(0, r.units).forEach(o => units.push({ g: o.gender ? gkey(o.gender) : 'blocked', free: Math.max(0, b - (o.beds || 0)) }));
  while (units.length < r.units) units.push({ g: null, free: b });
  const place = (g, n) => {
    for (const u of units) if (n > 0 && u.g === g && u.free > 0) { const t = Math.min(n, u.free); u.free -= t; n -= t; }
    for (const u of units) if (n > 0 && u.g === null) { u.g = g; const t = Math.min(n, u.free); u.free -= t; n -= t; }
  };
  place('female', taken.female || 0); place('male', taken.male || 0); place('other', taken.other || 0);
  const partial = g => units.filter(u => u.g === g).reduce((s, u) => s + u.free, 0);
  return { beds: b, empty_units: units.filter(u => u.g === null).length, partial: { female: partial('female'), male: partial('male') } };
}

/* Can `f` women and `m` men all be placed in this room type right now? */
export function fits(a, f, m) {
  if (!a) return false;
  if (f + m > a.program_left) return false;
  if (a.kind !== 'shared') return f + m <= a.left_any;
  const needF = Math.max(0, f - a.partial.female), needM = Math.max(0, m - a.partial.male);
  return Math.ceil(needF / a.beds) + Math.ceil(needM / a.beds) <= a.empty_units;
}

export function availability(program, occ = { booked: {}, holds: {} }) {
  const sum = id => {
    const a = occ.booked[id] || {}, h = occ.holds[id] || {};
    return { female: (a.female || 0) + (h.female || 0), male: (a.male || 0) + (h.male || 0), other: (a.other || 0) + (h.other || 0) };
  };
  const t = {}; let used = 0;
  for (const r of program.rooms) { t[r.id] = sum(r.id); used += t[r.id].female + t[r.id].male + t[r.id].other; }
  const program_left = Math.max(0, program.program_spaces - used);
  const rooms = {};
  for (const r of program.rooms) {
    const x = t[r.id], taken = x.female + x.male + x.other, capacity = roomCapacity(r);
    if (isShared(r)) {
      const st = sharedState(r, x);
      const lf = Math.min(program_left, st.partial.female + st.empty_units * st.beds);
      const lm = Math.min(program_left, st.partial.male + st.empty_units * st.beds);
      rooms[r.id] = { kind: 'shared', capacity, taken, beds: st.beds, empty_units: st.empty_units, partial: st.partial,
        left: { female: lf, male: lm }, left_any: Math.max(lf, lm), program_left, sold_out: Math.max(lf, lm) <= 0 };
    } else {
      const la = Math.min(program_left, Math.max(0, capacity - taken));
      rooms[r.id] = { kind: 'simple', capacity, taken, left: { female: la, male: la }, left_any: la, program_left, sold_out: la <= 0 };
    }
  }
  return { program_left, rooms };
}

export function checkAvailability(program, q, avail) {
  const n = q.guests.length;
  if (n > avail.program_left) return avail.program_left > 0
    ? `Only ${avail.program_left} ${avail.program_left === 1 ? 'place is' : 'places are'} left this week.`
    : 'This week is now fully booked.';
  const by = {};
  q.guests.forEach(g => { const c = by[g.room] || (by[g.room] = { female: 0, male: 0 }); c[gkey(g.gender) === 'male' ? 'male' : 'female']++; });
  for (const [id, c] of Object.entries(by)) {
    const a = avail.rooms[id], r = program.rooms.find(x => x.id === id);
    if (fits(a, c.female, c.male)) continue;
    if (!a || a.sold_out) return `${r.name} is sold out.`;
    if (a.kind === 'shared') {
      const who = c.female && !fits(a, c.female, 0) ? 'female' : (c.male && !fits(a, 0, c.male) ? 'male' : null);
      if (who) {
        const l = a.left[who], w = who === 'female' ? 'women' : 'men';
        return l > 0 ? `${r.name} has only ${l} ${l === 1 ? 'place' : 'places'} left for ${w}.` : `${r.name} has no places left for ${w}.`;
      }
      return `${r.name} doesn't have enough free rooms for your group. Try splitting your group across room types.`;
    }
    return `Only ${a.left_any} ${a.left_any === 1 ? 'place is' : 'places are'} left in ${r.name}.`;
  }
  return null;
}

export const publicQuote = q => ({
  payment: q.payment, guests: q.guests.length, lines: q.lines, plan: q.plan,
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
  if (q.plan) { md.aob_plan_n = String(q.plan.installments); md.aob_installment = String(q.plan.installment_cents); }
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

async function searchAll(env, query, cap = 2000, object = 'payment_intents') {
  const rows = []; let page;
  do {
    const r = await stripe(env, 'GET', `/${object}/search?` + qs({ query, limit: 100, page }));
    rows.push(...r.data);
    page = r.has_more ? r.next_page : undefined;
  } while (page && rows.length < cap);
  return rows;
}

/* Plan bookings are subscriptions. They count from the first paid invoice (status not "incomplete"). */
const LIVE_SUB = sub => sub.status !== 'incomplete' && sub.status !== 'incomplete_expired';
async function paidOnSub(env, subId) {
  const r = await stripe(env, 'GET', '/invoices?' + qs({ subscription: subId, status: 'paid', limit: 24 }));
  return { amount: r.data.reduce((a, inv) => a + (inv.amount_paid || 0), 0), count: r.data.length };
}
function subRecord(sub, paid) {
  const md = sub.metadata || {};
  const running = (sub.status === 'active' || sub.status === 'past_due') && (!sub.cancel_at || sub.current_period_end < sub.cancel_at);
  return {
    id: sub.id, sub: true, created: sub.created, customer: sub.customer, md, status: sub.status, cancel_at: sub.cancel_at || null,
    amount: paid ? paid.amount : parseInt(md.aob_due_now || '0', 10), paid_count: paid ? paid.count : 1,
    next_payment: running ? sub.current_period_end : null,
  };
}
function mergeRecentSessions(byId, sessions, match) {
  for (const s of sessions) {
    const md = s.metadata || {};
    if (!match(md) || s.payment_status !== 'paid') continue;
    if (s.mode === 'subscription' && s.subscription && !byId.has(s.subscription)) {
      byId.set(s.subscription, { id: s.subscription, sub: true, created: s.created, customer: s.customer, md, status: 'active', cancel_at: null, amount: s.amount_total, paid_count: 1, next_payment: null });
    } else if (s.payment_intent && !byId.has(s.payment_intent)) {
      byId.set(s.payment_intent, { id: s.payment_intent, created: s.created, amount: s.amount_total, customer: s.customer, md });
    }
  }
}

/* Every succeeded payment (and every plan subscription) for a program. Stripe's search index can lag
   about a minute, so sessions completed in the last 20 minutes are merged in from the (real-time)
   Checkout Sessions list. amounts: also total what each plan has paid so far (one call per plan). */
export async function programPayments(env, program, { amounts = false } = {}) {
  const byId = new Map();
  for (const pi of await searchAll(env, `metadata['aob_program']:'${program.id}' AND status:'succeeded'`)) {
    byId.set(pi.id, { id: pi.id, created: pi.created, amount: pi.amount_received, customer: pi.customer, md: pi.metadata || {} });
  }
  for (const sub of await searchAll(env, `metadata['aob_program']:'${program.id}'`, 2000, 'subscriptions')) {
    if (LIVE_SUB(sub)) byId.set(sub.id, subRecord(sub, amounts ? await paidOnSub(env, sub.id) : null));
  }
  const since = Math.floor(Date.now() / 1000) - 20 * 60;
  const recent = await stripe(env, 'GET', '/checkout/sessions?' + qs({ status: 'complete', 'created[gte]': since, limit: 100 }));
  mergeRecentSessions(byId, recent.data, md => md.aob_program === program.id);
  return [...byId.values()];
}

/* Stop a plan after its last payment: cancel_at a week after the final monthly invoice. */
export async function ensurePlanEnds(env, subId) {
  const sub = await stripe(env, 'GET', `/subscriptions/${subId}`);
  if (sub.cancel_at || sub.status === 'canceled' || !LIVE_SUB(sub)) return sub;
  const n = parseInt((sub.metadata || {}).aob_plan_n || '3', 10);
  const anchor = new Date((sub.billing_cycle_anchor || sub.start_date || sub.created) * 1000);
  const cancelAt = Math.floor(addMonths(anchor, n - 1).getTime() / 1000) + 7 * 86400;
  return stripe(env, 'POST', `/subscriptions/${subId}`, { cancel_at: cancelAt, proration_behavior: 'none' });
}
export function planDates(anchorSec, n) {
  const a = new Date(anchorSec * 1000);
  return Array.from({ length: n }, (_, k) => Math.floor(addMonths(a, k).getTime() / 1000));
}

/* Places taken per room and gender: paid bookings (not cancelled) + open checkouts holding places. */
function addGuests(into, md) {
  let any = false;
  for (let i = 1; i <= 12; i++) {
    const v = md[`aob_g${i}`]; if (!v) continue;
    any = true;
    const parts = v.split(' | '), k = gkey(parts[2]), room = parts[3];
    const c = into[room] || (into[room] = { female: 0, male: 0, other: 0 }); c[k]++;
  }
  if (!any) Object.entries(roomsFromString(md.aob_rooms)).forEach(([room, n]) => {
    const c = into[room] || (into[room] = { female: 0, male: 0, other: 0 }); c.other += n;
  });
}
export async function occupancy(env, program, payments) {
  const booked = {}, holds = {};
  for (const p of payments || await programPayments(env, program)) {
    if (p.md.aob_kind === 'booking' && p.md.aob_status !== 'cancelled') addGuests(booked, p.md);
  }
  const open = await stripe(env, 'GET', '/checkout/sessions?' + qs({ status: 'open', limit: 100 }));
  for (const s of open.data) {
    const md = s.metadata || {};
    if (md.aob_program === program.id && md.aob_kind === 'booking') addGuests(holds, md);
  }
  return { booked, holds };
}

/* Group a program's payments into bookings with paid / balance figures. */
export function groupBookings(program, payments) {
  const byRef = new Map();
  for (const p of payments) {
    const ref = p.md.aob_ref; if (!ref) continue;
    const b = byRef.get(ref) || { ref, payments: [], paid_cents: 0 };
    b.payments.push({ id: p.id, kind: p.md.aob_kind, amount_cents: p.amount, created: p.created });
    b.paid_cents += p.amount || 0;
    if (p.md.aob_kind === 'booking') {
      Object.assign(b, parseBooking(p.md)); b.created = p.created; b.booking_pi = p.id; b.customer = p.customer;
      if (p.sub) b.plan = { subscription: p.id, installments: parseInt(p.md.aob_plan_n || '3', 10), installment_cents: parseInt(p.md.aob_installment || '0', 10),
        paid_count: p.paid_count, next_payment: p.next_payment, status: p.status, cancel_at: p.cancel_at };
    }
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
  const byId = new Map();
  for (const pi of await searchAll(env, `metadata['aob_ref']:'${ref}' AND status:'succeeded'`, 200)) {
    byId.set(pi.id, { id: pi.id, created: pi.created, amount: pi.amount_received, customer: pi.customer, md: pi.metadata || {} });
  }
  for (const sub of await searchAll(env, `metadata['aob_ref']:'${ref}'`, 50, 'subscriptions')) {
    if (LIVE_SUB(sub)) byId.set(sub.id, subRecord(sub, await paidOnSub(env, sub.id)));
  }
  const since = Math.floor(Date.now() / 1000) - 20 * 60;
  const recent = await stripe(env, 'GET', '/checkout/sessions?' + qs({ status: 'complete', 'created[gte]': since, limit: 100 }));
  mergeRecentSessions(byId, recent.data, md => md.aob_ref === ref);
  const pays = [...byId.values()];
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
  if (q.payment === 'plan') {
    const p = q.plan, cur = program.currency.toLowerCase();
    const items = [{ quantity: 1, price_data: { currency: cur, unit_amount: p.installment_cents, recurring: { interval: 'month', interval_count: 1 },
      product_data: { name: `${title} · ${p.installments} monthly payments`, description: `${rooms}. Booking ${ref}.`.slice(0, 500) } } }];
    if (p.first_cents > p.installment_cents) items.push({ quantity: 1, price_data: { currency: cur, unit_amount: p.first_cents - p.installment_cents, product_data: { name: 'Rounding on the first payment' } } });
    return {
      mode: 'subscription', payment_method_types: ['card'], locale: 'auto', customer_email: q.guests[0].email, client_reference_id: ref,
      line_items: items, metadata: md,
      subscription_data: { metadata: md, description: `${title} · ${ref} · ${p.installments} monthly payments of ${eur(p.installment_cents)}` },
      custom_text: { submit: { message: `${p.installments} monthly payments of ${eur(p.installment_cents)}: the first today, then automatically each month to the same card, ${p.installments} payments in total.` } },
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: withQuery(returnUrl, 'status=success&session_id={CHECKOUT_SESSION_ID}'),
      cancel_url: withQuery(returnUrl, 'status=cancelled'),
    };
  }
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
