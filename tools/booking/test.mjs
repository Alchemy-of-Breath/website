// End-to-end tests for the booking functions against an in-memory Stripe mock.
//   node tools/booking/test.mjs
import * as health from '../../functions/api/booking/health.js';
import * as avail from '../../functions/api/booking/availability.js';
import * as checkout from '../../functions/api/booking/checkout.js';
import * as session from '../../functions/api/booking/session.js';
import * as balance from '../../functions/api/booking/balance.js';
import * as admin from '../../functions/api/booking/admin.js';
import * as webhook from '../../functions/api/booking/webhook.js';
import { verifyStripeSignature } from '../../booking-lib/core.js';

/* ---------- clock: 1 July 2026, so all 3 plan payments fit before the October arrival ---------- */
const RealDate = Date;
let fakeNow = RealDate.parse('2026-07-01T09:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [fakeNow])); }
  static now() { return fakeNow; }
};

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } };
const P = 'breathcamp-oct-2026', ORIGIN = 'https://alchemyofbreath.com';

/* ---------- Stripe mock ---------- */
const store = { sessions: new Map(), pis: new Map(), subs: new Map(), invoices: [], ghl: [], seq: 0 };
function parseForm(body) {
  const out = {};
  for (const pair of body.split('&')) {
    const [k, v] = pair.split('=').map(decodeURIComponent);
    const keys = k.replace(/\]/g, '').split('[');
    let o = out;
    keys.forEach((key, i) => { if (i === keys.length - 1) o[key] = v; else o = (o[key] ??= {}); });
  }
  return out;
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://ghl.example/')) { store.ghl.push(JSON.parse(init.body)); return new Response('ok'); }
  if (!url.startsWith('https://api.stripe.com/v1')) return realFetch(url, init);
  const u = new URL(url), path = u.pathname.replace('/v1', ''), method = init.method || 'GET';
  const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (method === 'POST' && path === '/checkout/sessions') {
    const b = parseForm(init.body), id = `cs_test_mock${++store.seq}abcdef`;
    const total = Object.values(b.line_items).reduce((a, li) => a + (+li.price_data.unit_amount) * (+li.quantity || 1), 0);
    const s = { id, mode: b.mode || 'payment', subscription: null, status: 'open', payment_status: 'unpaid', metadata: b.metadata || {}, amount_total: total,
      currency: b.line_items[0].price_data.currency, created: Math.floor(Date.now() / 1000), customer: b.customer || null, url: `https://checkout.stripe.com/c/pay/${id}`, payment_intent: null, expires_at: +b.expires_at, _params: b };
    store.sessions.set(id, s); return J(s);
  }
  if (method === 'GET' && path === '/checkout/sessions') {
    const st = u.searchParams.get('status');
    return J({ data: [...store.sessions.values()].filter(s => s.status === st), has_more: false });
  }
  if (method === 'GET' && path.startsWith('/checkout/sessions/')) {
    const s = store.sessions.get(path.split('/').pop()); return s ? J(s) : J({ error: { message: 'No such session' } }, 404);
  }
  if (method === 'GET' && path === '/payment_intents/search') {
    const q = u.searchParams.get('query');
    const conds = [...q.matchAll(/metadata\['(\w+)'\]:'([^']+)'/g)].map(m => [m[1], m[2]]);
    const data = [...store.pis.values()].filter(pi => pi.status === 'succeeded' && !pi._lagging && conds.every(([k, v]) => pi.metadata[k] === v));
    return J({ data, has_more: false, next_page: null });
  }
  if (method === 'GET' && path === '/subscriptions/search') {
    const q = u.searchParams.get('query');
    const conds = [...q.matchAll(/metadata\['(\w+)'\]:'([^']+)'/g)].map(m => [m[1], m[2]]);
    return J({ data: [...store.subs.values()].filter(x => !x._lagging && conds.every(([k, v]) => x.metadata[k] === v)), has_more: false, next_page: null });
  }
  if (path.startsWith('/subscriptions/')) {
    const sub = store.subs.get(path.split('/').pop());
    if (!sub) return J({ error: { message: 'No such subscription' } }, 404);
    if (method === 'GET') return J(sub);
    if (method === 'DELETE') { sub.status = 'canceled'; return J(sub); }
    if (method === 'POST') {
      if (sub.status === 'canceled') return J({ error: { message: 'You cannot update a canceled subscription.' } }, 400);
      const f = parseForm(init.body);
      if (f.metadata) Object.assign(sub.metadata, f.metadata);
      if (f.cancel_at) { sub.cancel_at = +f.cancel_at; sub._proration = f.proration_behavior; }
      return J(sub);
    }
  }
  if (method === 'GET' && path === '/invoices') {
    const sid = u.searchParams.get('subscription');
    return J({ data: store.invoices.filter(i => i.subscription === sid && i.status === 'paid'), has_more: false });
  }
  if (method === 'POST' && path.startsWith('/payment_intents/')) {
    const pi = store.pis.get(path.split('/').pop()); Object.assign(pi.metadata, parseForm(init.body).metadata || {}); return J(pi);
  }
  return J({ error: { message: 'mock: unhandled ' + method + ' ' + path } }, 400);
};
function complete(sessionId, { lagging = false } = {}) {
  const s = store.sessions.get(sessionId);
  if (s.mode === 'subscription') {
    const id = `sub_mock${++store.seq}`, now = Math.floor(Date.now() / 1000);
    s.status = 'complete'; s.payment_status = 'paid'; s.subscription = id; s.customer = s.customer || 'cus_mock2';
    store.subs.set(id, { id, status: 'active', metadata: { ...s.metadata }, billing_cycle_anchor: now, start_date: now, created: now,
      current_period_end: now + 30 * 86400, cancel_at: null, customer: s.customer, _lagging: lagging });
    store.invoices.push({ subscription: id, status: 'paid', amount_paid: s.amount_total });
    return id;
  }
  const id = `pi_mock${++store.seq}`;
  s.status = 'complete'; s.payment_status = 'paid'; s.payment_intent = id; s.customer = s.customer || 'cus_mock1';
  store.pis.set(id, { id, status: 'succeeded', amount_received: s.amount_total, created: s.created, customer: s.customer, metadata: { ...s.metadata }, _lagging: lagging });
  return id;
}

