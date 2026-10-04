// End-to-end tests for the booking functions against an in-memory Stripe mock.
//   node tools/booking/test.mjs
import * as health from '../../functions/api/booking/health.js';
import * as avail from '../../functions/api/booking/availability.js';
import * as checkout from '../../functions/api/booking/checkout.js';
import * as session from '../../functions/api/booking/session.js';
import * as balance from '../../functions/api/booking/balance.js';
import * as admin from '../../functions/api/booking/admin.js';
import * as webhook from '../../functions/api/booking/webhook.js';
import * as release from '../../functions/api/booking/release.js';
import * as lead from '../../functions/api/booking/lead.js';
import { readFileSync } from 'node:fs';
import { verifyStripeSignature, clearAvailabilityMemo, stripeConfig, getProgram, bookingPageUrl, balancePageUrl, addMonths, ipKey, planEndAt } from '../../booking-lib/core.js';

stripeConfig.retryBaseMs = 1; // keep retries fast

/* ---------- clock: 1 July 2026, so all 3 plan payments fit before the October arrival ---------- */
const RealDate = Date;
let fakeNow = RealDate.parse('2026-07-01T09:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [fakeNow])); }
  static now() { return fakeNow; }
};
const tick = sec => { fakeNow += sec * 1000; };
const nowS = () => Math.floor(fakeNow / 1000);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } };
const P = 'breathcamp-oct-2026', ORIGIN = 'https://alchemyofbreath.com';
const PROG = getProgram(P);

/* failure logs are expected in several tests: keep them, check they carry no personal data */
const logs = [];
console.error = (...a) => { logs.push(a.map(String).join(' ')); };

/* ---------- Stripe mock ---------- */
const store = {
  sessions: new Map(), pis: new Map(), subs: new Map(), invoices: [], customers: [], domains: new Map(),
  ghl: [], ghlAttempts: 0, ghlStatus: 200, turnstile: [], turnstileDown: false,
  idem: new Map(), calls: [], faults: [], disabledPM: new Set(), rejectParams: new Set(), badEmails: new Set(),
  onCreate: null, onList: null, waits: [], seq: 0, latency: 0, turnstileReply: null,
};
function reset(at = '2026-07-01T09:00:00Z') {
  store.sessions.clear(); store.pis.clear(); store.subs.clear(); store.invoices.length = 0; store.customers.length = 0; store.domains.clear();
  store.ghl.length = 0; store.ghlAttempts = 0; store.ghlStatus = 200; store.turnstile.length = 0; store.turnstileDown = false;
  store.faults.length = 0; store.disabledPM.clear(); store.rejectParams.clear(); store.badEmails.clear(); store.onCreate = null; store.onList = null;
  store.latency = 0; store.turnstileReply = null;
  fakeNow = RealDate.parse(at);
  clearAvailabilityMemo(undefined, { snapshot: true });
}
const pad = n => String(n).padStart(6, '0');
function parseForm(body) {
  const out = {};
  if (!body) return out;
  for (const pair of body.split('&')) {
    const [k, v] = pair.split('=').map(decodeURIComponent);
    const keys = k.replace(/\]/g, '').split('[');
    let o = out;
    keys.forEach((key, i) => { if (i === keys.length - 1) o[key] = v; else o = (o[key] ??= {}); });
  }
  return out;
}
const arr = o => o == null ? [] : Array.isArray(o) ? o : Object.keys(o).sort((a, b) => a - b).map(k => o[k]);
const getPath = (o, p) => p.replace(/\]/g, '').split('[').reduce((x, k) => x == null ? undefined : x[k], o);
function page(list, u) {
  let rows = list.slice().sort((a, b) => (b.created - a.created) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const gte = u.searchParams.get('created[gte]'); if (gte) rows = rows.filter(x => x.created >= +gte);
  const after = u.searchParams.get('starting_after');
  if (after) { const i = rows.findIndex(x => x.id === after); rows = i >= 0 ? rows.slice(i + 1) : []; }
  const limit = Math.min(100, +(u.searchParams.get('limit') || 10));
  return { object: 'list', data: rows.slice(0, limit), has_more: rows.length > limit };
}
const J = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Request-Id': 'req_mock' + pad(++store.seq), ...h } });
const E = (status, type, message, param, code) => J({ error: { type, message, param, code } }, status);
const charged = (pi, u) => ({ ...pi, latest_charge: u.searchParams.getAll('expand[]').includes('data.latest_charge') ? { id: 'ch_' + pi.id, amount_refunded: pi._refunded || 0 } : 'ch_' + pi.id });
const metaConds = q => [...q.matchAll(/metadata\['(\w+)'\]:'([^']+)'/g)].map(m => [m[1], m[2]]);

async function stripeMock(method, path, u, init) {
  const b = parseForm(init.body ? String(init.body) : '');
  let m;
  if (method === 'POST' && path === '/checkout/sessions') {
    const embedded = b.ui_mode === 'embedded';
    if (embedded && (b.success_url || b.cancel_url)) return E(400, 'invalid_request_error', 'success_url and cancel_url are not allowed with ui_mode embedded', b.success_url ? 'success_url' : 'cancel_url');
    if (embedded && !b.return_url) return E(400, 'invalid_request_error', 'return_url is required', 'return_url');
    if (!embedded && !b.success_url) return E(400, 'invalid_request_error', 'success_url is required', 'success_url');
    const off = arr(b.payment_method_types).find(t => store.disabledPM.has(t));
    if (off) return E(400, 'invalid_request_error', `The payment method type "${off}" is invalid. Please ensure the provided type is activated in your dashboard.`, 'payment_method_types');
    for (const p of store.rejectParams) if (getPath(b, p) !== undefined) return E(400, 'invalid_request_error', `mock refuses ${p}`, p);
    if (store.badEmails.has(b.customer_email)) return E(400, 'invalid_request_error', `Invalid email address: ${b.customer_email}`, 'customer_email', 'email_invalid');
    const id = `cs_test_mock${pad(++store.seq)}abcdef`;
    const items = arr(b.line_items);
    const total = items.reduce((a, li) => a + (+li.price_data.unit_amount) * (+li.quantity || 1), 0);
    const s = { id, object: 'checkout.session', mode: b.mode || 'payment', ui_mode: embedded ? 'embedded' : 'hosted', subscription: null, status: 'open', payment_status: 'unpaid',
      metadata: b.metadata || {}, amount_total: total, currency: items[0].price_data.currency, created: nowS(), customer: b.customer || null, customer_email: b.customer_email || null,
      url: embedded ? null : `https://checkout.stripe.com/c/pay/${id}`, client_secret: embedded ? `${id}_secret_mock` : null,
      payment_intent: null, expires_at: +b.expires_at, _params: b };
    store.sessions.set(id, s);
    if (store.onCreate) store.onCreate(s);
    return J(s);
  }
  if (method === 'GET' && path === '/checkout/sessions') {
    const st = u.searchParams.get('status');
    const res = J(page([...store.sessions.values()].filter(s => !st || s.status === st), u));
    if (store.onList) { const f = store.onList; store.onList = null; f(); } // something changes right after the list was read
    return res;
  }
  if (method === 'POST' && (m = path.match(/^\/checkout\/sessions\/(cs_\w+)\/expire$/))) {
    const s = store.sessions.get(m[1]);
    if (!s) return E(404, 'invalid_request_error', 'No such checkout.session', 'session', 'resource_missing');
    if (s.status !== 'open') return E(400, 'invalid_request_error', 'Only Checkout Sessions with a status of open can be expired.');
    s.status = 'expired'; return J(s);
  }
  if (method === 'GET' && (m = path.match(/^\/checkout\/sessions\/(cs_\w+)$/))) {
    const s = store.sessions.get(m[1]); return s ? J(s) : E(404, 'invalid_request_error', 'No such checkout.session', 'session', 'resource_missing');
  }
  if (method === 'GET' && path === '/payment_intents/search') {
    const q = u.searchParams.get('query'), conds = metaConds(q), st = (q.match(/status:'(\w+)'/) || [])[1];
    const data = [...store.pis.values()].filter(pi => !pi._lagging && (!st || pi.status === st) && conds.every(([k, v]) => pi.metadata[k] === v)).map(pi => charged(pi, u));
    return J({ data, has_more: false, next_page: null });
  }
  if (method === 'GET' && path === '/payment_intents') {
    const cus = u.searchParams.get('customer');
    const r = page([...store.pis.values()].filter(pi => !cus || pi.customer === cus), u);
    r.data = r.data.map(pi => charged(pi, u)); return J(r);
  }
  if ((m = path.match(/^\/payment_intents\/(pi_\w+)$/))) {
    const pi = store.pis.get(m[1]);
    if (!pi) return E(404, 'invalid_request_error', 'No such payment_intent', 'intent', 'resource_missing');
    if (method === 'POST') Object.assign(pi.metadata, b.metadata || {});
    return J(pi);
  }
  if (method === 'GET' && path === '/subscriptions/search') {
    const conds = metaConds(u.searchParams.get('query'));
    return J({ data: [...store.subs.values()].filter(x => !x._lagging && conds.every(([k, v]) => x.metadata[k] === v)), has_more: false, next_page: null });
  }
  if (method === 'GET' && path === '/subscriptions') return J(page([...store.subs.values()].filter(x => x.status !== 'canceled'), u));
  if ((m = path.match(/^\/subscriptions\/(sub_\w+)$/))) {
    const sub = store.subs.get(m[1]);
    if (!sub) return E(404, 'invalid_request_error', 'No such subscription', 'id', 'resource_missing');
    if (method === 'GET') return J(sub);
    if (method === 'DELETE') { sub.status = 'canceled'; return J(sub); }
    if (method === 'POST') {
      // Stripe still takes metadata (and cancellation details) on a canceled subscription, nothing else
      if (sub.status === 'canceled' && b.cancel_at) return E(400, 'invalid_request_error', 'You cannot update a canceled subscription.');
      if (b.metadata) Object.assign(sub.metadata, b.metadata);
      if (b.cancel_at) { sub.cancel_at = +b.cancel_at; sub._proration = b.proration_behavior; }
      return J(sub);
    }
  }
  if (method === 'GET' && path === '/invoices') {
    const sid = u.searchParams.get('subscription'), st = u.searchParams.get('status');
    return J({ data: store.invoices.filter(i => i.subscription === sid && (!st || i.status === st)), has_more: false });
  }
  if (method === 'POST' && (m = path.match(/^\/invoices\/(in_\w+)\/void$/))) {
    const inv = store.invoices.find(i => i.id === m[1]);
    if (!inv || inv.status !== 'open') return E(400, 'invalid_request_error', 'You can only void open invoices.');
    inv.status = 'void'; return J(inv);
  }
  if (method === 'GET' && path === '/customers/search') {
    const email = (u.searchParams.get('query').match(/^email:'(.*)'$/) || [])[1];
    return J({ data: store.customers.filter(c => c.email === email), has_more: false });
  }
  if (path === '/payment_method_domains') {
    if (method === 'GET') { const dn = u.searchParams.get('domain_name'); return J(page([...store.domains.values()].filter(d => !dn || d.domain_name === dn), u)); }
    if (method === 'POST') {
      if ([...store.domains.values()].some(d => d.domain_name === b.domain_name)) return E(400, 'invalid_request_error', 'Domain already exists', 'domain_name');
      const id = 'pmd_' + pad(++store.seq);
      const d = { id, object: 'payment_method_domain', domain_name: b.domain_name, enabled: true, created: nowS(),
        apple_pay: { status: 'active' }, google_pay: { status: 'active' }, link: { status: 'active' }, paypal: { status: 'inactive' } };
      store.domains.set(id, d); return J(d);
    }
  }
  return E(400, 'invalid_request_error', 'mock: unhandled ' + method + ' ' + path);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://ghl.example/')) {
    store.ghlAttempts++;
    if (store.ghlStatus >= 300) return new Response('nope', { status: store.ghlStatus });
    store.ghl.push(JSON.parse(init.body)); return new Response('ok');
  }
  if (url.startsWith('https://challenges.cloudflare.com/')) {
    const f = new URLSearchParams(String(init.body));
    store.turnstile.push(Object.fromEntries(f));
    if (store.turnstileDown) return new Response('down', { status: 500 });
    if (store.turnstileReply) return new Response(JSON.stringify(store.turnstileReply.body), { status: store.turnstileReply.status });
    const good = f.get('response') === 'good-token';
    return new Response(JSON.stringify(good ? { success: true, hostname: 'alchemyofbreath.com', action: 'booking' } : { success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 });
  }
  if (!url.startsWith('https://api.stripe.com/v1')) return realFetch(url, init);
  const u = new URL(url), path = u.pathname.replace('/v1', ''), method = init.method || 'GET';
  const key = (init.headers || {})['Idempotency-Key'];
  store.calls.push({ method, path, key });
  if (store.latency) await new Promise(r => setTimeout(r, store.latency));
  const f = store.faults.find(x => (!x.method || x.method === method) && x.path.test(path) && x.times > 0);
  if (f && !f.after) {
    f.times--;
    if (f.network) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ error: { type: 'api_error', message: 'mock fault' } }),
      { status: f.status, headers: f.shouldRetry != null ? { 'Stripe-Should-Retry': String(f.shouldRetry) } : {} });
  }
  if (method === 'POST' && key && store.idem.has(key)) { // Stripe replays the first answer for a repeated key
    const c = store.idem.get(key);
    if (c.body !== String(init.body || '')) return E(400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters they were first used with.');
    return new Response(c.text, { status: c.status, headers: { 'Content-Type': 'application/json' } });
  }
  const res = await stripeMock(method, path, u, init);
  if (method === 'POST' && key) store.idem.set(key, { body: String(init.body || ''), status: res.status, text: await res.clone().text() });
  if (f && f.after) { f.times--; throw new TypeError('connection lost after the request reached Stripe'); }
  return res;
};
const fault = (method, path, opts) => store.faults.push({ method, path, times: 1, status: 500, ...opts });
const stripeCalls = (method, re) => store.calls.filter(c => c.method === method && re.test(c.path)).length;

