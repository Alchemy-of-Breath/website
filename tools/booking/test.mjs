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

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } };
const P = 'breathcamp-oct-2026', ORIGIN = 'https://alchemyofbreath.com';

/* ---------- Stripe mock ---------- */
const store = { sessions: new Map(), pis: new Map(), ghl: [], seq: 0 };
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
    const s = { id, status: 'open', payment_status: 'unpaid', metadata: b.metadata || {}, amount_total: +b.line_items[0].price_data.unit_amount,
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
  if (method === 'POST' && path.startsWith('/payment_intents/')) {
    const pi = store.pis.get(path.split('/').pop()); Object.assign(pi.metadata, parseForm(init.body).metadata || {}); return J(pi);
  }
  return J({ error: { message: 'mock: unhandled ' + method + ' ' + path } }, 400);
};
function complete(sessionId, { lagging = false } = {}) {
  const s = store.sessions.get(sessionId), id = `pi_mock${++store.seq}`;
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
ok(r.data.demo && r.data.quote.total_cents === 281400 && r.data.quote.due_now_cents === 56280 && r.data.quote.balance_cents === 225120, 'demo quote: 2 × €1,407, 20% deposit');
ok(r.data.stripe_params.success_url.includes('{CHECKOUT_SESSION_ID}') && r.data.stripe_params.line_items[0].price_data.unit_amount === 56280, 'checkout params');
ok(r.data.stripe_params.metadata.aob_rooms === 'twin-ensuite:2' && r.data.stripe_params.metadata.utm_source === 'facebook', 'metadata');
r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'full'));
ok(r.data.quote.due_now_cents === 140700 && r.data.quote.balance_cents === 0, 'pay in full');
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
ok(r.data.demo && r.data.quote.total_cents === 281400, 'mixed group can book twin rooms (separate rooms)');

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
ok(r.data.ref === ref1 && r.data.paid && r.data.amount_paid_cents === 56280 && r.data.balance_cents === 225120 && r.data.first_name === 'Test1', 'session summary');

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
ok(b1 && b1.paid_cents === 281400 && b1.balance_cents === 0 && b1.guests.length === 2 && b1.lead.whatsapp === '+447700900123', 'admin booking detail');
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

const evil = await checkout.onRequestOptions({ request: new Request('https://x/', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }) });
ok(!evil.headers.get('Access-Control-Allow-Origin'), 'CORS refuses other sites');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