/* ---------- helpers ---------- */
const req = (method, path, body, headers = {}) => new Request('https://website-5h3.pages.dev' + path, {
  method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
const call = async (mod, method, path, body, env = {}, headers) => {
  const r = await mod['onRequest' + method[0] + method.slice(1).toLowerCase()]({ request: req(method, path, body, headers), env });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};
const guest = (n, room, extra = {}) => ({ first: 'Test' + n, last: 'Guest', email: `t${n}@example.com`, gender: 'Female', room, ...extra });
const booking = (guests, payment = 'deposit', extra = {}) => ({ program: P, payment, guests, whatsapp: '+44 7700 900123', terms: true, return_url: 'https://alchemyofbreath.com/book/breathcamp-oct-2026/', page: 'https://alchemyofbreath.com/book/breathcamp-oct-2026/', utm: { utm_source: 'facebook', utm_campaign: 'bc5' }, ...extra });
const LIVE = { STRIPE_SECRET_KEY: 'sk_test_mock', ADMIN_TOKEN: 'admin-token-1234567890', STRIPE_WEBHOOK_SECRET: 'whsec_mocksecret', GHL_WEBHOOK_URL: 'https://ghl.example/hook' };

/* ---------- demo mode ---------- */
let r = await call(health, 'GET', '/api/booking/health');
ok(r.status === 200 && r.data.stripe.startsWith('not connected'), 'health demo');
ok(r.headers.get('Access-Control-Allow-Origin') === ORIGIN, 'CORS allows alchemyofbreath.com');
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`);
ok(r.data.program_left === 17 && r.data.rooms['single-ensuite'].sold_out && r.data.rooms['twin-ensuite'].left.female === 10, 'demo availability');
ok(r.data.rooms['twin-shared-bath'].left.female === 2 && r.data.rooms['twin-shared-bath'].left.male === 2 && r.data.rooms['triple-ensuite'].left.male === 3, 'room with an unknown-gender occupant stays off sale');
r = await call(checkout, 'POST', '/api/booking/checkout', { program: P, guests: [{ first: '' }], terms: false });
ok(r.status === 422 && r.data.fields['guests.0.email'] && r.data.fields.whatsapp && r.data.fields.terms, 'validation errors');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')]));
ok(r.data.demo && r.data.quote.total_cents === 459000 && r.data.quote.due_now_cents === 233880 && r.data.quote.balance_cents === 225120, 'demo quote: 2 × (€888 programme + €1,407 room), programme + 20% room deposit today');
const li = r.data.stripe_params.line_items;
ok(r.data.stripe_params.success_url.includes('{CHECKOUT_SESSION_ID}') && li.length === 2 && li[0].quantity === 2 && li[0].price_data.unit_amount === 88800 && li[1].price_data.unit_amount === 56280, 'checkout lines: programme fee × 2, then the room deposit');
ok(li.reduce((a, l) => a + l.price_data.unit_amount * l.quantity, 0) === r.data.quote.due_now_cents, 'checkout lines add up to the amount due today');
ok(r.data.stripe_params.metadata.aob_prog === 'included' && r.data.stripe_params.metadata.aob_prog_total === '177600', 'programme fee in the metadata');
ok(r.data.stripe_params.metadata.aob_rooms === 'twin-ensuite:2' && r.data.stripe_params.metadata.utm_source === 'facebook', 'metadata');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'full'));
ok(r.data.quote.due_now_cents === 229500 && r.data.quote.balance_cents === 0 && r.data.stripe_params.line_items[1].price_data.unit_amount === 140700, 'pay in full: €888 + €1,407');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')], 'deposit', { programme: 'paid' }));
ok(r.data.quote.programme === 'paid' && r.data.quote.total_cents === 281400 && r.data.quote.due_now_cents === 56280 && r.data.stripe_params.line_items.length === 1, 'room only (programme already paid): 20% of €2,814');
ok(r.data.stripe_params.metadata.aob_prog === 'paid' && r.data.stripe_params.metadata.aob_prog_total === '0', 'room-only booking flagged in the metadata');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'single-ensuite')]));
ok(r.status === 409 && /sold out/i.test(r.data.error), 'sold-out room rejected');
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
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`);
ok(r.data.payment_plan && r.data.payment_plan.available === true && r.data.payment_plan.installments === 3 && r.data.payment_plan.last_payment_by === '2026-10-24', 'plan offered on 1 July (last payment by the day before arrival)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-shared-bath')], 'plan'));
ok(r.data.demo && r.data.quote.plan.installment_cents === 68633 && r.data.quote.due_now_cents === 68634 && r.data.quote.balance_cents === 137266, 'plan split: (€888 + €1,171) in 3, cent on the first');
ok(r.data.stripe_params.mode === 'subscription' && r.data.stripe_params.line_items[0].price_data.recurring.interval === 'month' && r.data.stripe_params.line_items[1].price_data.unit_amount === 1, 'plan uses a monthly subscription + rounding line');
ok(r.data.stripe_params.subscription_data.metadata.aob_plan_n === '3' && !r.data.stripe_params.payment_intent_data, 'plan metadata on the subscription');