/* Stripe marks a session paid (or processing, for bank debits). The PaymentIntent is created at payment time. */
function complete(sessionId, { lagging = false, pi = 'succeeded' } = {}) {
  const s = store.sessions.get(sessionId), now = nowS();
  s.customer_details = { email: s.customer_email };
  if (s.mode === 'subscription') {
    const id = `sub_mock${pad(++store.seq)}`;
    s.status = 'complete'; s.payment_status = 'paid'; s.subscription = id; s.customer = s.customer || 'cus_mock2';
    const items = arr(s._params.line_items), md = (s._params.subscription_data && s._params.subscription_data.metadata) || s.metadata;
    store.subs.set(id, { id, status: 'active', metadata: { ...md }, billing_cycle_anchor: now, start_date: now, created: now,
      current_period_end: Math.floor(addMonths(new Date(now * 1000), 1).getTime() / 1000), cancel_at: null, customer: s.customer, _lagging: lagging,
      _inst: +items[0].price_data.unit_amount, _periods: 1 });
    store.invoices.push({ id: 'in_mock' + pad(++store.seq), subscription: id, status: 'paid', amount_paid: s.amount_total, billing_reason: 'subscription_create' });
    return id;
  }
  const id = `pi_mock${pad(++store.seq)}`;
  s.status = 'complete'; s.payment_status = pi === 'succeeded' ? 'paid' : 'unpaid'; s.payment_intent = id; s.customer = s.customer || 'cus_mock1';
  const md = (s._params.payment_intent_data && s._params.payment_intent_data.metadata) || s.metadata;
  store.pis.set(id, { id, object: 'payment_intent', status: pi, amount: s.amount_total, amount_received: pi === 'succeeded' ? s.amount_total : 0, currency: s.currency,
    created: now, customer: s.customer, metadata: { ...md }, _lagging: lagging, _refunded: 0 });
  return id;
}
/* Stripe's monthly renewals up to `until` (unix seconds). Periods are counted from the anchor; the
   period that contains cancel_at is cut short there and its invoice prorated (Stripe does this whatever
   proration_behavior says); at cancel_at the subscription is canceled. fail: the k-th renewal's payment
   fails (invoice left open, subscription past_due). */
function renew(subId, until, { fail = 0 } = {}) {
  const sub = store.subs.get(subId), a = new Date(sub.billing_cycle_anchor * 1000), at = k => Math.floor(addMonths(a, k).getTime() / 1000);
  for (;;) {
    const start = sub.current_period_end;
    if (sub.status === 'canceled' || start > until) break;
    if (sub.cancel_at && start >= sub.cancel_at) { sub.status = 'canceled'; break; }
    const k = sub._periods, natural = at(k + 1), end = sub.cancel_at ? Math.min(natural, sub.cancel_at) : natural;
    const amount = Math.round(sub._inst * (end - start) / (natural - start));
    sub._periods++; sub.current_period_end = end;
    const failed = fail && sub._periods === fail;
    store.invoices.push({ id: 'in_mock' + pad(++store.seq), subscription: subId, status: failed ? 'open' : 'paid', amount_paid: failed ? 0 : amount, amount_due: amount, billing_reason: 'subscription_cycle' });
    if (failed) { sub.status = 'past_due'; break; }
  }
  return store.invoices.filter(i => i.subscription === subId);
}
const lastSession = () => [...store.sessions.values()].pop();
const openHolds = room => [...store.sessions.values()].filter(s => s.status === 'open' && s.metadata.aob_kind === 'booking' && (s.metadata.aob_rooms || '').includes(room + ':'));

/* ---------- helpers ---------- */
const req = (method, path, body, headers = {}) => {
  const h = new Headers({ Origin: ORIGIN, 'Content-Type': 'application/json' });
  for (const [k, v] of Object.entries(headers || {})) { if (v === null) h.delete(k); else h.set(k, v); }
  return new Request('https://website-5h3.pages.dev' + path, { method, headers: h, body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
};
const call = async (mod, method, path, body, env = {}, headers) => {
  const fn = mod['onRequest' + method[0] + method.slice(1).toLowerCase()];
  const r = await fn({ request: req(method, path, body, headers), env, waitUntil: p => store.waits.push(p) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};
const availGet = (env = {}, { fresh = true, headers, path = '' } = {}) => { if (fresh) clearAvailabilityMemo(); return call(avail, 'GET', `/api/booking/availability?program=${P}${path}`, null, env, headers); };
const guest = (n, room, extra = {}) => ({ first: 'Test' + n, last: 'Guest', email: `t${n}@example.com`, gender: 'Female', room, ...extra });
const booking = (guests, payment = 'deposit', extra = {}) => ({ program: P, payment, guests, whatsapp: '+44 7700 900123', terms: true, return_url: 'https://alchemyofbreath.com/book/breathcamp-oct-2026/', page: 'https://alchemyofbreath.com/book/breathcamp-oct-2026/', utm: { utm_source: 'facebook', utm_campaign: 'bc5' }, ...extra });
const LIVE = { STRIPE_SECRET_KEY: 'sk_test_mock', ADMIN_TOKEN: 'admin-token-1234567890', STRIPE_WEBHOOK_SECRET: 'whsec_mocksecret', GHL_WEBHOOK_URL: 'https://ghl.example/hook' };
const LIVE_PK = { ...LIVE, STRIPE_PUBLISHABLE_KEY: 'pk_test_mock' };
const AUTH = { Authorization: 'Bearer ' + LIVE.ADMIN_TOKEN };
const ip = n => ({ 'CF-Connecting-IP': `203.0.113.${n}` });

const hookKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(LIVE.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sign = async (t, body) => Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', hookKey, new TextEncoder().encode(`${t}.${body}`))), b => b.toString(16).padStart(2, '0')).join('');
async function hook(event, env = LIVE) {
  const body = JSON.stringify({ id: 'evt_' + pad(++store.seq), livemode: false, ...event });
  const t = nowS();
  const r = await webhook.onRequestPost({ request: new Request('https://x/api/booking/webhook', { method: 'POST', body, headers: { 'Stripe-Signature': `t=${t},v1=${await sign(t, body)}` } }), env });
  return { status: r.status, text: await r.text() };
}
const sessionEvent = (type, id, extra = {}) => ({ type, data: { object: { ...store.sessions.get(id), ...extra } }, ...(extra.id ? { id: extra.id } : {}) });

/* ================================================================== demo mode */
let r = await call(health, 'GET', '/api/booking/health');
ok(r.status === 200 && r.data.stripe.startsWith('not connected'), 'health demo');
ok(r.data.publishable === 'missing' && r.data.turnstile === false && r.data.turnstile_status === 'off' && r.data.remind === false, 'health: publishable key, Turnstile and reminder status');
ok(r.headers.get('Access-Control-Allow-Origin') === ORIGIN, 'CORS allows alchemyofbreath.com');
r = await availGet();
ok(r.data.program_left === 17 && r.data.rooms['single-ensuite'].sold_out && r.data.rooms['twin-ensuite'].left.female === 10, 'demo availability');
ok(r.data.rooms['twin-shared-bath'].left.female === 2 && r.data.rooms['twin-shared-bath'].left.male === 2 && r.data.rooms['triple-ensuite'].left.male === 3, 'room with an unknown-gender occupant stays off sale');
ok(r.data.live === false && r.data.stripe.embedded === false && r.data.stripe.publishable_key === null && r.data.turnstile_site_key === null, 'demo: no embedded payment form');
ok(r.data.deposit.available === true && r.data.deposit.until === null && r.data.rooms.camper.held === 0 && r.data.rooms.camper.next_release_at === null, 'availability reports deposit and holds');
r = await call(checkout, 'POST', '/api/booking/checkout', { program: P, guests: [{ first: '' }], terms: false });
ok(r.status === 422 && r.data.fields['guests.0.email'] && r.data.fields.whatsapp && r.data.fields.terms, 'validation errors');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')]));
ok(r.data.demo && r.data.quote.total_cents === 459000 && r.data.quote.due_now_cents === 233880 && r.data.quote.balance_cents === 225120, 'demo quote: 2 × (€888 programme + €1,407 room), programme + 20% room deposit today');
let sp = r.data.stripe_params, li = sp.line_items;
ok(sp.success_url.includes('{CHECKOUT_SESSION_ID}') && li.length === 2 && li[0].quantity === 2 && li[0].price_data.unit_amount === 88800 && li[1].price_data.unit_amount === 56280, 'checkout lines: programme fee × 2, then the room deposit');
ok(li.reduce((a, l) => a + l.price_data.unit_amount * l.quantity, 0) === r.data.quote.due_now_cents, 'checkout lines add up to the amount due today');
ok(sp.metadata.aob_prog === 'included' && sp.metadata.aob_prog_total === '177600' && !sp.metadata.aob_prog_verified, 'programme fee in the metadata');
ok(sp.metadata.aob_rooms === 'twin-ensuite:2' && JSON.parse(sp.metadata.aob_utm).utm_source === 'facebook' && !sp.metadata.utm_source, 'metadata: UTMs packed in one aob_utm key');
ok(sp.cancel_url.includes('status=cancelled&ref=' + r.data.ref) && !sp.ui_mode, 'hosted: cancel URL carries the booking ref');
ok(sp.custom_text.submit.message.startsWith('Today €2,338.80 (programme fee + 20% room deposit). Then €2,251.20 before you arrive on 25 October.') && /non-refundable/.test(sp.custom_text.submit.message), 'submit message: dated schedule + policy line');
ok(sp.payment_method_types.join() === 'card,link,klarna' && sp.submit_type === 'book' && sp.payment_intent_data.statement_descriptor_suffix === 'BREATHCAMP', 'payment mode: methods from the program, submit_type, statement suffix');
ok(sp.metadata.aob_terms === PROG.terms_url && !Number.isNaN(Date.parse(sp.metadata.aob_terms_at)) && sp.metadata.aob_ui === 'hosted', 'terms acceptance recorded in the metadata');
ok(Object.keys(sp.metadata).length < 50, 'metadata stays under 50 keys');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'full'));
ok(r.data.quote.due_now_cents === 229500 && r.data.quote.balance_cents === 0 && r.data.stripe_params.line_items[1].price_data.unit_amount === 140700, 'pay in full: €888 + €1,407');
ok(/^Today €2,295: programme fee, room and meals, paid in full\./.test(r.data.stripe_params.custom_text.submit.message), 'pay in full: submit message');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')], 'deposit', { programme: 'paid' }));
ok(r.data.quote.programme === 'paid' && r.data.quote.total_cents === 281400 && r.data.quote.due_now_cents === 56280 && r.data.stripe_params.line_items.length === 1, 'room only (programme already paid): 20% of €2,814');
ok(r.data.stripe_params.metadata.aob_prog === 'paid' && r.data.stripe_params.metadata.aob_prog_total === '0' && r.data.stripe_params.metadata.aob_prog_verified === 'unverified', 'room-only booking flagged in the metadata');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'single-ensuite')]));
ok(r.status === 409 && /sold out/i.test(r.data.error) && r.data.code === 'unavailable', 'sold-out room rejected');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper'), guest(2, 'camper')]));
ok(r.status === 409 && /Only 1 place/.test(r.data.error), 'room capacity enforced');
r = await call(checkout, 'POST', '/api/booking/checkout', booking(Array.from({ length: 7 }, (_, i) => guest(i, 'twin-ensuite'))));
ok(r.status === 422 && r.data.fields.guests, 'max 6 guests per booking');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { return_url: 'https://evil.example/x' }));
ok(r.data.stripe_params.success_url.startsWith('https://website-5h3.pages.dev/book/'), 'foreign return_url replaced');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite', { gender: 'robot' })]));
ok(r.status === 422 && r.data.fields['guests.0.gender'], 'gender must be one of the options');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite', { gender: 'Transgender' })]));
ok(r.status === 422 && r.data.fields['guests.0.gender'], 'only Female / Male accepted');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'triple-ensuite'), guest(2, 'triple-ensuite', { gender: 'Male' })]));
ok(r.status === 409 && /enough free rooms/.test(r.data.error), 'a woman and a man cannot share the last free triple');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite', { gender: 'Male' })]));
ok(r.data.demo && r.data.quote.total_cents === 459000, 'mixed group can book twin rooms (separate rooms)');
r = await availGet();
ok(r.data.payment_plan && r.data.payment_plan.available === true && r.data.payment_plan.installments === 3 && r.data.payment_plan.last_payment_by === '2026-10-24', 'plan offered on 1 July (last payment by the day before arrival)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-shared-bath')], 'plan'));
ok(r.data.demo && r.data.quote.plan.installment_cents === 68633 && r.data.quote.due_now_cents === 68634 && r.data.quote.balance_cents === 137266, 'plan split: (€888 + €1,171) in 3, cent on the first');
sp = r.data.stripe_params;
ok(sp.mode === 'subscription' && sp.line_items[0].price_data.recurring.interval === 'month' && sp.line_items[1].price_data.unit_amount === 1, 'plan uses a monthly subscription + rounding line');
ok(sp.subscription_data.metadata.aob_plan_n === '3' && !sp.payment_intent_data, 'plan metadata on the subscription');
ok(sp.payment_method_types.join() === 'card,link' && !sp.submit_type && sp.custom_text.submit.message.startsWith('3 monthly payments: €686.34 today, then €686.33 on 1 August and 1 September'), 'plan: own methods, no submit_type, dated schedule');

