/* AoB booking engine — shared by the Cloudflare Pages Functions in /functions/api/booking/.
   Runs on Workers (and Node 18+ for tests): only fetch, URL, AbortSignal and crypto.

   Source of truth
   - Programs, rooms, prices, capacity: booking/programs/*.json (compiled into ./programs.js
     by tools/booking/build.py). The browser never decides what is charged.
   - Bookings: Stripe. Every booking is a PaymentIntent (or, for payment plans, a subscription)
     whose metadata carries the booking (aob_* keys), so no separate database is needed. Balance
     payments are PaymentIntents with aob_kind=balance and the same aob_ref; wellbeing sessions
     bought after booking ("extras") are PaymentIntents with aob_kind=addon and the same aob_ref.
     Open booking Checkout Sessions are the holds: places in someone's checkout right now (an
     admin booking link holds its places for the 24 hours it is open).
   - Team notes on a booking (note, room assignment, session status) live in the metadata of the
     booking's own PaymentIntent / subscription (aob_note, aob_assign, aob_svc); for a plan whose
     subscription has ended, on its first invoice's PaymentIntent (see saveAdminMeta).

   Environment (Cloudflare Pages → Settings → Variables and secrets)
   - STRIPE_SECRET_KEY       required for live/test payments (sk_test_… first). Without it every
                             endpoint answers in demo mode and nothing is charged.
   - STRIPE_PUBLISHABLE_KEY  optional, pk_test_… / pk_live_… of the same account and mode. With it
                             the payment form is embedded in the booking page (else: Stripe redirect).
   - STRIPE_WEBHOOK_SECRET   optional, whsec_… for /api/booking/webhook
   - ADMIN_TOKEN             required for /api/booking/admin (long random string)
   - GHL_WEBHOOK_URL         optional, GHL inbound-webhook URL that receives booking events
   - TURNSTILE_SITE_KEY + TURNSTILE_SECRET  optional Cloudflare Turnstile bot check on checkout/lead

   Payment plans: payment "plan" is a Stripe subscription (monthly, program.payment_plan.installments
   payments). The webhook sets cancel_at right after checkout to the end of the last monthly period
   (exactly n months after the billing anchor), so the last payment is a full one and there is no
   extra one; the confirmation lookup, each instalment and the admin "repair plans" action re-check
   it as a safety net. In live mode plans are only offered when STRIPE_WEBHOOK_SECRET is set. */
import PROGRAMS from './programs.js';

export const STRIPE_VERSION = '2024-06-20';
export const SITE = 'https://website-5h3.pages.dev';
export const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------- key modes */
const secretKey = env => String((env && env.STRIPE_SECRET_KEY) || '');
/* Live mode = a live secret key. Preview hosts and localhost are only trusted outside live mode. */
export const liveMode = env => secretKey(env).includes('_live_');
/* 'test' | 'live' | 'none' */
export function keyMode(env) {
  const k = secretKey(env);
  if (!k) return 'none';
  return /^(sk|rk)_live_/.test(k) ? 'live' : 'test';
}
/* 'test' | 'live' | 'missing' | 'mismatch' (publishable key from the other mode, or no secret key) */
export function publishableStatus(env) {
  const pk = String((env && env.STRIPE_PUBLISHABLE_KEY) || '');
  if (!pk) return 'missing';
  const pm = pk.startsWith('pk_live_') ? 'live' : pk.startsWith('pk_test_') ? 'test' : null;
  return pm && pm === keyMode(env) ? pm : 'mismatch';
}
export const publishableKey = env => { const s = publishableStatus(env); return s === 'test' || s === 'live' ? env.STRIPE_PUBLISHABLE_KEY : null; };
/* Turnstile is on only with both keys: the page shows the widget exactly when the site key is handed out. */
export const turnstileSiteKey = env => (env && env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY) || null;
/* 'on' | 'off' | 'misconfigured' (only one of the two keys set: the bot check is off) */
export function turnstileStatus(env) {
  const s = !!(env && env.TURNSTILE_SECRET), k = !!(env && env.TURNSTILE_SITE_KEY);
  return s && k ? 'on' : s || k ? 'misconfigured' : 'off';
}
/* "Email me a link to finish my booking": needs GHL, and in live mode the bot check too (the form can
   name any email address, so without it the reminder could be used to email strangers). */
export const remindEnabled = env => !!(env && env.GHL_WEBHOOK_URL) && (!liveMode(env) || !!turnstileSiteKey(env));

/* ---------------------------------------------------------------- HTTP */
export const PROD_ORIGINS = ['https://alchemyofbreath.com', 'https://www.alchemyofbreath.com', SITE];
export const PROD_HOSTS = PROD_ORIGINS.map(o => new URL(o).host);
export function originOk(o, env) {
  if (PROD_ORIGINS.includes(o)) return true;
  if (liveMode(env)) return false;
  return /^https:\/\/[a-z0-9-]+\.website-5h3\.pages\.dev$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}

export function cors(request, env) {
  const o = request.headers.get('Origin') || '';
  return originOk(o, env) ? {
    'Access-Control-Allow-Origin': o, 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  } : { 'Vary': 'Origin' };
}
export const preflight = (request, env) => new Response(null, { status: 204, headers: cors(request, env) });
export function json(request, data, status = 200, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(request, env) },
  });
}

/* POST guard: JSON only (so a foreign page can't post without a CORS preflight), and a present
   Origin must be one of ours. `text` also accepts text/plain (sendBeacon / keepalive bodies). */
export function guardPost(request, env, { text = false } = {}) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!(ct.startsWith('application/json') || (text && ct.startsWith('text/plain')))) {
    return json(request, { error: 'Please send the request as JSON.' }, 415, env);
  }
  const o = request.headers.get('Origin');
  if (o !== null && !originOk(o, env)) return json(request, { error: 'This request is not allowed from this site.' }, 403, env);
  return null;
}
/* The request body as a JSON object, or null. */
export async function readBody(request, max = 32768) {
  let t;
  try { t = await request.text(); } catch { return null; }
  if (!t || t.length > max) return null;
  try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
export const clientIp = request => request.headers.get('CF-Connecting-IP') || '';

/* Stripe errors worth a "busy, try again" answer: network/timeouts, rate limits, Stripe 5xx. */
export const isBusy = e => !!e && (e.status === 0 || e.status === 429 || e.status >= 500);
export const BUSY = { error: 'Payments are busy for a moment. Please try again.', code: 'busy', retry_after: 5 };
/* Structured failure log for Cloudflare's real-time logs. Never logs messages (they can carry emails). */
export function logError(route, e, extra = {}) {
  try {
    console.error(JSON.stringify({ route, ...extra, type: (e && e.type) || null, code: (e && e.code) || null,
      param: (e && e.param) || null, status: e && e.status != null ? e.status : null, request_id: (e && e.requestId) || null }));
  } catch {}
}

/* Best-effort per-isolate rate limit (Workers isolates are short-lived; this only blunts bursts).
   Least recently used keys are dropped first, so a flood of new keys can't wipe everyone's counters.
   (A durable limit needs a Cloudflare zone WAF rule on a custom API domain, or a Durable Object.) */
const hits = new Map(), HITS_MAX = 5000;
export function rateLimited(key, max, windowMs) {
  if (!key) return false;
  const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < windowMs);
  const limited = list.length >= max;
  if (!limited) list.push(now);
  hits.delete(key); hits.set(key, list); // most recently used last
  while (hits.size > HITS_MAX) hits.delete(hits.keys().next().value);
  return limited;
}

/* The part of an address one visitor controls: an IPv4 address whole, an IPv6 address by its /64
   (first four groups), since home and server connections get a whole /64 to pick addresses from. */