fakeNow = RealDate.parse('2026-08-25T09:00:00Z'); // 3rd payment on 25 Oct = arrival day: too late
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`);
ok(r.data.payment_plan.available === false && /2026-10-24/.test(r.data.payment_plan.reason), 'plan hidden when the last payment would fall on arrival day');
fakeNow = RealDate.parse('2026-10-03T09:00:00Z');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-shared-bath')], 'plan'));
ok(r.status === 422 && /payment plan/.test(r.data.error), 'plan refused on 3 October (payments would run past arrival)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-shared-bath')], 'deposit'));
ok(r.data.demo && r.data.quote.due_now_cents === 88800 + 23420, 'deposit still offered on 3 October');
fakeNow = RealDate.parse('2026-07-01T09:00:00Z');

/* ---------- live (mock Stripe) ---------- */
r = await call(health, 'GET', '/api/booking/health', null, LIVE);
ok(r.data.stripe === 'test' && r.data.webhook && r.data.admin && r.data.ghl, 'health live');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')]), LIVE);
ok(r.status === 200 && r.data.url && r.data.ref, 'live checkout opens Stripe');
const ref1 = r.data.ref, cs1 = [...store.sessions.keys()].pop();
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`, null, LIVE);
ok(r.data.rooms['twin-ensuite'].left.female === 8 && r.data.program_left === 15, 'open checkout holds places');
complete(cs1, { lagging: true }); // paid, but not yet in Stripe's search index
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`, null, LIVE);
ok(r.data.rooms['twin-ensuite'].left.female === 8 && r.data.program_left === 15, 'paid booking counted while search lags');
store.pis.forEach(pi => { pi._lagging = false; });
r = await call(session, 'GET', `/api/booking/session?id=${cs1}`, null, LIVE);
ok(r.data.ref === ref1 && r.data.paid && r.data.amount_paid_cents === 233880 && r.data.balance_cents === 225120 && r.data.first_name === 'Test1', 'session summary');
ok(r.data.programme === 'included' && r.data.programme_cents === 177600, 'confirmation knows the programme fee was paid');

// fill the week: 15 places left → book 6 + 6, then 3 left
for (const n of [6, 6]) {
  r = await call(checkout, 'POST', '/api/booking/checkout', booking(Array.from({ length: n }, (_, i) => guest(i, ['glamping-single', 'glamping-twin', 'twin-ensuite'][i % 3]))), LIVE);
  ok(r.status === 200, `book ${n} more`); complete([...store.sessions.keys()].pop());
}
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`, null, LIVE);
ok(r.data.program_left === 3, 'program cap tracks bookings (3 left)');
r = await call(checkout, 'POST', '/api/booking/checkout', booking(Array.from({ length: 4 }, (_, i) => guest(i, 'twin-ensuite'))), LIVE);
ok(r.status === 409 && /Only 3 places are left this week/.test(r.data.error), 'program cap enforced');