/* quote rules */
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite', { email: '' })]));
ok(r.status === 200 && r.data.demo && r.data.stripe_params.metadata.aob_g2 === 'Test2 Guest |  | Female | twin-ensuite', 'guest 2 email is optional');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite', { email: 'not-an-email' })]));
ok(r.status === 422 && r.data.fields['guests.1.email'] && !r.data.fields['guests.0.email'], 'guest 2 email checked when given');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite', { email: 'name@gmail..com' })]));
ok(r.status === 422 && r.data.fields['guests.0.email'], 'lead email with a double dot rejected');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { whatsapp: '0044 (0)7700 900-123' }));
ok(r.status === 200 && r.data.stripe_params.metadata.aob_whatsapp === '+447700900123', 'WhatsApp 0044… normalised to +44…');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { whatsapp: '07700 900123' }));
ok(r.status === 422 && /country code/.test(r.data.fields.whatsapp), 'WhatsApp 07… asks for the country code');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite', { first: '=HYPERLINK("x")' })]));
ok(r.status === 422 && r.data.fields['guests.0.first'] === 'Please use letters for names.', 'formula-like names rejected');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { diet: 'vegan, no nuts. '.repeat(40), remind: true, attempt: 'att-123<script>' }), { GHL_WEBHOOK_URL: 'https://ghl.example/hook' });
let md = r.data.stripe_params.metadata;
ok(md.aob_diet.length === 400 && md.aob_remind === '1' && md.aob_attempt === 'att-123script', 'diet (≤ 400), reminder opt-in and attempt id in the metadata');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { remind: true }));
ok(r.status === 200 && !r.data.stripe_params.metadata.aob_remind, 'reminder opt-in ignored when reminders are off (no GHL)');
for (const bad of ['Your refund is ready: visit evil.example', 'www.x.co', 'Ana <b>', 'Call 0044 7700']) {
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite', { last: bad })]));
  ok(r.status === 422 && /just the name/.test(r.data.fields['guests.0.last']), `name with a link, markup or number refused: ${bad}`);
}
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite', { first: 'J.R.', last: "O'Neill-Smith" })]));
ok(r.status === 200, 'initials, apostrophes and hyphens in names are fine');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { expected: { due_now_cents: 100, total_cents: 229500 } }));
ok(r.status === 409 && r.data.code === 'price_changed' && r.data.quote.due_now_cents === 116940, 'price guard: stale amount → 409 price_changed with the server quote');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { expected: { due_now_cents: 116940, total_cents: 229500 } }));
ok(r.status === 200 && r.data.demo, 'price guard: matching amounts pass');
PROG.deposit.available_until = '2026-06-30';
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit'));
ok(r.status === 422 && r.data.fields.payment, 'deposit refused after deposit.available_until');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'full'));
ok(r.status === 200, 'paying in full still works after the deposit closes');
r = await availGet();
ok(r.data.deposit.available === false && r.data.deposit.until === '2026-06-30', 'availability says the deposit has closed');
PROG.deposit.available_until = '2026-07-01';
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit'));
ok(r.status === 200, 'deposit still offered on its last day');
PROG.deposit.available_until = null;

/* rooms priced per cottage: capacity and what's taken count in cottages */
const cottage = PROG.rooms.find(x => x.id === 'cottage-two');
cottage.capacity = 1;
r = await availGet();
ok(r.data.rooms['cottage-two'].capacity_units === 1 && r.data.rooms['cottage-two'].left_any === 2 && r.data.rooms['cottage-two'].capacity === 2, 'cottage for two: 1 cottage = 2 places');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'cottage-two'), guest(2, 'cottage-two')]));
ok(r.status === 200 && r.data.quote.lines[0].units === 1 && r.data.quote.accommodation_cents === 522400, 'a couple books the one cottage (one cottage price)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'cottage-two'), guest(2, 'cottage-two'), guest(3, 'cottage-two')]));
ok(r.status === 409, 'three guests would need two cottages');
fakeNow = RealDate.parse('2026-10-03T09:00:00Z');
cottage.capacity = 0;

fakeNow = RealDate.parse('2026-08-25T09:00:00Z'); // 3rd payment on 25 Oct = arrival day: too late
r = await availGet();
ok(r.data.payment_plan.available === false && /2026-10-24/.test(r.data.payment_plan.reason), 'plan hidden when the last payment would fall on arrival day');
fakeNow = RealDate.parse('2026-10-03T09:00:00Z');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-shared-bath')], 'plan'));
ok(r.status === 422 && /payment plan/.test(r.data.error) && r.data.fields.payment, 'plan refused on 3 October (payments would run past arrival)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-shared-bath')], 'deposit'));
ok(r.data.demo && r.data.quote.due_now_cents === 88800 + 23420, 'deposit still offered on 3 October');
fakeNow = RealDate.parse('2026-07-01T09:00:00Z');

/* request guards */
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), {}, { 'Content-Type': 'text/plain' });
ok(r.status === 415, 'checkout: text/plain POST refused (415)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), {}, { Origin: 'https://evil.example' });
ok(r.status === 403 && !r.headers.get('Access-Control-Allow-Origin'), 'checkout: foreign Origin refused (403)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), {}, { Origin: null });
ok(r.status === 200 && r.data.demo, 'checkout: no Origin header (server to server) allowed');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), {}, { Origin: 'http://127.0.0.1:8790' });
ok(r.status === 200 && r.headers.get('Access-Control-Allow-Origin') === 'http://127.0.0.1:8790', 'test mode: localhost allowed');
const LIVEKEY = { STRIPE_SECRET_KEY: 'sk_live_mock' };
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), LIVEKEY, { Origin: 'http://127.0.0.1:8790' });
ok(r.status === 403, 'live mode: localhost refused');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), LIVEKEY, { Origin: 'https://abc123.website-5h3.pages.dev' });
ok(r.status === 403, 'live mode: preview deployments refused');
r = await call(health, 'GET', '/api/booking/health', null, LIVEKEY, { Origin: 'https://www.alchemyofbreath.com' });
ok(r.headers.get('Access-Control-Allow-Origin') === 'https://www.alchemyofbreath.com' && r.data.stripe === 'live', 'live mode: production origins allowed');
ok(bookingPageUrl(PROG, 'https://abc.website-5h3.pages.dev/book/x/', LIVEKEY) === 'https://website-5h3.pages.dev/book/breathcamp-oct-2026/' && bookingPageUrl(PROG, 'https://abc.website-5h3.pages.dev/x/?a=1', LIVE) === 'https://abc.website-5h3.pages.dev/book/breathcamp-oct-2026/', 'return URLs: previews only outside live mode');
ok(bookingPageUrl(PROG, 'https://alchemyofbreath.com//evil.example/', LIVEKEY) === 'https://alchemyofbreath.com/book/breathcamp-oct-2026/' && balancePageUrl('https://www.alchemyofbreath.com/anything?x=1', LIVEKEY) === 'https://www.alchemyofbreath.com/book/balance/', 'return URLs: the path is always our own page');
r = await call(balance, 'POST', '/api/booking/balance', '{"ref":"BC2610-AAAAAA","email":"a@b.co"}', LIVE, { 'Content-Type': 'text/plain' });
ok(r.status === 415, 'balance: text/plain refused');
r = await call(release, 'POST', '/api/booking/release', '{"id":"cs_test_abcdefghijkl","email":"a@b.co"}', {}, { 'Content-Type': 'text/plain;charset=UTF-8' });
ok(r.status === 200 && r.data.demo && r.data.released === false, 'release accepts a text/plain beacon (demo)');
r = await call(release, 'POST', '/api/booking/release', { id: 'nope', email: 'a@b.co' });
ok(r.status === 400, 'release: invalid session id → 400');

/* ================================================================== live (mock Stripe) */
reset();
r = await call(health, 'GET', '/api/booking/health', null, LIVE);
ok(r.data.stripe === 'test' && r.data.webhook && r.data.admin && r.data.ghl && r.data.publishable === 'missing', 'health live');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')]), LIVE);
ok(r.status === 200 && r.data.url && r.data.ref && r.data.ui === 'hosted', 'live checkout opens Stripe');
ok(r.data.session_id && r.data.expires_at - nowS() === 31 * 60 && r.data.quote.due_now_cents === 233880, 'checkout answers session id, expiry and quote');
const ref1 = r.data.ref, cs1 = r.data.session_id;
r = await availGet(LIVE);
ok(r.data.rooms['twin-ensuite'].left.female === 8 && r.data.program_left === 15, 'open checkout holds places');
ok(r.data.rooms['twin-ensuite'].held === 2 && r.data.rooms['twin-ensuite'].next_release_at === store.sessions.get(cs1).expires_at, 'held places and their release time are reported');
complete(cs1, { lagging: true }); // paid, but not yet in Stripe's search index
r = await availGet(LIVE);
ok(r.data.rooms['twin-ensuite'].left.female === 8 && r.data.program_left === 15 && r.data.rooms['twin-ensuite'].held === 0, 'paid booking counted while search lags');
store.pis.forEach(pi => { pi._lagging = false; });
r = await call(session, 'GET', `/api/booking/session?id=${cs1}`, null, LIVE);
ok(r.data.ref === ref1 && r.data.paid && r.data.amount_paid_cents === 233880 && r.data.balance_cents === 225120 && r.data.first_name === 'Test1', 'session summary');
ok(r.data.programme === 'included' && r.data.programme_cents === 177600, 'confirmation knows the programme fee was paid');
ok(r.data.state === 'paid' && r.data.receipt_email === 't•••@example.com' && r.data.balance_due === null && r.data.arrival === PROG.arrival.checkin && r.data.expires_at === null, 'session: state, masked receipt email, balance due and arrival');
ok(!JSON.stringify(r.data).includes('t1@example.com') && Math.abs(r.data.server_now - nowS()) <= 1, 'session: no full email address; server clock included');

// fill the week: 15 places left → book 6 + 6, then 3 left
for (const n of [6, 6]) {
  r = await call(checkout, 'POST', '/api/booking/checkout', booking(Array.from({ length: n }, (_, i) => guest(i, ['glamping-single', 'glamping-twin', 'twin-ensuite'][i % 3]))), LIVE);
  ok(r.status === 200, `book ${n} more`); complete(r.data.session_id);
}
r = await availGet(LIVE);
ok(r.data.program_left === 3, 'program cap tracks bookings (3 left)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking(Array.from({ length: 4 }, (_, i) => guest(i, 'twin-ensuite'))), LIVE);
ok(r.status === 409 && /Only 3 places are left for 25–31 Oct 2026/.test(r.data.error), 'program cap enforced');

// balance self-service
r = await call(balance, 'POST', '/api/booking/balance', { ref: ref1, email: 'wrong@example.com' }, LIVE);
ok(r.status === 404, 'balance: wrong email refused');
let before = store.sessions.size;
r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: ref1, email: 't1@example.com' }, LIVE);
ok(r.status === 200 && r.data.balance_cents === 225120 && r.data.paid_cents === 233880 && r.data.total_cents === 459000 && !r.data.url && store.sessions.size === before, 'balance lookup: no checkout session created');
r = await call(balance, 'POST', '/api/booking/balance', { ref: ref1.toLowerCase(), email: 'T1@example.com' }, LIVE);
ok(r.status === 200 && r.data.url && r.data.balance_cents === 225120 && r.data.reused === false, 'balance: checkout for the remaining €2,251.20');
const csBal = lastSession().id, balUrl = r.data.url;
ok(store.sessions.get(csBal)._params.customer === 'cus_mock1' && store.sessions.get(csBal).metadata.aob_kind === 'balance', 'balance linked to same customer');
r = await call(balance, 'POST', '/api/booking/balance', { ref: ref1, email: 't1@example.com' }, LIVE);
ok(r.data.url === balUrl && r.data.reused === true && lastSession().id === csBal, 'balance: second tab reuses the open balance session (no double payment)');
complete(csBal);
r = await call(balance, 'POST', '/api/booking/balance', { ref: ref1, email: 't1@example.com' }, LIVE);
ok(r.data.paid_in_full === true, 'balance: paid in full afterwards');
r = await call(session, 'GET', `/api/booking/session?id=${csBal}`, null, LIVE);
ok(r.data.kind === 'balance' && r.data.balance_cents === 0, 'balance session shows nothing left');