export function ipKey(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (!s) return '';
  const v4 = s.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  if (!s.includes(':')) return s;
  s = s.split('%')[0];
  const dbl = s.indexOf('::');
  const head = (dbl >= 0 ? s.slice(0, dbl) : s).split(':').filter(Boolean);
  const tail = dbl >= 0 ? s.slice(dbl + 2).split(':').filter(Boolean) : [];
  const groups = dbl >= 0 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

/* first 16 hex of SHA-256(visitor key + pepper): groups holds per visitor without storing the address */
export async function ipHash(env, ip) {
  const key = ipKey(ip);
  if (!key) return '';
  const pepper = secretKey(env).slice(-24) || 'aob-booking';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${key}|${pepper}`));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const timeoutSignal = ms => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

/* Cloudflare Turnstile, decided on siteverify's JSON answer (it uses 4xx statuses for real results).
   Fails open only when Cloudflare can't be reached (network error, timeout, a 5xx without an answer)
   or reports our own secret as broken (bookings must not stop because of the bot check); fails closed
   on anything else: no token, an invalid / used token, an unreadable answer. In live mode the token
   must also come from one of our hosts and from the widget's action (`action`: one name or a list). */
const TS_OPEN = /^(missing-input-secret|invalid-input-secret|internal-error)$/;
export async function verifyTurnstile(env, token, ip, { action = 'booking' } = {}) {
  const actions = Array.isArray(action) ? action : [action];
  if (!turnstileSiteKey(env)) return { ok: true, skipped: true };
  if (typeof token !== 'string' || !token || token.length > 4096) return { ok: false, reason: 'missing' };
  let r;
  try {
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    if (ip) form.set('remoteip', ip);
    r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: timeoutSignal(5000) });
  } catch (e) { logError('turnstile', { type: 'network_error', status: 0 }); return { ok: true, unavailable: true }; }
  const d = await r.json().catch(() => null);
  if (!d || typeof d !== 'object') {
    logError('turnstile', { status: r.status, type: 'unreadable' });
    return r.status >= 500 ? { ok: true, unavailable: true } : { ok: false, reason: 'unreadable' };
  }
  const codes = Array.isArray(d['error-codes']) ? d['error-codes'].map(String) : [];
  if (d.success === true) {
    if (liveMode(env)) {
      if (!PROD_HOSTS.includes(String(d.hostname || ''))) return { ok: false, reason: 'hostname' };
      if (!actions.includes(d.action)) return { ok: false, reason: 'action' };
    }
    return { ok: true };
  }
  if (codes.some(c => TS_OPEN.test(c))) { logError('turnstile', { type: 'config', code: codes.join(','), status: r.status }); return { ok: true, unavailable: true }; }
  return { ok: false, reason: codes.join(',') || 'failed' };
}

/* ------------------------------------------------------------ programs */
export const getProgram = id => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROGRAMS, id)) ? PROGRAMS[id] : null;
export const listPrograms = () => Object.values(PROGRAMS);
const todayIso = (now = new Date()) => now.toISOString().slice(0, 10);
export function isClosed(program, now = new Date()) {
  return todayIso(now) > (program.booking_closes || program.dates.start);
}
/* The 20% deposit can be switched off from a date on (deposit.available_until, inclusive). */
export function depositInfo(program, now = new Date()) {
  const until = (program.deposit && program.deposit.available_until) || null;
  return { available: !until || todayIso(now) <= until, until };
}

/* --------------------------------------------------------------- money */
export const eur = c => '€' + (c / 100).toLocaleString('en-GB', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/* '2026-10-25' or unix seconds → '25 October' */
export function dayMonth(v) {
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v).slice(0, 10) + 'T00:00:00Z');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
const andList = a => a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

/* ------------------------------------------------------------- quoting */
/* Half an emoji (a UTF-16 surrogate without its partner) is what cutting text by length can leave
   behind; it can't be URL-encoded for Stripe. dropLoneSurrogates removes them (after every cut),
   wellFormed replaces them with U+FFFD (same length, for what is sent as it is). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const dropLoneSurrogates = s => String(s).replace(LONE_SURROGATE, '');
export const wellFormed = s => String(s).replace(LONE_SURROGATE, '\uFFFD');
/* s cut to at most max UTF-16 units without leaving half an emoji */
export const cut = (s, max) => dropLoneSurrogates(String(s).slice(0, max));
export const str = (v, max = 200) => cut((typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), max);
/* local part without leading/trailing/double dots; domain labels without leading/trailing hyphens */
const EMAIL = /^(?!\.)(?!.*\.\.)[^\s@"(),:;<>[\\\]]{1,64}(?<!\.)@(?=.{4,255}$)(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:\p{L}{2,63}|xn--[a-z0-9-]{2,59})$/iu;
export const validEmail = e => typeof e === 'string' && EMAIL.test(e);
/* "jane.doe@gmail.com" → "j•••@gmail.com" (for answers that travel with a link) */
export function maskEmail(e) {
  const s = String(e || ''), at = s.lastIndexOf('@');
  return at < 1 ? null : s[0] + '•••' + s.slice(at);
}
const NAME_BAD = /^[=+\-@]/; // spreadsheet formulas
// links, domains, emails, markup and numbers: names are forwarded to the CRM and used in emails
const NAME_LINK = /:\/\/|www\.|[\p{L}\p{N}]{2,}\.\p{L}{2,}|[@<>]|\d{2,}/iu;
export const nameError = s => NAME_BAD.test(s) ? 'Please use letters for names.'
  : NAME_LINK.test(s) ? 'Please enter just the name, without links, email addresses or numbers.' : null;

/* WhatsApp numbers: strip spaces, brackets, dots and dashes; "00" → "+"; "(0)" trunk prefixes dropped. */
export function normalizePhone(v) {
  let s = str(v, 40).replace(/\(0\)/g, '').replace(/[\s().\-‐-―]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return s;
}
export function phoneError(s) {
  if (/^\+[1-9]\d{6,14}$/.test(s)) return null;
  if (/^0/.test(s)) return 'Add your country code, e.g. +44 7700 900123.';
  return 'Add your WhatsApp number with the country code, e.g. +44 7700 900123.';
}

/* Free text the team types (notes): line breaks kept, other control and direction-override
   characters replaced, trimmed and cut to `max`. */
export const cleanNote = (v, max = 480) => cut((typeof v === 'string' ? v : v == null ? '' : String(v))
  .replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').trim(), max);

/* ---------------------------------------------------- wellbeing sessions
   program.services is compiled by build.py from booking/services.json: { currency, note, limits:
   { per_service, per_booking }, categories, practitioners: { key: { name, role, photo, bio } },
   items: [{ id, practitioner, category, title, minutes, price (whole euros) }] }. A session is
   requested as { id, guest } (guest = 0-based guest index); its price only ever comes from here. */
export const serviceItems = program => (program && program.services && Array.isArray(program.services.items)) ? program.services.items : [];
export function serviceLimits(program) {
  const l = (program && program.services && program.services.limits) || {};
  return { per_service: Number.isInteger(l.per_service) ? l.per_service : 4, per_booking: Number.isInteger(l.per_booking) ? l.per_booking : 12 };
}
export function serviceInfo(program, id) {
  const s = serviceItems(program).find(x => x.id === id);
  if (!s) return null;
  const pr = (program.services.practitioners || {})[s.practitioner] || {};
  return { id: s.id, title: s.title, practitioner: s.practitioner, practitioner_name: pr.name || s.practitioner,
    category: s.category || null, minutes: s.minutes, price_cents: Math.round(s.price * 100) };
}
/* "Muji: Magic Massage (60 min)" */
export const sessionLabel = a => a.unknown ? a.id : `${a.practitioner_name}: ${a.title} (${a.minutes} min)`;
/* aob_addons: 'id@G,id@G' (G = 1-based guest number) */
export const addonsToString = list => list.map(a => `${a.id}@${a.guest + 1}`).join(',');
/* aob_addons → [{ id, guest (0-based), title, practitioner, practitioner_name, category, minutes, price_cents }]
   from the program's catalogue; ids it no longer has are kept as they are (unknown: true). */
export function parseAddons(s, program) {
  return String(s || '').split(',').filter(Boolean).map(x => {
    const at = x.lastIndexOf('@'), id = at > 0 ? x.slice(0, at) : x, n = at > 0 ? parseInt(x.slice(at + 1), 10) : 1;
    const guest = Number.isInteger(n) && n >= 1 ? n - 1 : 0, info = program ? serviceInfo(program, id) : null;
    return info ? { ...info, guest } : { id, guest, title: id, practitioner: null, practitioner_name: '', category: null, minutes: null, price_cents: null, unknown: true };
  });
}
const ADDONS_MAX_CHARS = 490;
/* Requested sessions checked against the catalogue and the limits; sessions already on the booking
   (`existing`, cancelled ones left out) count towards the limits. → { list, error } */
export function checkAddons(program, raw, guestCount, existing = []) {
  if (raw == null || (Array.isArray(raw) && !raw.length)) return { list: [] };
  if (!Array.isArray(raw)) return { list: [], error: 'Please choose your sessions from the list.' };
  if (!serviceItems(program).length) return { list: [], error: 'Wellbeing sessions are not offered for this week.' };
  const lim = serviceLimits(program), have = existing.length;
  if (have + raw.length > lim.per_booking) {
    const left = Math.max(0, lim.per_booking - have);
    return { list: [], error: !have ? `You can add up to ${lim.per_booking} sessions to one booking.`
      : left ? `You can add ${left} more ${left === 1 ? 'session' : 'sessions'} to this booking.`
      : 'This booking already has as many sessions as we can add online. Message us on WhatsApp and we will help.' };
  }
  const list = [], per = {};
  existing.forEach(a => { per[a.id] = (per[a.id] || 0) + 1; });
  for (const x of raw) {
    const a = x && typeof x === 'object' && !Array.isArray(x) ? x : {};
    const info = typeof a.id === 'string' ? serviceInfo(program, a.id) : null;
    if (!info) return { list: [], error: 'One of the sessions is no longer offered. Please choose again.' };
    const g = a.guest == null || a.guest === '' ? 0 : typeof a.guest === 'number' ? a.guest : /^\d{1,2}$/.test(String(a.guest)) ? parseInt(a.guest, 10) : NaN;
    if (!Number.isInteger(g) || g < 0 || g >= guestCount) return { list: [], error: 'Please choose who each session is for.' };
    per[info.id] = (per[info.id] || 0) + 1;
    if (per[info.id] > lim.per_service) {
      return { list: [], error: `You can book “${info.title}” (${info.minutes} min) up to ${lim.per_service} times on one booking.` };
    }
    list.push({ ...info, guest: g });
  }
  // never cut short what a guest pays for: refuse instead (only reachable with very long service ids)
  if (addonsToString(list).length > ADDONS_MAX_CHARS) return { list: [], error: 'That is more sessions than we can record on one booking. Please add the rest after booking.' };
  return { list };
}
/* One receipt line per session type: [{ id, title, practitioner_name, minutes, count, unit_cents, amount_cents }] */
function addonLinesOf(list) {
  const out = [];
  for (const a of list) {
    let l = out.find(x => x.id === a.id);
    if (!l) out.push(l = { id: a.id, title: a.title, practitioner_name: a.practitioner_name, minutes: a.minutes, count: 0, unit_cents: a.price_cents, amount_cents: 0, discount_cents: 0 });
    l.count++; l.amount_cents += a.price_cents;
  }
  return out;
}

/* ------------------------------------------------------------- discount
   Admin booking links only (quote(…, { admin: true })): { type: 'percent'|'amount', value, scope:
   'programme'|'room'|'total', reason }. A percentage (whole, 1–100) comes off each part in its scope
   (sessions only with 'total'), one receipt line at a time, so every line stays whole cents. An
   amount (cents) comes off the programme fee, the accommodation, or with 'total' the accommodation
   first and then the programme fee; it can't be more than that. Nothing ever goes below zero. */
const D_TYPES = ['percent', 'amount'], D_SCOPES = ['programme', 'room', 'total'];
const hasDiscount = d => d != null && d !== false && !(typeof d === 'object' && !Array.isArray(d) && !d.type && (d.value == null || d.value === ''));
function discountFor(d, parts, errors) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) { errors['discount.type'] = 'Choose a percentage or an amount.'; return null; }
  const { type, scope } = d, reason = str(d.reason, 200);
  const raw = typeof d.value === 'string' ? d.value.trim() : d.value;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? parseInt(raw, 10) : NaN;
  let ok = true;
  const err = (k, m) => { errors['discount.' + k] = m; ok = false; };
  if (!D_TYPES.includes(type)) err('type', 'Choose a percentage or an amount.');
  if (!D_SCOPES.includes(scope)) err('scope', 'Choose what the discount applies to.');
  if (!reason || reason.length > 60) err('reason', 'Add a short reason (up to 60 characters).');
  if (type === 'percent' && !(Number.isInteger(value) && value >= 1 && value <= 100)) err('value', 'Enter a whole percentage from 1 to 100.');
  if (type === 'amount' && !(Number.isInteger(value) && value >= 1)) err('value', 'Enter an amount above zero (in cents).');
  if (!ok) return null;
  const { programme, accommodation, lines } = parts;
  if (scope === 'programme' && !programme) { err('scope', 'This booking has no programme fee to discount.'); return null; }
  if (scope === 'room' && !accommodation) { err('scope', 'This booking has no accommodation to discount.'); return null; }
  const out = { type, value, scope, reason, programme_cents: 0, accommodation_cents: 0, addons_cents: 0, lines: {} };
  if (type === 'percent') {
    const off = c => Math.round(c * value / 100);
    if (scope !== 'room') out.programme_cents = off(programme);
    if (scope !== 'programme') out.accommodation_cents = off(accommodation);
    if (scope === 'total') lines.forEach(l => { out.lines[l.id] = off(l.amount_cents); out.addons_cents += out.lines[l.id]; });
  } else {
    const cap = scope === 'programme' ? programme : scope === 'room' ? accommodation : programme + accommodation;
    if (value > cap) { err('value', `The discount can be at most ${eur(cap)}.`); return null; }
    if (scope === 'programme') out.programme_cents = value;
    else if (scope === 'room') out.accommodation_cents = value;
    else { out.accommodation_cents = Math.min(value, accommodation); out.programme_cents = value - out.accommodation_cents; }
  }
  out.cents = out.programme_cents + out.accommodation_cents + out.addons_cents;
  return out;
}
/* "50% off (Bring a friend)" / "€200 off (Bring a friend)" */
export const discountLabel = d => `${d.type === 'percent' ? `${d.value}%` : eur(d.value)} off (${d.reason})`;

/* Validate a booking request and price it from the program file.
   input: { payment: 'deposit'|'full'|'plan', programme: 'included'|'paid', guests: [{first,last,email,gender,room}],
            whatsapp, roommate, diet, terms, remind, addons: [{ id, guest }], discount (admin only) }
   opts: { now, admin } (a Date is taken as now). admin: a booking link made by the team: the guest
   accepts the terms on Stripe's page (no `terms` here) and a discount may apply.
   Guest 1's email is required, the others' optional. With a programme fee, every guest pays it in
   full at booking (programme: 'paid' = already paid elsewhere, room only), and the deposit
   percentage applies to the accommodation. Wellbeing sessions are paid in full at booking too:
   total = accommodation + programme + sessions; the deposit is programme + sessions + the deposit
   percentage of the accommodation, so the balance is always accommodation only. */
export const programmeFee = program => (program.programme && Number.isInteger(program.programme.fee) && program.programme.fee > 0) ? program.programme : null;
export function quote(program, input, opts = {}) {
  const o = opts instanceof Date ? { now: opts } : (opts || {});
  const now = o.now || new Date(), admin = o.admin === true;
  input = input && typeof input === 'object' ? input : {};
  const errors = {};
  const payment = input.payment === 'full' || input.payment === 'plan' ? input.payment : 'deposit';
  const raw = Array.isArray(input.guests) ? input.guests.slice(0, 50) : [];
  const max = program.max_guests_per_booking || 6;
  if (raw.length < 1) errors.guests = 'Add at least one guest.';
  if (raw.length > max) errors.guests = `You can book up to ${max} guests at a time.`;
  const rooms = Object.fromEntries(program.rooms.map(r => [r.id, r]));
  const genders = (program.genders || []).map(g => g.toLowerCase());

  const guests = raw.slice(0, max).map((g, i) => {
    g = g && typeof g === 'object' ? g : {};
    const o = { first: str(g.first, 60), last: str(g.last, 60), email: str(g.email, 120).toLowerCase(), gender: str(g.gender, 40), room: str(g.room, 40) };
    for (const k of ['first', 'last']) {
      if (!o[k]) errors[`guests.${i}.${k}`] = k === 'first' ? 'Please add a first name.' : 'Please add a last name.';
      else if (nameError(o[k])) errors[`guests.${i}.${k}`] = nameError(o[k]);
    }
    if (i === 0 ? !validEmail(o.email) : (o.email && !validEmail(o.email))) errors[`guests.${i}.email`] = 'Please add a valid email address.';
    const gi = genders.indexOf(o.gender.toLowerCase());
    if (gi < 0) errors[`guests.${i}.gender`] = 'Please choose an option.'; else o.gender = program.genders[gi];
    if (!rooms[o.room]) errors[`guests.${i}.room`] = 'Please choose where this guest will stay.';
    return o;
  });

  const whatsapp = normalizePhone(input.whatsapp);
  const pe = phoneError(whatsapp);
  if (pe) errors.whatsapp = pe;
  const roommate = str(input.roommate, 200);
  const diet = str(input.diet, 400);
  if (!admin && input.terms !== true) errors.terms = 'Please agree to the terms and conditions.';
  if (payment === 'deposit' && !depositInfo(program, now).available) {
    errors.payment = 'The deposit option has closed for this week. Please choose to pay in full.';
  }

  const counts = {};
  guests.forEach(g => { if (rooms[g.room]) counts[g.room] = (counts[g.room] || 0) + 1; });
  const lines = Object.entries(counts).map(([id, n]) => {
    const r = rooms[id];
    const units = r.unit === 'person' ? n : Math.ceil(n / (r.sleeps || 1));
    return { room: id, name: r.name, guests: n, units, unit: r.unit, unit_price_cents: r.price * 100, amount_cents: units * r.price * 100 };
  });
  const accommodation = lines.reduce((s, l) => s + l.amount_cents, 0);
  const prog = programmeFee(program);
  const programme = !prog ? 'none' : input.programme === 'paid' ? 'paid' : 'included';
  const programmeGross = programme === 'included' ? guests.length * prog.fee * 100 : 0;

  const ad = checkAddons(program, input.addons, guests.length);
  if (ad.error) errors.addons = ad.error;
  const addons = ad.list, addonLines = addonLinesOf(addons);
  const addonsGross = addonLines.reduce((s, l) => s + l.amount_cents, 0);

  // a discount is only ever read for admin links: the public checkout ignores one in the request
  const disc = admin && hasDiscount(input.discount)
    ? discountFor(input.discount, { programme: programmeGross, accommodation, lines: addonLines }, errors) : null;
  addonLines.forEach(l => { l.discount_cents = disc ? (disc.lines[l.id] || 0) : 0; l.net_cents = l.amount_cents - l.discount_cents; });
  const programmeCents = programmeGross - (disc ? disc.programme_cents : 0);
  const accNet = accommodation - (disc ? disc.accommodation_cents : 0);
  const addonsCents = addonsGross - (disc ? disc.addons_cents : 0);

  const total = accNet + programmeCents + addonsCents;
  const deposit = programmeCents + addonsCents + Math.round(accNet * (program.deposit && program.deposit.percent || 100) / 100);
  let dueNow = payment === 'full' ? total : deposit, plan = null;
  if (payment === 'plan') {
    const n = (program.payment_plan && program.payment_plan.installments) || 3;
    const inst = Math.floor(total / n);                 // equal monthly payments…
    plan = { installments: n, installment_cents: inst, first_cents: total - inst * (n - 1) }; // …any cents go on the first
    dueNow = plan.first_cents;
  }
  const discount = disc ? { type: disc.type, value: disc.value, scope: disc.scope, reason: disc.reason, cents: disc.cents,
    programme_cents: disc.programme_cents, accommodation_cents: disc.accommodation_cents, addons_cents: disc.addons_cents } : null;
  return {
    ok: Object.keys(errors).length === 0, errors, payment, guests, whatsapp, roommate, diet, remind: input.remind === true,
    counts, lines, plan, programme, programme_cents: programmeCents, programme_fee_cents: prog ? prog.fee * 100 : 0,
    accommodation_cents: accNet, addons, addon_lines: addonLines, addons_cents: addonsCents, discount,
    subtotal_cents: accommodation + programmeGross + addonsGross,
    total_cents: total, deposit_cents: deposit, due_now_cents: dueNow, balance_cents: total - dueNow,
  };
}

/* ---------------------------------------------------------- payment plan */
/* k months after d, same time of day, clamped to the month's last day: the way Stripe steps monthly
   billing periods from a billing_cycle_anchor (always counted from the anchor, never chained). */
export function addMonths(d, k) {
  const x = new Date(d.getTime()), day = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + k);
  x.setUTCDate(Math.min(day, new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate()));
  return x;
}
/* The last day a plan payment may fall on: "before_arrival" = the day before the start date. */
export function lastPaymentBy(program) {
  const v = program.payment_plan && program.payment_plan.last_payment_by;
  if (v !== 'before_arrival') return v || null;
  const d = new Date(program.dates.start + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
/* Is the monthly plan on offer right now? (program setting, last-payment-by rule, webhook in live mode) */
export function planInfo(program, env = {}, now = new Date()) {
  const pp = program.payment_plan;
  if (!pp || !pp.installments) return { available: false, reason: 'not offered' };
  const n = pp.installments, by = lastPaymentBy(program), base = { installments: n, interval: pp.interval || 'month', last_payment_by: by };
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) return { ...base, available: false, reason: 'webhook not configured' };
  if (by && addMonths(now, n - 1).toISOString().slice(0, 10) > by) {
    return { ...base, available: false, reason: 'not enough time before ' + by };
  }
  return { ...base, available: true };
}

/* ---------------------------------------------------------- availability
   Shared rooms are single-gender. Each shared room type lists its physical rooms ("units",
   all with `sleeps` beds) and any beds already taken outside this system ("occupied", with the
   occupant's gender; gender null = unknown, which keeps the rest of that room off sale until
   someone sets it). An empty room can go to women or men; once a bed is taken, the other beds
   in that room are only for the same gender. Rooms that sleep one have a simple `capacity`.
   Rooms not priced per person (unit "cottage") count `capacity` and what is taken in units:
   each booking takes ceil(its guests / sleeps) of them. */
const gkey = g => { const k = String(g || '').toLowerCase(); return k === 'female' || k === 'male' ? k : 'other'; };
export const isShared = r => !!r.same_gender && (r.sleeps || 1) > 1 && Number.isInteger(r.units);
export const byUnit = r => !!r.unit && r.unit !== 'person' && !isShared(r);
/* capacity in places (people) */
export const roomCapacity = r => isShared(r)
  ? r.units * r.sleeps - (r.occupied || []).slice(0, r.units).reduce((s, o) => s + (o.beds || 0), 0)
  : byUnit(r) ? (r.capacity || 0) * (r.sleeps || 1) : (r.capacity || 0);

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

/* Can `f` women and `m` men all be placed in this room type right now? (left_any is in places, so
   for unit rooms "n places fit" ⇔ ceil(n / sleeps) units are free) */
export function fits(a, f, m) {
  if (!a) return false;
  if (f + m > a.program_left) return false;
  if (a.kind !== 'shared') return f + m <= a.left_any;
  const needF = Math.max(0, f - a.partial.female), needM = Math.max(0, m - a.partial.male);
  return Math.ceil(needF / a.beds) + Math.ceil(needM / a.beds) <= a.empty_units;
}

/* occ = { booked, holds, release } from occupancy(); per room: { female, male, other, units }.
   Adds per room `held` (places in open checkouts) and `next_release_at` (earliest hold expiry). */
export function availability(program, occ) {
  const booked = (occ && occ.booked) || {}, holds = (occ && occ.holds) || {}, release = (occ && occ.release) || {};
  const sum = id => {
    const a = booked[id] || {}, h = holds[id] || {};
    return { female: (a.female || 0) + (h.female || 0), male: (a.male || 0) + (h.male || 0), other: (a.other || 0) + (h.other || 0), units: (a.units || 0) + (h.units || 0) };
  };
  const t = {}; let used = 0;
  for (const r of program.rooms) { t[r.id] = sum(r.id); used += t[r.id].female + t[r.id].male + t[r.id].other; }
  const program_left = Math.max(0, program.program_spaces - used);
  const rooms = {};
  for (const r of program.rooms) {
    const x = t[r.id], taken = x.female + x.male + x.other, capacity = roomCapacity(r), h = holds[r.id] || {};
    const extra = { held: (h.female || 0) + (h.male || 0) + (h.other || 0), next_release_at: release[r.id] || null };
    if (isShared(r)) {
      const st = sharedState(r, x);
      const lf = Math.min(program_left, st.partial.female + st.empty_units * st.beds);
      const lm = Math.min(program_left, st.partial.male + st.empty_units * st.beds);
      rooms[r.id] = { kind: 'shared', capacity, taken, beds: st.beds, empty_units: st.empty_units, partial: st.partial,
        left: { female: lf, male: lm }, left_any: Math.max(lf, lm), program_left, sold_out: Math.max(lf, lm) <= 0, ...extra };
    } else if (byUnit(r)) {
      const sleeps = r.sleeps || 1, capU = r.capacity || 0, leftU = Math.max(0, capU - x.units);
      const la = Math.min(program_left, leftU * sleeps);
      rooms[r.id] = { kind: 'simple', unit: r.unit, sleeps, capacity, capacity_units: capU, taken, taken_units: x.units, units_left: leftU,
        left: { female: la, male: la }, left_any: la, program_left, sold_out: la <= 0, ...extra };
    } else {
      const la = Math.min(program_left, Math.max(0, capacity - taken));
      rooms[r.id] = { kind: 'simple', capacity, taken, left: { female: la, male: la }, left_any: la, program_left, sold_out: la <= 0, ...extra };
    }
  }
  // What would be free if every open checkout were given up (the page says "places in checkout
  // right now, check again after 14:32" instead of a flat "sold out"). if_released carries the
  // room's packing (empty rooms, partly filled rooms) so the page can run fits() on it: a mixed
  // group may need two empty rooms even when both genders have places on paper.
  const anyHeld = Object.values(rooms).some(x => x.held > 0);
  const base = anyHeld ? availability(program, { booked }) : null;
  for (const id of Object.keys(rooms)) {
    const b = base ? base.rooms[id] : rooms[id];
    rooms[id].left_if_released = b.left;
    rooms[id].if_released = { kind: b.kind, beds: b.beds, empty_units: b.empty_units, partial: b.partial, left_any: b.left_any, program_left: b.program_left };
  }
  return { program_left, program_left_if_released: base ? base.program_left : program_left, rooms };
}

export function checkAvailability(program, q, avail) {
  const n = q.guests.length;
  if (n > avail.program_left) return avail.program_left > 0
    ? `Only ${avail.program_left} ${avail.program_left === 1 ? 'place is' : 'places are'} left for ${program.dates.short}.`
    : `${program.edition || program.title} is now fully booked.`;
  const by = {};
  q.guests.forEach(g => { const c = by[g.room] || (by[g.room] = { female: 0, male: 0 }); c[gkey(g.gender) === 'male' ? 'male' : 'female']++; });
  for (const [id, c] of Object.entries(by)) {
    const a = avail.rooms[id], r = program.rooms.find(x => x.id === id) || { name: id };
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

const publicAddon = a => ({ id: a.id, guest: a.guest, title: a.title, practitioner: a.practitioner, practitioner_name: a.practitioner_name, minutes: a.minutes, price_cents: a.price_cents });
export const publicQuote = q => ({
  payment: q.payment, guests: q.guests.length, lines: q.lines, plan: q.plan,
  programme: q.programme, programme_cents: q.programme_cents, accommodation_cents: q.accommodation_cents,
  addons: (q.addons || []).map(publicAddon), addons_cents: q.addons_cents || 0,
  discount: q.discount ? { type: q.discount.type, value: q.discount.value, scope: q.discount.scope, reason: q.discount.reason, cents: q.discount.cents } : null,
  subtotal_cents: q.subtotal_cents,
  total_cents: q.total_cents, deposit_cents: q.deposit_cents, due_now_cents: q.due_now_cents, balance_cents: q.balance_cents,
});

/* ------------------------------------------------------------- metadata
   Stripe allows 50 keys of ≤ 500 characters. A 6-guest booking uses about 35 (12 guests ≈ 41); the
   team's notes (aob_note, aob_assign, aob_svc), aob_status(_at) and aob_ghl add up to 6 later, so
   the fullest booking (12 guests, room only, plan, sessions, every option) stays at 47. */
export const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'];
export function pickUtm(utm) {
  const o = {};
  if (utm && typeof utm === 'object') UTM.forEach(k => { const v = str(utm[k], 150); if (v) o[k] = v; });
  return o;
}
/* All UTMs in one JSON key (≤ 490 characters; keys that don't fit are dropped, least useful last). */
export function packUtm(utm) {
  const all = pickUtm(utm), o = {};
  let s = '';
  for (const k of UTM) {
    if (!all[k]) continue;
    o[k] = all[k];
    const t = JSON.stringify(o);
    if (t.length > 490) delete o[k]; else s = t;
  }
  return s;
}
export const cleanAttempt = v => typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '';
export const roomsToString = counts => Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(',');
export function roomsFromString(s) {
  const out = {};
  String(s || '').split(',').forEach(p => { const [k, v] = p.split(':'); const n = parseInt(v, 10); if (k && n > 0) out[k] = (out[k] || 0) + n; });
  return out;
}
const noPipe = s => String(s).replace(/\|/g, '/');

/* extra: { page, utm, ui, attempt, iph, progVerified, progPis: [{ id, cents }], now, source, note }
   aob_iph (visitor hash) is only for the open checkout: bookingCheckoutParams leaves it off the
   PaymentIntent / subscription, which are kept for good. source 'admin': a booking link made by the
   team (the guest accepts the terms on Stripe's page, so there is no aob_terms_at yet). */
export function bookingMetadata(program, q, ref, extra = {}) {
  const lead = q.guests[0], admin = extra.source === 'admin';
  const md = {
    aob_kind: 'booking', aob_program: program.id, aob_ref: ref, aob_payment: q.payment,
    aob_total: String(q.total_cents), aob_due_now: String(q.due_now_cents), aob_balance: String(q.balance_cents),
    aob_rooms: roomsToString(q.counts), aob_guests: String(q.guests.length),
    aob_lead_name: cut(`${lead.first} ${lead.last}`, 120), aob_lead_email: lead.email,
    aob_whatsapp: q.whatsapp, aob_roommate: cut(q.roommate || '', 200),
  };
  if (q.programme !== 'none') { md.aob_prog = q.programme; md.aob_prog_total = String(q.programme_cents); }
  if (q.programme === 'paid') md.aob_prog_verified = extra.progVerified === 'stripe' || extra.progVerified === 'admin' ? extra.progVerified : 'unverified';
  if (q.programme === 'paid' && Array.isArray(extra.progPis) && extra.progPis.length) {
    md.aob_prog_pi = extra.progPis.map(p => `${p.id}:${p.cents}`).join(',').slice(0, 490); // the earlier payments matched
  }
  if (q.plan) { md.aob_plan_n = String(q.plan.installments); md.aob_installment = String(q.plan.installment_cents); }
  q.guests.forEach((g, i) => { md[`aob_g${i + 1}`] = cut([noPipe(`${g.first} ${g.last}`), g.email, g.gender, g.room].join(' | '), 490); });
  if (q.addons && q.addons.length) { md.aob_addons = addonsToString(q.addons); md.aob_addons_total = String(q.addons_cents); } // checkAddons keeps it ≤ 490
  if (q.discount) {
    const d = q.discount;
    md.aob_discount = cut(`${d.type}:${d.value}:${d.scope}:${d.reason}`, 490);
    md.aob_discount_cents = String(d.cents);
  }
  if (admin) md.aob_source = 'admin';
  const note = cleanNote(extra.note); if (note) md.aob_note = note;
  if (q.diet) md.aob_diet = cut(q.diet, 400);
  if (q.remind) md.aob_remind = '1';
  if (!admin) md.aob_terms_at = (extra.now || new Date()).toISOString();
  if (program.terms_url) md.aob_terms = str(program.terms_url, 300);
  if (extra.ui) md.aob_ui = extra.ui === 'embedded' ? 'embedded' : 'hosted';
  const attempt = cleanAttempt(extra.attempt); if (attempt) md.aob_attempt = attempt;
  if (extra.iph) md.aob_iph = String(extra.iph).slice(0, 32);
  const utm = packUtm(extra.utm); if (utm) md.aob_utm = utm;
  if (extra.page) md.aob_page = str(extra.page, 300);
  return md;
}

/* Room assignment (aob_assign): '0=2A · Temple Cottage|1=2B · Temple Cottage' ⇄ { "0": "2A · Temple Cottage", … } */
export function parseAssign(s) {
  const out = {};
  String(s || '').split('|').forEach(p => { const i = p.indexOf('='); if (i > 0 && /^\d+$/.test(p.slice(0, i)) && p.slice(i + 1)) out[p.slice(0, i)] = p.slice(i + 1); });
  return out;
}
export const assignToString = a => Object.keys(a).filter(k => a[k]).sort((x, y) => x - y).map(k => `${k}=${a[k]}`).join('|');
/* Session status (aob_svc): 'b0:scheduled:Tue 20 Jul, 15:00;x1a2b3c4d-0:done:' ⇄ { b0: { status, when }, … } */
export const SVC_STATUS = ['todo', 'scheduled', 'done', 'cancelled'];
export function parseSvc(s) {
  const out = {};
  String(s || '').split(';').forEach(p => {
    const a = p.indexOf(':'), b = a < 0 ? -1 : p.indexOf(':', a + 1);
    if (a <= 0) return;
    const status = b < 0 ? p.slice(a + 1) : p.slice(a + 1, b);
    if (SVC_STATUS.includes(status)) out[p.slice(0, a)] = { status, when: b < 0 ? '' : p.slice(b + 1) };
  });
  return out;
}
export const svcToString = m => Object.entries(m).filter(([, v]) => v && (v.status !== 'todo' || v.when)).map(([k, v]) => `${k}:${v.status}:${v.when || ''}`).join(';');
/* aob_discount 'type:value:scope:reason' + aob_discount_cents → { type, value, scope, reason, cents } | null */
export function parseDiscount(md) {
  const s = String(md.aob_discount || ''); if (!s) return null;
  const [type, value, scope, ...rest] = s.split(':');
  return { type, value: parseInt(value, 10) || 0, scope, reason: rest.join(':'), cents: parseInt(md.aob_discount_cents || '0', 10) || 0 };
}

/* A booking's metadata, read back. program: for the sessions' titles and prices (defaults to the
   booking's own program). */
export function parseBooking(md = {}, program = getProgram(md.aob_program)) {
  const guests = [];
  for (let i = 1; i <= 12; i++) {
    const v = md[`aob_g${i}`]; if (!v) continue;
    const [name, email, gender, room] = v.split(' | ');
    guests.push({ name, email: email || '', gender, room });
  }
  const utm = {};
  if (md.aob_utm) { try { const o = JSON.parse(md.aob_utm); if (o && typeof o === 'object') UTM.forEach(k => { if (o[k]) utm[k] = String(o[k]); }); } catch {} }
  UTM.forEach(k => { if (md[k] && !utm[k]) utm[k] = md[k]; }); // bookings made before aob_utm existed
  const progPis = String(md.aob_prog_pi || '').split(',').filter(Boolean).map(x => { const [id, c] = x.split(':'); return { id, cents: parseInt(c || '0', 10) || 0 }; });
  return {
    ref: md.aob_ref, program: md.aob_program, payment: md.aob_payment, status: md.aob_status || 'active',
    status_at: parseInt(md.aob_status_at || '0', 10) || null,
    total_cents: parseInt(md.aob_total || '0', 10), rooms: roomsFromString(md.aob_rooms),
    programme: md.aob_prog || 'none', programme_cents: parseInt(md.aob_prog_total || '0', 10),
    programme_verified: md.aob_prog === 'paid' ? (md.aob_prog_verified || 'unverified') : '',
    programme_payments: md.aob_prog === 'paid' ? progPis : [],
    lead: { name: md.aob_lead_name, email: md.aob_lead_email, whatsapp: md.aob_whatsapp, roommate: md.aob_roommate || '' },
    guests, utm, page: md.aob_page || '', diet: md.aob_diet || '', ui: md.aob_ui || '', remind: md.aob_remind === '1',
    attempt: md.aob_attempt || '', terms_at: md.aob_terms_at || '',
    addons: parseAddons(md.aob_addons, program), addons_cents: parseInt(md.aob_addons_total || '0', 10) || 0,
    source: md.aob_source === 'admin' ? 'admin' : 'online', discount: parseDiscount(md), demo: md.aob_demo === '1',
    note: md.aob_note || '', assign: parseAssign(md.aob_assign), svc: parseSvc(md.aob_svc),
  };
}

const refPrefix = program => 'BC' + program.dates.start.replace(/-/g, '').slice(2, 6); // BC + YYMM
export function newRef(program) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return `${refPrefix(program)}-` + Array.from(b, x => A[x % A.length]).join('');
}
export const validRef = r => typeof r === 'string' && /^[A-Z0-9]{2,8}-[A-Z0-9]{4,10}$/.test(r);
/* A reference one of our programs could have issued (checked before spending Stripe calls on it). */
export const knownRef = r => validRef(r) && listPrograms().some(p => r.startsWith(refPrefix(p) + '-'));
/* The programs that issue references like this one (weeks starting in the same month share a prefix;
   live lookups take the program from the booking itself, this is for demo answers). */
export const programsForRef = r => validRef(r) ? listPrograms().filter(p => r.startsWith(refPrefix(p) + '-')) : [];
export const CS_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

/* ---------------------------------------------------------------- Stripe */
export function formEncode(obj) {
  const out = [];
  const walk = (v, key) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, key ? `${key}[${k}]` : k));
    else out.push(encodeURIComponent(wellFormed(key)) + '=' + encodeURIComponent(wellFormed(v))); // never throws on half an emoji
  };
  walk(obj, '');
  return out.join('&');
}
export const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();

/* Tunables (tests shorten the backoff). */
export const stripeConfig = { timeoutMs: 8000, retries: 2, retryBaseMs: 300 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function stripeError(res, data, netErr) {
  const se = (data && data.error) || {};
  const http = res && !res.ok;
  const e = new Error(http ? (se.message || `Stripe error ${res.status}`) : `Stripe unreachable (${(netErr && netErr.name) || 'error'})`);
  e.status = http ? res.status : 0;
  e.type = http ? (se.type || null) : 'network_error';
  e.code = se.code || null; e.param = se.param || null;
  e.requestId = res ? res.headers.get('Request-Id') : null;
  return e;
}
/* One Stripe API call. 8 s timeout; up to 2 retries on network errors, 429 and 5xx (jittered backoff,
   Stripe-Should-Retry honoured), reusing ONE Idempotency-Key per logical POST so a retry can't
   create a second object. Errors carry type, code, param, status and requestId. */
export async function stripe(env, method, path, params, opts = {}) {
  const retries = opts.retries ?? stripeConfig.retries, timeoutMs = opts.timeoutMs ?? stripeConfig.timeoutMs;
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': STRIPE_VERSION };
  let body;
  if (params && method !== 'GET') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = formEncode(params); }
  if (method === 'POST') headers['Idempotency-Key'] = opts.idempotencyKey || crypto.randomUUID();
  for (let attempt = 0; ; attempt++) {
    let res = null, data = null, netErr = null;
    try {
      res = await fetch('https://api.stripe.com/v1' + path, { method, headers, body, signal: timeoutSignal(timeoutMs) });
      const text = await res.text();
      try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
      if (res.ok && !data) netErr = new Error('invalid JSON');
    } catch (e) { netErr = e; res = null; }
    if (res && res.ok && !netErr) return data;
    const should = res && !netErr ? res.headers.get('Stripe-Should-Retry') : null;
    const retryable = netErr ? true : should === 'true' ? true : should === 'false' ? false : (res.status === 429 || res.status >= 500);
    if (retryable && attempt < retries) {
      await sleep(Math.min(4000, stripeConfig.retryBaseMs * 2 ** attempt) * (0.5 + Math.random() / 2));
      continue;
    }
    throw stripeError(netErr ? null : res, data, netErr);
  }
}

/* Every page of a list endpoint (newest first), up to maxPages × 100 rows. */
export async function listAll(env, path, params = {}, { maxPages = 10 } = {}) {
  const rows = []; let after;
  for (let page = 0; page < maxPages; page++) {
    const r = await stripe(env, 'GET', `${path}?` + qs({ ...params, limit: 100, starting_after: after }));
    const data = (r && r.data) || [];
    rows.push(...data);
    if (!r.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return rows;
}
export async function searchAll(env, query, cap = 2000, object = 'payment_intents', extra = {}) {
  const rows = []; let page;
  do {
    const r = await stripe(env, 'GET', `/${object}/search?` + qs({ query, limit: 100, page, ...extra }));
    rows.push(...(r.data || []));
    page = r.has_more ? r.next_page : undefined;
  } while (page && rows.length < cap);
  return rows;
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* Plan bookings are subscriptions. They count from the first paid invoice (status not "incomplete"). */
export const LIVE_SUB = sub => sub.status !== 'incomplete' && sub.status !== 'incomplete_expired';
const idOf = v => typeof v === 'string' ? v : (v && v.id) || null;
/* What a plan has paid (its paid invoices), and its first paid invoice's PaymentIntent (expanded):
   { amount, count, first_pi: { id, metadata } | null, overlay: { id, md } | null (the team's keys of an
   ended plan, see saveAdminMeta) }. */
export async function paidOnSub(env, subId) {
  const r = await stripe(env, 'GET', '/invoices?' + qs({ subscription: subId, status: 'paid', limit: 24, 'expand[]': 'data.payment_intent' }));
  const data = (r && r.data) || [];
  // the first paid invoice: the one that started the plan, else the oldest (lists come newest first)
  const first = data.find(i => i.billing_reason === 'subscription_create')
    || data.slice().sort((a, b) => (a.created || 0) - (b.created || 0) || (a.id < b.id ? 1 : -1))[0] || null;
  const pi = first && first.payment_intent;
  const first_pi = pi ? { id: idOf(pi), metadata: (typeof pi === 'object' && pi.metadata) || null } : null;
  return { amount: data.reduce((a, inv) => a + (inv.amount_paid || 0), 0), count: data.length, first_pi,
    overlay: first_pi && isOverlay(first_pi.metadata) ? { id: first_pi.id, md: first_pi.metadata } : null };
}

/* The team's keys on a booking (note, room assignment, session status, cancelled status). They live
   on the booking's PaymentIntent, or on a plan's subscription. A plan's subscription is canceled once
   its last period ends (often before the week) and Stripe may refuse to update a canceled
   subscription: the keys then go to the plan's first paid invoice's PaymentIntent (succeeded, it
   takes metadata), tagged aob_admin_overlay='1' with aob_overlay_of=<subscription>, and aob_program /
   aob_ref so the searches that read bookings find it too (no extra calls). It has no aob_kind and is
   filtered out of payments explicitly (toRecords, programmeFeePayments), so it never counts as one.
   When the overlay exists, its keys replace the subscription's (the first write copies the
   subscription's current keys over, so nothing is lost and a key cleared on the overlay stays
   cleared). Reads: paidOnSub's fresh copy where plans' amounts are read (admin, findBooking), else
   the one search found (it can lag a minute behind a change, like every search). */
export const ADMIN_KEYS = ['aob_note', 'aob_assign', 'aob_svc', 'aob_status', 'aob_status_at'];
const OVERLAY = 'aob_admin_overlay';
const isOverlay = md => !!md && md[OVERLAY] === '1';
export function withOverlay(md, overlay) { // overlay: the overlay PaymentIntent's metadata
  if (!isOverlay(overlay)) return md || {};
  const out = { ...(md || {}) };
  for (const k of ADMIN_KEYS) { delete out[k]; if (overlay[k]) out[k] = overlay[k]; }
  return out;
}
const pickAdmin = md => Object.fromEntries(ADMIN_KEYS.filter(k => md && md[k]).map(k => [k, md[k]]));
/* Stripe refusing a change because the subscription has ended */
const canceledSubError = e => !!e && e.type === 'invalid_request_error' && /cancel+ed subscription/i.test(e.message || '');
async function saveOverlay(env, subId, fields, sub) {
  const { first_pi } = await paidOnSub(env, subId);
  if (!first_pi || !first_pi.id) { const e = new Error('This plan has no paid invoice to keep the team\'s notes on.'); e.type = 'no_overlay'; throw e; }
  // (not expanded: read it, so an existing overlay is never mistaken for a first write)
  const piMd = first_pi.metadata || ((await stripe(env, 'GET', `/payment_intents/${first_pi.id}`)) || {}).metadata || {};
  let md = fields;
  if (!isOverlay(piMd)) {
    // first write: carry the subscription's current keys over (the overlay replaces them all on read)
    const cur = sub || await stripe(env, 'GET', `/subscriptions/${subId}`), smd = (cur && cur.metadata) || {};
    md = { ...pickAdmin(smd), ...fields, [OVERLAY]: '1', aob_overlay_of: subId, aob_program: smd.aob_program || '', aob_ref: smd.aob_ref || '' };
  }
  return stripe(env, 'POST', `/payment_intents/${first_pi.id}`, { metadata: md });
}
/* Write the team's keys (ADMIN_KEYS; '' removes one) on a booking from findBooking / groupBookings. */
export async function saveAdminMeta(env, booking, fields) {
  if (!booking.plan) return stripe(env, 'POST', `/payment_intents/${booking.booking_pi}`, { metadata: fields });
  const subId = booking.booking_pi;
  if (booking.plan.status !== 'canceled') {
    try { return await stripe(env, 'POST', `/subscriptions/${subId}`, { metadata: fields }); }
    catch (e) {
      if (e.type !== 'invalid_request_error') throw e;
      let sub = null;
      if (!canceledSubError(e)) { sub = await stripe(env, 'GET', `/subscriptions/${subId}`); if (!sub || sub.status !== 'canceled') throw e; }
      logError('admin.overlay', { type: 'subscription_canceled' }, { subscription: subId });
      return saveOverlay(env, subId, fields, sub);
    }
  }
  return saveOverlay(env, subId, fields);
}
/* A booking's metadata read fresh from Stripe (search can lag a minute behind an update): its
   PaymentIntent, or its plan's subscription with the overlay of an ended plan. */
export async function currentBookingMeta(env, booking) {
  if (!booking.plan) return ((await stripe(env, 'GET', `/payment_intents/${booking.booking_pi}`)) || {}).metadata || {};
  const sub = await stripe(env, 'GET', `/subscriptions/${booking.booking_pi}`);
  const md = (sub && sub.metadata) || {};
  if (!sub || sub.status !== 'canceled') return md; // only an ended plan can have an overlay
  const ov = (await paidOnSub(env, sub.id)).overlay;
  return withOverlay(md, ov && ov.md);
}

const subAnchor = sub => sub.billing_cycle_anchor || sub.start_date || sub.created;
/* paid: paidOnSub() when the amounts were asked for; overlay: { id, md } of an ended plan (saveAdminMeta). */
function subRecord(sub, paid, overlay) {
  const md = withOverlay(sub.metadata || {}, overlay && overlay.md);
  const running = (sub.status === 'active' || sub.status === 'past_due') && (!sub.cancel_at || sub.current_period_end < sub.cancel_at);
  return {
    id: sub.id, sub: true, created: sub.created, customer: sub.customer, md, status: sub.status, cancel_at: sub.cancel_at || null,
    amount: paid ? paid.amount : parseInt(md.aob_due_now || '0', 10), paid_count: paid ? paid.count : 1, paid_known: !!paid, refunded: 0,
    next_payment: running ? sub.current_period_end : null, period_end: sub.current_period_end || null, anchor: subAnchor(sub),
    overlay_pi: overlay ? overlay.id : null,
  };
}
/* A plan that will take no more payments: stopped (by the team, or by Stripe after failed payments),
   past its end date, or in its last period with nothing left to invoice. Its remaining balance, if
   any, can then only be collected with a balance payment (after voiding its open invoices). */
export function planEnded(p, now = nowSec()) {
  if (!p) return false;
  if (p.status === 'canceled' || p.status === 'unpaid' || p.status === 'incomplete_expired') return true;
  if (p.cancel_at && p.cancel_at <= now) return true;
  return p.status === 'active' && !!p.cancel_at && !!p.period_end && p.cancel_at <= p.period_end;
}
/* Open invoices of a plan (a failed instalment stays payable from its invoice link): voided before a
   balance payment replaces them, so nothing can be paid twice. */
export async function voidOpenPlanInvoices(env, subId) {
  const r = await stripe(env, 'GET', '/invoices?' + qs({ subscription: subId, status: 'open', limit: 24 }));
  for (const inv of r.data || []) await stripe(env, 'POST', `/invoices/${inv.id}/void`);
  return (r.data || []).length;
}
/* A PaymentIntent that holds a place: paid, or a delayed method (bank debit) still processing.
   Paid = amount received minus refunds (latest_charge expanded). */
const COUNTS = pi => pi.status === 'succeeded' || pi.status === 'processing';
function piRecord(pi) {
  const refunded = pi.latest_charge && typeof pi.latest_charge === 'object' ? (pi.latest_charge.amount_refunded || 0) : 0;
  const ok = pi.status === 'succeeded';
  return { id: pi.id, created: pi.created, amount: ok ? Math.max(0, (pi.amount_received || 0) - refunded) : 0, refunded: ok ? refunded : 0,
    pending: pi.status === 'processing', customer: pi.customer, md: pi.metadata || {} };
}
const EXPAND_CHARGE = { 'expand[]': 'data.latest_charge' };
const RECENT_PAY_SEC = 40 * 60;  // safety net for Stripe's search lag, by PAYMENT time
const OPEN_HOLD_SEC = 35 * 60;   // guests' checkouts expire 31 minutes after creation…
const LINK_HOLD_SEC = 24 * 3600 + 600; // …admin booking links after up to 24 hours (they hold their places too)

/* Rows in order; a later row for the same id wins (lists are real time, search lags). */
async function toRecords(env, match, pis, subs, amounts) {
  const byId = new Map(), overlays = new Map();
  for (const pi of pis) {
    const md = pi.metadata || {};
    if (!match(md)) continue;
    // an ended plan's team keys on its first invoice's payment: never a payment itself
    if (isOverlay(md)) { if (md.aob_overlay_of) overlays.set(md.aob_overlay_of, { id: pi.id, md }); continue; }
    if (COUNTS(pi)) byId.set(pi.id, piRecord(pi)); else byId.delete(pi.id);
  }
  const live = new Map();
  for (const sub of subs) {
    if (!match(sub.metadata || {})) continue;
    if (LIVE_SUB(sub)) live.set(sub.id, sub); else live.delete(sub.id);
  }
  const list = [...live.values()];
  const paid = amounts ? await mapLimit(list, 4, s => paidOnSub(env, s.id).catch(() => null)) : [];
  list.forEach((sub, i) => {
    // an ended plan's overlay: paidOnSub's fresh read when there is one, else what search found
    const p = amounts ? paid[i] : null, fresh = p && p.first_pi && p.first_pi.metadata;
    const overlay = sub.status !== 'canceled' ? null : fresh ? p.overlay : overlays.get(sub.id) || null;
    byId.set(sub.id, subRecord(sub, p, overlay));
  });
  return [...byId.values()];
}
/* The real-time lists of PaymentIntents and subscriptions created in the last 40 minutes. */
export async function recentRaw(env) {
  const since = nowSec() - RECENT_PAY_SEC;
  const [pis, subs] = await Promise.all([
    listAll(env, '/payment_intents', { 'created[gte]': since, ...EXPAND_CHARGE }),
    listAll(env, '/subscriptions', { 'created[gte]': since }),
  ]);
  return { pis, subs };
}
async function collectPayments(env, match, query, { amounts = false, cap = 2000, recent } = {}) {
  const [pis, subs, rec] = await Promise.all([
    searchAll(env, query, cap, 'payment_intents', EXPAND_CHARGE),
    searchAll(env, query, cap, 'subscriptions'),
    recent || recentRaw(env),
  ]);
  return toRecords(env, match, [...pis, ...rec.pis], [...subs, ...rec.subs], amounts);
}

/* Every booking/balance/add-on payment (and every plan subscription) for a program: Stripe search,
   plus the real-time lists of PaymentIntents and subscriptions created in the last 40 minutes
   (Checkout creates the PaymentIntent when the guest pays), because search can lag. amounts: also
   total what each plan has paid so far (one call per plan). recent: recentRaw() already read (the
   overview reads it once for every week). */
export function programPayments(env, program, { amounts = false, recent } = {}) {
  return collectPayments(env, md => md.aob_program === program.id, `metadata['aob_program']:'${program.id}'`, { amounts, recent });
}
/* Only the real-time part (for the post-create race check). */
export async function recentProgramPayments(env, program) {
  const r = await recentRaw(env);
  return toRecords(env, md => md.aob_program === program.id, r.pis, r.subs, false);
}
export function mergePayments(...lists) {
  const m = new Map();
  for (const l of lists) for (const p of l || []) m.set(p.id, p);
  return [...m.values()];
}

/* When a plan stops: exactly at the end of its n-th monthly period. Stripe shortens (and prorates,
   whatever proration_behavior says) the period that contains cancel_at, so cancel_at must sit on a
   period boundary: anything inside the last period cuts the last payment down; anything after it
   starts an extra, prorated period. */
export function planEndAt(sub) {
  const n = parseInt((sub.metadata || {}).aob_plan_n || '3', 10);
  return Math.floor(addMonths(new Date(subAnchor(sub) * 1000), n).getTime() / 1000);
}
const onBoundary = (sub, t) => { const a = new Date(subAnchor(sub) * 1000); for (let k = 1; k <= 36; k++) { const b = Math.floor(addMonths(a, k).getTime() / 1000); if (b === t) return true; if (b > t) return false; } return false; };
/* For a running plan: { state, want }. 'ok' | 'missing' (no end date) | 'movable' (wrong end date that
   only touches a future period: safe to move now) | 'short' (the current period already stops at a
   wrong date, so its payment was or will be cut down: invoice the difference by hand) | 'ended'. */
export function planEndCheck(sub) {
  if (sub.status === 'canceled' || !LIVE_SUB(sub)) return { state: 'ended' };
  const want = planEndAt(sub), pe = sub.current_period_end || 0;
  if (sub.cancel_at === want) return { state: 'ok', want };
  if (!sub.cancel_at) return { state: 'missing', want };
  if (want < pe) return { state: 'short', want };                        // already billing past the last period
  if (sub.cancel_at > pe || onBoundary(sub, sub.cancel_at)) return { state: 'movable', want };
  return { state: 'short', want };
}
/* Set (or correct, when that can't change any payment) the plan's end date. Returns the subscription. */
export async function ensurePlanEnds(env, subId) {
  const sub = await stripe(env, 'GET', `/subscriptions/${subId}`);
  const c = planEndCheck(sub);
  if (c.state !== 'missing' && c.state !== 'movable') return sub;
  if (c.state === 'movable') logError('plan.end_moved', { type: 'plan_end' }, { subscription: subId });
  return stripe(env, 'POST', `/subscriptions/${subId}`, { cancel_at: c.want, proration_behavior: 'none' });
}
/* planEndCheck for a subscription record from programPayments / findBooking */
export const planEndCheckRecord = p => planEndCheck({ status: p.status, cancel_at: p.cancel_at, current_period_end: p.period_end, billing_cycle_anchor: p.anchor, metadata: p.md });
export function planDates(anchorSec, n) {
  const a = new Date(anchorSec * 1000);
  return Array.from({ length: n }, (_, k) => Math.floor(addMonths(a, k).getTime() / 1000));
}

/* ------------------------------------------------------------- occupancy */
const isBookingHold = (s, program) => !!s && s.status === 'open' && (s.metadata || {}).aob_kind === 'booking' && (s.metadata || {}).aob_program === program.id;
/* Every open Checkout Session created in the last 24 hours (+10 min), all pages. Only status=open
   rows come back, so the longer window costs little: guests' checkouts are gone after 31 minutes. */
export const openSessionsRaw = env => listAll(env, '/checkout/sessions', { status: 'open', 'created[gte]': nowSec() - LINK_HOLD_SEC });
/* Open booking Checkout Sessions (holds) for a program: guests' checkouts and admin booking links.
   rows: openSessionsRaw() already read. */
export async function openBookingSessions(env, program, rows) {
  return (rows || await openSessionsRaw(env)).filter(s => isBookingHold(s, program));
}
/* Open add-on checkouts of one booking (they hold nothing; one payable at a time). */
export async function openAddonSessions(env, ref) {
  const rows = await listAll(env, '/checkout/sessions', { status: 'open', 'created[gte]': nowSec() - OPEN_HOLD_SEC });
  return rows.filter(s => (s.metadata || {}).aob_kind === 'addon' && s.metadata.aob_ref === ref);
}

/* Places one booking takes, per room and gender (+ units for rooms not priced per person). */
function addGuests(into, md, program) {
  const per = {};
  const bump = (room, k, n) => {
    if (!room) return;
    const c = into[room] || (into[room] = { female: 0, male: 0, other: 0, units: 0 });
    c[k] += n; per[room] = (per[room] || 0) + n;
  };
  let any = false;
  for (let i = 1; i <= 12; i++) {
    const v = md[`aob_g${i}`]; if (!v) continue;
    any = true;
    const parts = v.split(' | ');
    bump(parts[3], gkey(parts[2]), 1);
  }
  if (!any) Object.entries(roomsFromString(md.aob_rooms)).forEach(([room, n]) => bump(room, 'other', n));
  for (const [room, n] of Object.entries(per)) {
    const r = program.rooms.find(x => x.id === room);
    if (r && byUnit(r)) into[room].units += Math.ceil(n / (r.sleeps || 1));
  }
  return per;
}
/* booked (paid, not cancelled) + holds (open checkouts, minus `exclude`d session ids) + per-room
   earliest hold expiry. Pure: payments and sessions come from programPayments/openBookingSessions. */
export function buildOccupancy(program, payments, sessions, exclude = []) {
  const booked = {}, holds = {}, release = {}, skip = new Set(exclude);
  for (const p of payments || []) {
    const md = p.md || {};
    if (md.aob_kind === 'booking' && md.aob_program === program.id && md.aob_status !== 'cancelled') addGuests(booked, md, program);
  }
  const open = (sessions || []).filter(s => !skip.has(s.id) && isBookingHold(s, program));
  for (const s of open) {
    const per = addGuests(holds, s.metadata || {}, program);
    for (const room of Object.keys(per)) if (s.expires_at && (!release[room] || s.expires_at < release[room])) release[room] = s.expires_at;
  }
  return { booked, holds, release, open };
}
export async function occupancy(env, program, payments, { exclude = [], open } = {}) {
  const [pays, sessions] = await Promise.all([payments || programPayments(env, program), open || openBookingSessions(env, program)]);
  return buildOccupancy(program, pays, sessions, exclude);
}

/* Availability memo per program (module scope = per isolate): 15 s TTL + single flight, so a burst
   of page polls costs one round of Stripe calls. It keeps the raw payments and open checkouts (not
   the computed answer), so each request can leave out the asking visitor's own checkout (exclude).
   Checkout clears it and always reads fresh. The last good read is also kept as a snapshot for when
   Stripe can't be reached. */
const MEMO_TTL_MS = 15000, SNAPSHOT_MAX_MS = 3600 * 1000;
const memo = new Map(), snapshots = new Map();
let memoGen = 0;
export function clearAvailabilityMemo(programId, { snapshot = false } = {}) {
  memoGen++;
  if (programId) { memo.delete(programId); if (snapshot) snapshots.delete(programId); }
  else { memo.clear(); if (snapshot) snapshots.clear(); }
}
/* { pays, open, at, cached } */
export function liveOccupancy(env, program) {
  const m = memo.get(program.id);
  if (m && m.raw && Date.now() - m.at < MEMO_TTL_MS) return Promise.resolve({ ...m.raw, at: m.at, cached: true });
  if (m && m.inflight) return m.inflight;
  const gen = memoGen, entry = { inflight: null };
  entry.inflight = Promise.all([programPayments(env, program), openBookingSessions(env, program)]).then(([pays, open]) => {
    const v = { pays, open, at: Date.now() };
    snapshots.set(program.id, v);
    if (memoGen === gen && memo.get(program.id) === entry) memo.set(program.id, { raw: { pays, open }, at: v.at });
    return v;
  }, e => { if (memo.get(program.id) === entry) memo.delete(program.id); throw e; });
  memo.set(program.id, entry);
  return entry.inflight;
}
/* { avail, at, cached }: availability without the `exclude`d checkouts (the asking visitor's own). */
export function liveAvailability(env, program, exclude = []) {
  return liveOccupancy(env, program).then(v => ({ avail: availability(program, buildOccupancy(program, v.pays, v.open, exclude)), at: v.at, cached: !!v.cached }));
}
/* The last good read ({ pays, open, at }), up to an hour old. */
export function lastSnapshot(programId) {
  const s = snapshots.get(programId);
  return s && Date.now() - s.at < SNAPSHOT_MAX_MS ? s : null;
}

/* ------------------------------------------------------------ bookings */
/* Group a program's payments into bookings with paid / balance figures.
   paid_cents is net of refunds (what we kept); the balance still to pay counts what was received
   before any refund, so a refund never becomes payable again.
   Sessions bought after booking (aob_kind addon) add what they received to the total as well as to
   what was paid, so the balance stays the accommodation balance (refunding one changes neither).
   refunded_cents: every refund (for display); refunded_booking_cents: refunds of the booking's own
   payments (booking, balance), the ones that stop an online balance payment. A refunded session
   doesn't.
   addons: every session, booking-time first (key b<n>, n = its place in aob_addons), then extras
   (key x<last 8 of the payment id>-<n>), with the team's status/when from aob_svc. The sessions of
   an extras payment refunded in full are refunded: true and cancelled; sessions_cents counts what
   the extras payments kept (received minus refunds). */
export function groupBookings(program, payments, now = nowSec()) {
  const byRef = new Map();
  for (const p of payments) {
    const ref = p.md.aob_ref; if (!ref) continue;
    const b = byRef.get(ref) || { ref, payments: [], paid_cents: 0, refunded_cents: 0, refunded_booking_cents: 0, extra_pays: [] };
    b.payments.push({ id: p.id, kind: p.md.aob_kind, amount_cents: p.amount, refunded_cents: p.refunded || 0, pending: !!p.pending, created: p.created });
    b.paid_cents += p.amount || 0;
    b.refunded_cents += p.refunded || 0;
    if (p.md.aob_kind !== 'addon') b.refunded_booking_cents += p.refunded || 0;
    if (p.md.aob_kind === 'addon') b.extra_pays.push(p);
    if (p.md.aob_kind === 'booking') {
      Object.assign(b, parseBooking(p.md, program)); b.created = p.created; b.booking_pi = p.id; b.customer = p.customer; b.pending = !!p.pending;
      if (p.sub) {
        const end = planEndCheckRecord(p);
        b.plan = { subscription: p.id, installments: parseInt(p.md.aob_plan_n || '3', 10), installment_cents: parseInt(p.md.aob_installment || '0', 10),
          paid_count: p.paid_count, paid_known: !!p.paid_known, next_payment: p.next_payment, status: p.status, cancel_at: p.cancel_at,
          period_end: p.period_end, ended: planEnded(p, now), end_check: end.state, overlay_pi: p.overlay_pi || null };
      }
    }
    byRef.set(ref, b);
  }
  return [...byRef.values()].filter(b => b.booking_pi).map(b => {
    const { extra_pays, svc, ...rest } = b;
    const extras = extra_pays.slice().sort((x, y) => (x.created - y.created) || (x.id < y.id ? -1 : 1));
    const extras_cents = extras.reduce((s, p) => s + (p.amount || 0) + (p.refunded || 0), 0);
    const extras_kept = extras.reduce((s, p) => s + (p.amount || 0), 0); // net of refunds
    const refundedInFull = p => (p.refunded || 0) > 0 && !((p.amount || 0) > 0);
    const total = b.total_cents + extras_cents;
    const guestName = i => (b.guests[i] && b.guests[i].name) || `Guest ${i + 1}`;
    const addons = [
      ...b.addons.map((a, i) => ({ ...a, key: `b${i}`, source: 'booking', payment_id: b.booking_pi, pending: b.pending })),
      ...extras.flatMap(p => parseAddons(p.md.aob_addons, program).map((a, i) => ({ ...a, key: `x${p.id.slice(-8)}-${i}`, source: 'extra', payment_id: p.id, pending: !!p.pending, created: p.created,
        ...(refundedInFull(p) ? { refunded: true } : {}) }))),
    ].map(a => ({ ...a, guest_name: guestName(a.guest), status: a.refunded ? 'cancelled' : (svc[a.key] || {}).status || 'todo', when: (svc[a.key] || {}).when || '' }));
    // payments that came in after the team cancelled the booking (e.g. a balance link already sent)
    const after = b.status === 'cancelled' && b.status_at
      ? b.payments.filter(x => (x.kind === 'balance' || x.kind === 'addon') && x.created > b.status_at).reduce((s, x) => s + (x.amount_cents || 0), 0) : 0;
    return {
      ...rest, total_cents: total, extras_cents, addons, sessions_count: addons.filter(a => a.status !== 'cancelled').length,
      sessions_cents: b.addons_cents + extras_kept,
      balance_cents: Math.max(0, total - b.paid_cents - b.refunded_cents), paid_after_cancel_cents: after,
      room_names: Object.entries(b.rooms).map(([id, n]) => `${(program.rooms.find(r => r.id === id) || { name: id }).name} × ${n}`).join(', '),
    };
  }).sort((a, b) => b.created - a.created);
}

/* Physical rooms (room.names) and who the team has put in them, over the bookings that aren't
   cancelled. → { rooming: { name: { room_id, gender|null, capacity, guests: [{ ref, index, name, gender }],
   conflict: 'mixed'|'over'|null } }, unassigned: [{ ref, index, name, gender, room }] }.
   A name holds `sleeps` people in shared and per-cottage rooms, one in rooms sold by the place.
   'mixed': women and men in a same-gender room; 'over': more people than it holds. Names a booking
   still carries but the program no longer lists show up with unknown: true. */
export const nameCapacity = r => r && (r.same_gender || byUnit(r)) ? (r.sleeps || 1) : 1;
export function roomingMap(program, bookings) {
  const rooming = {}, unassigned = [];
  for (const r of program.rooms) for (const name of r.names || []) rooming[name] = { room_id: r.id, gender: null, capacity: nameCapacity(r), guests: [], conflict: null };
  for (const b of bookings || []) {
    if (b.status === 'cancelled') continue;
    b.guests.forEach((g, i) => {
      const name = (b.assign || {})[i], who = { ref: b.ref, index: i, name: g.name, gender: g.gender };
      if (!name) { unassigned.push({ ...who, room: g.room }); return; }
      const slot = rooming[name] || (rooming[name] = { room_id: g.room, gender: null, capacity: nameCapacity(program.rooms.find(r => r.id === g.room)), guests: [], conflict: null, unknown: true });
      slot.guests.push(who);
    });
  }
  for (const slot of Object.values(rooming)) {
    const r = program.rooms.find(x => x.id === slot.room_id), kinds = new Set(slot.guests.map(g => gkey(g.gender)));
    slot.gender = kinds.size === 1 ? slot.guests[0].gender : null;
    slot.conflict = kinds.size > 1 && r && r.same_gender ? 'mixed' : slot.guests.length > slot.capacity ? 'over' : null;
  }
  return { rooming, unassigned };
}

/* One booking (and its balance payments) by reference. cached: answer from a 30 s per-isolate memo
   when there is one (lookups only; anything that takes money reads fresh). Unknown references are
   refused before any Stripe call. */
const bookingMemo = new Map(), BOOKING_MEMO_MS = 30000;
export const forgetBooking = ref => { bookingMemo.delete(ref); };
export async function findBooking(env, ref, { cached = false } = {}) {
  if (!knownRef(ref)) return null;
  if (cached) { const m = bookingMemo.get(ref); if (m && Date.now() - m.at < BOOKING_MEMO_MS) return m.v; }
  const pays = await collectPayments(env, md => md.aob_ref === ref, `metadata['aob_ref']:'${ref}'`, { amounts: true, cap: 200 });
  const first = pays.find(p => p.md.aob_kind === 'booking');
  const program = first && getProgram(first.md.aob_program);
  const [booking] = program ? groupBookings(program, pays) : [];
  const v = booking ? { program, booking } : null;
  bookingMemo.delete(ref); bookingMemo.set(ref, { v, at: Date.now() });
  while (bookingMemo.size > 500) bookingMemo.delete(bookingMemo.keys().next().value);
  return v;
}

/* Wellbeing sessions after booking: can this booking still add some? Until the last day of its
   week, unless it was cancelled or its first payment is still clearing.
   → { open, reason: null|'cancelled'|'ended'|'processing'|'unavailable', message } */
export function extrasOpen(program, booking, now = new Date()) {
  const no = (reason, message) => ({ open: false, reason, message });
  if (booking.status === 'cancelled') return no('cancelled', 'This booking has been cancelled. Message us on WhatsApp if that looks wrong.');
  if (todayIso(now) > program.dates.end) return no('ended', `${program.edition || program.title} has ended, so sessions can no longer be added.`);
  if (!serviceItems(program).length) return no('unavailable', 'Wellbeing sessions are not offered for this week.');
  if (booking.pending) return no('processing', 'Your first payment is still being processed. Please check back once it has cleared.');
  return { open: true, reason: null, message: null };
}
/* The sessions that count towards the limits (the team's cancelled ones don't) and what is left. */
export const activeAddons = booking => (booking.addons || []).filter(a => a.status !== 'cancelled');
export function addonLimitsLeft(program, existing) {
  const lim = serviceLimits(program), per = {};
  existing.forEach(a => { per[a.id] = (per[a.id] || 0) + 1; });
  return { per_booking: Math.max(0, lim.per_booking - existing.length),
    per_service: Object.fromEntries(serviceItems(program).map(s => [s.id, Math.max(0, lim.per_service - (per[s.id] || 0))])) };
}

export const programSummary = p => {
  const prog = programmeFee(p);
  return { id: p.id, title: p.title, edition: p.edition, dates: p.dates, venue: p.venue.name, currency: p.currency, program_spaces: p.program_spaces,
    programme: prog ? { name: prog.name || 'Programme fee', fee: prog.fee } : null };
};
/* What the admin needs to know about a week: rooms with their physical room names, the sessions on offer. */
export const programDetail = p => ({
  id: p.id, title: p.title, edition: p.edition, dates: p.dates, program_spaces: p.program_spaces, currency: p.currency,
  rooms: p.rooms.map(r => ({ id: r.id, name: r.name, sleeps: r.sleeps || 1, same_gender: !!r.same_gender, unit: r.unit, price: r.price,
    capacity: roomCapacity(r), names: Array.isArray(r.names) ? r.names.slice() : null })),
  services: serviceItems(p).map(s => { const i = serviceInfo(p, s.id); return { id: s.id, title: s.title, practitioner: s.practitioner, practitioner_name: i.practitioner_name, category: s.category || null, minutes: s.minutes, price: s.price }; }),
  practitioners: Object.fromEntries(Object.entries((p.services && p.services.practitioners) || {}).map(([k, v]) => [k, { name: v.name, role: v.role || '', photo: v.photo || null }])),
  booking_url: `${SITE}/book/${p.id}/`,
  deposit: { percent: (p.deposit && p.deposit.percent) || null, balance_due: (p.deposit && p.deposit.balance_due) || null, available_until: (p.deposit && p.deposit.available_until) || null },
  payment_plan: p.payment_plan ? { installments: p.payment_plan.installments || null, last_payment_by: lastPaymentBy(p) } : null,
  programme_fee: (p.programme && p.programme.fee) || 0,
  max_guests_per_booking: p.max_guests_per_booking || 6, genders: (p.genders || []).slice(),
});
/* The catalogue as the guest pages show it (no internal source note). imgBase: where the photos are. */
export function publicServices(program, imgBase) {
  if (!serviceItems(program).length) return null;
  const { source, ...pub } = program.services;
  return { ...structuredClone(pub), img_cdn: imgBase || null };
}

/* ---------------------------------------------------------- sessions */
/* Expire an open Checkout Session (frees its hold). true when it was expired. */
export const expireSession = (env, id) => stripe(env, 'POST', `/checkout/sessions/${id}/expire`).then(() => true, () => false);
/* Expire, and when that fails say why: { state: 'expired' } (by us or just before us), 'complete'
   (with the session: it was paid or is paying), 'open' (still open), or 'unknown'. */
export async function expireOrCheck(env, id) {
  if (await expireSession(env, id)) return { state: 'expired' };
  try { const s = await stripe(env, 'GET', `/checkout/sessions/${id}`); return { state: s.status, session: s }; }
  catch (e) { return { state: e.status === 404 ? 'expired' : 'unknown' }; }
}

/* 'paid' | 'processing' | 'open' | 'expired' | 'unpaid' */
export async function sessionState(env, s) {
  if (s.status === 'open') return 'open';
  if (s.status === 'expired') return 'expired';
  if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') return 'paid';
  // complete but unpaid: a delayed method (bank debit) is in flight, or it failed
  try {
    if (s.payment_intent) {
      const pi = typeof s.payment_intent === 'object' ? s.payment_intent : await stripe(env, 'GET', `/payment_intents/${s.payment_intent}`);
      return pi.status === 'succeeded' ? 'paid' : pi.status === 'processing' ? 'processing' : 'unpaid';
    }
  } catch {}
  return 'processing';
}

/* Open balance sessions for a booking (admin links live up to 24 h). */
export async function openBalanceSessions(env, ref) {
  const rows = await listAll(env, '/checkout/sessions', { status: 'open', 'created[gte]': nowSec() - 24 * 3600 });
  return rows.filter(s => (s.metadata || {}).aob_kind === 'balance' && s.metadata.aob_ref === ref);
}
/* One payable balance session per booking: reuse an open one for the same amount that still has
   `minLeftSec` to run, otherwise expire the others and create a new one. For a plan that has ended
   short, its open invoices are voided first (they would otherwise stay payable from their links). */
export async function balanceSession(env, program, booking, returnUrl, { hours = 0.52, minLeftSec = 600 } = {}) {
  if (booking.plan) await voidOpenPlanInvoices(env, booking.booking_pi);
  const open = await openBalanceSessions(env, booking.ref);
  const now = nowSec();
  const reuse = open.find(s => s.amount_total === booking.balance_cents && s.url && s.expires_at - now >= minLeftSec);
  if (reuse) return { session: reuse, reused: true };
  await Promise.all(open.map(s => expireSession(env, s.id)));
  const session = await stripe(env, 'POST', '/checkout/sessions', balanceCheckoutParams(program, booking, booking.balance_cents, returnUrl, hours));
  return { session, reused: false };
}

/* --------------------------------------------------------------- checkout
   Return / resume links: only the origin comes from the request (when it is one of ours); the path
   is always our own page, so a link in our emails or a Stripe return can't point anywhere else. */
export function pageOrigin(url, env) {
  try { const o = new URL(url).origin; return originOk(o, env) ? o : null; } catch { return null; }
}
export const bookingPageUrl = (program, page, env) => `${pageOrigin(page, env) || SITE}/book/${program.id}/`;
export const balancePageUrl = (page, env) => `${pageOrigin(page, env) || SITE}/book/balance/`;
export const extrasPageUrl = (page, env) => `${pageOrigin(page, env) || SITE}/book/extras/`;
/* Origin of a booking page URL we may link guests to (production only), else the pages.dev site. */
export function siteOrigin(page) {
  try { const o = new URL(page).origin; if (PROD_ORIGINS.includes(o)) return o; } catch {}
  return SITE;
}
const withQuery = (url, q) => url + (url.includes('?') ? '&' : '?') + q; // keeps {CHECKOUT_SESSION_ID} literal
const PM_TYPE = /^[a-z][a-z0-9_]{1,40}$/;
export function paymentMethodTypes(program, mode) {
  const l = program.payment_methods && program.payment_methods[mode === 'subscription' ? 'plan' : 'payment'];
  const out = Array.isArray(l) ? [...new Set(l.filter(x => typeof x === 'string' && PM_TYPE.test(x)))] : [];
  return out.length ? out : ['card'];
}
const descriptorSuffix = program => String(program.title || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 22) || undefined;

const sessionsText = n => `${n} wellbeing ${n === 1 ? 'session' : 'sessions'}`;
/* The dated schedule and the policy line shown above Stripe's pay button (≤ 1200 characters). */
export function scheduleText(program, q, now = new Date()) {
  const prog = programmeFee(program), pct = program.deposit && program.deposit.percent;
  const due = (program.deposit && program.deposit.balance_due) ? `by ${dayMonth(program.deposit.balance_due)}` : `before you arrive on ${dayMonth(program.dates.start)}`;
  const n = (q.addons || []).length;
  let s;
  if (q.payment === 'plan' && q.plan) {
    const p = q.plan, later = planDates(Math.floor(now.getTime() / 1000), p.installments).slice(1).map(t => dayMonth(t));
    s = `${p.installments} monthly payments: ${eur(p.first_cents)} today, then ${eur(p.installment_cents)} on ${andList(later)}, charged automatically to the same card.`;
  } else if (q.balance_cents > 0) {
    const what = [q.programme_cents && prog ? prog.name.toLowerCase() : null, n ? (n === 1 ? 'session' : 'sessions') : null, `${pct}% room deposit`].filter(Boolean).join(' + ');
    s = `Today ${eur(q.due_now_cents)} (${what}). Then ${eur(q.balance_cents)} ${due}.`;
  } else {
    s = `Today ${eur(q.due_now_cents)}: ${q.programme_cents && prog ? `${prog.name.toLowerCase()}, room and meals` : 'room and meals'}, paid in full.`;
  }
  const incl = [n ? sessionsText(n) : null, q.discount ? `${eur(q.discount.cents)} off (${q.discount.reason})` : null].filter(Boolean);
  if (incl.length) s += ` Includes ${incl.join(' and ')}.`;
  if (program.policy) {
    s += n ? ` Payments are non-refundable unless we cancel ${program.title} (a wellbeing session that can't be scheduled is refunded); see the ${program.title} terms.`
      : ` Payments are non-refundable unless we cancel ${program.title}; see the ${program.title} terms.`;
  }
  return s.slice(0, 1200);
}

/* How long a checkout stays open: guests 31 minutes; admin links up to 24 hours (Stripe's limit). */
const expiresAt = (now, hours) => Math.floor(now.getTime() / 1000) + (hours ? Math.max(31 * 60, Math.min(24 * 3600 - 60, Math.round(hours * 3600))) : 31 * 60);
const SESSION_LINE_NOTE = 'Arranged with you by ASHA Reception.';
/* One receipt line per session type. A line a discount touches keeps quantity × unit when that
   stays whole cents, else becomes one line of "n × …"; free lines are left out. */
function sessionItems(q, ref, cur, label) {
  const out = [];
  for (const l of q.addon_lines || []) {
    const net = l.net_cents == null ? l.amount_cents : l.net_cents;
    if (net <= 0) continue;
    const even = net % l.count === 0;
    const name = `${even ? '' : `${l.count} × `}Wellbeing session · ${l.practitioner_name}: ${l.title} (${l.minutes} min)${l.discount_cents ? ` · ${label}` : ''}`;
    out.push({ quantity: even ? l.count : 1, price_data: { currency: cur, unit_amount: even ? net / l.count : net,
      product_data: { name: cut(name, 250), description: `Booking ${ref}. ${SESSION_LINE_NOTE}` } } });
  }
  return out;
}

/* Checkout Session params. embedded: the payment form inside our page (ui_mode 'embedded' on API
   2024-06-20; success_url/cancel_url are not allowed there, return_url is used only by redirect
   methods). hosted: Stripe's own page with success/cancel URLs.
   hours: how long it stays open (admin links: 23.9). consent: the guest ticks the terms on Stripe's
   page (admin links; dropped by safeCreateSession if the account has no terms URL set).
   Payment mode: one receipt line for the programme fee, one per session type, one for the
   accommodation (in full, or its deposit); together exactly the amount due today. */
export function bookingCheckoutParams(program, q, ref, md, returnUrl, { embedded = false, now = new Date(), hours = 0, consent = false } = {}) {
  const title = `${program.title}, ${program.dates.short}`;
  const rooms = q.lines.map(l => `${l.name} × ${l.guests}`).join(', ');
  const prog = programmeFee(program), n = q.guests.length, ns = (q.addons || []).length;
  let progText = q.programme === 'included' ? `${prog.name} for ${n} ${n === 1 ? 'guest' : 'guests'} and accommodation: ${rooms}`
    : q.programme === 'paid' ? `Accommodation: ${rooms} (${prog.name.toLowerCase()} already paid)` : rooms;
  if (ns) progText += `, and ${sessionsText(ns)}`;
  const cur = program.currency.toLowerCase();
  const ui = embedded
    ? { ui_mode: 'embedded', redirect_on_completion: 'if_required', return_url: withQuery(returnUrl, 'status=success&session_id={CHECKOUT_SESSION_ID}') }
    : { success_url: withQuery(returnUrl, 'status=success&session_id={CHECKOUT_SESSION_ID}'), cancel_url: withQuery(returnUrl, `status=cancelled&ref=${encodeURIComponent(ref)}`) };
  const custom_text = { submit: { message: scheduleText(program, q, now) } };
  const terms = consent && program.terms_url ? { consent_collection: { terms_of_service: 'required' } } : {};
  if (terms.consent_collection) custom_text.terms_of_service_acceptance = { message: `I agree to the [${program.title} terms](${program.terms_url}).` };
  const expires_at = expiresAt(now, hours);
  const { aob_iph, ...keep } = md; // the visitor hash only matters while the checkout is open
  if (q.payment === 'plan') {
    const p = q.plan;
    const items = [{ quantity: 1, price_data: { currency: cur, unit_amount: p.installment_cents, recurring: { interval: 'month', interval_count: 1 },
      product_data: { name: `${title} · ${p.installments} monthly payments`, description: `${progText}. Booking ${ref}.`.slice(0, 500) } } }];
    if (p.first_cents > p.installment_cents) items.push({ quantity: 1, price_data: { currency: cur, unit_amount: p.first_cents - p.installment_cents, product_data: { name: 'Rounding on the first payment' } } });
    return {
      mode: 'subscription', ...ui, payment_method_types: paymentMethodTypes(program, 'subscription'), locale: 'auto',
      customer_email: q.guests[0].email, client_reference_id: ref,
      line_items: items, metadata: md,
      subscription_data: { metadata: keep, description: `${title} · ${ref} · ${p.installments} monthly payments of ${eur(p.installment_cents)}${ns ? ` · includes ${sessionsText(ns)}` : ''}`.slice(0, 500) },
      ...terms, custom_text, expires_at,
    };
  }
  const d = q.discount, label = d ? discountLabel(d) : '';
  const named = (base, off) => cut(off ? `${base} · ${label} · ${title}` : `${base} · ${title}`, 250);
  const items = [];
  if (q.programme_cents > 0) {
    // n × the fee, or after a discount n × the reduced fee when that stays whole cents, else one line
    const even = q.programme_cents % n === 0;
    items.push({ quantity: even ? n : 1, price_data: { currency: cur, unit_amount: even ? q.programme_cents / n : q.programme_cents,
      product_data: { name: named(prog.name, !!(d && d.programme_cents)), description: `Booking ${ref}. ${even ? 'Per guest.' : `${n} guests.`}` } } });
  }
  items.push(...sessionItems(q, ref, cur, label));
  const stay = q.due_now_cents - q.programme_cents - (q.addons_cents || 0);
  if (stay > 0) items.push({ quantity: 1, price_data: { currency: cur, unit_amount: stay, product_data: {
    name: named(q.payment === 'full' ? 'Accommodation and meals' : `${program.deposit.percent}% accommodation deposit`, !!(d && d.accommodation_cents)),
    description: `${rooms}. Booking ${ref}.`.slice(0, 500) } } });
  const desc = `${progText}. Booking ${ref}.` + (q.balance_cents ? ` Accommodation balance ${eur(q.balance_cents)} to pay before arrival.` : ' Paid in full.')
    + (d ? ` Includes ${eur(d.cents)} off (${d.reason}).` : '');
  const lead = q.guests[0];
  return {
    mode: 'payment', ...ui, payment_method_types: paymentMethodTypes(program, 'payment'), locale: 'auto', submit_type: 'book',
    customer_email: lead.email, customer_creation: 'always', client_reference_id: ref,
    line_items: items,
    metadata: md,
    payment_intent_data: { metadata: keep, description: `${title} · ${ref} · ${progText}`.slice(0, 1000), receipt_email: lead.email,
      statement_descriptor_suffix: descriptorSuffix(program) },
    invoice_creation: { enabled: true, invoice_data: { description: desc.slice(0, 1500), metadata: { aob_ref: ref, aob_program: program.id } } },
    ...terms, custom_text, expires_at,
  };
}

/* Wellbeing sessions added to an existing booking ("extras"): a one-off payment with its own receipt.
   list: checked sessions ([{ id, guest, … }]); md: addonMetadata(). */
export function addonMetadata(program, booking, list, ui) {
  return {
    aob_kind: 'addon', aob_program: program.id, aob_ref: booking.ref, aob_addons: addonsToString(list),
    aob_addons_total: String(list.reduce((s, a) => s + a.price_cents, 0)),
    aob_lead_email: booking.lead.email || '', aob_lead_name: cut(booking.lead.name || '', 120), aob_ui: ui === 'embedded' ? 'embedded' : 'hosted',
  };
}
export function addonCheckoutParams(program, booking, list, md, returnUrl, { embedded = false, now = new Date() } = {}) {
  const ref = booking.ref, title = `${program.title}, ${program.dates.short}`, cur = program.currency.toLowerCase();
  const total = list.reduce((s, a) => s + a.price_cents, 0), n = list.length;
  const ui = embedded
    ? { ui_mode: 'embedded', redirect_on_completion: 'if_required', return_url: withQuery(returnUrl, 'status=success&session_id={CHECKOUT_SESSION_ID}') }
    : { success_url: withQuery(returnUrl, 'status=success&session_id={CHECKOUT_SESSION_ID}'), cancel_url: withQuery(returnUrl, `status=cancelled&ref=${encodeURIComponent(ref)}`) };
  const note = (program.services && program.services.note) || SESSION_LINE_NOTE;
  const p = {
    mode: 'payment', ...ui, payment_method_types: paymentMethodTypes(program, 'payment'), locale: 'auto', submit_type: 'pay',
    client_reference_id: ref,
    line_items: sessionItems({ addon_lines: addonLinesOf(list) }, ref, cur, ''),
    metadata: md,
    payment_intent_data: { metadata: md, description: `${title} · ${ref} · ${sessionsText(n)}`.slice(0, 1000), receipt_email: booking.lead.email || undefined,
      statement_descriptor_suffix: descriptorSuffix(program) },
    invoice_creation: { enabled: true, invoice_data: { description: `${sessionsText(n)} for booking ${ref} (${title}).`.slice(0, 1500), metadata: { aob_ref: ref, aob_program: program.id } } },
    custom_text: { submit: { message: `Today ${eur(total)} for ${sessionsText(n)} during ${program.edition || program.title}. ${note}`.slice(0, 1200) } },
    expires_at: expiresAt(now, 0),
  };
  if (booking.customer) p.customer = booking.customer; else p.customer_email = booking.lead.email;
  return p;
}

/* Create a Checkout Session; when Stripe refuses an optional setting (a payment method that isn't
   activated, the statement descriptor suffix, submit_type, collecting terms consent without a terms
   URL in the account), drop/downgrade it and retry once per setting. Returns { session, dropped: [params] }. */
const DOWNGRADES = [
  { match: p => /^payment_method_types/.test(p), fix: x => { if (x.payment_method_types && x.payment_method_types.join() === 'card') return false; x.payment_method_types = ['card']; return true; } },
  { match: p => /statement_descriptor_suffix/.test(p), fix: x => { if (!x.payment_intent_data || !x.payment_intent_data.statement_descriptor_suffix) return false; delete x.payment_intent_data.statement_descriptor_suffix; return true; } },
  { match: p => p === 'submit_type', fix: x => { if (!x.submit_type) return false; delete x.submit_type; return true; } },
  // the account has no terms URL in its public details (Stripe may not name a param for this one)
  { match: (p, m) => /^consent_collection/.test(p) || /^custom_text\[terms_of_service_acceptance\]/.test(p) || (!p && /terms of service/i.test(m)),
    fix: x => { if (!x.consent_collection) return false; delete x.consent_collection; if (x.custom_text) delete x.custom_text.terms_of_service_acceptance; return true; } },
];
export async function safeCreateSession(env, params) {
  const p = structuredClone(params), used = new Set(), dropped = [];
  for (;;) {
    try { return { session: await stripe(env, 'POST', '/checkout/sessions', p), dropped }; }
    catch (e) {
      if (e.type !== 'invalid_request_error') throw e;
      const i = DOWNGRADES.findIndex(d => d.match(e.param || '', e.message || ''));
      if (i < 0 || used.has(i) || !DOWNGRADES[i].fix(p)) throw e;
      used.add(i); dropped.push(e.param || 'consent_collection');
      logError('checkout.downgrade', e);
    }
  }
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
    expires_at: nowSec() + Math.max(31 * 60, Math.min(24 * 3600 - 60, Math.round(hours * 3600))),
    success_url: withQuery(returnUrl, `status=paid&ref=${encodeURIComponent(booking.ref)}&session_id={CHECKOUT_SESSION_ID}`),
    cancel_url: withQuery(returnUrl, `ref=${encodeURIComponent(booking.ref)}`),
  };
  if (booking.customer) p.customer = booking.customer; else p.customer_email = booking.lead.email;
  return p;
}