// balance self-service
r = await call(balance, 'POST', '/api/booking/balance', { ref: ref1, email: 'wrong@example.com' }, LIVE);
ok(r.status === 404, 'balance: wrong email refused');
r = await call(balance, 'POST', '/api/booking/balance', { ref: ref1.toLowerCase(), email: 'T1@example.com' }, LIVE);
ok(r.status === 200 && r.data.url && r.data.balance_cents === 225120, 'balance: checkout for the remaining €2,251.20');
const csBal = [...store.sessions.keys()].pop();
ok(store.sessions.get(csBal)._params.customer === 'cus_mock1' && store.sessions.get(csBal).metadata.aob_kind === 'balance', 'balance linked to same customer');
complete(csBal);
r = await call(balance, 'POST', '/api/booking/balance', { ref: ref1, email: 't1@example.com' }, LIVE);
ok(r.data.paid_in_full === true, 'balance: paid in full afterwards');
r = await call(session, 'GET', `/api/booking/session?id=${csBal}`, null, LIVE);
ok(r.data.kind === 'balance' && r.data.balance_cents === 0, 'balance session shows nothing left');

// admin
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE);
ok(r.status === 401, 'admin needs token');
const AUTH = { Authorization: 'Bearer ' + LIVE.ADMIN_TOKEN };
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
const b1 = r.data.bookings && r.data.bookings.find(b => b.ref === ref1);
ok(r.status === 200 && r.data.totals.bookings === 3 && r.data.totals.guests === 14, 'admin totals');
ok(b1 && b1.paid_cents === 459000 && b1.balance_cents === 0 && b1.guests.length === 2 && b1.lead.whatsapp === '+447700900123', 'admin booking detail');
ok(b1 && b1.programme === 'included' && b1.programme_cents === 177600, 'admin shows the programme fee');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'cancel', ref: ref1 }, LIVE, AUTH);
ok(r.data.ok && r.data.status === 'cancelled', 'admin cancel');
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`, null, LIVE);
ok(r.data.program_left === 5, 'cancelled booking frees its places');
const ref2 = [...store.pis.values()].find(p => p.metadata.aob_kind === 'booking' && p.metadata.aob_ref !== ref1).metadata.aob_ref;
r = await call(admin, 'POST', '/api/booking/admin', { action: 'balance_link', ref: ref2 }, LIVE, AUTH);
ok(r.status === 200 && r.data.url && r.data.expires_at - Date.now() / 1000 > 23 * 3600, 'admin balance link valid ~24h');

// webhook
const evt = JSON.stringify({ type: 'checkout.session.completed', data: { object: store.sessions.get(cs1) } });
const t = Math.floor(Date.now() / 1000);
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(LIVE.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${evt}`))), b => b.toString(16).padStart(2, '0')).join('');
ok(await verifyStripeSignature(evt, `t=${t},v1=${sig}`, LIVE.STRIPE_WEBHOOK_SECRET), 'signature verifies');
let wr = await webhook.onRequestPost({ request: new Request('https://x/api/booking/webhook', { method: 'POST', body: evt, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` } }), env: LIVE });
ok(wr.status === 200 && store.ghl.length === 1 && store.ghl[0].ref === ref1 && store.ghl[0].phone === '+447700900123' && store.ghl[0].utm_source === 'facebook', 'webhook forwards booking to GHL');
ok(store.ghl[0].programme === 'included' && store.ghl[0].programme_total === '1776.00' && store.ghl[0].total === '4590.00', 'GHL gets the programme fee and the full total');
wr = await webhook.onRequestPost({ request: new Request('https://x/api/booking/webhook', { method: 'POST', body: evt, headers: { 'Stripe-Signature': `t=${t},v1=deadbeef` } }), env: LIVE });
ok(wr.status === 400, 'bad signature rejected');

// single-gender rooms: one woman books a twin, the other bed is now for a woman only
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-shared-bath')]), LIVE);
ok(r.status === 200, 'woman books twin with shared bathroom'); complete([...store.sessions.keys()].pop());
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`, null, LIVE);
ok(r.data.rooms['twin-shared-bath'].left.female === 1 && r.data.rooms['twin-shared-bath'].left.male === 0, 'remaining bed is for women only');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(9, 'twin-shared-bath', { gender: 'Male' })]), LIVE);
ok(r.status === 409 && /no places left for men/.test(r.data.error), 'man refused for that room');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(8, 'twin-shared-bath')]), LIVE);
ok(r.status === 200, 'another woman can take the bed');
r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
ok(r.data.rooms.find(x => x.id === 'twin-shared-bath').capacity === 3 && r.data.availability.rooms['twin-shared-bath'].left.male === 0, 'admin shows per-gender availability');