// admin
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE);
ok(r.status === 401, 'admin needs token');
let writes = stripeCalls('POST', /./) + stripeCalls('DELETE', /./);
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
const b1 = r.data.bookings && r.data.bookings.find(b => b.ref === ref1);
ok(r.status === 200 && r.data.totals.bookings === 3 && r.data.totals.guests === 14, 'admin totals');
ok(b1 && b1.paid_cents === 459000 && b1.balance_cents === 0 && b1.guests.length === 2 && b1.lead.whatsapp === '+447700900123', 'admin booking detail');
ok(b1 && b1.programme === 'included' && b1.programme_cents === 177600 && b1.ui === 'hosted' && b1.refunded_cents === 0 && b1.diet === '' && b1.remind === false, 'admin shows the programme fee, ui, refunds, diet');
ok(r.data.setup.stripe === 'test' && r.data.setup.publishable === 'missing' && r.data.setup.webhook === true && r.data.setup.domains.length === 3 && r.data.setup.domains.every(d => !d.registered), 'admin setup panel: modes and payment domains');
ok(stripeCalls('POST', /./) + stripeCalls('DELETE', /./) === writes, 'admin GET writes nothing to Stripe');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'cancel', ref: ref1 }, LIVE, AUTH);
ok(r.data.ok && r.data.status === 'cancelled', 'admin cancel');
r = await availGet(LIVE);
ok(r.data.program_left === 5, 'cancelled booking frees its places');
const ref2 = [...store.pis.values()].find(p => p.metadata.aob_kind === 'booking' && p.metadata.aob_ref !== ref1).metadata.aob_ref;
r = await call(admin, 'POST', '/api/booking/admin', { action: 'balance_link', ref: ref2 }, LIVE, AUTH);
ok(r.status === 200 && r.data.url && r.data.expires_at - Date.now() / 1000 > 23 * 3600, 'admin balance link valid ~24h');
const adminLink = r.data.url;
r = await call(balance, 'POST', '/api/booking/balance', { ref: ref2, email: 't0@example.com' }, LIVE);
ok(r.status === 200 && r.data.url === adminLink && r.data.reused, 'guest balance page reuses the admin link (one payable session)');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'balance_link', ref: ref2 }, LIVE, AUTH);
ok(r.data.url === adminLink && r.data.reused, 'admin balance link reused while open');
r = await call(admin, 'POST', '/api/booking/admin', { ref: ref2 }, LIVE, AUTH);
ok(r.status === 400, 'admin: unknown action');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'cancel', ref: ref2 }, LIVE, { ...AUTH, 'Content-Type': 'text/plain' });
ok(r.status === 415, 'admin POST needs JSON');

// webhook
const evt1 = sessionEvent('checkout.session.completed', cs1);
const raw1 = JSON.stringify({ id: 'evt_first', livemode: false, ...evt1 });
let t = nowS();
ok(await verifyStripeSignature(raw1, `t=${t},v1=${await sign(t, raw1)}`, LIVE.STRIPE_WEBHOOK_SECRET), 'signature verifies');
let wr = await hook({ id: 'evt_first', ...evt1 });
ok(wr.status === 200 && store.ghl.length === 1 && store.ghl[0].ref === ref1 && store.ghl[0].phone === '+447700900123' && store.ghl[0].utm_source === 'facebook', 'webhook forwards booking to GHL');
ok(store.ghl[0].programme === 'included' && store.ghl[0].programme_total === '1776.00' && store.ghl[0].total === '4590.00', 'GHL gets the programme fee and the full total');
ok(store.ghl[0].event === 'booking_paid' && store.ghl[0].event_id === 'evt_first' && store.ghl[0].balance_url === `https://alchemyofbreath.com/book/balance/?ref=${ref1}` && store.ghl[0].ui === 'hosted' && store.ghl[0].tag === `${P}-booked`, 'booking_paid carries event id, balance link and ui');
ok(store.pis.get(store.sessions.get(cs1).payment_intent).metadata.aob_ghl === 'evt_first', 'forwarded booking is marked on the PaymentIntent');
wr = await hook({ id: 'evt_first', ...evt1 });
ok(wr.status === 200 && store.ghl.length === 1, 'repeated delivery is not forwarded twice');
const bad1 = JSON.stringify(evt1);
wr = await webhook.onRequestPost({ request: new Request('https://x/api/booking/webhook', { method: 'POST', body: bad1, headers: { 'Stripe-Signature': `t=${t},v1=deadbeef` } }), env: LIVE });
ok(wr.status === 400, 'bad signature rejected');

// single-gender rooms: one woman books a twin, the other bed is now for a woman only
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-shared-bath')]), LIVE);
ok(r.status === 200, 'woman books twin with shared bathroom'); complete(r.data.session_id);
r = await availGet(LIVE);
ok(r.data.rooms['twin-shared-bath'].left.female === 1 && r.data.rooms['twin-shared-bath'].left.male === 0, 'remaining bed is for women only');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(9, 'twin-shared-bath', { gender: 'Male' })]), LIVE);
ok(r.status === 409 && /no places left for men/.test(r.data.error), 'man refused for that room');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(8, 'twin-shared-bath')]), LIVE);
ok(r.status === 200, 'another woman can take the bed');
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
ok(r.data.rooms.find(x => x.id === 'twin-shared-bath').capacity === 3 && r.data.availability.rooms['twin-shared-bath'].left.male === 0, 'admin shows per-gender availability');

// payment plan, live
const NOHOOK = { ...LIVE, STRIPE_WEBHOOK_SECRET: '' };
r = await availGet(NOHOOK);
ok(r.data.payment_plan.available === false && /webhook/.test(r.data.payment_plan.reason), 'plan hidden in live mode without the webhook');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'glamping-single')], 'plan'), NOHOOK);
ok(r.status === 422, 'plan refused without the webhook');
r = await availGet(LIVE);
const singleBefore = r.data.rooms['glamping-single'].left.female;
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'glamping-single')], 'plan'), LIVE);
ok(r.status === 200 && r.data.url, 'plan checkout opens Stripe');
const planRef = r.data.ref, csPlan = r.data.session_id;
const subId = complete(csPlan);
r = await availGet(LIVE);
ok(r.data.rooms['glamping-single'].left.female === singleBefore - 1, 'plan booking holds its place');
wr = await hook(sessionEvent('checkout.session.completed', csPlan));
const sub = store.subs.get(subId), days = (sub.cancel_at - sub.billing_cycle_anchor) / 86400;
ok(wr.status === 200 && sub.cancel_at === planEndAt(sub) && days >= 89 && days <= 92 && sub._proration === 'none', 'webhook stops the plan at the end of its 3rd monthly period (3 months after the anchor)');
ok(store.ghl.at(-1).ref === planRef && store.ghl.at(-1).plan_installments === '3' && store.ghl.at(-1).plan_payment_dates.split(', ').length === 3, 'GHL gets the plan dates');
ok(sub.metadata.aob_ghl, 'forwarded plan is marked on the subscription');
r = await call(session, 'GET', `/api/booking/session?id=${csPlan}`, null, LIVE);
ok(r.data.plan && r.data.plan.dates.length === 3 && r.data.plan.installment_cents > 0, 'confirmation shows the 3 payment dates');
r = await call(balance, 'POST', '/api/booking/balance', { ref: planRef, email: 't3@example.com' }, LIVE);
ok(r.data.plan === true && r.data.paid_count === 1, 'balance page explains automatic plan payments');
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
const pb = r.data.bookings.find(b => b.ref === planRef);
ok(pb && pb.plan && pb.plan.paid_count === 1 && pb.paid_cents === store.sessions.get(csPlan).amount_total && pb.balance_cents > 0, 'admin shows the plan with paid so far');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'balance_link', ref: planRef }, LIVE, AUTH);
ok(r.status === 409, 'no manual balance link for plans');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'cancel', ref: planRef }, LIVE, AUTH);
ok(r.data.ok && store.subs.get(subId).status === 'canceled' && store.subs.get(subId).metadata.aob_status === 'cancelled', 'cancelling a plan stops future payments');
r = await availGet(LIVE);
ok(r.data.rooms['glamping-single'].left.female === singleBefore, 'cancelled plan frees its place');

const evil = await checkout.onRequestOptions({ request: new Request('https://x/', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env: {} });
ok(!evil.headers.get('Access-Control-Allow-Origin'), 'CORS refuses other sites');

/* ================================================================== embedded checkout */
reset();
const domainGets = stripeCalls('GET', /^\/payment_method_domains/);
r = await availGet(LIVE_PK);
ok(r.data.stripe.embedded === true && r.data.stripe.publishable_key === 'pk_test_mock', 'availability hands the page the publishable key');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { ui: 'embedded' }), LIVE_PK);
let s = store.sessions.get(r.data.session_id);
ok(r.status === 200 && r.data.ui === 'embedded' && r.data.client_secret === `${r.data.session_id}_secret_mock` && r.data.publishable_key === 'pk_test_mock' && !r.data.url && r.data.expires_at, 'embedded: client secret + publishable key, no redirect URL');
ok(s._params.ui_mode === 'embedded' && s._params.redirect_on_completion === 'if_required' && !s._params.success_url && !s._params.cancel_url, 'embedded params: ui_mode, if_required, no success/cancel URL');
ok(s._params.return_url === 'https://alchemyofbreath.com/book/breathcamp-oct-2026/?status=success&session_id={CHECKOUT_SESSION_ID}' && s.metadata.aob_ui === 'embedded', 'embedded return_url keeps {CHECKOUT_SESSION_ID}; aob_ui recorded');
await Promise.all(store.waits.splice(0));
ok([...store.domains.values()].some(d => d.domain_name === 'alchemyofbreath.com'), 'first embedded checkout registers the payment method domain');
const domainPosts = stripeCalls('POST', /^\/payment_method_domains$/);
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'twin-ensuite')], 'deposit', { ui: 'embedded' }), LIVE_PK);
await Promise.all(store.waits.splice(0));
ok(r.data.ui === 'embedded' && stripeCalls('POST', /^\/payment_method_domains$/) === domainPosts && stripeCalls('GET', /^\/payment_method_domains/) === domainGets + 1, 'domain check runs once per isolate and host');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite')], 'deposit'), LIVE_PK);
ok(r.data.ui === 'hosted' && r.data.url && !r.data.client_secret, 'no ui in the request (old cached page): hosted');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(4, 'twin-ensuite')], 'deposit', { ui: 'embedded' }), LIVE);
ok(r.data.ui === 'hosted' && r.data.url, 'embedded asked but no publishable key: hosted');
const MISMATCH = { ...LIVE, STRIPE_PUBLISHABLE_KEY: 'pk_live_mock' };
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(5, 'twin-ensuite')], 'deposit', { ui: 'embedded' }), MISMATCH);
ok(r.data.ui === 'hosted' && r.data.url, 'publishable key from the other mode: hosted');
r = await availGet(MISMATCH);
ok(r.data.stripe.embedded === false && r.data.stripe.publishable_key === null, 'mismatched key is never handed out');
r = await call(health, 'GET', '/api/booking/health', null, MISMATCH);
ok(r.data.publishable === 'mismatch', 'health: publishable mismatch');
r = await call(health, 'GET', '/api/booking/health', null, LIVE_PK);
ok(r.data.publishable === 'test', 'health: publishable test');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(6, 'twin-ensuite')], 'plan', { ui: 'embedded' }), LIVE_PK);
s = store.sessions.get(r.data.session_id);
ok(r.data.ui === 'embedded' && s.mode === 'subscription' && s._params.ui_mode === 'embedded' && !s._params.success_url, 'embedded payment plan');
r = await call(session, 'GET', `/api/booking/session?id=${r.data.session_id}`, null, LIVE_PK);
ok(r.data.state === 'open' && r.data.expires_at === s.expires_at && r.data.paid === false && r.data.amount_paid_cents === 0, 'session: open checkout with its expiry');