/* ------------------------------------------------- programme verification
   Room-only bookings ("programme already paid"): best effort, never blocks, and only ever a
   "possible match" for the team to confirm. Earlier programme-fee payments of the lead's Stripe
   customer(s) (exact email): succeeded, in the program currency, not one of our own bookings, made
   in the year before this edition starts, and, after refunds, a whole number of fees. A booking is
   marked 'stripe' only when payments no other room-only booking has used cover every guest; the
   payments used are stored on the booking (aob_prog_pi). */
export async function programmeFeePayments(env, program, email) {
  const prog = programmeFee(program);
  if (!prog || !validEmail(email)) return [];
  const o = { retries: 0, timeoutMs: 4000 };
  try {
    const want = email.toLowerCase();
    const q = `email:'${email.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    const cs = await stripe(env, 'GET', '/customers/search?' + qs({ query: q, limit: 10 }), null, o);
    const custs = (cs.data || []).filter(c => String(c.email || '').toLowerCase() === want).slice(0, 5);
    const start = Math.floor(Date.parse(program.dates.start + 'T00:00:00Z') / 1000);
    const since = Math.max(nowSec() - 400 * 86400, start - 365 * 86400), unit = prog.fee * 100, cur = program.currency.toLowerCase();
    const lists = await Promise.all(custs.map(c =>
      stripe(env, 'GET', '/payment_intents?' + qs({ customer: c.id, 'created[gte]': since, limit: 100, ...EXPAND_CHARGE }), null, o).catch(() => ({ data: [] }))));
    const out = [];
    for (const l of lists) for (const pi of l.data || []) {
      if (pi.status !== 'succeeded' || pi.currency !== cur || (pi.metadata || {}).aob_kind || isOverlay(pi.metadata) || pi.created < since) continue;
      if (!pi.latest_charge || typeof pi.latest_charge !== 'object') continue; // refunds unknown: don't count it
      const net = (pi.amount_received || 0) - (pi.latest_charge.amount_refunded || 0);
      if (net > 0 && net % unit === 0) out.push({ id: pi.id, cents: net, fees: net / unit, created: pi.created });
    }
    return out.sort((a, b) => a.created - b.created);
  } catch (e) { logError('programme.verify', e); return []; }
}
/* Fee payments already used by another room-only booking (paid, or in an open checkout other than
   the `exclude`d ones being replaced). Cancelled bookings give theirs back. */
export function claimedProgrammePayments(payments, sessions, exclude = []) {
  const skip = new Set(exclude), out = new Set();
  const add = md => {
    if (!md || md.aob_kind !== 'booking' || md.aob_prog !== 'paid' || md.aob_status === 'cancelled') return;
    String(md.aob_prog_pi || '').split(',').forEach(x => { const id = x.split(':')[0]; if (id) out.add(id); });
  };
  (payments || []).forEach(p => add(p.md));
  (sessions || []).forEach(s => { if (!skip.has(s.id)) add(s.metadata); });
  return out;
}
/* { status: 'stripe' | 'unverified', pis: [{ id, cents }] } */
export function matchProgramme(feePays, guests, claimed = new Set()) {
  const used = []; let fees = 0;
  for (const p of feePays || []) {
    if (fees >= guests) break;
    if (claimed.has(p.id)) continue;
    used.push({ id: p.id, cents: p.cents }); fees += p.fees;
  }
  return fees >= guests && used.length ? { status: 'stripe', pis: used } : { status: 'unverified', pis: [] };
}

/* ------------------------------------------------- payment method domains
   Wallets (Apple Pay, Google Pay, Link) in embedded Checkout need every page host registered. */
const domainSeen = new Set();
const pmStatus = x => (x && x.status) || null;
export const domainInfo = d => ({ domain: d.domain_name, registered: true, enabled: d.enabled !== false,
  apple_pay: pmStatus(d.apple_pay), google_pay: pmStatus(d.google_pay), link: pmStatus(d.link), paypal: pmStatus(d.paypal) });
export async function ensurePaymentMethodDomain(env, host) {
  const r = await stripe(env, 'GET', '/payment_method_domains?' + qs({ domain_name: host, limit: 1 }));
  if (r.data && r.data.length) return { ...domainInfo(r.data[0]), created: false };
  return { ...domainInfo(await stripe(env, 'POST', '/payment_method_domains', { domain_name: host })), created: true };
}
/* Fire-and-forget, once per isolate per production host. Never affects the checkout. */
export function autoRegisterDomain(env, request, waitUntil) {
  let host;
  try { host = new URL(request.headers.get('Origin') || '').host; } catch { return null; }
  if (!PROD_HOSTS.includes(host) || domainSeen.has(host)) return null;
  domainSeen.add(host);
  const p = ensurePaymentMethodDomain(env, host).catch(e => { domainSeen.delete(host); logError('domains.auto', e); });
  if (typeof waitUntil === 'function') { try { waitUntil(p); } catch {} }
  return p;
}
/* The production hosts first (registered or not), then any other registered domains. */
export async function listDomains(env) {
  const rows = await listAll(env, '/payment_method_domains', {}, { maxPages: 3 });
  const info = rows.map(domainInfo);
  const out = PROD_HOSTS.map(h => info.find(d => d.domain === h) || { domain: h, registered: false, enabled: false, apple_pay: null, google_pay: null, link: null, paypal: null });
  return out.concat(info.filter(d => !PROD_HOSTS.includes(d.domain)));
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