// payment plan, live
const NOHOOK = { ...LIVE, STRIPE_WEBHOOK_SECRET: '' };
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`, null, NOHOOK);
ok(r.data.payment_plan.available === false && /webhook/.test(r.data.payment_plan.reason), 'plan hidden in live mode without the webhook');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'glamping-single')], 'plan'), NOHOOK);
ok(r.status === 422, 'plan refused without the webhook');
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`, null, LIVE);
const singleBefore = r.data.rooms['glamping-single'].left.female;
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'glamping-single')], 'plan'), LIVE);
ok(r.status === 200 && r.data.url, 'plan checkout opens Stripe');
const planRef = r.data.ref, csPlan = [...store.sessions.keys()].pop();
const subId = complete(csPlan);
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`, null, LIVE);
ok(r.data.rooms['glamping-single'].left.female === singleBefore - 1, 'plan booking holds its place');
const planEvt = JSON.stringify({ type: 'checkout.session.completed', data: { object: store.sessions.get(csPlan) } });
const t2 = Math.floor(Date.now() / 1000);
const sig2 = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t2}.${planEvt}`))), b => b.toString(16).padStart(2, '0')).join('');
wr = await webhook.onRequestPost({ request: new Request('https://x/api/booking/webhook', { method: 'POST', body: planEvt, headers: { 'Stripe-Signature': `t=${t2},v1=${sig2}` } }), env: LIVE });
const sub = store.subs.get(subId), days = (sub.cancel_at - sub.billing_cycle_anchor) / 86400;
ok(wr.status === 200 && sub.cancel_at && days > 65 && days < 70 && sub._proration === 'none', 'webhook stops the plan after the 3rd payment (~2 months + 7 days)');
ok(store.ghl.at(-1).ref === planRef && store.ghl.at(-1).plan_installments === '3' && store.ghl.at(-1).plan_payment_dates.split(', ').length === 3, 'GHL gets the plan dates');
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
r = await call(avail, 'GET', `/api/booking/availability?program=${P}`, null, LIVE);
ok(r.data.rooms['glamping-single'].left.female === singleBefore, 'cancelled plan frees its place');

const evil = await checkout.onRequestOptions({ request: new Request('https://x/', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }) });
ok(!evil.headers.get('Access-Control-Allow-Origin'), 'CORS refuses other sites');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