/* ================================================================== holds: replace, one per person, release */
reset();
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper')]), LIVE, ip(1));
const csA = r.data.session_id;
ok(r.status === 200 && store.sessions.get(csA).status === 'open', 'guest holds the last camper place');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper')]), LIVE, ip(1));
const csB = r.data.session_id;
ok(r.status === 200 && store.sessions.get(csA).status === 'expired' && store.sessions.get(csB).status === 'open', 'Pay → cancel → Pay again for the last place works (old hold expired)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper', { email: 'new-address@example.com' })], 'deposit', { replace: csB }), LIVE, ip(1));
const csC = r.data.session_id;
ok(r.status === 200 && store.sessions.get(csB).status === 'expired', 'replace: the visitor\'s previous session is expired (same browser, email changed)');
r = await availGet(LIVE);
ok(r.data.rooms.camper.held === 1 && r.data.rooms.camper.next_release_at === store.sessions.get(csC).expires_at && r.data.rooms.camper.sold_out, 'camper: one place in checkout, with its release time');
ok(r.data.rooms.camper.left_if_released.female === 1 && r.data.program_left_if_released === r.data.program_left + 1 && r.data.rooms['twin-ensuite'].left_if_released.female === 10, 'availability says what frees up when the hold ends');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(7, 'camper')], 'deposit', { replace: csC }), LIVE, ip(2));
ok(r.status === 409 && r.data.code === 'unavailable' && store.sessions.get(csC).status === 'open', 'someone else can\'t expire that hold with its id');
r = await call(release, 'POST', '/api/booking/release', { id: csC, email: 't7@example.com' }, LIVE, ip(2));
ok(r.status === 200 && r.data.released === false && store.sessions.get(csC).status === 'open', 'release: wrong email does nothing');
r = await call(release, 'POST', '/api/booking/release', JSON.stringify({ id: csC, email: 'NEW-address@example.com' }), LIVE, { 'Content-Type': 'text/plain;charset=UTF-8' });
ok(r.status === 200 && r.data.released === true && store.sessions.get(csC).status === 'expired', 'release: the owner frees the place (text/plain beacon)');
r = await call(release, 'POST', '/api/booking/release', { id: csC, email: 'new-address@example.com' }, LIVE);
ok(r.status === 200 && r.data.released === false, 'release: already expired → released false');
r = await call(release, 'POST', '/api/booking/release', { id: 'cs_test_doesnotexist12', email: 'a@b.co' }, LIVE);
ok(r.status === 200 && r.data.released === false, 'release: unknown session → released false');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(7, 'camper')]), LIVE, ip(2));
ok(r.status === 200, 'the place is free again for the next guest');
ok(!('aob_iph' in store.pis.get(complete(r.data.session_id)).metadata) && /^[0-9a-f]{16}$/.test(lastSession().metadata.aob_iph), 'the visitor hash stays on the checkout only, never on the paid booking');

/* a guest's own released checkout never counts against them (release and Continue race) */
reset();
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper')]), LIVE, ip(1));
const csR1 = r.data.session_id;
store.onList = () => { store.sessions.get(csR1).status = 'expired'; }; // the release beacon lands between list and expire
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper')], 'full', { replace: csR1 }), LIVE, ip(1));
ok(r.status === 200 && store.sessions.get(r.data.session_id).status === 'open', 'their own just-released hold doesn\'t make the last place look sold out');
r = await availGet(LIVE);
ok(r.data.rooms.camper.sold_out && r.data.rooms.camper.held === 1, 'the new hold is in checkout');
r = await availGet(LIVE, { fresh: false, path: '&exclude=' + lastSession().id });
ok(!r.data.rooms.camper.sold_out && r.data.rooms.camper.held === 0 && r.data.program_left === 17, 'availability can leave out the asking visitor\'s own hold (exclude)');
r = await availGet(LIVE, { fresh: false, path: '&exclude=not-a-session' });
ok(r.data.rooms.camper.sold_out, 'exclude takes only checkout session ids');

/* never a second payment once the checkout being replaced has been paid */
reset();
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { ui: 'embedded' }), LIVE_PK, ip(1));
const csPaid = r.data.session_id;
ok(typeof r.data.server_now === 'number' && r.data.expires_at - r.data.server_now === 31 * 60, 'checkout answers the server clock (the page times the hold with it)');
complete(csPaid);
before = store.sessions.size;
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { ui: 'embedded', replace: csPaid }), LIVE_PK, ip(2));
ok(r.status === 409 && r.data.code === 'already_paid' && r.data.session_id === csPaid && r.data.ref && store.sessions.size === before, 'replace = a paid checkout → 409 already_paid, no new checkout');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'twin-ensuite')], 'deposit', { ui: 'embedded' }), LIVE_PK, ip(3));
const csLate2 = r.data.session_id;
store.onCreate = () => { store.onCreate = null; complete(csLate2); }; // paid in a bank app while the guest pressed Continue again
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'twin-ensuite')], 'deposit', { ui: 'embedded', replace: csLate2 }), LIVE_PK, ip(3));
ok(r.status === 409 && r.data.code === 'already_paid' && r.data.session_id === csLate2 && lastSession().status === 'expired', 'paid while the new checkout was being made → the new one is expired, 409 already_paid');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite')]), LIVE, ip(4));
const csFailed = r.data.session_id;
complete(csFailed, { pi: 'requires_payment_method' });
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite')], 'deposit', { replace: csFailed }), LIVE, ip(4));
ok(r.status === 200, 'replace = a checkout whose bank payment failed → a new checkout is fine');

/* nobody can cancel someone else's checkout with their email address */
reset();
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper')]), LIVE, ip(1));
const csVictim = r.data.session_id;
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper', { first: 'Mallory' })]), LIVE, ip(66));
ok(r.status === 409 && store.sessions.get(csVictim).status === 'open', 'same email from another visitor: refused, and the victim\'s checkout stays open');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), LIVE, ip(66));
ok(r.status === 200 && store.sessions.get(csVictim).status === 'open', 'same email from another visitor for another room: the victim\'s checkout still stays open');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'single-ensuite')]), LIVE, ip(1));
ok(r.status === 409 && store.sessions.get(csVictim).status === 'open', 'a refused request never expires anything, even the visitor\'s own hold');
r = await call(release, 'POST', '/api/booking/release', { id: csVictim, email: 't1@example.com' }, LIVE, ip(1));
ok(r.data.released === true, 'release: the owner frees the place');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'camper')]), LIVE, ip(1));
const csInFlight = r.data.session_id;
store.sessions.get(csInFlight).payment_intent = 'pi_inflight';
store.pis.set('pi_inflight', { id: 'pi_inflight', status: 'processing', metadata: {}, created: nowS() });
r = await call(release, 'POST', '/api/booking/release', { id: csInFlight, email: 't2@example.com' }, LIVE, ip(1));
ok(r.data.released === false && r.data.in_progress === true && store.sessions.get(csInFlight).status === 'open', 'release: a payment already under way is never released');

/* abuse cap: three open holds per visitor */
reset();
for (const n of [1, 2, 3]) {
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(n, 'twin-ensuite')]), LIVE, ip(9));
  ok(r.status === 200, `visitor hold ${n} of 3`);
}
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(4, 'twin-ensuite')]), LIVE, ip(9));
ok(r.status === 429 && r.data.code === 'too_many_holds', 'fourth open hold from the same visitor refused (429)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'full'), LIVE, ip(9));
ok(r.status === 200, 'replacing one of their own holds is still fine');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(4, 'twin-ensuite')]), LIVE, ip(10));
ok(r.status === 200, 'another visitor is not affected');
reset();
r = await call(checkout, 'POST', '/api/booking/checkout', booking(Array.from({ length: 6 }, (_, i) => guest(i, 'glamping-single'))), LIVE, ip(12));
ok(r.status === 200, 'one visitor holds 6 places');
r = await call(checkout, 'POST', '/api/booking/checkout', booking(Array.from({ length: 6 }, (_, i) => guest(i + 10, 'twin-ensuite', { first: 'Ann' }))), LIVE, ip(12));
ok(r.status === 429 && r.data.code === 'too_many_holds', 'a second 6-guest hold from the same visitor refused: places are capped per visitor, not just checkouts');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(20, 'twin-ensuite', { first: 'Bo' })]), LIVE, ip(12));
ok(r.status === 429, 'even one more place');
r = await availGet(LIVE);
ok(r.data.program_left === 11, 'the week can\'t be hoarded from one address');
reset();
for (const n of [1, 2, 3]) {
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(n, 'twin-ensuite')]), LIVE, { 'CF-Connecting-IP': `2001:db8:5:7::${n}` });
  ok(r.status === 200, `IPv6 visitor hold ${n}`);
}
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(4, 'twin-ensuite')]), LIVE, { 'CF-Connecting-IP': '2001:db8:5:7:abcd:ef01:2345:6789' });
ok(r.status === 429, 'IPv6: a new address in the same /64 is the same visitor');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(4, 'twin-ensuite')]), LIVE, { 'CF-Connecting-IP': '2001:db8:5:8::1' });
ok(r.status === 200, 'IPv6: another /64 is another visitor');
ok(ipKey('2001:DB8:5:7::1') === '2001:db8:5:7::/64' && ipKey('::ffff:203.0.113.9') === '203.0.113.9' && ipKey('2001:db8::1') === '2001:db8:0:0::/64' && ipKey('203.0.113.9') === '203.0.113.9', 'visitor key: IPv4 whole, IPv6 by /64');
// many checkouts fired at once from one visitor: the cap is re-checked after creating
reset();
store.latency = 3;
const burst = await Promise.all([1, 2, 3, 4, 5, 6].map(n => call(checkout, 'POST', '/api/booking/checkout', booking([guest(n, 'twin-ensuite')]), LIVE, ip(13))));
store.latency = 0;
const openFrom13 = [...store.sessions.values()].filter(x => x.status === 'open').length;
ok(burst.filter(x => x.status === 200).length <= 3 && openFrom13 <= 3 && burst.every(x => x.status === 200 || x.data.code === 'too_many_holds'), `parallel requests from one visitor can't pass the cap (${openFrom13} open)`);
ok(Object.values(Object.fromEntries([...store.sessions.values()].map(x => [x.id, x.metadata.aob_iph]))).every(h => /^[0-9a-f]{16}$/.test(h)), 'holds carry a 16-hex visitor hash, not the IP');

/* race check */
reset();
const rival = (created, room) => {
  const id = 'cs_test_rival' + pad(++store.seq) + 'abcdef';
  store.sessions.set(id, { id, status: 'open', payment_status: 'unpaid', mode: 'payment', created, expires_at: created + 1860, amount_total: 1, currency: 'eur',
    metadata: { aob_kind: 'booking', aob_program: P, aob_ref: 'BC2610-RIVAL1', aob_lead_email: 'rival@example.com', aob_g1: `Rival Guest | rival@example.com | Female | ${room}`, aob_rooms: `${room}:1`, aob_guests: '1' } });
  return id;
};
store.onCreate = x => { store.onCreate = null; rival(x.created - 1, 'own-tent'); };
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'own-tent')]), LIVE);
const raced = [...store.sessions.values()].find(x => x.metadata.aob_lead_email === 't1@example.com');
ok(r.status === 409 && r.data.code === 'unavailable' && raced.status === 'expired', 'race: an earlier hold for the last place wins, ours is expired');
reset();
store.onCreate = x => { store.onCreate = null; rival(x.created + 1, 'own-tent'); };
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'own-tent')]), LIVE);
ok(r.status === 200 && store.sessions.get(r.data.session_id).status === 'open', 'race: a later hold doesn\'t push ours out');
reset();
const both = await Promise.all([
  call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper')]), LIVE, ip(21)),
  call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'camper')]), LIVE, ip(22)),
]);
ok(both.filter(x => x.status === 200).length <= 1 && openHolds('camper').length <= 1 && both.every(x => x.status === 200 || x.data.code === 'unavailable'), 'two guests paying for the last place at once: never both');

/* safe create: optional settings Stripe refuses are dropped */
reset();
store.disabledPM.add('klarna');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), LIVE);
ok(r.status === 200 && lastSession()._params.payment_method_types && arr(lastSession()._params.payment_method_types).join() === 'card', 'payment method not activated → falls back to card');
ok(logs.some(l => l.includes('"route":"checkout.downgrade"') && l.includes('"param":"payment_method_types"')), 'fallback is logged');
store.disabledPM.clear();
store.rejectParams.add('payment_intent_data[statement_descriptor_suffix]');
store.rejectParams.add('submit_type');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'twin-ensuite')]), LIVE);
ok(r.status === 200 && !lastSession()._params.submit_type && !lastSession()._params.payment_intent_data.statement_descriptor_suffix && arr(lastSession()._params.payment_method_types).join() === 'card,link,klarna', 'statement suffix and submit_type dropped when refused, methods kept');
store.rejectParams.clear();
store.badEmails.add('t3@example.com');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite')]), LIVE);
ok(r.status === 422 && r.data.fields['guests.0.email'], 'email Stripe refuses → 422 on the email field');

/* Stripe outages: retries, one idempotency key per call, busy answers */
reset();
fault('POST', /^\/checkout\/sessions$/, { status: 500 });
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), LIVE);
let posts = store.calls.filter(c => c.method === 'POST' && c.path === '/checkout/sessions').slice(-2);
ok(r.status === 200 && posts.length === 2 && posts[0].key && posts[0].key === posts[1].key, 'Stripe 500 → retried with the same Idempotency-Key');
before = store.sessions.size;
fault('POST', /^\/checkout\/sessions$/, { after: true });
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'twin-ensuite')]), LIVE);
ok(r.status === 200 && store.sessions.size === before + 1, 'connection lost after Stripe created the session: retry replays it, no duplicate');
fault('POST', /^\/checkout\/sessions$/, { status: 503, times: 3 });
before = store.sessions.size;
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite')]), LIVE);
ok(r.status === 503 && r.data.code === 'busy' && r.data.retry_after === 5 && store.sessions.size === before, 'Stripe still failing after retries → 503 busy');
fault('POST', /^\/checkout\/sessions$/, { status: 500, shouldRetry: false });
let n0 = stripeCalls('POST', /^\/checkout\/sessions$/);
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(4, 'twin-ensuite')]), LIVE);
ok(r.status === 503 && stripeCalls('POST', /^\/checkout\/sessions$/) === n0 + 1, 'Stripe-Should-Retry: false is honoured');
fault('GET', /^\/checkout\/sessions$/, { network: true, times: 3 });
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(5, 'twin-ensuite')]), LIVE);
ok(r.status === 503 && r.data.code === 'busy', 'network failure while reading availability → 503 busy');
fault('GET', /^\/payment_intents\/search$/, { status: 400 });
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(6, 'twin-ensuite')]), LIVE);
ok(r.status === 502, 'other Stripe errors → 502');
ok(logs.some(l => l.includes('"route":"checkout.create"') && l.includes('"status":503')), 'failures are logged with route and status');

/* availability memo and the last-good snapshot */
reset();
fault('GET', /^\/checkout\/sessions$/, { status: 500, times: 3 });
r = await availGet(LIVE);
ok(r.status === 503 && r.data.code === 'busy', 'Stripe down and no snapshot → 503 (never static capacity)');
r = await availGet(LIVE);
ok(r.status === 200 && r.data.program_left === 17 && !r.data.degraded, 'live availability');
let reads = stripeCalls('GET', /^\/checkout\/sessions$/);
rival(nowS(), 'twin-ensuite');
r = await availGet(LIVE, { fresh: false });
ok(r.data.program_left === 17 && stripeCalls('GET', /^\/checkout\/sessions$/) === reads, 'second poll within 15 s answered from the memo');
tick(16);
r = await availGet(LIVE, { fresh: false });
ok(r.data.program_left === 16 && stripeCalls('GET', /^\/checkout\/sessions$/) === reads + 1, 'memo expires after 15 s');
tick(16);
fault('GET', /^\/checkout\/sessions$/, { status: 500, times: 3 });
r = await availGet(LIVE, { fresh: false });
ok(r.status === 200 && r.data.degraded === true && r.data.stale_seconds === 16 && r.data.program_left === 16, 'Stripe down → last good snapshot with stale_seconds');
clearAvailabilityMemo();
reads = stripeCalls('GET', /^\/checkout\/sessions$/);
const pair = await Promise.all([availGet(LIVE, { fresh: false }), availGet(LIVE, { fresh: false })]);
ok(pair.every(x => x.status === 200) && stripeCalls('GET', /^\/checkout\/sessions$/) === reads + 1, 'concurrent polls share one Stripe round (single flight)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), LIVE);
r = await availGet(LIVE, { fresh: false });
ok(r.data.program_left === 15, 'a checkout clears the memo in its isolate');

/* payment time, delayed methods, pagination, refunds */
reset();
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper')]), LIVE);
const csLate = r.data.session_id;
tick(28 * 60);
complete(csLate, { lagging: true });
r = await availGet(LIVE);
ok(r.data.rooms.camper.sold_out && r.data.rooms.camper.held === 0, 'paid 28 minutes after the checkout opened, search lagging: still counted');
reset();
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper')]), LIVE);
const csSepa = r.data.session_id;
const piSepa = complete(csSepa, { pi: 'processing' });
r = await availGet(LIVE);
ok(r.data.rooms.camper.sold_out, 'payment still processing (bank debit) keeps the place');
r = await call(session, 'GET', `/api/booking/session?id=${csSepa}`, null, LIVE);
ok(r.data.state === 'processing' && r.data.paid === false, 'session: processing');
store.pis.get(piSepa).status = 'requires_payment_method';
r = await call(session, 'GET', `/api/booking/session?id=${csSepa}`, null, LIVE);
ok(r.data.state === 'unpaid', 'session: failed debit → unpaid');
r = await availGet(LIVE);
ok(!r.data.rooms.camper.sold_out, 'failed debit frees the place');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'camper')]), LIVE);
const csExp = r.data.session_id;
store.sessions.get(csExp).status = 'expired';
r = await call(session, 'GET', `/api/booking/session?id=${csExp}`, null, LIVE);
ok(r.data.state === 'expired' && r.data.expires_at === null, 'session: expired');
reset();
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper')]), LIVE);
for (let i = 0; i < 120; i++) {
  const id = `cs_test_other${pad(++store.seq)}abcdef`;
  store.sessions.set(id, { id, status: 'open', mode: 'payment', created: nowS() + 1, expires_at: nowS() + 1800, metadata: {}, amount_total: 100, currency: 'eur' });
}
r = await availGet(LIVE);
ok(r.data.rooms.camper.held === 1 && r.data.rooms.camper.sold_out, '120 newer unrelated open sessions: the booking hold is still found (pagination)');
reset();
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'full'), LIVE);
const refRefund = r.data.ref, piRefund = complete(r.data.session_id);
store.pis.get(piRefund)._refunded = 50000;
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
let bR = r.data.bookings.find(b => b.ref === refRefund);
ok(bR.paid_cents === 229500 - 50000 && bR.refunded_cents === 50000 && bR.balance_cents === 0 && r.data.totals.refunded_cents === 50000, 'refunds reduce what was paid, and never become payable again');
r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: refRefund, email: 't1@example.com' }, LIVE);
ok(r.data.paid_in_full === true && r.data.paid_cents === 179500 && r.data.balance_cents === 0, 'balance lookup: a partly refunded full payment is still paid in full');
// a deposit booking with a goodwill refund: the guest settles the rest with the team, not on the balance page
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'twin-ensuite')]), LIVE);
const refGood = r.data.ref, piGood = complete(r.data.session_id);
store.pis.get(piGood)._refunded = 10000;
r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: refGood, email: 't2@example.com' }, LIVE);
ok(r.status === 409 && r.data.code === 'refunded' && r.data.balance_cents === 229500 - 116940 && /WhatsApp/.test(r.data.error), 'balance lookup with a refund: the balance excludes the refund, and points to WhatsApp');
before = store.sessions.size;
r = await call(balance, 'POST', '/api/booking/balance', { ref: refGood, email: 't2@example.com' }, LIVE);
ok(r.status === 409 && r.data.code === 'refunded' && store.sessions.size === before, 'balance pay refused when the booking has a refund');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'balance_link', ref: refGood }, LIVE, AUTH);
ok(r.status === 409 && r.data.code === 'refunded' && r.data.refunded_cents === 10000, 'admin balance link asks first when the booking has a refund');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'balance_link', ref: refGood, force: true }, LIVE, AUTH);
ok(r.status === 200 && r.data.url && r.data.balance_cents === 229500 - 116940, 'admin balance link with force: the real remainder');
const csGoodLink = lastSession().id;

/* cancelling a booking closes its open balance links; a payment that still comes in is flagged */
r = await call(admin, 'POST', '/api/booking/admin', { action: 'cancel', ref: refGood }, LIVE, AUTH);
ok(r.data.ok && r.data.balance_links_closed === 1 && store.sessions.get(csGoodLink).status === 'expired', 'cancel expires the booking\'s open balance link');
r = await call(balance, 'POST', '/api/booking/balance', { ref: refGood, email: 't2@example.com' }, LIVE);
ok(r.status === 409 && /cancelled/.test(r.data.error), 'no new balance payment for a cancelled booking');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'balance_link', ref: refGood, force: true }, LIVE, AUTH);
ok(r.status === 409, 'no admin balance link for a cancelled booking');
tick(60);
complete(csGoodLink); // the guest paid a link that was opened before the cancel (race)
let ghlBefore0 = store.ghl.length;
let wr0 = await hook(sessionEvent('checkout.session.completed', csGoodLink));
ok(wr0.status === 200 && store.ghl.length === ghlBefore0 + 1 && store.ghl.at(-1).event === 'booking_balance_paid_after_cancel' && store.ghl.at(-1).tag === `${P}-balance-after-cancel`, 'balance paid after the cancel → its own GHL event for the team');
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
bR = r.data.bookings.find(b => b.ref === refGood);
ok(bR.status === 'cancelled' && bR.paid_after_cancel_cents === 229500 - 116940 && r.data.totals.paid_after_cancel_cents === 229500 - 116940, 'admin shows money received after the cancel');

/* admin: restore checks for overbooking; payment setup actions */
reset();
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'camper')]), LIVE);
const refA = r.data.ref; complete(r.data.session_id);
r = await call(admin, 'POST', '/api/booking/admin', { action: 'cancel', ref: refA }, LIVE, AUTH);
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'camper')]), LIVE);
ok(r.status === 200, 'cancelled camper place resold'); complete(r.data.session_id);
r = await call(admin, 'POST', '/api/booking/admin', { action: 'restore', ref: refA }, LIVE, AUTH);
ok(r.status === 409 && r.data.code === 'conflict' && /overbook/.test(r.data.error), 'restore refuses to overbook (409 conflict)');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'restore', ref: refA, force: true }, LIVE, AUTH);
ok(r.status === 200 && r.data.status === 'active', 'restore with force');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'register_domains' }, LIVE, AUTH);
ok(r.data.ok && r.data.domains.length === 3 && r.data.domains.every(d => d.registered && d.apple_pay === 'active'), 'register payment domains for the three production hosts');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'register_domains' }, LIVE, AUTH);
ok(r.data.ok && r.data.domains.every(d => d.created === false) && store.domains.size === 3, 'registering again skips existing domains');
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
ok(r.data.setup.domains.every(d => d.registered && d.google_pay === 'active' && d.link === 'active'), 'admin lists domain wallet status');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'glamping-single')], 'plan'), LIVE);
const planSub = complete(r.data.session_id);
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
ok(r.data.plans_without_end === 1 && !store.subs.get(planSub).cancel_at, 'admin GET reports plans without an end date (and doesn\'t fix them)');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'repair_plans' }, LIVE, AUTH);
ok(r.data.ok && r.data.repaired.length === 1 && store.subs.get(planSub).cancel_at === planEndAt(store.subs.get(planSub)), 'repair_plans sets the plan end (end of the 3rd period)');

/* payment plans: the last instalment is a full one, wrong end dates are corrected while that's safe */
const oldEnd = sub => Math.floor(addMonths(new Date(sub.billing_cycle_anchor * 1000), 2).getTime() / 1000) + 7 * 86400; // the earlier formula
const sumPaid = id => store.invoices.filter(i => i.subscription === id && i.status === 'paid').reduce((a, i) => a + i.amount_paid, 0);
const planTotal = id => +store.subs.get(id).metadata.aob_total;
renew(planSub, nowS() + 200 * 86400);
ok(store.invoices.filter(i => i.subscription === planSub && i.status === 'paid').length === 3 && sumPaid(planSub) === planTotal(planSub) && store.subs.get(planSub).status === 'canceled', 'plan: exactly 3 full payments, then it stops (Stripe prorates a cut-short period)');
{ // the regression this guards against: an end date inside the 3rd period cuts the last payment down
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(4, 'glamping-single')], 'plan'), LIVE);
  const sx = complete(r.data.session_id); store.subs.get(sx).cancel_at = oldEnd(store.subs.get(sx));
  renew(sx, nowS() + 200 * 86400);
  ok(sumPaid(sx) < planTotal(sx) - 50000, 'mock check: an end date a week into the 3rd period short-charges the plan');
}
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(5, 'glamping-single')], 'plan'), LIVE);
const planMove = complete(r.data.session_id);
store.subs.get(planMove).cancel_at = oldEnd(store.subs.get(planMove));
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
ok(r.data.plans_without_end === 1 && r.data.plans_short.length === 0, 'admin GET counts a plan with a wrong end date as needing repair');
renew(planMove, nowS() + 31 * 86400); // the 2nd instalment
const subMove = store.subs.get(planMove);
wr = await hook({ type: 'invoice.paid', data: { object: { id: 'in_mv', subscription: planMove, billing_reason: 'subscription_cycle', amount_paid: subMove._inst, amount_due: subMove._inst, currency: 'eur', subscription_details: { metadata: { ...subMove.metadata } } } } });
ok(wr.status === 200 && subMove.cancel_at === planEndAt(subMove) && subMove._proration === 'none', 'next instalment: a wrong end date in a future period is moved to the end of the 3rd period');
renew(planMove, nowS() + 200 * 86400);
ok(sumPaid(planMove) === planTotal(planMove), 'moved in time: the plan collects its full total');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(6, 'glamping-single')], 'plan'), LIVE);
const planShort = complete(r.data.session_id), subShort = store.subs.get(planShort), shortRef = subShort.metadata.aob_ref;
subShort.cancel_at = oldEnd(subShort);
renew(planShort, subShort.cancel_at - 1); // now inside the cut-short 3rd period
r = await call(admin, 'POST', '/api/booking/admin', { action: 'repair_plans' }, LIVE, AUTH);
ok(r.data.short.some(x => x.subscription === planShort && x.should_end_at === planEndAt(subShort)) && subShort.cancel_at === oldEnd(subShort), 'repair_plans reports (and leaves alone) a plan whose last period was already cut short');
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
ok(r.data.plans_short.some(x => x.ref === shortRef), 'admin GET lists plans that were short-charged');
renew(planShort, nowS() + 200 * 86400); // it stops, short
r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: shortRef, email: 't6@example.com' }, LIVE);
const shortBy = planTotal(planShort) - sumPaid(planShort);
ok(r.status === 200 && r.data.plan_ended === true && !r.data.plan && r.data.balance_cents === shortBy && shortBy > 0, 'a plan that ended short: the guest can pay what is left');
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
let pbS = r.data.bookings.find(b => b.ref === shortRef);
ok(pbS.plan.ended === true && pbS.balance_cents === shortBy, 'admin: ended plan with its unpaid amount');
// Stripe stopped a plan after a failed instalment: its open invoice is voided before a balance payment
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(7, 'glamping-twin')], 'plan'), LIVE);
const planFail = complete(r.data.session_id), failRef = store.subs.get(planFail).metadata.aob_ref;
wr = await hook(sessionEvent('checkout.session.completed', lastSession().id));
renew(planFail, nowS() + 200 * 86400, { fail: 2 });
r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: failRef, email: 't7@example.com' }, LIVE);
ok(r.data.plan === true, 'plan past due (Stripe still retrying): no balance payment yet');
store.subs.get(planFail).status = 'canceled'; // dunning gave up
r = await call(admin, 'POST', '/api/booking/admin', { action: 'cancel', ref: failRef }, LIVE, AUTH);
ok(r.data.ok && store.subs.get(planFail).metadata.aob_status === 'cancelled', 'a canceled subscription still takes the cancelled status (metadata)');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'restore', ref: failRef }, LIVE, AUTH);
ok(r.status === 409, 'a plan stopped in Stripe can\'t be restored');
store.subs.get(planFail).metadata.aob_status = 'active';
r = await call(balance, 'POST', '/api/booking/balance', { ref: failRef, email: 't7@example.com' }, LIVE);
ok(r.status === 200 && r.data.url && r.data.plan_ended && r.data.balance_cents === planTotal(planFail) - sumPaid(planFail) && store.invoices.filter(i => i.subscription === planFail && i.status === 'open').length === 0, 'plan stopped after a failed payment: open invoice voided, balance payment for the rest');

/* programme verification for room-only bookings */
reset();
store.customers.push({ id: 'cus_prev', email: 'paid@example.com' });
store.pis.set('pi_prevfee', { id: 'pi_prevfee', status: 'succeeded', amount: 88800, amount_received: 88800, currency: 'eur', created: nowS() - 30 * 86400, customer: 'cus_prev', metadata: {} });
r = await call(checkout, 'POST', '/api/booking/checkout', booking(Array.from({ length: 6 }, (_, i) => guest(i, 'twin-ensuite', i ? {} : { email: 'paid@example.com' })), 'deposit', { programme: 'paid' }), LIVE);
ok(r.status === 200 && lastSession().metadata.aob_prog_verified === 'unverified' && !lastSession().metadata.aob_prog_pi, 'room only for 6 guests: one earlier €888 payment doesn\'t cover them');
store.sessions.get(lastSession().id).status = 'expired';
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite', { email: 'paid@example.com' })], 'deposit', { programme: 'paid' }), LIVE);
const csVer = r.data.session_id;
ok(r.status === 200 && lastSession().metadata.aob_prog_verified === 'stripe' && lastSession().metadata.aob_prog_pi === 'pi_prevfee:88800', 'room only: earlier programme-fee payment found in Stripe → possible match, payment recorded');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(8, 'twin-ensuite', { email: 'paid@example.com' })], 'deposit', { programme: 'paid' }), LIVE, ip(41));
ok(r.status === 200 && lastSession().metadata.aob_prog_verified === 'unverified', 'room only: the same earlier payment can\'t verify a second booking');
complete(csVer);
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
ok(r.data.bookings.some(b => b.programme_verified === 'stripe' && b.programme_payments.length === 1 && b.programme_payments[0].id === 'pi_prevfee' && b.programme_payments[0].cents === 88800), 'admin sees which earlier payment was matched');
store.customers.push({ id: 'cus_ref', email: 'refunded@example.com' });
store.pis.set('pi_reffee', { id: 'pi_reffee', status: 'succeeded', amount: 88800, amount_received: 88800, currency: 'eur', created: nowS() - 10 * 86400, customer: 'cus_ref', metadata: {}, _refunded: 88800 });
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite', { email: 'refunded@example.com' })], 'deposit', { programme: 'paid' }), LIVE);
ok(lastSession().metadata.aob_prog_verified === 'unverified', 'room only: a refunded programme payment doesn\'t count');
store.customers.push({ id: 'cus_old', email: 'lastyear@example.com' });
store.pis.set('pi_oldfee', { id: 'pi_oldfee', status: 'succeeded', amount: 88800, amount_received: 88800, currency: 'eur', created: Date.parse('2025-09-01T00:00:00Z') / 1000, customer: 'cus_old', metadata: {} });
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite', { email: 'lastyear@example.com' })], 'deposit', { programme: 'paid' }), LIVE);
ok(lastSession().metadata.aob_prog_verified === 'unverified', 'room only: last year\'s programme payment doesn\'t count');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'twin-ensuite')], 'deposit', { programme: 'paid' }), LIVE);
ok(r.status === 200 && lastSession().metadata.aob_prog_verified === 'unverified', 'room only: nothing found → unverified (still booked)');
store.customers.push({ id: 'cus_own', email: 'own@example.com' });
store.pis.set('pi_ownbooking', { id: 'pi_ownbooking', status: 'succeeded', amount: 177600, amount_received: 177600, currency: 'eur', created: nowS() - 86400, customer: 'cus_own', metadata: { aob_kind: 'booking' } });
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite', { email: 'own@example.com' })], 'deposit', { programme: 'paid' }), LIVE);
ok(lastSession().metadata.aob_prog_verified === 'unverified', 'our own earlier booking doesn\'t count as a programme payment');
fault('GET', /^\/customers\/search$/, { status: 500 });
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite', { email: 'paid@example.com' })], 'deposit', { programme: 'paid' }), LIVE);
ok(r.status === 200 && lastSession().metadata.aob_prog_verified === 'unverified', 'verification failure never blocks the booking');

/* ================================================================== webhook event matrix */
reset();
const mk = async (room, payment = 'deposit', extra = {}, email) => {
  const res = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(email || 1, room)], payment, extra), LIVE, ip(30));
  return res.data.session_id;
};
let ghlBefore;
// GHL down → 500 so Stripe retries; nothing marked; the retry forwards once
let csW = await mk('twin-ensuite', 'deposit', { diet: 'vegetarian' });
complete(csW);
store.ghlStatus = 500;
wr = await hook({ id: 'evt_retry', ...sessionEvent('checkout.session.completed', csW) });
ok(wr.status === 500 && !store.pis.get(store.sessions.get(csW).payment_intent).metadata.aob_ghl, 'GHL 500 → webhook 500 (Stripe retries), not marked');
store.ghlStatus = 200; ghlBefore = store.ghl.length;
wr = await hook({ id: 'evt_retry', ...sessionEvent('checkout.session.completed', csW) });
ok(wr.status === 200 && store.ghl.length === ghlBefore + 1 && store.ghl.at(-1).diet === 'vegetarian' && store.ghl.at(-1).event_id === 'evt_retry', 'retry succeeds and forwards once (with diet)');
// unpaid (bank debit processing) → pending, then async success → paid, async failure → failed
csW = await mk('twin-ensuite', 'deposit', {}, 2);
complete(csW, { pi: 'processing' });
wr = await hook(sessionEvent('checkout.session.completed', csW));
ok(wr.status === 200 && store.ghl.at(-1).event === 'booking_pending' && store.ghl.at(-1).amount_paid === '0.00' && store.ghl.at(-1).tag === `${P}-pending`, 'completed but unpaid → booking_pending');
store.pis.get(store.sessions.get(csW).payment_intent).status = 'succeeded';
wr = await hook(sessionEvent('checkout.session.async_payment_succeeded', csW, { payment_status: 'paid' }));
ok(wr.status === 200 && store.ghl.at(-1).event === 'booking_paid', 'async payment succeeded → booking_paid');
csW = await mk('twin-ensuite', 'deposit', {}, 3);
complete(csW, { pi: 'processing' });
wr = await hook(sessionEvent('checkout.session.async_payment_failed', csW));
ok(wr.status === 200 && store.ghl.at(-1).event === 'booking_payment_failed' && store.ghl.at(-1).tag === `${P}-payment-failed`, 'async payment failed → booking_payment_failed');
// expired: only with the reminder opt-in, and not when they're booking again
csW = await mk('glamping-single', 'deposit', { remind: true }, 4);
store.sessions.get(csW).status = 'expired'; // given back by the guest ("Change booking details")
ghlBefore = store.ghl.length;
wr = await hook({ created: nowS(), ...sessionEvent('checkout.session.expired', csW) });
ok(wr.status === 200 && wr.text === 'released, not abandoned' && store.ghl.length === ghlBefore, 'checkout given back by the guest → no "finish your booking" email');
tick(31 * 60); // now it has timed out
wr = await hook({ created: nowS(), ...sessionEvent('checkout.session.expired', csW) });
ok(wr.status === 200 && store.ghl.length === ghlBefore + 1 && store.ghl.at(-1).event === 'booking_abandoned' && store.ghl.at(-1).resume_url === 'https://alchemyofbreath.com/book/breathcamp-oct-2026/' && store.ghl.at(-1).tag === `${P}-abandoned`, 'expired with reminder opt-in → booking_abandoned linking to our page');
ok(!('url' in store.ghl.at(-1)) && !JSON.stringify(store.ghl.at(-1)).includes('checkout.stripe.com'), 'no Stripe recovery link in the reminder');
csW = await mk('glamping-single', 'deposit', {}, 5);
store.sessions.get(csW).status = 'expired';
ghlBefore = store.ghl.length;
wr = await hook(sessionEvent('checkout.session.expired', csW));
ok(wr.status === 200 && store.ghl.length === ghlBefore, 'expired without opt-in → nothing sent');
const csOld = await mk('glamping-single', 'deposit', { remind: true }, 6);
const csNew = await mk('glamping-single', 'full', { remind: true }, 6); // same person, new checkout (old one expired)
ok(store.sessions.get(csOld).status === 'expired' && store.sessions.get(csNew).status === 'open', 'new checkout replaced the old one');
ghlBefore = store.ghl.length;
wr = await hook({ created: nowS(), ...sessionEvent('checkout.session.expired', csOld) });
ok(wr.status === 200 && wr.text === 'released, not abandoned' && store.ghl.length === ghlBefore, 'replaced checkout → no reminder');
tick(31 * 60);
wr = await hook({ created: nowS(), ...sessionEvent('checkout.session.expired', csOld) });
ok(wr.status === 200 && wr.text === 'still booking' && store.ghl.length === ghlBefore, 'no reminder while they\'re still booking');
complete(csNew);
wr = await hook({ created: nowS(), ...sessionEvent('checkout.session.expired', csOld) });
ok(wr.text === 'already booked' && store.ghl.length === ghlBefore, 'no reminder once they have booked');
// plans: instalments, failures, end
csW = await mk('glamping-twin', 'plan', {}, 7);
const subW = complete(csW);
const subMd = { ...store.subs.get(subW).metadata };
store.invoices.push({ subscription: subW, status: 'paid', amount_paid: 68000 });
wr = await hook({ type: 'invoice.paid', data: { object: { id: 'in_1', object: 'invoice', subscription: subW, billing_reason: 'subscription_cycle', amount_paid: 68000, amount_due: 68000, currency: 'eur', subscription_details: { metadata: subMd } } } });
ok(wr.status === 200 && store.ghl.at(-1).event === 'plan_payment_paid' && store.ghl.at(-1).paid_count === 2 && store.ghl.at(-1).amount_paid === '680.00' && store.subs.get(subW).cancel_at, 'invoice.paid (instalment) → plan_payment_paid, and the plan end is set');
ghlBefore = store.ghl.length;
wr = await hook({ type: 'invoice.paid', data: { object: { id: 'in_0', subscription: subW, billing_reason: 'subscription_create', amount_paid: 1, currency: 'eur', subscription_details: { metadata: subMd } } } });
ok(wr.status === 200 && store.ghl.length === ghlBefore, 'first invoice ignored (checkout.session.completed covers it)');
wr = await hook({ type: 'invoice.payment_failed', data: { object: { id: 'in_2', parent: { subscription_details: { subscription: subW } }, billing_reason: 'subscription_cycle', amount_paid: 0, amount_due: 68000, currency: 'eur', hosted_invoice_url: 'https://invoice.stripe.com/i/mock', attempt_count: 1 } } });
ok(wr.status === 200 && store.ghl.at(-1).event === 'plan_payment_failed' && store.ghl.at(-1).hosted_invoice_url === 'https://invoice.stripe.com/i/mock' && store.ghl.at(-1).ref === subMd.aob_ref, 'invoice.payment_failed (new invoice shape, metadata fetched) → plan_payment_failed');
wr = await hook({ type: 'customer.subscription.deleted', data: { object: { ...store.subs.get(subW), status: 'canceled' } } });
ok(wr.status === 200 && store.ghl.at(-1).event === 'plan_ended' && store.ghl.at(-1).paid_count === 2 && store.ghl.at(-1).installments === 3 && store.ghl.at(-1).completed === 'no', 'subscription deleted → plan_ended with payments made');
// mode mismatch, no GHL, unknown events
ghlBefore = store.ghl.length;
csW = await mk('twin-ensuite', 'deposit', {}, 8); complete(csW);
wr = await hook({ livemode: true, ...sessionEvent('checkout.session.completed', csW) });
ok(wr.status === 200 && /other mode/.test(wr.text) && store.ghl.length === ghlBefore, 'live event on a test key ignored');
wr = await hook(sessionEvent('checkout.session.completed', csW), { ...LIVE, GHL_WEBHOOK_URL: '' });
ok(wr.status === 200 && store.ghl.length === ghlBefore, 'no GHL URL: acknowledged, nothing sent');
wr = await hook({ type: 'charge.succeeded', data: { object: {} } });
ok(wr.status === 200 && wr.text === 'ignored', 'other events ignored');
ok(store.ghl.every(x => x.event_id && /^evt_/.test(x.event_id)), 'every GHL payload has the Stripe event id');

/* ================================================================== lead (reminder opt-in) */
reset();
const leadBody = (extra = {}) => ({ program: P, attempt: 'a1', first: 'Ana', last: 'Lee', email: 'ana@example.com', whatsapp: '0044 7700 900123', guests: 2, room: 'twin-ensuite', consent: true,
  page: 'https://alchemyofbreath.com/book/breathcamp-oct-2026/', utm: { utm_source: 'newsletter', other: 'x' }, ...extra });
r = await call(lead, 'POST', '/api/booking/lead', leadBody({ consent: false }), LIVE);
ok(r.status === 422 && r.data.fields.consent && store.ghl.length === 0, 'lead without consent refused');
r = await call(lead, 'POST', '/api/booking/lead', leadBody({ email: 'nope' }), LIVE);
ok(r.status === 422 && r.data.fields.email, 'lead needs a valid email');
r = await call(lead, 'POST', '/api/booking/lead', leadBody(), LIVE);
let g = store.ghl.at(-1);
ok(r.status === 202 && r.data.ok && g.event === 'booking_started' && g.tag === `${P}-started` && g.consent_text === 'Email me a link to finish my booking if I get interrupted', 'lead forwarded to GHL with the consent text');
ok(g.phone === '+447700900123' && g.guests === 2 && g.room === 'twin-ensuite' && g.resume_url === 'https://alchemyofbreath.com/book/breathcamp-oct-2026/' && g.utm_source === 'newsletter' && !('other' in g), 'lead payload: phone, guests, room, resume link, UTMs');
let ghlN = store.ghl.length;
r = await call(lead, 'POST', '/api/booking/lead', leadBody(), LIVE);
ok(r.status === 202 && store.ghl.length === ghlN, 'one booking_started per email address per day');
r = await call(lead, 'POST', '/api/booking/lead', leadBody({ email: 'phish-test@example.com', page: 'https://evil.example/phish' }), LIVE);
ok(store.ghl.at(-1).resume_url === 'https://website-5h3.pages.dev/book/breathcamp-oct-2026/', 'lead resume link never points off-site');
r = await call(lead, 'POST', '/api/booking/lead', leadBody({ email: 'path-test@example.com', page: 'https://alchemyofbreath.com//evil.example/x' }), LIVE);
ok(store.ghl.at(-1).resume_url === 'https://alchemyofbreath.com/book/breathcamp-oct-2026/' && store.ghl.at(-1).consent_verified === 'no', 'lead resume link is always our booking page; consent marked unverified');
r = await call(lead, 'POST', '/api/booking/lead', leadBody({ email: 'relay@example.com', first: 'Your refund is ready: visit evil.example' }), LIVE);
ok(r.status === 422 && r.data.fields.first, 'lead: a name carrying a link is refused');
ghlN = store.ghl.length;
r = await call(lead, 'POST', '/api/booking/lead', leadBody({ email: 'live-no-ts@example.com' }), { ...LIVE, STRIPE_SECRET_KEY: 'sk_live_mock' });
ok(r.status === 202 && store.ghl.length === ghlN, 'live mode without the bot check: reminders are off (nothing forwarded)');
r = await availGet({ ...LIVE, STRIPE_SECRET_KEY: '' });
ok(r.data.remind === true, 'availability: reminder on with GHL (test/demo mode)');
r = await availGet({});
ok(r.data.remind === false, 'availability: reminder off without GHL');
store.ghlStatus = 500;
r = await call(lead, 'POST', '/api/booking/lead', leadBody(), LIVE);
ok(r.status === 202, 'GHL down: the guest still gets 202');
store.ghlStatus = 200;
r = await call(lead, 'POST', '/api/booking/lead', leadBody(), {});
ok(r.status === 202, 'lead without GHL configured: 202');
r = await call(lead, 'POST', '/api/booking/lead', leadBody(), LIVE, { 'Content-Type': 'text/plain' });
ok(r.status === 415, 'lead needs JSON');
for (let i = 0; i < 6; i++) r = await call(lead, 'POST', '/api/booking/lead', leadBody(), LIVE, ip(77));
ok(r.status === 202, 'six leads from one visitor in 10 minutes');
r = await call(lead, 'POST', '/api/booking/lead', leadBody(), LIVE, ip(77));
ok(r.status === 429, 'seventh is rate limited');

/* ================================================================== Turnstile */
reset();
const TS = { ...LIVE, TURNSTILE_SITE_KEY: '0x4AAAAmock', TURNSTILE_SECRET: '0x4AAAAsecret' };
r = await availGet(TS);
ok(r.data.turnstile_site_key === '0x4AAAAmock', 'availability hands out the Turnstile site key');
r = await availGet({ ...LIVE, TURNSTILE_SITE_KEY: '0x4AAAAmock' });
ok(r.data.turnstile_site_key === null, 'no site key without the secret');
r = await call(health, 'GET', '/api/booking/health', null, TS);
ok(r.data.turnstile === true, 'health: Turnstile on');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), TS, ip(5));
ok(r.status === 403 && r.data.code === 'turnstile', 'checkout without a Turnstile token refused');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { turnstile: 'bad-token' }), TS, ip(5));
ok(r.status === 403 && store.turnstile.at(-1).remoteip === '203.0.113.5', 'invalid token refused (sent with the visitor IP)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { turnstile: 'good-token' }), TS, ip(5));
ok(r.status === 200, 'valid token accepted');
store.turnstileDown = true;
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'twin-ensuite')], 'deposit', { turnstile: 'whatever' }), TS, ip(6));
ok(r.status === 200, 'Turnstile unreachable: bookings continue');
store.turnstileDown = false;
store.turnstileReply = { status: 400, body: { success: false, 'error-codes': ['invalid-input-response'] } };
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite')], 'deposit', { turnstile: 'garbage' }), TS, ip(7));
ok(r.status === 403 && r.data.code === 'turnstile', 'siteverify 400 + invalid-input-response → refused (decided on the answer, not the HTTP status)');
store.turnstileReply = { status: 400, body: { success: false, 'error-codes': ['timeout-or-duplicate'] } };
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite')], 'deposit', { turnstile: 'replayed' }), TS, ip(7));
ok(r.status === 403, 'a replayed token is refused');
store.turnstileReply = { status: 400, body: { success: false, 'error-codes': ['invalid-input-secret'] } };
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite')], 'deposit', { turnstile: 'x' }), TS, ip(7));
ok(r.status === 200, 'our own secret broken → bookings continue (logged)');
store.turnstileReply = null;
const TS_LIVE = { ...TS, STRIPE_SECRET_KEY: 'sk_live_mock' };
store.turnstileReply = { status: 200, body: { success: true, hostname: 'evil.example', action: 'booking' } };
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(4, 'twin-ensuite')], 'deposit', { turnstile: 'other-site' }), TS_LIVE, ip(7));
ok(r.status === 403, 'live mode: a token solved on another hostname is refused');
store.turnstileReply = { status: 200, body: { success: true, hostname: 'alchemyofbreath.com', action: 'login' } };
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(4, 'twin-ensuite')], 'deposit', { turnstile: 'other-action' }), TS_LIVE, ip(7));
ok(r.status === 403, 'live mode: a token from another widget action is refused');
store.turnstileReply = null;
const HALF = { ...LIVE, TURNSTILE_SECRET: '0x4AAAAsecret' };
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(5, 'twin-ensuite')]), HALF, ip(7));
ok(r.status === 200, 'secret without a site key: the page shows no widget, so the check is off (not a 403 for everyone)');
r = await call(health, 'GET', '/api/booking/health', null, HALF);
ok(r.data.turnstile === false && r.data.turnstile_status === 'misconfigured', 'health says the bot check is misconfigured');
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, HALF, AUTH);
ok(r.data.setup.turnstile_status === 'misconfigured', 'admin setup says so too');
r = await call(balance, 'GET', '/api/booking/balance', null, TS);
ok(r.data.turnstile_site_key === '0x4AAAAmock', 'balance page gets the Turnstile site key');
r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: 'BC2610-AAAAAA', email: 'a@b.co' }, TS, ip(9));
ok(r.status === 403 && r.data.code === 'turnstile', 'balance lookup needs the bot check when it is on');
let calls0 = store.calls.length;
r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: 'ZZ9999-AAAAAA', email: 'a@b.co' }, LIVE, ip(9));
ok(r.status === 404 && store.calls.length === calls0, 'a reference no program issues costs no Stripe calls');
store.turnstileDown = false;
r = await call(lead, 'POST', '/api/booking/lead', leadBody(), TS, ip(8));
ok(r.status === 403, 'lead without a token refused when Turnstile is on');
r = await call(lead, 'POST', '/api/booking/lead', leadBody({ turnstile: 'good-token' }), TS, ip(8));
ok(r.status === 202, 'lead with a token accepted');

/* the page gets a public copy of the program: no internal notes */
{
  const html = readFileSync(new URL('../../book/breathcamp-oct-2026/index.html', import.meta.url), 'utf8');
  const m = html.match(/<script type="application\/json" id="programData">([\s\S]*?)<\/script>/);
  const pub = JSON.parse(m[1]);
  const keys = []; (function walk(v, path) { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(path + k); walk(x, path + k + '.'); } })(pub, '');
  ok(!keys.some(k => /(^|\.)about$/.test(k)) && !pub.rooms.some(r => 'rg_id' in r) && !pub.policy.source && !pub.trust.source && !pub.arrival.source, 'page data: no "about" notes, RetreatGuru ids or source notes');
  ok(pub.source && pub.source.snapshot === PROG.source.snapshot && Object.keys(pub.source).length === 1 && pub.trust.rating.source === 'Trustpilot', 'page data keeps the snapshot date and the rating source it shows');
  ok(/^https:\/\/cdn\.jsdelivr\.net\/gh\/Alchemy-of-Breath\/website@[0-9a-f]{40}\/assets\/booking\/rooms\/$/.test(pub.img_cdn) && html.includes(`<img id="heroImg" src="${pub.img_cdn}asha-campus.jpg"`), 'room photos and the hero are pinned to a commit on jsDelivr');
  ok(PROG.programme.about && PROG.rooms[0].rg_id, 'the server copy keeps its notes');
}

/* nothing personal in the logs */
ok(logs.length > 0 && logs.every(l => !l.includes('@')), 'failure logs carry no email addresses');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
