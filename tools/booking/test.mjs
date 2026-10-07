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
import * as addonsApi from '../../functions/api/booking/addons.js';
import * as loginApi from '../../functions/api/booking/login.js';
import * as uplistingApi from '../../functions/api/booking/uplisting.js';
import { readFileSync } from 'node:fs';
import PROGRAMS from '../../booking-lib/programs.js';
import {
  verifyStripeSignature, clearAvailabilityMemo, stripeConfig, getProgram, listPrograms, bookingPageUrl, balancePageUrl, addMonths, ipKey, planEndAt,
  quote, groupBookings, roomingMap, parseBooking, parseAddons, parseSvc, parseAssign, bookingCheckoutParams, bookingMetadata,
  formEncode, str, cleanNote, saveAdminMeta, findBooking, forgetBooking,
  availability, programWithRecords, calendarRooms, areaOf, blockInput, parseRecord, rangeLabel, overbooked, addDays, forgetWrites, listRecords, forgetRateLimits,
  nightsBetween, channelLabel, guestShort, REC_REASONS, BLOCK_REASONS,
} from '../../booking-lib/core.js';
import {
  forgetUplisting, uplistingConfig, parseProperties, normBooking, roomSets, chooseRooms, authHeader, mergeSettings, MAP_MAX_KEYS,
} from '../../booking-lib/uplisting.js';
import {
  forgetTeam, adminIdentity, generatePassword, PASSWORD_WORDS, activityEntry, logActivity, scrubText, hashPassword, verifyPassword, LOGBOOK_MAX,
} from '../../booking-lib/team.js';

stripeConfig.retryBaseMs = 1; // keep retries fast
uplistingConfig.webhookRetryMs = [1, 1];

/* ---------- the archived October 2026 week as a runtime fixture ----------
   It is no longer compiled into programs.js (booking/archive/), but most tests below were written
   against it (its dates fit the fake clock, its capacity is small). The functions read the same
   PROGRAMS object, so adding it here makes it a live program for this run. Its sessions are
   resolved from booking/services.json the way build.py resolves "services": "all". */
const readJson = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
function resolveServices(cat, want = 'all') {
  const items = want === 'all' ? cat.services : cat.services.filter(s => want.includes(s.id));
  const used = new Set(items.map(s => s.practitioner));
  return {
    currency: cat.currency, note: cat.note || '', booking_url: cat.booking_url, limits: cat.limits,
    categories: Object.fromEntries(Object.entries(cat.categories).filter(([k]) => items.some(s => s.category === k))),
    practitioners: Object.fromEntries(Object.entries(cat.practitioners).filter(([k]) => used.has(k))),
    items, source: cat.source || '',
  };
}
const CATALOGUE = readJson('../../booking/services.json');
const OCT = readJson('../../booking/archive/breathcamp-oct-2026.json');
OCT.services = resolveServices(CATALOGUE);
PROGRAMS[OCT.id] = OCT;

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
let demoSeq = 0;
const store = {
  sessions: new Map(), pis: new Map(), subs: new Map(), invoices: [], customers: [], domains: new Map(),
  ghl: [], ghlAttempts: 0, ghlStatus: 200, turnstile: [], turnstileDown: false,
  idem: new Map(), calls: [], faults: [], disabledPM: new Set(), rejectParams: new Set(), badEmails: new Set(),
  onCreate: null, onList: null, onGet: null, waits: [], seq: 0, latency: 0, turnstileReply: null, canceledSubPosts: 0,
  invoiceItems: [], lagCustomers: false, lagInvoices: false,
};
function reset(at = '2026-07-01T09:00:00Z') {
  store.sessions.clear(); store.pis.clear(); store.subs.clear(); store.invoices.length = 0; store.customers.length = 0; store.domains.clear();
  store.ghl.length = 0; store.ghlAttempts = 0; store.ghlStatus = 200; store.turnstile.length = 0; store.turnstileDown = false;
  store.faults.length = 0; store.disabledPM.clear(); store.rejectParams.clear(); store.badEmails.clear(); store.onCreate = null; store.onList = null; store.onGet = null;
  store.latency = 0; store.turnstileReply = null; store.noTosUrl = false; store.lagCustomers = false; store.lagInvoices = false; store.invoiceItems.length = 0;
  fakeNow = RealDate.parse(at);
  clearAvailabilityMemo(undefined, { snapshot: true }); forgetWrites(); forgetTeam(); forgetUplisting(); upReset();
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
/* Stripe's metadata rules: at most 50 keys, keys ≤ 40 characters, values ≤ 500; '' removes a key. */
const metaError = md => {
  const keys = Object.keys(md || {});
  if (keys.length > 50) return `metadata has ${keys.length} keys (max 50)`;
  const k = keys.find(x => x.length > 40 || String(md[x]).length > 500);
  return k ? `metadata ${k} too long` : null;
};
const metaMerge = (into, md) => { const o = { ...into }; for (const [k, v] of Object.entries(md || {})) { if (v === '') delete o[k]; else o[k] = v; } return o; };
store.metaChecks = 0;

async function stripeMock(method, path, u, init) {
  const b = parseForm(init.body ? String(init.body) : '');
  let m;
  if (method === 'POST' && path === '/checkout/sessions') {
    for (const md of [b.metadata, b.payment_intent_data && b.payment_intent_data.metadata, b.subscription_data && b.subscription_data.metadata]) {
      store.metaChecks++;
      const err = metaError(md); if (err) return E(400, 'invalid_request_error', err, 'metadata');
    }
    const badLine = arr(b.line_items).find(li => !/^\d+$/.test(String(li.price_data.unit_amount)) || !/^[1-9]\d*$/.test(String(li.quantity)));
    if (badLine) return E(400, 'invalid_request_error', 'line_items: unit_amount must be a whole number ≥ 0 and quantity ≥ 1', 'line_items');
    const embedded = b.ui_mode === 'embedded';
    if (embedded && (b.success_url || b.cancel_url)) return E(400, 'invalid_request_error', 'success_url and cancel_url are not allowed with ui_mode embedded', b.success_url ? 'success_url' : 'cancel_url');
    if (embedded && !b.return_url) return E(400, 'invalid_request_error', 'return_url is required', 'return_url');
    if (!embedded && !b.success_url) return E(400, 'invalid_request_error', 'success_url is required', 'success_url');
    const off = arr(b.payment_method_types).find(t => store.disabledPM.has(t));
    if (off) return E(400, 'invalid_request_error', `The payment method type "${off}" is invalid. Please ensure the provided type is activated in your dashboard.`, 'payment_method_types');
    for (const p of store.rejectParams) if (getPath(b, p) !== undefined) return E(400, 'invalid_request_error', `mock refuses ${p}`, p);
    if (store.noTosUrl && b.consent_collection) return E(400, 'invalid_request_error', 'You cannot collect consent to your terms of service unless a URL is set in the Stripe Dashboard.');
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
    const s = store.sessions.get(m[1]), res = s ? J(s) : E(404, 'invalid_request_error', 'No such checkout.session', 'session', 'resource_missing');
    if (store.onGet) { const f = store.onGet; store.onGet = null; f(m[1]); } // something changes right after it was read
    return res;
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
  if (method === 'POST' && path === '/payment_intents') {   // demo bookings: created and confirmed server-side with the test card
    const md = metaMerge({}, b.metadata || {}), err = metaError(md);
    if (err) return E(400, 'invalid_request_error', err, 'metadata');
    if (b.payment_method !== 'pm_card_visa' || String(b.confirm) !== 'true') return E(400, 'invalid_request_error', 'mock: only confirmed pm_card_visa payments');
    const amount = +b.amount;
    if (!Number.isInteger(amount) || amount < 50) return E(400, 'invalid_request_error', 'Amount must be at least €0.50', 'amount');
    const id = 'pi_demo' + (++demoSeq);
    const pi = { id, object: 'payment_intent', status: 'succeeded', amount, amount_received: amount, currency: b.currency, created: nowS(), customer: null, metadata: md, description: b.description, _refunded: 0 };
    store.pis.set(id, pi); return J(pi);
  }
  if ((m = path.match(/^\/payment_intents\/(pi_\w+)$/))) {
    const pi = store.pis.get(m[1]);
    if (!pi) return E(404, 'invalid_request_error', 'No such payment_intent', 'intent', 'resource_missing');
    if (method === 'POST') {
      const next = metaMerge(pi.metadata, b.metadata), err = metaError(next);
      store.metaChecks++;
      if (err) return E(400, 'invalid_request_error', err, 'metadata');
      pi.metadata = next;
    }
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
      // strict: whether Stripe takes metadata on a canceled subscription is not relied on (the team's
      // keys of an ended plan go to its first invoice's PaymentIntent instead)
      if (sub.status === 'canceled') { store.canceledSubPosts++; return E(400, 'invalid_request_error', 'You cannot update a canceled subscription.'); }
      if (b.metadata) {
        const next = metaMerge(sub.metadata, b.metadata), err = metaError(next);
        store.metaChecks++;
        if (err) return E(400, 'invalid_request_error', err, 'metadata');
        sub.metadata = next;
      }
      if (b.cancel_at) { sub.cancel_at = +b.cancel_at; sub._proration = b.proration_behavior; }
      return J(sub);
    }
  }
  if (method === 'GET' && path === '/invoices' && !u.searchParams.get('subscription')) { // every invoice (offline payments' real-time list)
    return J(page(store.invoices.filter(i => i.id && i.created != null), u));
  }
  if (method === 'GET' && path === '/invoices') {
    const sid = u.searchParams.get('subscription'), st = u.searchParams.get('status');
    const expandPi = u.searchParams.getAll('expand[]').includes('data.payment_intent');
    const rows = store.invoices.filter(i => i.subscription === sid && (!st || i.status === st)).reverse() // newest first, like Stripe
      .map(i => expandPi && i.payment_intent ? { ...i, payment_intent: store.pis.get(i.payment_intent) || i.payment_intent } : i);
    return J({ data: rows, has_more: false });
  }
  /* offline payments: invoice (draft) → its line → finalize → paid out of band; metadata search */
  if (method === 'GET' && path === '/invoices/search') {
    const conds = metaConds(u.searchParams.get('query'));
    return J({ data: store.invoices.filter(i => i.metadata && !i._lagging && conds.every(([k, v]) => i.metadata[k] === v)), has_more: false, next_page: null });
  }
  if (method === 'POST' && path === '/invoices') {
    const md = metaMerge({}, b.metadata || {}), err = metaError(md);
    store.metaChecks++;
    if (err) return E(400, 'invalid_request_error', err, 'metadata');
    if (!store.customers.some(c => c.id === b.customer && !c.deleted) && !/^cus_mock/.test(b.customer || '')) return E(400, 'invalid_request_error', 'No such customer', 'customer', 'resource_missing');
    if (b.collection_method === 'send_invoice' && !b.days_until_due) return E(400, 'invalid_request_error', 'days_until_due is required for send_invoice', 'days_until_due');
    const inv = { id: 'in_off' + pad(++store.seq), object: 'invoice', customer: b.customer, status: 'draft', collection_method: b.collection_method, days_until_due: +b.days_until_due || null,
      auto_advance: String(b.auto_advance) === 'true', currency: b.currency || 'eur', description: b.description, metadata: md, created: nowS(), total: 0, amount_due: 0, amount_paid: 0,
      lines: [], paid_out_of_band: false, _params: b, _lagging: store.lagInvoices };
    if (b.pending_invoice_items_behavior !== 'exclude') {
      for (const ii of store.invoiceItems.filter(x => x.customer === b.customer && !x.invoice)) { ii.invoice = inv.id; inv.lines.push(ii); inv.total += ii.amount; }
    }
    store.invoices.push(inv); return J(inv);
  }
  if (method === 'POST' && path === '/invoiceitems') {
    const ii = { id: 'ii_' + pad(++store.seq), object: 'invoiceitem', customer: b.customer, amount: +b.amount, currency: b.currency, description: b.description, invoice: b.invoice || null };
    if (!Number.isInteger(ii.amount) || ii.amount < 1) return E(400, 'invalid_request_error', 'amount must be a positive integer', 'amount');
    if (ii.invoice) {
      const inv = store.invoices.find(i => i.id === ii.invoice);
      if (!inv || inv.status !== 'draft') return E(400, 'invalid_request_error', 'You can only add invoice items to draft invoices.', 'invoice');
      if (inv.customer !== ii.customer) return E(400, 'invalid_request_error', 'The invoice belongs to another customer.', 'invoice');
      if (inv.currency !== ii.currency) return E(400, 'invalid_request_error', 'Currency mismatch.', 'currency');
      inv.lines.push(ii); inv.total += ii.amount;
    }
    store.invoiceItems.push(ii); return J(ii);
  }
  if ((m = path.match(/^\/invoices\/(in_\w+)\/(finalize|pay)$/)) && method === 'POST') {
    const inv = store.invoices.find(i => i.id === m[1]);
    if (!inv) return E(404, 'invalid_request_error', 'No such invoice', 'invoice', 'resource_missing');
    if (m[2] === 'finalize') {
      if (inv.status !== 'draft') return E(400, 'invalid_request_error', 'This invoice is already finalized.');
      if (b.auto_advance !== undefined) inv.auto_advance = String(b.auto_advance) === 'true';
      if (inv.auto_advance) store.emailed = (store.emailed || 0) + 1; // Stripe would send it
      inv.status = 'open'; inv.amount_due = inv.total; inv.number = 'MOCK-' + pad(store.seq); return J(inv);
    }
    if (inv.status !== 'open') return E(400, 'invalid_request_error', 'Invoice is not open.');
    if (String(b.paid_out_of_band) !== 'true') return E(400, 'invalid_request_error', 'mock: only paid_out_of_band');
    inv.status = 'paid'; inv.paid_out_of_band = true; inv.amount_paid = 0; // like Stripe for out-of-band payments: read `total`
    return J(inv);
  }
  if ((m = path.match(/^\/invoices\/(in_\w+)$/))) {
    const inv = store.invoices.find(i => i.id === m[1]);
    if (!inv) return E(404, 'invalid_request_error', 'No such invoice', 'invoice', 'resource_missing');
    if (method === 'GET') return J(inv);
    if (method === 'DELETE') { if (inv.status !== 'draft') return E(400, 'invalid_request_error', 'Only draft invoices can be deleted.'); store.invoices.splice(store.invoices.indexOf(inv), 1); return J({ id: inv.id, object: 'invoice', deleted: true }); }
    if (method === 'POST') {
      const next = metaMerge(inv.metadata, b.metadata), err = metaError(next);
      store.metaChecks++;
      if (err) return E(400, 'invalid_request_error', err, 'metadata');
      inv.metadata = next; return J(inv);
    }
  }
  if (method === 'POST' && (m = path.match(/^\/invoices\/(in_\w+)\/void$/))) {
    const inv = store.invoices.find(i => i.id === m[1]);
    if (!inv || inv.status !== 'open') return E(400, 'invalid_request_error', 'You can only void open invoices.');
    inv.status = 'void'; return J(inv);
  }
  if (method === 'GET' && path === '/customers/search') {
    const q = u.searchParams.get('query'), conds = metaConds(q), after = (q.match(/\bcreated>(\d+)/) || [])[1];
    if (conds.length) return J({ data: store.customers.filter(c => !c.deleted && !c._lagging && c.metadata && conds.every(([k, v]) => c.metadata[k] === v) && (!after || c.created > +after)), has_more: false, next_page: null });
    const email = (q.match(/^email:'(.*)'$/) || [])[1];
    return J({ data: store.customers.filter(c => !c.deleted && c.email === email), has_more: false });
  }
  /* the team's records (and customers for offline payments): create, read, update, delete, list */
  if (method === 'POST' && path === '/customers') {
    const md = metaMerge({}, b.metadata || {}), err = metaError(md);
    store.metaChecks++;
    if (err) return E(400, 'invalid_request_error', err, 'metadata');
    if (b.name && b.name.length > 256) return E(400, 'invalid_request_error', 'name too long', 'name');
    const c = { id: 'cus_rec' + pad(++store.seq), object: 'customer', name: b.name || null, email: b.email || null, description: b.description || null, metadata: md, created: nowS(), _lagging: store.lagCustomers };
    store.customers.push(c); return J(c);
  }
  if (method === 'GET' && path === '/customers') return J(page(store.customers.filter(c => !c.deleted && c.created != null), u));
  if ((m = path.match(/^\/customers\/(cus_\w+)$/))) {
    const c = store.customers.find(x => x.id === m[1]);
    if (!c) return E(404, 'invalid_request_error', 'No such customer', 'id', 'resource_missing');
    if (method === 'GET') return J(c.deleted ? { id: c.id, object: 'customer', deleted: true } : c);
    if (c.deleted) return E(404, 'invalid_request_error', 'No such customer (deleted)', 'id', 'resource_missing');
    if (method === 'DELETE') { c.deleted = true; return J({ id: c.id, object: 'customer', deleted: true }); }
    if (method === 'POST') {
      const next = metaMerge(c.metadata, b.metadata), err = metaError(next);
      store.metaChecks++;
      if (err) return E(400, 'invalid_request_error', err, 'metadata');
      c.metadata = next; if (b.name) c.name = b.name; return J(c);
    }
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
  if (url.startsWith('https://connect.uplisting.io/')) return upMock(url, init);
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

/* ---------- Uplisting mock (https://connect.uplisting.io): properties (JSON:API), bookings with pages, hooks ---------- */
const UPK = 'upl_test_key_0001';
const up = { props: [], included: [], bookings: new Map(), hooks: [], seq: 5000, calls: [], faults: [], account: { name: 'ASHA Tuscany', uid: 'u7005dd' }, hideWide: new Set() };
function upReset() { up.props = []; up.included = []; up.bookings = new Map(); up.hooks = []; up.calls.length = 0; up.faults.length = 0; up.hideWide.clear(); }
const upJ = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...h } });
async function upMock(url, init) {
  const u = new URL(url), method = init.method || 'GET', h = init.headers || {};
  up.calls.push({ method, path: u.pathname, search: u.search, auth: h.Authorization, ct: h['Content-Type'], body: init.body || null, t: Date.now() });
  const f = up.faults.find(x => (!x.method || x.method === method) && x.path.test(u.pathname + u.search) && x.times > 0);
  if (f) { f.times--; if (f.network) throw new TypeError('fetch failed'); return upJ({ errors: ['mock fault'] }, f.status, f.retryAfter ? { 'Retry-After': String(f.retryAfter) } : {}); }
  if (h.Authorization !== 'Basic ' + Buffer.from(UPK).toString('base64')) return upJ({ error: 'Your API key does not appear to be valid' }, 401);
  let m;
  if (method === 'GET' && u.pathname === '/users/me') return upJ(up.account);
  if (method === 'GET' && u.pathname === '/properties') return upJ({ data: up.props, included: up.included });
  if (method === 'GET' && (m = u.pathname.match(/^\/bookings\/([^/]+)$/))) {
    const pid = decodeURIComponent(m[1]);
    if (!up.bookings.has(pid)) return upJ({ error: 'Not found' }, 404);
    const from = u.searchParams.get('from'), to = u.searchParams.get('to'), wide = from && to && nightsBetween(from, to) > 100;
    const rows = up.bookings.get(pid).filter(b => (!from || b.check_out >= from) && (!to || b.check_in <= to) && !(wide && up.hideWide.has(String(b.id))))
      .sort((a, b) => (a.check_in < b.check_in ? -1 : a.check_in > b.check_in ? 1 : a.id - b.id));
    const per = Math.min(50, +(u.searchParams.get('per_page') || 50)), pg = +(u.searchParams.get('page') || 0);
    return upJ({ bookings: rows.slice(pg * per, pg * per + per).map(b => ({ ...b })), meta: { total_pages: Math.ceil(rows.length / per), total: rows.length } });
  }
  if (u.pathname === '/hooks' && method === 'GET') return upJ({ data: up.hooks.map(x => ({ id: String(x.id), type: 'webhooks', attributes: { target_url: x.target_url, event: x.event, created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' } })) });
  if (u.pathname === '/hooks' && method === 'POST') {
    const b = JSON.parse(init.body || '{}');
    if (!b.target_url || !b.event) return upJ({ error: 'target_url and event are required' }, 422);
    const id = ++up.seq; up.hooks.push({ id, target_url: b.target_url, event: b.event }); return upJ({ id }, 201);
  }
  if (method === 'DELETE' && (m = u.pathname.match(/^\/hooks\/(\d+)$/))) {
    const i = up.hooks.findIndex(x => String(x.id) === m[1]);
    if (i < 0) return upJ({ error: 'Not found' }, 404);
    up.hooks.splice(i, 1); return upJ({ status: 'destroyed' });
  }
  return upJ({ error: 'mock: unhandled ' + method + ' ' + u.pathname }, 400);
}
const upFault = (path, opts) => up.faults.push({ path, times: 1, status: 500, ...opts });
const stripeCalls = (method, re) => store.calls.filter(c => c.method === method && re.test(c.path)).length;

/* A subscription invoice's PaymentIntent: no metadata of ours (Stripe doesn't copy the subscription's). */
function invoicePi(amount, customer, status, created = nowS()) {
  const id = `pi_mockinv${pad(++store.seq)}`;
  store.pis.set(id, { id, object: 'payment_intent', status, amount, amount_received: status === 'succeeded' ? amount : 0, currency: 'eur', created, customer, metadata: {}, _refunded: 0 });
  return id;
}
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
    store.invoices.push({ id: 'in_mock' + pad(++store.seq), subscription: id, status: 'paid', amount_paid: s.amount_total, billing_reason: 'subscription_create', created: now,
      payment_intent: invoicePi(s.amount_total, s.customer, 'succeeded') });
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
    store.invoices.push({ id: 'in_mock' + pad(++store.seq), subscription: subId, status: failed ? 'open' : 'paid', amount_paid: failed ? 0 : amount, amount_due: amount, billing_reason: 'subscription_cycle',
      created: start, payment_intent: invoicePi(amount, sub.customer, failed ? 'requires_payment_method' : 'succeeded', start) });
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
  await Promise.all(store.waits.splice(0)); // background work (activity log, GHL, domains) done before the next step
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
const failOverlay = () => store.pis.get(store.invoices.find(i => i.subscription === planFail && i.billing_reason === 'subscription_create').payment_intent).metadata;
ok(r.data.ok && !store.subs.get(planFail).metadata.aob_status && failOverlay().aob_status === 'cancelled' && failOverlay().aob_admin_overlay === '1', 'a canceled subscription: the cancelled status goes on the plan\'s first invoice payment (overlay)');
r = await call(admin, 'POST', '/api/booking/admin', { action: 'restore', ref: failRef }, LIVE, AUTH);
ok(r.status === 409, 'a plan stopped in Stripe can\'t be restored');
delete failOverlay().aob_status; delete failOverlay().aob_status_at; // (by hand in Stripe)
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

/* the page gets a public copy of the program: no internal notes (the October page is now a redirect
   to the week list, so this reads a generated July page) */
{
  const J1P = getProgram('breathcamp-jul-2027-1');
  const html = readFileSync(new URL('../../book/breathcamp-jul-2027-1/index.html', import.meta.url), 'utf8');
  const m = html.match(/<script type="application\/json" id="programData">([\s\S]*?)<\/script>/);
  const pub = JSON.parse(m[1]);
  const keys = []; (function walk(v, path) { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(path + k); walk(x, path + k + '.'); } })(pub, '');
  ok(!keys.some(k => /(^|\.)about$/.test(k)) && !pub.rooms.some(r => 'rg_id' in r || 'names' in r) && !pub.policy.source && !pub.trust.source && !pub.arrival.source, 'page data: no "about" notes, RetreatGuru ids, room names or source notes');
  ok(pub.source && pub.source.snapshot === J1P.source.snapshot && Object.keys(pub.source).length === 1 && pub.trust.rating.source === 'Trustpilot', 'page data keeps the snapshot date and the rating source it shows');
  ok(/^https:\/\/cdn\.jsdelivr\.net\/gh\/Alchemy-of-Breath\/website@[0-9a-f]{40}\/assets\/booking\/rooms\/$/.test(pub.img_cdn), 'room photos are pinned to a commit on jsDelivr');
  ok(html.includes('class="hero slim"') && !html.includes('id="heroImg"') && html.includes('class="about-link" href="https://alchemyofbreath.com/breathcamps/"'), 'slim booking header with an About link (the week is explained on its own page)');
  ok(J1P.programme.about && J1P.rooms[0].names && J1P.rooms[0].names.length === 5 && J1P.services.source, 'the server copy keeps its notes, room names and the catalogue source');
  ok(pub.services && pub.services.items.length === J1P.services.items.length && !('source' in pub.services) && /^https:\/\/cdn\.jsdelivr\.net\/gh\/Alchemy-of-Breath\/website@[0-9a-f]{40}\/assets\/booking\/services\/$/.test(pub.services.img_cdn), 'page data: the session catalogue with its photo base, without the source note');
}

/* ================================================================== July 2027 weeks */
const J1 = 'breathcamp-jul-2027-1', J2 = 'breathcamp-jul-2027-2', JP = getProgram(J1);
const S = { muji60: 'muji-magic-massage-60', muji90: 'muji-magic-massage-90', anthony: 'anthony-private-intensive', kate: 'kate-reiki', nancyBw: 'nancy-breathwork',
  nancyR60: 'nancy-reiki-60', amy: 'amy-intuitive-reading', michael: 'michael-deep-listening', monica: 'monica-qigong' };
const sumLines = sp => arr(sp.line_items).reduce((a, l) => a + (+l.price_data.unit_amount) * (+l.quantity), 0);
const availJ = (env = LIVE, id = J1) => { clearAvailabilityMemo(); return call(avail, 'GET', `/api/booking/availability?program=${id}`, null, env); };
const jBooking = (guests, payment = 'deposit', extra = {}) => booking(guests, payment, { program: J1, return_url: `https://alchemyofbreath.com/book/${J1}/`, page: `https://alchemyofbreath.com/book/${J1}/`, ...extra });
const xa = (body, env = LIVE, headers) => call(addonsApi, 'POST', '/api/booking/addons', body, env, headers);
const adm = (body, env = LIVE) => call(admin, 'POST', '/api/booking/admin', body, env, AUTH);
const ADMIN_ONLY = { ADMIN_TOKEN: LIVE.ADMIN_TOKEN };
reset();
{
  const j2 = getProgram(J2), names = id => JP.rooms.find(x => x.id === id).names;
  ok(JP && j2 && JP.program_spaces === 49 && j2.program_spaces === 49 && JP.dates.start === '2027-07-18' && j2.dates.start === '2027-07-25' && JP.edition === 'BreathCamp 1' && j2.edition === 'BreathCamp 2', 'July weeks load: BreathCamp 1 (18 July) and 2 (25 July), 49 places each');
  ok(listPrograms().filter(p => p.id.startsWith('breathcamp-jul-2027-')).length === 2 && !getProgram('breathcamp-jul-2027-3'), 'two July weeks compiled');
  ok(names('twin-ensuite').length === 5 && names('twin-ensuite')[1] === '2A · Temple Cottage' && names('camper').length === 8 && !names('own-tent') && names('cottage-two')[0] === '4C + 4D · Alchemy Cottage (combined)', 'July rooms carry their physical room names (none for own tents)');
  ok(JP.rooms.every(x => !x.names || x.names.length === (x.same_gender ? x.units : x.capacity)), 'one name per shared room (unit) or per place');
  ok(JP.services.items.length === 10 && JP.services.limits.per_service === 4 && JP.services.limits.per_booking === 12 && Object.keys(JP.services.practitioners).length === 7 && !('img_cdn' in JP.services), 'July weeks offer the 10 wellbeing sessions of 7 practitioners (server copy)');
  r = await availJ({});
  ok(r.data.program_left === 49 && r.data.rooms['twin-ensuite'].left.female === 10 && r.data.rooms.camper.left_any === 8 && r.data.rooms['own-tent'].left_any === 10 && r.data.rooms['cottage-two'].capacity_units === 1 && r.data.rooms['single-ensuite'].left_any === 3, 'July capacity: 49 places, 5 twin rooms, 8 camper spots, 10 pitches, 3 single rooms, 1 cottage for two');
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(1, 'twin-ensuite')]));
  ok(r.data.demo && /^BC2707-/.test(r.data.ref) && r.data.stripe_params.custom_text.submit.message.includes('before you arrive on 18 July'), 'July booking: BC2707 reference, balance before 18 July');
}

/* ================================================================== wellbeing sessions: quote, lines, metadata (demo) */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')], 'deposit', { addons: [{ id: S.muji60, guest: 0 }, { id: S.muji60, guest: 1 }, { id: S.anthony, guest: 1 }] }));
  let q = r.data.quote, sp2 = r.data.stripe_params, l2 = sp2.line_items;
  ok(r.status === 200 && q.addons_cents === 60000 && q.total_cents === 519000 && q.due_now_cents === 293880 && q.balance_cents === 225120, 'sessions are paid in full today; the balance stays accommodation only');
  ok(q.addons.length === 3 && q.addons[2].title === 'Private Intensive' && q.addons[2].practitioner === 'anthony' && q.addons[2].practitioner_name === 'Anthony Abbagnano' && q.addons[2].minutes === 90 && q.addons[2].price_cents === 40000 && q.addons[2].guest === 1, 'quote lists each session with practitioner, minutes, price and guest');
  ok(l2.length === 4 && l2[1].quantity === 2 && l2[1].price_data.unit_amount === 10000 && l2[1].price_data.product_data.name === 'Wellbeing session · Muji: Magic Massage (60 min)' && l2[1].price_data.product_data.description === `Booking ${r.data.ref}. Arranged with you by ASHA Reception.` && l2[2].quantity === 1 && l2[2].price_data.unit_amount === 40000, 'one receipt line per session type (count × price)');
  ok(sumLines(sp2) === q.due_now_cents && l2[0].price_data.unit_amount === 88800 && l2[3].price_data.unit_amount === 56280 && l2.every(x => x.price_data.unit_amount > 0), 'lines add up to the amount due today (programme + sessions + room deposit)');
  ok(sp2.metadata.aob_addons === 'muji-magic-massage-60@1,muji-magic-massage-60@2,anthony-private-intensive@2' && sp2.metadata.aob_addons_total === '60000' && sp2.metadata.aob_total === '519000' && sp2.metadata.aob_balance === '225120', 'metadata: sessions as id@guest number, their total, the total with sessions');
  ok(sp2.custom_text.submit.message.startsWith('Today €2,938.80 (programme fee + sessions + 20% room deposit). Then €2,251.20 before you arrive on 25 October. Includes 3 wellbeing sessions.') && /can't be scheduled is refunded/.test(sp2.custom_text.submit.message), 'submit text: sessions in the schedule, their count and the refund rule');
  ok(/and 3 wellbeing sessions/.test(sp2.payment_intent_data.description) && /and 3 wellbeing sessions\. Booking /.test(sp2.invoice_creation.invoice_data.description), 'payment and invoice descriptions mention the sessions');
  ok(parseBooking(sp2.metadata).addons.map(a => a.title).join() === 'Magic Massage,Magic Massage,Private Intensive' && parseBooking(sp2.metadata).addons_cents === 60000, 'parseBooking reads the sessions back from the program');
  ok(parseAddons('gone-session@3,kate-reiki@1', PROG).map(a => [a.unknown || false, a.guest, a.title]).join('|') === 'true,2,gone-session|false,0,Reiki for Energetic Integration', 'unknown session ids are kept as they are');

  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'full', { addons: [{ id: S.kate, guest: 0 }] }));
  ok(r.data.quote.total_cents === 241500 && r.data.quote.due_now_cents === 241500 && r.data.quote.balance_cents === 0 && sumLines(r.data.stripe_params) === 241500 && /^Today €2,415: programme fee, room and meals, paid in full\. Includes 1 wellbeing session\./.test(r.data.stripe_params.custom_text.submit.message), 'pay in full with one session');
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { programme: 'paid', addons: [{ id: S.muji90, guest: 0 }] }));
  q = r.data.quote;
  ok(q.total_cents === 155700 && q.due_now_cents === 43140 && q.balance_cents === 112560 && r.data.stripe_params.line_items.length === 2 && sumLines(r.data.stripe_params) === 43140 && r.data.stripe_params.custom_text.submit.message.startsWith('Today €431.40 (session + 20% room deposit).'), 'room only with a session: the session + 20% deposit today');
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-shared-bath')], 'plan', { addons: [{ id: S.nancyBw, guest: 0 }] }));
  q = r.data.quote; sp2 = r.data.stripe_params;
  ok(q.total_cents === 220900 && q.plan.installment_cents === 73633 && q.plan.first_cents === 73634 && q.due_now_cents === 73634 && sumLines(sp2) === 73634, 'plan with a session: the total (session included) split in 3');
  ok(/ · includes 1 wellbeing session$/.test(sp2.subscription_data.description) && /, and 1 wellbeing session\. Booking /.test(sp2.line_items[0].price_data.product_data.description) && sp2.subscription_data.metadata.aob_addons === 'nancy-breathwork@1' && sp2.subscription_data.metadata.aob_addons_total === '15000', 'plan: sessions in the subscription description and metadata');

  const withAddons = (addons, extra = {}) => call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')], 'deposit', { addons, ...extra }));
  r = await withAddons([{ id: 'no-such-session', guest: 0 }]);
  ok(r.status === 422 && /no longer offered/.test(r.data.fields.addons), 'unknown session refused (422 fields.addons)');
  for (const g of [2, -1, 1.5, 'two', true]) {
    r = await withAddons([{ id: S.kate, guest: g }]);
    ok(r.status === 422 && /who each session is for/.test(r.data.fields.addons), `session for guest ${JSON.stringify(g)} refused`);
  }
  r = await withAddons([{ id: S.kate, guest: '1' }, { id: S.kate }]);
  ok(r.status === 200 && r.data.stripe_params.metadata.aob_addons === 'kate-reiki@2,kate-reiki@1', 'guest given as text, or left out (the lead guest), is fine');
  r = await withAddons(Array.from({ length: 5 }, (_, i) => ({ id: S.muji60, guest: i % 2 })));
  ok(r.status === 422 && /up to 4 times/.test(r.data.fields.addons), 'at most 4 of one session per booking');
  const twelve = [S.muji60, S.kate, S.amy].flatMap(id => Array.from({ length: 4 }, (_, i) => ({ id, guest: i % 2 })));
  r = await withAddons(twelve);
  ok(r.status === 200 && r.data.quote.addons.length === 12 && sumLines(r.data.stripe_params) === r.data.quote.due_now_cents, '12 sessions on one booking');
  r = await withAddons([...twelve, { id: S.michael, guest: 0 }]);
  ok(r.status === 422 && /up to 12 sessions/.test(r.data.fields.addons), 'at most 12 sessions per booking');
  r = await withAddons('all of them');
  ok(r.status === 422 && r.data.fields.addons, 'sessions must be a list');
  r = await withAddons([]);
  ok(r.status === 200 && !r.data.stripe_params.metadata.aob_addons && r.data.quote.addons_cents === 0 && r.data.quote.addons.length === 0, 'no sessions: nothing about them in the metadata');
  r = await withAddons([{ id: S.kate, guest: 0 }], { expected: { due_now_cents: 233880, total_cents: 459000 } });
  ok(r.status === 409 && r.data.code === 'price_changed' && r.data.quote.due_now_cents === 245880 && r.data.quote.total_cents === 471000, 'the price guard counts the sessions');
  r = await withAddons([{ id: S.kate, guest: 0 }], { expected: { due_now_cents: 245880, total_cents: 471000 } });
  ok(r.status === 200, 'matching amounts with sessions pass');
  const svcBackup = PROG.services; delete PROG.services;
  r = await withAddons([{ id: S.kate, guest: 0 }]);
  ok(r.status === 422 && /not offered/.test(r.data.fields.addons), 'a week without sessions refuses them');
  r = await withAddons([]);
  ok(r.status === 200, '… and books without them');
  PROG.services = svcBackup;
  r = await withAddons([], { discount: { type: 'percent', value: 100, scope: 'total', reason: 'free' } });
  ok(r.status === 200 && r.data.quote.total_cents === 459000 && r.data.quote.discount === null && !r.data.stripe_params.metadata.aob_discount, 'the public checkout ignores a discount in the request');
}

/* ================================================================== metadata limits: the fullest booking */
reset('2026-09-01T09:00:00Z');
{
  const keepMax = JP.max_guests_per_booking;
  JP.max_guests_per_booking = 12;
  const long = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const lead = `${long('guestname', 60)}a@${long('example', 50)}.com`;
  const big = Array.from({ length: 12 }, (_, i) => ({ first: long('Mariabella', 60), last: long('Esperanza', 60),
    email: `${long('guestname', 60)}${String.fromCharCode(97 + i)}@${long('example', 50)}.com`, gender: 'Female', room: i < 10 ? 'twin-ensuite' : 'glamping-single' }));
  // an earlier payment of 12 programme fees, so the booking also carries aob_prog_verified + aob_prog_pi
  store.customers.push({ id: 'cus_big', email: lead });
  store.pis.set('pi_bigfees', { id: 'pi_bigfees', status: 'succeeded', amount: 12 * 88800, amount_received: 12 * 88800, currency: 'eur', created: nowS() - 5 * 86400, customer: 'cus_big', metadata: {} });
  const twelveS = [S.anthony, S.amy, S.muji90, S.michael].flatMap(id => [0, 1, 2].map(k => ({ id, guest: (k * 4 + id.length) % 12 })));
  r = await call(checkout, 'POST', '/api/booking/checkout', {
    program: J1, payment: 'plan', programme: 'paid', guests: big, whatsapp: '+447700900123', roommate: long('Room with my friend ', 250), diet: long('No nuts, no gluten. ', 500),
    terms: true, remind: true, attempt: long('a', 80), addons: twelveS, utm: Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'].map(k => [k, long('x', 200)])),
    return_url: `https://alchemyofbreath.com/book/${J1}/`, page: `https://alchemyofbreath.com/book/${J1}/?${long('q', 400)}`,
  }, LIVE, ip(50));
  const s12 = r.data.session_id && store.sessions.get(r.data.session_id), md12 = (s12 && s12.metadata) || {};
  ok(r.status === 200 && md12.aob_g12 && md12.aob_addons.split(',').length === 12 && md12.aob_prog_verified === 'stripe' && md12.aob_prog_pi && md12.aob_plan_n === '3' && md12.aob_remind === '1' && md12.aob_utm, '12 guests, room only, plan, 12 sessions and every option: checkout opens');
  ok(Object.keys(md12).length < 50 && Object.values(md12).every(v => String(v).length <= 500) && Object.keys(s12._params.subscription_data.metadata).length < 50, `checkout metadata within Stripe's limits (${Object.keys(md12).length} keys)`);
  const sub12 = complete(r.data.session_id), ref12 = md12.aob_ref;
  r = await adm({ action: 'note', ref: ref12, note: long('Late arrival, call Maria first. ', 600) });
  ok(r.data.ok && r.data.note.length === 480, 'a full-length note');
  const tw = JP.rooms.find(x => x.id === 'twin-ensuite').names, gs = JP.rooms.find(x => x.id === 'glamping-single').names;
  r = await adm({ action: 'assign', ref: ref12, assign: Object.fromEntries(big.map((g, i) => [i, i < 10 ? tw[Math.floor(i / 2)] : gs[i - 10]])) });
  ok(r.data.ok && Object.keys(r.data.assign).length === 12 && r.data.warnings.length === 0, 'all 12 guests assigned to rooms');
  let stored = 0, refused = null;
  for (let k = 0; k < 12; k++) {
    r = await adm({ action: 'svc_status', ref: ref12, key: `b${k}`, status: 'scheduled', when: long('Tuesday 20 July 2027, 15:00, Prana Shala ', 40) });
    if (r.data.ok) stored++; else { refused = r; break; }
  }
  ok(stored === 9 && refused.status === 422 && refused.data.code === 'too_long' && store.subs.get(sub12).metadata.aob_svc.length <= 490, `session times are stored until aob_svc would pass 490 characters, then refused (${stored} stored)`);
  wr = await hook(sessionEvent('checkout.session.completed', r.data.session_id || [...store.sessions.values()].find(x => x.metadata.aob_ref === ref12).id));
  r = await adm({ action: 'cancel', ref: ref12 });
  const subMd12 = store.subs.get(sub12).metadata;
  ok(r.data.ok && subMd12.aob_ghl && subMd12.aob_status === 'cancelled' && subMd12.aob_status_at && subMd12.aob_note && subMd12.aob_assign && subMd12.aob_svc, 'every later key is on the subscription (GHL mark, status, note, rooms, session times)');
  ok(Object.keys(subMd12).length < 50 && Object.values(subMd12).every(v => String(v).length <= 500), `the fullest booking stays within Stripe's metadata limits (${Object.keys(subMd12).length} keys)`);
  ok(store.metaChecks > 0, 'the Stripe mock checked every metadata write against the limits');
  JP.max_guests_per_booking = keepMax;
}

/* ================================================================== sessions on a live booking; extras after booking */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')], 'deposit', { addons: [{ id: S.muji60, guest: 0 }, { id: S.muji60, guest: 1 }] }), LIVE);
  ok(r.status === 200 && r.data.quote.due_now_cents === 253880 && r.data.quote.total_cents === 479000, 'live checkout with two sessions');
  const refX = r.data.ref, csX = r.data.session_id, piX = complete(csX);
  r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
  let bX = r.data.bookings.find(b => b.ref === refX);
  ok(bX.total_cents === 479000 && bX.paid_cents === 253880 && bX.balance_cents === 225120 && bX.addons.length === 2 && bX.addons.map(a => a.key).join() === 'b0,b1' && bX.addons.every(a => a.source === 'booking' && a.status === 'todo' && a.when === '' && a.payment_id === piX), 'admin: booking-time sessions with keys b0, b1, status todo');
  ok(bX.addons[1].guest_name === 'Test2 Guest' && bX.addons[1].practitioner_name === 'Muji' && bX.sessions_count === 2 && bX.sessions_cents === 20000 && bX.addons_cents === 20000 && bX.extras_cents === 0, 'admin: sessions name their guest; counts and amounts');
  ok(bX.source === 'online' && bX.discount === null && bX.note === '' && JSON.stringify(bX.assign) === '{}' && !('svc' in bX) && !('extra_pays' in bX), 'admin booking: source, discount, note and room assignment fields');
  wr = await hook(sessionEvent('checkout.session.completed', csX));
  g = store.ghl.at(-1);
  ok(g.event === 'booking_paid' && g.sessions.length === 2 && g.sessions[0] === 'Muji: Magic Massage (60 min) for Test1 Guest' && g.sessions_total === '200.00' && g.sessions_text.split('\n').length === 2, 'booking_paid lists the sessions with their guests');

  r = await call(addonsApi, 'GET', '/api/booking/addons', null, LIVE_PK);
  ok(r.data.stripe.embedded === true && r.data.stripe.publishable_key === 'pk_test_mock' && r.data.turnstile_site_key === null && r.data.live === true, 'extras GET: payment form and bot-check settings');
  r = await xa({ action: 'lookup', ref: refX, email: 'wrong@example.com' });
  ok(r.status === 404, 'extras lookup: wrong email → 404');
  r = await xa({ action: 'lookup', ref: refX.toLowerCase(), email: ' T1@example.com ' });
  ok(r.status === 200 && r.data.open === true && r.data.reason === null && r.data.ref === refX && r.data.program.id === P && r.data.program.edition === 'BreathCamp 5' && r.data.guests.map(x => `${x.index}:${x.first_name}`).join() === '0:Test1,1:Test2', 'extras lookup: the booking, its week and its guests\' first names');
  ok(r.data.addons.length === 2 && r.data.addons[0].key === 'b0' && r.data.addons[0].source === 'booking' && r.data.addons[0].status === 'todo' && r.data.limits.per_booking === 12 && r.data.limits_left.per_booking === 10 && r.data.limits_left.per_service[S.muji60] === 2 && r.data.limits_left.per_service[S.kate] === 4, 'extras lookup: existing sessions and how many more fit');
  ok(r.data.services.items.length === 10 && !('source' in r.data.services) && r.data.services.img_cdn === 'https://website-5h3.pages.dev/assets/booking/services/' && r.data.services.practitioners.muji.name === 'Muji' && r.data.services.note === PROG.services.note, 'extras lookup: the public catalogue with its photo base');
  ok(!JSON.stringify(r.data).includes('t2@example.com') && !JSON.stringify(r.data).includes('Test2 Guest'), 'extras lookup: no guest emails or full names');

  r = await xa({ action: 'pay', ref: refX, email: 't1@example.com', addons: [{ id: S.muji60, guest: 0 }, { id: S.muji60, guest: 0 }, { id: S.muji60, guest: 1 }] });
  ok(r.status === 422 && /up to 4 times/.test(r.data.fields.addons), 'extras: booked + new sessions of one kind stay within 4');
  r = await xa({ action: 'pay', ref: refX, email: 't1@example.com', addons: Array.from({ length: 11 }, (_, i) => ({ id: [S.kate, S.amy, S.michael][i % 3], guest: 0 })) });
  ok(r.status === 422 && /add 10 more sessions/.test(r.data.fields.addons), 'extras: booked + new sessions stay within 12');
  r = await xa({ action: 'pay', ref: refX, email: 't1@example.com', addons: [] });
  ok(r.status === 422 && /at least one/.test(r.data.fields.addons), 'extras: nothing chosen → 422');
  r = await xa({ action: 'pay', ref: refX, email: 't1@example.com', addons: [{ id: S.kate, guest: 2 }] });
  ok(r.status === 422 && /who each session is for/.test(r.data.fields.addons), 'extras: only the booking\'s own guests');
  r = await xa({ action: 'pay', ref: refX, email: 't1@example.com', addons: [{ id: S.kate, guest: 0 }], expected: { due_now_cents: 10000 } });
  ok(r.status === 409 && r.data.code === 'price_changed' && r.data.quote.due_now_cents === 12000, 'extras: price guard');
  r = await xa({ action: 'pay', ref: refX, email: 'other@example.com', addons: [{ id: S.kate, guest: 0 }] });
  ok(r.status === 404, 'extras pay: wrong email → 404');

  r = await xa({ action: 'pay', ref: refX, email: 't1@example.com', addons: [{ id: S.kate, guest: 0 }, { id: S.nancyR60, guest: 1 }], return_url: 'https://www.alchemyofbreath.com/book/extras/?ref=x' });
  let sx = store.sessions.get(r.data.session_id);
  ok(r.status === 200 && r.data.ui === 'hosted' && r.data.url && r.data.ref === refX && r.data.quote.due_now_cents === 24000 && r.data.quote.total_cents === 24000 && r.data.quote.addons.length === 2 && r.data.expires_at - nowS() === 31 * 60, 'extras: hosted checkout for two more sessions');
  const mdx = sx.metadata;
  ok(mdx.aob_kind === 'addon' && mdx.aob_program === P && mdx.aob_ref === refX && mdx.aob_addons === 'kate-reiki@1,nancy-reiki-60@2' && mdx.aob_addons_total === '24000' && mdx.aob_lead_email === 't1@example.com' && mdx.aob_lead_name === 'Test1 Guest' && mdx.aob_ui === 'hosted' && Object.keys(mdx).length === 8, 'extras metadata: kind addon, the booking ref, sessions, total, lead');
  ok(sx._params.submit_type === 'pay' && arr(sx._params.payment_method_types).join() === 'card,link,klarna' && sx._params.customer === 'cus_mock1' && sx._params.invoice_creation.enabled === 'true' && sx._params.payment_intent_data.receipt_email === 't1@example.com' && sx._params.payment_intent_data.metadata.aob_kind === 'addon' && sx._params.mode === 'payment', 'extras: pay button, methods from the program, the same customer, invoice and receipt');
  ok(sx._params.success_url === 'https://www.alchemyofbreath.com/book/extras/?status=success&session_id={CHECKOUT_SESSION_ID}' && sx._params.cancel_url === `https://www.alchemyofbreath.com/book/extras/?status=cancelled&ref=${refX}`, 'extras: hosted return links go to our own extras page');
  ok(sumLines(sx._params) === 24000 && arr(sx._params.line_items)[0].price_data.product_data.name === 'Wellbeing session · Kate Hawley: Reiki for Energetic Integration (60 min)' && /ASHA Reception/.test(sx._params.custom_text.submit.message), 'extras: one line per session, adding up to the amount');
  const csHosted = sx.id;
  r = await availGet(LIVE);
  ok(r.data.rooms['twin-ensuite'].held === 0 && r.data.program_left === 15, 'add-on checkouts hold no places');
  r = await xa({ action: 'pay', ref: refX, email: 't1@example.com', addons: [{ id: S.kate, guest: 0 }, { id: S.nancyR60, guest: 1 }], ui: 'embedded', return_url: 'https://alchemyofbreath.com/book/extras/' }, LIVE_PK);
  sx = store.sessions.get(r.data.session_id);
  ok(r.status === 200 && r.data.ui === 'embedded' && r.data.client_secret === `${sx.id}_secret_mock` && r.data.publishable_key === 'pk_test_mock' && sx._params.ui_mode === 'embedded' && sx._params.redirect_on_completion === 'if_required' && sx._params.return_url === 'https://alchemyofbreath.com/book/extras/?status=success&session_id={CHECKOUT_SESSION_ID}' && !sx._params.success_url && sx.metadata.aob_ui === 'embedded', 'extras: embedded checkout returns to the extras page');
  ok(store.sessions.get(csHosted).status === 'expired', 'extras: one payable add-on checkout per booking (the earlier one is expired)');
  const csAdd = sx.id, piAdd = complete(csAdd), last8 = piAdd.slice(-8);
  tick(31); // past the 30 s lookup memo of this isolate (the webhook clears it in real life)
  r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: refX, email: 't1@example.com' }, LIVE);
  ok(r.status === 200 && r.data.balance_cents === 225120 && r.data.total_cents === 503000 && r.data.paid_cents === 277880, 'balance page: the sessions add to total and paid, the balance stays');
  r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
  bX = r.data.bookings.find(b => b.ref === refX);
  ok(bX.total_cents === 503000 && bX.paid_cents === 277880 && bX.balance_cents === 225120 && bX.extras_cents === 24000, 'extras: paid and total both go up, the balance is unchanged');
  ok(bX.addons.length === 4 && bX.addons[2].key === `x${last8}-0` && bX.addons[3].key === `x${last8}-1` && bX.addons[2].source === 'extra' && bX.addons[3].guest_name === 'Test2 Guest' && bX.addons[2].payment_id === piAdd && bX.sessions_count === 4 && bX.sessions_cents === 44000, 'extras: sessions appended with stable keys x<payment>-n');
  ok(bX.payments.some(p => p.kind === 'addon' && p.amount_cents === 24000 && p.id === piAdd), 'the payments list shows the add-on payment');
  ok(groupBookings(PROG, [...store.pis.values()].filter(p => p.metadata.aob_ref === refX).reverse().map(p => ({ id: p.id, created: p.created, amount: p.amount_received, refunded: 0, md: p.metadata })))[0].addons.map(a => a.key).join() === bX.addons.map(a => a.key).join(), 'session keys don\'t depend on the order Stripe lists the payments');

  r = await call(session, 'GET', `/api/booking/session?id=${csAdd}`, null, LIVE);
  ok(r.data.kind === 'addon' && r.data.state === 'paid' && r.data.ref === refX && r.data.addons.length === 2 && r.data.addons[0].title === 'Reiki for Energetic Integration' && r.data.addons[1].guest === 1 && r.data.addons_cents === 24000 && r.data.amount_paid_cents === 24000 && !JSON.stringify(r.data).includes('Test2'), 'session (add-on): state, ref, sessions and amounts, no guest names');
  r = await call(session, 'GET', `/api/booking/session?id=${csX}`, null, LIVE);
  ok(r.data.kind === 'booking' && r.data.addons.length === 2 && r.data.addons_cents === 20000 && r.data.services_note === PROG.services.note, 'session (booking): the sessions booked, for the confirmation');

  store.ghlStatus = 500;
  wr = await hook({ id: 'evt_add1', ...sessionEvent('checkout.session.completed', csAdd) });
  ok(wr.status === 500 && !store.pis.get(piAdd).metadata.aob_ghl, 'addon_paid: GHL down → 500 (Stripe retries), not marked');
  store.ghlStatus = 200; ghlBefore = store.ghl.length;
  wr = await hook({ id: 'evt_add1', ...sessionEvent('checkout.session.completed', csAdd) });
  g = store.ghl.at(-1);
  ok(wr.status === 200 && store.ghl.length === ghlBefore + 1 && g.event === 'addon_paid' && g.ref === refX && g.program === P && g.email === 't1@example.com' && g.amount_paid === '240.00' && g.event_id === 'evt_add1' && g.tag === `${P}-addon-paid`, 'addon_paid forwarded to GHL');
  ok(g.sessions.length === 2 && g.sessions[0] === 'Kate Hawley: Reiki for Energetic Integration (60 min) for Test1 Guest' && g.sessions[1] === 'Nancy Iannotti: Reiki Energy Healing (60 min) for Test2 Guest' && g.phone === '+447700900123' && g.first_name === 'Test1', 'addon_paid names each session and its guest');
  ok(store.pis.get(piAdd).metadata.aob_ghl === 'evt_add1', 'the forwarded add-on payment is marked');
  wr = await hook({ id: 'evt_add2', ...sessionEvent('checkout.session.completed', csAdd) });
  ok(wr.status === 200 && wr.text === 'already forwarded' && store.ghl.length === ghlBefore + 1, 'addon_paid is forwarded once');

  r = await xa({ action: 'pay', ref: refX, email: 't1@example.com', addons: [{ id: S.kate, guest: 1 }], replace: csAdd });
  ok(r.status === 409 && r.data.code === 'already_paid' && r.data.session_id === csAdd, 'extras: replacing a checkout that was paid meanwhile → 409 already_paid');
  r = await xa({ action: 'lookup', ref: refX, email: 't1@example.com' });
  ok(r.data.addons.length === 4 && r.data.limits_left.per_booking === 8 && r.data.limits_left.per_service[S.kate] === 3, 'extras lookup counts the sessions bought after booking');
  r = await adm({ action: 'svc_status', ref: refX, key: 'b0', status: 'cancelled' });
  ok(r.data.ok && store.pis.get(piX).metadata.aob_svc === 'b0:cancelled:', 'svc_status stored on the booking');
  r = await xa({ action: 'lookup', ref: refX, email: 't1@example.com' });
  ok(r.data.limits_left.per_booking === 9 && r.data.addons.find(a => a.key === 'b0').status === 'cancelled', 'a cancelled session no longer counts towards the limits');

  // a session that can't be scheduled is refunded: paid goes down, the balance doesn't
  store.pis.get(piAdd)._refunded = 12000;
  r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
  bX = r.data.bookings.find(b => b.ref === refX);
  ok(bX.paid_cents === 265880 && bX.refunded_cents === 12000 && bX.total_cents === 503000 && bX.balance_cents === 225120, 'refunding a session lowers what was paid, never changes the balance');
  store.pis.get(piAdd)._refunded = 0;

  // an add-on checkout open when the booking is cancelled is closed; one paid in that moment is flagged
  r = await xa({ action: 'pay', ref: refX, email: 't1@example.com', addons: [{ id: S.monica, guest: 0 }] });
  const csLateAdd = r.data.session_id;
  r = await adm({ action: 'cancel', ref: refX });
  ok(r.data.ok && r.data.addon_checkouts_closed === 1 && store.sessions.get(csLateAdd).status === 'expired', 'cancelling a booking closes its open add-on checkout');
  r = await xa({ action: 'lookup', ref: refX, email: 't1@example.com' });
  ok(r.status === 200 && r.data.open === false && r.data.reason === 'cancelled' && /cancelled/.test(r.data.message), 'extras lookup: cancelled booking → open false');
  r = await xa({ action: 'pay', ref: refX, email: 't1@example.com', addons: [{ id: S.monica, guest: 0 }] });
  ok(r.status === 409 && r.data.code === 'cancelled', 'extras pay: cancelled booking → 409');
  tick(60);
  complete(csLateAdd); // the guest's payment went through just as the booking was cancelled
  wr = await hook(sessionEvent('checkout.session.completed', csLateAdd));
  ok(wr.status === 200 && store.ghl.at(-1).event === 'addon_paid_after_cancel' && store.ghl.at(-1).tag === `${P}-addon-after-cancel`, 'a session paid after the cancel → its own GHL event for the team');
  r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
  ok(r.data.bookings.find(b => b.ref === refX).paid_after_cancel_cents === 15000, 'admin shows the session money received after the cancel');
  wr = await hook(sessionEvent('checkout.session.async_payment_failed', csLateAdd));
  ok(store.ghl.at(-1).event === 'addon_payment_failed', 'a failed add-on payment has its own event name');
}
{
  // the week is over / the first payment is still clearing / no sessions offered
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite')]), LIVE);
  const refE = r.data.ref, csE = r.data.session_id;
  complete(csE, { pi: 'processing' });
  r = await xa({ action: 'lookup', ref: refE, email: 't3@example.com' });
  ok(r.data.open === false && r.data.reason === 'processing', 'extras: the first payment still clearing → not yet');
  store.pis.get(store.sessions.get(csE).payment_intent).status = 'succeeded';
  store.pis.get(store.sessions.get(csE).payment_intent).amount_received = store.sessions.get(csE).amount_total;
  tick(31);
  r = await xa({ action: 'lookup', ref: refE, email: 't3@example.com' });
  ok(r.data.open === true, 'extras: open once it has cleared');
  const svcBackup = PROG.services; delete PROG.services;
  r = await xa({ action: 'lookup', ref: refE, email: 't3@example.com' });
  ok(r.data.open === false && r.data.reason === 'unavailable' && r.data.services === null, 'extras: a week without sessions');
  PROG.services = svcBackup;
  const nowKeep = fakeNow;
  fakeNow = RealDate.parse('2026-10-31T20:00:00Z');
  r = await xa({ action: 'lookup', ref: refE, email: 't3@example.com' });
  ok(r.data.open === true, 'extras: still open on the last day of the week');
  fakeNow = RealDate.parse('2026-11-01T08:00:00Z');
  r = await xa({ action: 'lookup', ref: refE, email: 't3@example.com' });
  ok(r.status === 200 && r.data.open === false && r.data.reason === 'ended', 'extras lookup: after the week → open false');
  r = await xa({ action: 'pay', ref: refE, email: 't3@example.com', addons: [{ id: S.kate, guest: 0 }] });
  ok(r.status === 409 && r.data.code === 'ended', 'extras pay: after the week → 409');
  fakeNow = nowKeep;
  // guards
  r = await xa({ action: 'lookup', ref: refE, email: 't3@example.com' }, LIVE, { 'Content-Type': 'text/plain' });
  ok(r.status === 415, 'extras: JSON only');
  r = await xa({ action: 'lookup', ref: refE, email: 't3@example.com' }, LIVE, { Origin: 'https://evil.example' });
  ok(r.status === 403, 'extras: foreign origin refused');
  r = await xa({ action: 'delete', ref: refE, email: 't3@example.com' });
  ok(r.status === 400, 'extras: unknown action');
  r = await xa({ action: 'lookup', ref: 'nope', email: 't3@example.com' });
  ok(r.status === 400, 'extras: invalid reference');
  let c0 = store.calls.length;
  r = await xa({ action: 'lookup', ref: 'ZZ9999-AAAAAA', email: 'a@b.co' });
  ok(r.status === 404 && store.calls.length === c0, 'extras: a reference no program issues costs no Stripe calls');
  r = await xa({ action: 'lookup', ref: refE, email: 't3@example.com' }, { ...LIVE, TURNSTILE_SITE_KEY: '0x4AAAAmock', TURNSTILE_SECRET: '0x4AAAAsecret' }, ip(61));
  ok(r.status === 403 && r.data.code === 'turnstile', 'extras: needs the bot check when it is on');
  r = await xa({ action: 'lookup', ref: refE, email: 't3@example.com', turnstile: 'good-token' }, { ...LIVE, TURNSTILE_SITE_KEY: '0x4AAAAmock', TURNSTILE_SECRET: '0x4AAAAsecret' }, ip(61));
  ok(r.status === 200, 'extras: a valid token passes');
  for (let i = 0; i < 30; i++) await xa({ action: 'lookup', ref: refE, email: 't3@example.com' }, LIVE, ip(62));
  r = await xa({ action: 'lookup', ref: refE, email: 't3@example.com' }, LIVE, ip(62));
  ok(r.status === 429, 'extras: rate limited per visitor');
}
{
  // demo mode (no Stripe key): a stand-in booking to try the page with
  r = await xa({ action: 'lookup', ref: 'BC2610-DEMO23', email: 'a@b.co' }, {});
  ok(r.status === 200 && r.data.demo && r.data.program.id === P && r.data.guests.map(x => x.first_name).join() === 'You,Guest 2' && r.data.open && r.data.addons.length === 0 && r.data.limits_left.per_booking === 12 && r.data.services.items.length === 10 && r.data.stripe.embedded === false, 'extras demo lookup: a stand-in booking with two guests');
  r = await xa({ action: 'lookup', ref: 'BC2707-DEMO23', email: 'a@b.co', program: J2 }, {});
  ok(r.data.program.id === J2, 'extras demo: weeks that share a reference prefix are told apart by program');
  r = await xa({ action: 'pay', ref: 'BC2610-DEMO23', email: 'a@b.co', addons: [{ id: S.muji90, guest: 1 }, { id: S.muji90, guest: 1 }] }, {});
  ok(r.status === 200 && r.data.demo && r.data.quote.due_now_cents === 30000 && r.data.stripe_params.metadata.aob_kind === 'addon' && r.data.stripe_params.metadata.aob_addons === 'muji-magic-massage-90@2,muji-magic-massage-90@2' && r.data.stripe_params.line_items[0].quantity === 2 && /\/book\/extras\/\?status=success/.test(r.data.stripe_params.success_url), 'extras demo pay: the checkout it would open');
  r = await xa({ action: 'pay', ref: 'BC2610-DEMO23', email: 'a@b.co', addons: [{ id: S.muji90, guest: 2 }] }, {});
  ok(r.status === 422, 'extras demo pay: validated like the real one');
  r = await call(addonsApi, 'GET', '/api/booking/addons', null, {});
  ok(r.data.live === false && r.data.stripe.embedded === false, 'extras GET (demo)');
}

/* ================================================================== admin overview */
reset();
{
  r = await call(admin, 'GET', '/api/booking/admin?overview=1', null, ADMIN_ONLY, AUTH);
  ok(r.status === 200 && r.data.overview === true && r.data.demo === true && r.data.weeks.length === listPrograms().length && r.data.recent.length === 0 && Object.values(r.data.totals).every(v => v === 0), 'overview (demo): every week, all zeros');
  const wj = r.data.weeks.find(w => w.program.id === J1);
  ok(wj && wj.places.spaces === 49 && wj.places.left === 49 && Object.values(wj.alerts).every(v => v === 0) && Object.keys(wj.totals).join() === 'bookings,guests,paid_cents,balance_cents,refunded_cents,sessions_count,sessions_cents' && Object.keys(wj.alerts).join() === 'balance_due,plan_issues,unverified_room_only,pending' && wj.program.edition === 'BreathCamp 1', 'overview week: program, totals, places, alerts');
  r = await call(admin, 'GET', '/api/booking/admin?overview=1', null, LIVE);
  ok(r.status === 401, 'overview needs the token');
  // live: a deposit booking with sessions, a room-only booking, a July plan, a payment still clearing
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')], 'deposit', { addons: [{ id: S.muji60, guest: 0 }, { id: S.kate, guest: 1 }] }), LIVE);
  const oA = r.data.ref; complete(r.data.session_id); tick(10);
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'glamping-single')], 'full', { programme: 'paid' }), LIVE);
  const oB = r.data.ref; complete(r.data.session_id); tick(10);
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(4, 'camper')], 'plan'), LIVE);
  const oC = r.data.ref; complete(r.data.session_id); tick(10);
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(5, 'own-tent')]), LIVE);
  const oD = r.data.ref; complete(r.data.session_id, { pi: 'processing' }); tick(10);
  r = await call(admin, 'GET', '/api/booking/admin?overview=1', null, LIVE, AUTH);
  const wP = r.data.weeks.find(w => w.program.id === P), wJ = r.data.weeks.find(w => w.program.id === J1), wJ2 = r.data.weeks.find(w => w.program.id === J2);
  ok(r.status === 200 && r.data.live && wP.totals.bookings === 3 && wP.totals.guests === 4 && wP.totals.sessions_count === 2 && wP.totals.sessions_cents === 22000 && wP.places.left === 13 && wP.places.spaces === 17, 'overview: the October week\'s totals, sessions and places');
  ok(wP.totals.paid_cents === (177600 + 22000 + 56280) + 116100 && wP.totals.balance_cents === 225120 + 164900, 'overview: paid and balance per week');
  ok(wP.alerts.balance_due === 1 && wP.alerts.unverified_room_only === 1 && wP.alerts.pending === 1 && wP.alerts.plan_issues === 0, 'overview alerts: balance due, unverified room only, payment clearing');
  ok(wJ.totals.bookings === 1 && wJ.alerts.plan_issues === 1 && wJ.alerts.balance_due === 0 && wJ2.totals.bookings === 0, 'overview alerts: a plan without its end date is an issue; its balance isn\'t "due"');
  ok(r.data.recent.map(x => x.ref).join() === [oD, oC, oB, oA].join() && r.data.recent[1].program === J1 && r.data.recent[1].edition === 'BreathCamp 1' && r.data.recent[3].lead_name === 'Test1 Guest' && r.data.recent[3].guests === 2 && r.data.recent[3].total_cents === 481000 && r.data.recent[3].status === 'active', 'overview: newest bookings across weeks');
  ok(r.data.totals.bookings === 4 && r.data.totals.paid_cents === r.data.weeks.reduce((s, w) => s + w.totals.paid_cents, 0) && r.data.totals.sessions_count === 2, 'overview totals sum the weeks');
  let n0 = stripeCalls('GET', /^\/payment_intents$/);
  r = await call(admin, 'GET', '/api/booking/admin?overview=1', null, LIVE, AUTH);
  ok(stripeCalls('GET', /^\/payment_intents$/) === n0 + 1, 'overview reads the recent payments once for all weeks');
  fault('GET', /^\/payment_intents\/search$/, { status: 400 });
  r = await call(admin, 'GET', '/api/booking/admin?overview=1', null, LIVE, AUTH);
  ok(r.status === 502, 'overview: Stripe error → 502');
}

/* ================================================================== admin: notes, rooms, session status, rooming */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite', { gender: 'Male' })], 'deposit', { addons: [{ id: S.muji60, guest: 0 }] }), LIVE);
  const kA = r.data.ref, kApi = complete(r.data.session_id);
  r = await adm({ action: 'note', ref: kA, note: '  Arrives late on Sunday\r\nVegan \u0007 meals\u202e  ' });
  ok(r.data.ok && r.data.note === 'Arrives late on Sunday\nVegan   meals' && store.pis.get(kApi).metadata.aob_note === r.data.note, 'note: saved on the booking\'s PaymentIntent, control characters removed, line breaks kept');
  r = await adm({ action: 'note', ref: kA, note: 'x'.repeat(600) });
  ok(r.data.note.length === 480 && store.pis.get(kApi).metadata.aob_note.length === 480, 'note: at most 480 characters');
  r = await adm({ action: 'note', ref: kA, note: '' });
  ok(r.data.ok && !('aob_note' in store.pis.get(kApi).metadata), 'note: empty removes it');
  r = await adm({ action: 'note', ref: kA, note: 'Arrives late' });

  r = await adm({ action: 'assign', ref: kA, assign: { 0: '2A · Temple Cottage', 1: '2A · Temple Cottage' } });
  ok(r.data.ok && r.data.assign['0'] === '2A · Temple Cottage' && r.data.warnings.length === 1 && /women and men/.test(r.data.warnings[0]), 'assign: a woman and a man in one twin is saved, with a warning');
  ok(store.pis.get(kApi).metadata.aob_assign === '0=2A · Temple Cottage|1=2A · Temple Cottage', 'assignment stored as 0=<room>|1=<room>');
  r = await adm({ action: 'assign', ref: kA, assign: { 1: '2B · Temple Cottage' } });
  ok(r.data.ok && r.data.warnings.length === 0 && r.data.assign['0'] === '2A · Temple Cottage' && r.data.assign['1'] === '2B · Temple Cottage', 'assign: one guest moved, the other kept');
  r = await adm({ action: 'assign', ref: kA, assign: { 0: 'Glamping Single 1' } });
  ok(r.status === 422 && /not one of the Twin Room Ensuite rooms/.test(r.data.fields['assign.0']), 'assign: only rooms of the guest\'s room type');
  r = await adm({ action: 'assign', ref: kA, assign: { 5: '2A · Temple Cottage' } });
  ok(r.status === 422 && r.data.fields['assign.5'], 'assign: no such guest');
  r = await adm({ action: 'assign', ref: kA, assign: 'everyone in 2A' });
  ok(r.status === 400, 'assign: needs a guest → room map');
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(3, 'twin-ensuite', { gender: 'Male' }), guest(4, 'twin-ensuite', { gender: 'Male' })]), LIVE);
  const kB = r.data.ref; complete(r.data.session_id);
  r = await adm({ action: 'assign', ref: kB, assign: { 0: '2B · Temple Cottage', 1: '2B · Temple Cottage' } });
  ok(r.data.ok && r.data.warnings.length === 1 && /2B · Temple Cottage: 3 guests for 2 beds/.test(r.data.warnings[0]), 'assign: more people than beds (across bookings) → warning');
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(5, 'glamping-single')], 'full'), LIVE);
  const kC = r.data.ref; complete(r.data.session_id);

  r = await adm({ action: 'svc_status', ref: kA, key: 'b0', status: 'scheduled', when: 'Tue 20 Jul, 15:00' });
  ok(r.data.ok && store.pis.get(kApi).metadata.aob_svc === 'b0:scheduled:Tue 20 Jul, 15:00', 'svc_status: stored as key:status:when');
  r = await adm({ action: 'svc_status', ref: kA, key: 'b0', status: 'done', when: 'Tue 20 Jul; 15:00 with Muji, room 3 at the Main House' });
  ok(r.data.when === 'Tue 20 Jul, 15:00 with Muji, room 3 at t' && !store.pis.get(kApi).metadata.aob_svc.includes(';'), 'svc_status: "when" cut to 40 characters, no separators');
  r = await adm({ action: 'svc_status', ref: kA, key: 'b0', status: 'todo', when: '' });
  ok(r.data.ok && !('aob_svc' in store.pis.get(kApi).metadata), 'svc_status: back to "todo" with no time drops the entry');
  r = await adm({ action: 'svc_status', ref: kA, key: 'b9', status: 'done' });
  ok(r.status === 404, 'svc_status: unknown session key → 404');
  r = await adm({ action: 'svc_status', ref: kA, key: 'b0', status: 'maybe' });
  ok(r.status === 422 && r.data.fields.status, 'svc_status: unknown status → 422');
  r = await adm({ action: 'svc_status', ref: kA, key: 'b0', status: 'scheduled', when: 'Wed 21 Jul, 10:00' });

  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  const pd = r.data.program_detail, rm = r.data.rooming, bA = r.data.bookings.find(b => b.ref === kA);
  ok(pd.id === J1 && pd.edition === 'BreathCamp 1' && pd.program_spaces === 49 && pd.rooms.find(x => x.id === 'twin-ensuite').names.length === 5 && pd.rooms.find(x => x.id === 'twin-ensuite').same_gender === true && pd.rooms.find(x => x.id === 'own-tent').names === null && pd.rooms.find(x => x.id === 'cottage-two').unit === 'cottage', 'admin: program detail with rooms and their physical names');
  ok(pd.services.length === 10 && pd.services[0].id === S.anthony && pd.services[0].practitioner_name === 'Anthony Abbagnano' && pd.services[0].price === 400 && pd.services[0].minutes === 90 && pd.practitioners.muji.name === 'Muji' && pd.booking_url === `https://website-5h3.pages.dev/book/${J1}/`, 'admin: program detail with the sessions on offer and the booking page');
  ok(bA.note === 'Arrives late' && bA.assign['1'] === '2B · Temple Cottage' && bA.addons[0].status === 'scheduled' && bA.addons[0].when === 'Wed 21 Jul, 10:00' && bA.source === 'online', 'admin booking: note, rooms and session status');
  ok(Object.keys(rm).length === 31 && rm['2A · Temple Cottage'].room_id === 'twin-ensuite' && rm['2A · Temple Cottage'].gender === 'Female' && rm['2A · Temple Cottage'].guests.length === 1 && rm['2A · Temple Cottage'].guests[0].ref === kA && rm['2A · Temple Cottage'].guests[0].index === 0 && rm['2A · Temple Cottage'].guests[0].name === 'Test1 Guest' && rm['2A · Temple Cottage'].conflict === null, 'rooming: every physical room with its guests and gender');
  ok(rm['2B · Temple Cottage'].conflict === 'over' && rm['2B · Temple Cottage'].guests.length === 3 && rm['2B · Temple Cottage'].capacity === 2 && rm['2B · Temple Cottage'].gender === 'Male' && rm['1B · Peace Cottage'].guests.length === 0 && rm['1B · Peace Cottage'].gender === null && rm['Glamping Single 1'].capacity === 1, 'rooming: an over-full room is flagged; empty rooms are listed');
  ok(r.data.unassigned.length === 1 && r.data.unassigned[0].ref === kC && r.data.unassigned[0].room === 'glamping-single', 'rooming: guests without a room yet');
  r = await adm({ action: 'cancel', ref: kB });
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  ok(r.data.rooming['2B · Temple Cottage'].guests.length === 1 && r.data.rooming['2B · Temple Cottage'].conflict === null, 'rooming: a cancelled booking leaves its rooms');
  const rmx = roomingMap(JP, [
    { ref: 'R1', status: 'active', guests: [{ name: 'A', gender: 'Female', room: 'triple-ensuite' }, { name: 'B', gender: 'Male', room: 'triple-ensuite' }], assign: { 0: '4A · Alchemy Cottage', 1: '4A · Alchemy Cottage' } },
    { ref: 'R3', status: 'active', guests: [{ name: 'D', gender: 'Male', room: 'cottage-two' }, { name: 'E', gender: 'Female', room: 'cottage-two' }, { name: 'F', gender: 'Male', room: 'camper' }, { name: 'G', gender: 'Male', room: 'camper' }],
      assign: { 0: '4C + 4D · Alchemy Cottage (combined)', 1: '4C + 4D · Alchemy Cottage (combined)', 2: 'Old Spot 9', 3: 'Campervan Spot 1' } },
    { ref: 'R4', status: 'active', guests: [{ name: 'H', gender: 'Female', room: 'camper' }], assign: { 0: 'Campervan Spot 1' } },
  ]);
  ok(rmx.rooming['4A · Alchemy Cottage'].conflict === 'mixed' && rmx.rooming['4A · Alchemy Cottage'].gender === null, 'rooming: women and men in a same-gender room → mixed');
  ok(rmx.rooming['4C + 4D · Alchemy Cottage (combined)'].conflict === null && rmx.rooming['4C + 4D · Alchemy Cottage (combined)'].capacity === 2, 'rooming: a couple in the cottage for two is fine');
  ok(rmx.rooming['Campervan Spot 1'].conflict === 'over' && rmx.rooming['Campervan Spot 1'].capacity === 1, 'rooming: two people on one camper spot → over');
  ok(rmx.rooming['Old Spot 9'].unknown === true && rmx.rooming['Old Spot 9'].guests[0].name === 'F' && rmx.unassigned.length === 0, 'rooming: a name the program no longer lists is kept (unknown)');
  ok(JSON.stringify(parseAssign('0=2A · Temple Cottage|x=y|3=|1=2B')) === '{"0":"2A · Temple Cottage","1":"2B"}' && JSON.stringify(parseSvc('b0:done:Tue 20 Jul, 15:00;b1:bogus:x;x1:scheduled')) === '{"b0":{"status":"done","when":"Tue 20 Jul, 15:00"},"x1":{"status":"scheduled","when":""}}', 'assignment and session-status strings parse safely');
}

/* ================================================================== admin booking links (create_link) and discounts */
reset();
{
  const linkBody = (extra = {}) => ({ action: 'create_link', program: J1, payment: 'deposit', programme: 'included', whatsapp: '+447700900123', guests: [guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')], ...extra });
  r = await call(admin, 'POST', '/api/booking/admin', linkBody(), LIVE);
  ok(r.status === 401, 'create_link: admin only');
  r = await adm(linkBody({ payment: 'plan' }));
  ok(r.status === 422 && r.data.fields.payment, 'create_link: deposit or full only');
  r = await adm(linkBody({ guests: [guest(1, 'twin-ensuite', { email: 'nope' })] }));
  ok(r.status === 422 && r.data.fields['guests.0.email'], 'create_link: validated like a booking');
  r = await adm(linkBody({ discount: { type: 'percent', value: 50, scope: 'programme', reason: 'Bring a friend' }, note: 'Friend of Maria' }));
  const sL = store.sessions.get(r.data.session_id), liL = arr(sL._params.line_items), refL = r.data.ref;
  ok(r.status === 200 && r.data.ok && r.data.url && /^BC2707-/.test(refL) && r.data.quote.total_cents === 370200 && r.data.quote.due_now_cents === 145080 && r.data.quote.balance_cents === 225120 && r.data.quote.discount.cents === 88800 && r.data.quote.subtotal_cents === 459000, 'create_link: 50% off the programme fee');
  ok(liL[0].quantity === '2' && liL[0].price_data.unit_amount === '44400' && liL[0].price_data.product_data.name === 'Programme fee · 50% off (Bring a friend) · BreathCamp, 18–24 Jul 2027' && sumLines(sL._params) === 145080, 'create_link: the line names the discount, the lines add up');
  ok(sL.expires_at - nowS() === 86040 && r.data.expires_at === sL.expires_at && !sL._params.ui_mode && sL._params.success_url.startsWith(`https://website-5h3.pages.dev/book/${J1}/?status=success`) && sL._params.consent_collection.terms_of_service === 'required' && /\[BreathCamp terms\]\(https:/.test(sL._params.custom_text.terms_of_service_acceptance.message), 'create_link: hosted, open 23.9 hours, the guest accepts the terms on Stripe\'s page');
  const mdL = sL.metadata;
  ok(mdL.aob_source === 'admin' && mdL.aob_discount === 'percent:50:programme:Bring a friend' && mdL.aob_discount_cents === '88800' && mdL.aob_note === 'Friend of Maria' && mdL.aob_total === '370200' && mdL.aob_kind === 'booking' && !mdL.aob_terms_at && !mdL.aob_iph && !mdL.aob_attempt, 'create_link metadata: source, discount, note, the discounted total');
  ok(/Includes €888 off \(Bring a friend\)\./.test(sL._params.custom_text.submit.message) && /Includes €888 off/.test(sL._params.invoice_creation.invoice_data.description), 'create_link: the discount is spelled out above the pay button and on the invoice');
  // the guest pays the link
  complete(sL.id);
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  const bL = r.data.bookings.find(b => b.ref === refL);
  ok(bL.source === 'admin' && JSON.stringify(bL.discount) === '{"type":"percent","value":50,"scope":"programme","reason":"Bring a friend","cents":88800}' && bL.note === 'Friend of Maria' && bL.total_cents === 370200 && bL.paid_cents === 145080 && bL.balance_cents === 225120 && bL.programme_cents === 88800, 'admin: a paid link shows its source, discount and note');

  // holds: a link keeps its places for as long as it is open
  r = await adm(linkBody({ guests: [guest(5, 'cottage-one')], payment: 'full' }));
  const linkId = r.data.session_id;
  r = await availJ();
  ok(r.data.rooms['cottage-one'].held === 1 && r.data.rooms['cottage-one'].sold_out && r.data.rooms['cottage-one'].next_release_at === store.sessions.get(linkId).expires_at, 'an admin link holds its places while it is open');
  tick(3 * 3600);
  r = await availJ();
  ok(r.data.rooms['cottage-one'].held === 1, '… for hours, not just 35 minutes');
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(6, 'cottage-one')]), LIVE);
  ok(r.status === 409 && r.data.code === 'unavailable', 'nobody else can book the place meanwhile');
  r = await adm(linkBody({ guests: [guest(7, 'cottage-one')], payment: 'full' }));
  ok(r.status === 409 && r.data.code === 'unavailable', '… nor get a second link for it');
  r = await adm(linkBody({ guests: [guest(5, 'cottage-one')], payment: 'deposit' }));
  ok(r.status === 200 && r.data.replaced === 1 && store.sessions.get(linkId).status === 'expired' && store.sessions.get(r.data.session_id).status === 'open', 'a new link for the same guest replaces the old one');
  store.rejectParams.add('consent_collection[terms_of_service]');
  r = await adm(linkBody({ guests: [guest(8, 'twin-ensuite')] }));
  ok(r.status === 200 && !lastSession()._params.consent_collection && !lastSession()._params.custom_text.terms_of_service_acceptance && logs.some(l => l.includes('"param":"consent_collection[terms_of_service]"')), 'no terms URL in the Stripe account: the link is made without the terms tick (logged)');
  store.rejectParams.clear();
  store.noTosUrl = true;
  r = await adm(linkBody({ guests: [guest(9, 'twin-ensuite')] }));
  ok(r.status === 200 && !lastSession()._params.consent_collection && store.sessions.get(r.data.session_id).status === 'open', '… also when Stripe refuses it without naming the setting');
  store.noTosUrl = false;
  store.rejectParams.add('payment_intent_data[receipt_email]');
  r = await adm(linkBody({ guests: [guest(4, 'twin-ensuite')] }));
  ok(r.status === 502 && /Stripe error/.test(r.data.error), 'other refusals are not papered over');
  store.rejectParams.clear();
  r = await adm(linkBody({ guests: [guest(1, 'twin-ensuite')], payment: 'full', discount: { type: 'percent', value: 100, scope: 'total', reason: 'Free place' } }));
  ok(r.status === 422 && /€0.50/.test(r.data.fields['discount.value']), 'create_link: a link for nothing is refused (Stripe needs at least €0.50)');
  const nowKeep = fakeNow; fakeNow = RealDate.parse('2027-07-25T09:00:00Z');
  r = await adm(linkBody());
  ok(r.status === 410, 'create_link: not after the week');
  fakeNow = nowKeep;
  r = await call(admin, 'POST', '/api/booking/admin', linkBody({ discount: { type: 'amount', value: 5000, scope: 'room', reason: 'Late booking' } }), ADMIN_ONLY, AUTH);
  ok(r.status === 200 && r.data.demo && r.data.url === null && r.data.quote.discount.cents === 5000 && r.data.stripe_params.metadata.aob_discount === 'amount:5000:room:Late booking' && r.data.stripe_params.expires_at - nowS() === 86040, 'create_link without Stripe (demo): the link it would make');
  r = await call(admin, 'POST', '/api/booking/admin', { action: 'note', ref: refL, note: 'x' }, ADMIN_ONLY, AUTH);
  ok(r.status === 503, 'other admin actions still need Stripe');

  // discount math, every scope and type
  const qa = (extra = {}) => quote(JP, { payment: 'deposit', programme: 'included', whatsapp: '+447700900123', guests: [guest(1, 'twin-ensuite')], ...extra }, { admin: true });
  const lines = qd => bookingCheckoutParams(JP, qd, 'BC2707-TESTAA', bookingMetadata(JP, qd, 'BC2707-TESTAA', { source: 'admin' }), 'https://website-5h3.pages.dev/book/x/');
  let qd = qa({ discount: { type: 'amount', value: 20000, scope: 'room', reason: 'Staff' } }), spd = lines(qd);
  ok(qd.ok && qd.accommodation_cents === 120700 && qd.programme_cents === 88800 && qd.deposit_cents === 112940 && qd.total_cents === 209500 && qd.balance_cents === 96560 && qd.discount.cents === 20000, 'discount: €200 off the room; the deposit is 20% of the reduced room');
  ok(sumLines(spd) === 112940 && spd.line_items[1].price_data.unit_amount === 24140 && spd.line_items[1].price_data.product_data.name === '20% accommodation deposit · €200 off (Staff) · BreathCamp, 18–24 Jul 2027' && spd.line_items[0].price_data.product_data.name === 'Programme fee · BreathCamp, 18–24 Jul 2027', 'room discount: only the accommodation line names it');
  qd = qa({ payment: 'full', guests: [guest(1, 'glamping-single')], discount: { type: 'percent', value: 10, scope: 'room', reason: 'Staff' } });
  ok(qd.ok && qd.accommodation_cents === 104490 && qd.programme_cents === 88800 && qd.total_cents === 193290 && qd.due_now_cents === 193290 && qd.discount.cents === 11610 && sumLines(lines(qd)) === 193290, 'discount: 10% off the room only');
  qd = qa({ discount: { type: 'amount', value: 30000, scope: 'programme', reason: 'Scholarship' } });
  ok(qd.ok && qd.programme_cents === 58800 && qd.accommodation_cents === 140700 && qd.deposit_cents === 58800 + 28140 && qd.total_cents === 199500 && sumLines(lines(qd)) === qd.due_now_cents, 'discount: €300 off the programme fee');
  qd = qa({ addons: [{ id: S.muji60, guest: 0 }, { id: S.muji60, guest: 0 }, { id: S.anthony, guest: 0 }], discount: { type: 'percent', value: 10, scope: 'total', reason: 'Team' } });
  spd = lines(qd);
  ok(qd.ok && qd.programme_cents === 79920 && qd.accommodation_cents === 126630 && qd.addons_cents === 54000 && qd.total_cents === 260550 && qd.deposit_cents === 159246 && qd.discount.cents === 8880 + 14070 + 6000 && qd.subtotal_cents === 289500, 'discount: 10% off everything, sessions included');
  ok(sumLines(spd) === 159246 && spd.line_items[1].quantity === 2 && spd.line_items[1].price_data.unit_amount === 9000 && spd.line_items[1].price_data.product_data.name === 'Wellbeing session · Muji: Magic Massage (60 min) · 10% off (Team)' && spd.line_items[2].price_data.unit_amount === 36000 && spd.line_items.every(x => Number.isInteger(x.price_data.unit_amount) && x.price_data.unit_amount > 0), 'discounted lines stay whole cents, positive, and add up');
  qd = qa({ payment: 'full', addons: [{ id: S.kate, guest: 0 }], discount: { type: 'amount', value: 150000, scope: 'total', reason: 'Gift' } });
  spd = lines(qd);
  ok(qd.ok && qd.accommodation_cents === 0 && qd.programme_cents === 79500 && qd.addons_cents === 12000 && qd.total_cents === 91500 && qd.due_now_cents === 91500 && qd.balance_cents === 0 && qd.discount.programme_cents === 9300 && qd.discount.accommodation_cents === 140700, 'discount: an amount off the total comes off the room first, then the programme fee (sessions untouched)');
  ok(sumLines(spd) === 91500 && spd.line_items.length === 2 && /€1,500 off \(Gift\)/.test(spd.line_items[0].price_data.product_data.name) && spd.line_items.every(x => x.price_data.unit_amount > 0), 'a line brought to zero is left out; nothing negative');
  qd = qa({ guests: [guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite'), guest(3, 'twin-ensuite')], discount: { type: 'amount', value: 10001, scope: 'programme', reason: 'Odd' } });
  spd = lines(qd);
  ok(qd.ok && qd.programme_cents === 256399 && spd.line_items[0].quantity === 1 && spd.line_items[0].price_data.unit_amount === 256399 && /3 guests\./.test(spd.line_items[0].price_data.product_data.description) && sumLines(spd) === qd.due_now_cents, 'an amount that doesn\'t split evenly per guest becomes one programme line');
  qd = qa({ discount: { type: 'amount', value: 300000, scope: 'total', reason: 'Too much' } });
  ok(!qd.ok && /at most €2,295/.test(qd.errors['discount.value']), 'discount: never more than its scope');
  qd = qa({ discount: { type: 'amount', value: 140701, scope: 'room', reason: 'Too much' } });
  ok(!qd.ok && /at most €1,407/.test(qd.errors['discount.value']), 'discount: an amount off the room is at most the room');
  for (const [d, k] of [[{ type: 'percent', value: 0, scope: 'total', reason: 'x' }, 'value'], [{ type: 'percent', value: 101, scope: 'total', reason: 'x' }, 'value'], [{ type: 'percent', value: 12.5, scope: 'total', reason: 'x' }, 'value'],
    [{ type: 'amount', value: -500, scope: 'room', reason: 'x' }, 'value'], [{ type: 'amount', value: '5e3', scope: 'room', reason: 'x' }, 'value'], [{ type: 'percent', value: 10, scope: 'total', reason: '' }, 'reason'],
    [{ type: 'percent', value: 10, scope: 'total', reason: 'r'.repeat(61) }, 'reason'], [{ type: 'free', value: 10, scope: 'total', reason: 'x' }, 'type'], [{ type: 'percent', value: 10, scope: 'everything', reason: 'x' }, 'scope'], ['50%', 'type']]) {
    qd = qa({ discount: d });
    ok(!qd.ok && qd.errors['discount.' + k], `discount refused: ${JSON.stringify(d)} (${k})`);
  }
  qd = qa({ discount: { type: 'percent', value: '20', scope: 'total', reason: 'Text value' } });
  ok(qd.ok && qd.discount.value === 20, 'discount value may come as text');
  qd = qa({ programme: 'paid', discount: { type: 'percent', value: 10, scope: 'programme', reason: 'x' } });
  ok(!qd.ok && /no programme fee/.test(qd.errors['discount.scope']), 'discount: no programme fee to take it off on a room-only booking');
  qd = qa({ discount: null });
  ok(qd.ok && qd.discount === null && qd.total_cents === 229500 && !qd.errors.terms, 'admin quote: no discount, and no terms tick needed (the guest ticks them on Stripe\'s page)');
  qd = quote(JP, { payment: 'deposit', whatsapp: '+447700900123', guests: [guest(1, 'twin-ensuite')], terms: true, discount: { type: 'percent', value: 50, scope: 'total', reason: 'x' } });
  ok(qd.ok && qd.discount === null && qd.total_cents === 229500, 'without admin a discount is never applied');
  qd = qa({ programme: 'paid' });
  ok(bookingMetadata(JP, qd, 'BC2707-TESTAB', { source: 'admin', progVerified: 'admin' }).aob_prog_verified === 'admin', 'a room-only link made by the team counts as checked by the team');
}

/* ================================================================== review fixes (regressions) */
const lone = s => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(s));
const addonOpen = ref => [...store.sessions.values()].filter(s => s.status === 'open' && s.metadata.aob_kind === 'addon' && s.metadata.aob_ref === ref);

/* F1: re-issuing an admin link while the old one is being paid, or can't be closed */
reset();
{
  const lk = extra => adm({ action: 'create_link', program: J1, payment: 'full', programme: 'included', whatsapp: '+447700900123', guests: [guest(5, 'cottage-one')], ...extra });
  r = await lk();
  const L1 = r.data.session_id, L1ref = r.data.ref;
  store.onCreate = s => { if (s.id !== L1 && store.sessions.get(L1).status === 'open') complete(L1); }; // the guest pays link 1 as link 2 is made
  r = await lk({ payment: 'deposit' });
  store.onCreate = null;
  const L2 = lastSession().id;
  ok(r.status === 409 && r.data.code === 'already_paid' && r.data.ref === L1ref && r.data.session_id === L1 && L2 !== L1 && store.sessions.get(L2).status === 'expired' && !('replaced' in r.data), 'create_link: the old link was paid meanwhile → the new link is closed, 409 already_paid with the paid reference');
  r = await availJ();
  ok(r.data.rooms['cottage-one'].taken === 1 && r.data.rooms['cottage-one'].held === 0, 'create_link: the single cottage is sold once, no second payable link');
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  ok(r.data.bookings.filter(b => b.lead.email === 't5@example.com').length === 1, 'create_link: one booking for the guest, not two');

  const lt = (n, extra) => lk({ guests: [guest(n, 'twin-ensuite')], ...extra });
  r = await lt(6); const L3 = r.data.session_id, L3ref = r.data.ref;
  store.onCreate = s => { if (s.id !== L3 && store.sessions.get(L3).status === 'open') complete(L3, { pi: 'processing' }); }; // a bank debit
  r = await lt(6, { payment: 'deposit' });
  store.onCreate = null;
  ok(r.status === 409 && r.data.code === 'already_paid' && r.data.ref === L3ref && /clearing/.test(r.data.error) && store.sessions.get(lastSession().id).status === 'expired', 'create_link: an old link whose payment is still clearing counts as paid');

  r = await lt(7); const L4 = r.data.session_id;
  const n0 = store.sessions.size;
  fault('POST', /^\/checkout\/sessions\/cs_\w+\/expire$/, { status: 500, times: 3 }); // Stripe can't close link 4 right now
  r = await lt(7, { payment: 'deposit' });
  const L5 = lastSession().id;
  ok(r.status === 503 && r.data.code === 'busy' && store.sessions.size === n0 + 1 && store.sessions.get(L5).status === 'expired' && store.sessions.get(L4).status === 'open', 'create_link: the old link couldn\'t be closed → the new one is closed, 503 busy (never two payable links)');
  r = await lt(7, { payment: 'deposit' });
  ok(r.status === 200 && r.data.replaced === 1 && store.sessions.get(L4).status === 'expired' && store.sessions.get(r.data.session_id).status === 'open', 'create_link: tried again, the old link is replaced (replaced counts what was closed)');
  // the old link expired on its own between the list and the replace: nothing to count
  r = await lt(8); const L6 = r.data.session_id;
  store.onList = () => { store.sessions.get(L6).status = 'expired'; };
  r = await lt(8, { payment: 'deposit' });
  ok(r.status === 200 && r.data.replaced === 1 && store.sessions.get(r.data.session_id).status === 'open', 'create_link: an old link that just expired by itself is simply gone');
}

/* F6: terms acceptance on admin links is reported, and recorded on the booking once paid */
reset();
{
  const lb = (extra = {}) => adm({ action: 'create_link', program: J1, payment: 'deposit', programme: 'included', whatsapp: '+447700900123', guests: [guest(1, 'twin-ensuite')], ...extra });
  r = await lb();
  ok(r.status === 200 && r.data.terms === 'collected' && !('warning' in r.data), 'create_link: terms collected on Stripe\'s page');
  const sT = store.sessions.get(r.data.session_id), refT = r.data.ref, piT = complete(sT.id);
  sT.consent = { terms_of_service: 'accepted', promotions: null };
  const tEvt = nowS() - 7;
  wr = await hook({ ...sessionEvent('checkout.session.completed', sT.id), created: tEvt }, { ...LIVE, GHL_WEBHOOK_URL: '' });
  let mdT = store.pis.get(piT).metadata;
  ok(wr.status === 200 && mdT.aob_terms_at === new Date(tEvt * 1000).toISOString() && mdT.aob_terms === JP.terms_url, 'admin link paid: the terms acceptance is recorded on the booking (also without GHL)');
  const at0 = mdT.aob_terms_at; tick(60);
  wr = await hook({ ...sessionEvent('checkout.session.completed', sT.id), created: nowS() });
  ok(wr.status === 200 && store.pis.get(piT).metadata.aob_terms_at === at0 && store.ghl.at(-1).event === 'booking_paid', '… once (a later event doesn\'t move it)');
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  ok(r.data.bookings.find(b => b.ref === refT).terms_at === at0, 'admin shows when the guest accepted the terms');
  r = await lb({ guests: [guest(2, 'twin-ensuite')] });
  const sN = store.sessions.get(r.data.session_id), piN = complete(sN.id);
  wr = await hook(sessionEvent('checkout.session.completed', sN.id));
  ok(wr.status === 200 && !store.pis.get(piN).metadata.aob_terms_at, 'no consent on the session → nothing recorded');
  store.noTosUrl = true;
  r = await lb({ guests: [guest(3, 'twin-ensuite')] });
  store.noTosUrl = false;
  ok(r.status === 200 && r.data.terms === 'not_collected' && r.data.warning === 'Stripe isn\'t set up to ask for terms acceptance on this link. Add a terms URL in Stripe → Settings → Public details, or send the terms with the link.', 'create_link: Stripe refused the terms tick → not_collected, with a warning for the team');
  r = await call(admin, 'POST', '/api/booking/admin', { action: 'create_link', program: J1, payment: 'deposit', programme: 'included', whatsapp: '+447700900123', guests: [guest(1, 'twin-ensuite')] }, ADMIN_ONLY, AUTH);
  ok(r.data.demo && r.data.terms === 'collected', 'create_link (demo): says whether the terms are asked for');
  // the fullest admin booking still has room for the terms record and the team's keys
  const big = quote(JP, { payment: 'deposit', programme: 'paid', whatsapp: '+447700900123', roommate: 'r'.repeat(200), diet: 'd'.repeat(400),
    guests: Array.from({ length: 6 }, (_, i) => guest(i, 'twin-ensuite')), addons: Array.from({ length: 12 }, (_, i) => ({ id: [S.kate, S.amy, S.michael][i % 3], guest: i % 6 })),
    discount: { type: 'percent', value: 10, scope: 'total', reason: 'r'.repeat(60) } }, { admin: true });
  const bigMd = bookingMetadata(JP, big, 'BC2707-ABCDEF', { source: 'admin', note: 'n'.repeat(480), progVerified: 'admin', progPis: [{ id: 'pi_x', cents: 88800 }], page: 'https://alchemyofbreath.com/book/x/', ui: 'hosted' });
  const keys = new Set([...Object.keys(bigMd), 'aob_terms_at', 'aob_terms', 'aob_assign', 'aob_svc', 'aob_status', 'aob_status_at', 'aob_ghl']);
  ok(big.ok && keys.size <= 50, `the fullest admin booking + terms record + team keys: ${keys.size} metadata keys (≤ 50)`);
}

/* F2 + F7: a refunded wellbeing session (extras) */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), LIVE);
  const refR = r.data.ref, piB = complete(r.data.session_id);
  r = await xa({ action: 'pay', ref: refR, email: 't1@example.com', addons: [{ id: S.kate, guest: 0 }] });
  const piK = complete(r.data.session_id);
  r = await xa({ action: 'pay', ref: refR, email: 't1@example.com', addons: [{ id: S.amy, guest: 0 }] });
  const piA = complete(r.data.session_id), amyCents = store.pis.get(piA).amount_received;
  store.pis.get(piK)._refunded = 12000;                // the €120 session couldn't be scheduled: refunded in full
  store.pis.get(piA)._refunded = 1000;                 // a goodwill partial refund on the other one
  tick(31);
  r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: refR, email: 't1@example.com' }, LIVE);
  ok(r.status === 200 && !r.data.code && r.data.balance_cents === 112560, 'a refunded session doesn\'t stop the online balance payment');
  r = await call(balance, 'POST', '/api/booking/balance', { action: 'pay', ref: refR, email: 't1@example.com' }, LIVE);
  ok(r.status === 200 && r.data.url && r.data.balance_cents === 112560, '… the guest can pay the balance');
  r = await adm({ action: 'balance_link', ref: refR });
  ok(r.status === 200 && r.data.url && r.data.balance_cents === 112560, '… and the team can send a balance link without forcing it');
  r = await call(admin, 'GET', `/api/booking/admin?program=${P}`, null, LIVE, AUTH);
  let bR = r.data.bookings.find(b => b.ref === refR);
  ok(bR.refunded_cents === 13000 && bR.refunded_booking_cents === 0 && bR.balance_cents === 112560, 'refunded_cents is every refund; refunded_booking_cents only the booking\'s own');
  const kAdd = bR.addons.find(a => a.payment_id === piK), aAdd = bR.addons.find(a => a.payment_id === piA);
  ok(kAdd.refunded === true && kAdd.status === 'cancelled' && !aAdd.refunded && aAdd.status === 'todo', 'a session refunded in full is flagged refunded (and cancelled)');
  ok(bR.sessions_count === 1 && bR.sessions_cents === amyCents - 1000 && r.data.totals.sessions_cents === amyCents - 1000 && r.data.totals.sessions_count === 1, 'sessions sold count what was kept: the refunded session is out, a partial refund is netted');
  r = await call(admin, 'GET', '/api/booking/admin?overview=1', null, LIVE, AUTH);
  const wR = r.data.weeks.find(w => w.program.id === P);
  ok(wR.totals.sessions_cents === amyCents - 1000 && wR.totals.sessions_count === 1 && r.data.totals.sessions_cents === amyCents - 1000, 'overview totals follow');
  r = await xa({ action: 'lookup', ref: refR, email: 't1@example.com' });
  ok(r.data.limits_left.per_booking === 11 && r.data.limits_left.per_service[S.kate] === 4, 'a session refunded in full no longer counts towards the limits');
  // a refund of the booking's own payment still stops it
  store.pis.get(piB)._refunded = 5000; tick(31);
  r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: refR, email: 't1@example.com' }, LIVE);
  ok(r.status === 409 && r.data.code === 'refunded', 'a refund of the booking payment still stops the online balance payment');
  r = await adm({ action: 'balance_link', ref: refR });
  ok(r.status === 409 && r.data.code === 'refunded' && r.data.refunded_cents === 5000 && /€50 of booking/.test(r.data.error), '… and the admin link names the booking refund only');
}

/* F3 + F4: one payable add-on checkout per booking */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), LIVE);
  const ref3 = r.data.ref; complete(r.data.session_id);
  const pay3 = (addons, extra) => xa({ action: 'pay', ref: ref3, email: 't1@example.com', addons, ...extra });
  const m90 = [{ id: S.muji90, guest: 0 }];
  r = await pay3(m90); const A = r.data.session_id;
  store.onList = () => complete(A);     // paid right after the open checkouts were listed
  let n0 = store.sessions.size;
  r = await pay3(m90, { replace: A });
  ok(r.status === 409 && r.data.code === 'already_paid' && r.data.session_id === A && store.sessions.size === n0, 'extras: the replaced checkout paid while being closed → 409 already_paid, no second checkout');
  r = await pay3(m90); const A2 = r.data.session_id;
  store.onGet = id => { if (id === A2) complete(A2); }; // paid right after the first look at it (gone from the open list)
  n0 = store.sessions.size;
  r = await pay3(m90, { replace: A2 });
  ok(r.status === 409 && r.data.code === 'already_paid' && r.data.session_id === A2 && store.sessions.size === n0, 'extras: … also when it left the open list before it was listed');
  r = await pay3(m90); const A3 = r.data.session_id;
  store.onList = () => complete(A3);
  n0 = store.sessions.size;
  r = await pay3(m90); // another tab, the same sessions, no replace
  ok(r.status === 409 && r.data.code === 'already_paid' && r.data.session_id === A3 && store.sessions.size === n0, 'extras: the same sessions paid in another checkout meanwhile → 409 already_paid');
  r = await pay3([{ id: S.kate, guest: 0 }]); const A4 = r.data.session_id;
  store.onList = () => complete(A4);
  r = await pay3([{ id: S.amy, guest: 0 }]);
  ok(r.status === 200 && store.sessions.get(A4).status === 'complete' && addonOpen(ref3).length === 1 && r.data.session_id === addonOpen(ref3)[0].id, 'extras: other sessions paid meanwhile count towards the limits, the new checkout opens');
  r = await xa({ action: 'lookup', ref: ref3, email: 't1@example.com' });
  ok(r.data.limits_left.per_service[S.muji90] === 1 && r.data.limits_left.per_booking === 8, 'extras: every payment counted once (3 + 1 paid; the open one not yet)');

  // F4: two requests at the same moment
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'twin-ensuite')]), LIVE);
  const ref4 = r.data.ref; complete(r.data.session_id);
  const twelve = [S.muji60, S.kate, S.amy].flatMap(id => Array.from({ length: 4 }, () => ({ id, guest: 0 })));
  const pay4 = () => xa({ action: 'pay', ref: ref4, email: 't2@example.com', addons: twelve });
  store.latency = 3;
  const [ca, cb] = await Promise.all([pay4(), pay4()]);
  store.latency = 0;
  ok(addonOpen(ref4).length <= 1 && !(ca.status === 200 && cb.status === 200) && [ca, cb].every(x => x.status === 200 || (x.status === 409 && x.data.code === 'busy' && /in progress/.test(x.data.error))), 'extras: two pay requests at once → never two payable checkouts (the later one, or in a tie both, back off with 409 busy)');
  r = await pay4();
  ok(r.status === 200 && addonOpen(ref4).length === 1 && addonOpen(ref4)[0].id === r.data.session_id, 'extras: tried again → one payable checkout');
  // the post-create check, with clear creation times
  const fakeOpen = (created) => { const id = `cs_test_mockrace${pad(++store.seq)}abcdef`; store.sessions.set(id, { id, status: 'open', created, expires_at: created + 1860, metadata: { aob_kind: 'addon', aob_ref: ref4 }, amount_total: 1 }); return id; };
  let injected = null, made = null;
  store.onCreate = s => { if (s.metadata.aob_kind === 'addon') { made = s.id; injected = fakeOpen(s.created - 1); store.onCreate = null; } }; // another request's checkout, created a second earlier
  r = await pay4();
  ok(r.status === 409 && r.data.code === 'busy' && store.sessions.get(made).status === 'expired' && addonOpen(ref4).map(s => s.id).join() === injected, 'extras: an add-on checkout created earlier by another request wins; the new one is closed');
  store.sessions.get(injected).status = 'expired';
  store.onCreate = s => { if (s.metadata.aob_kind === 'addon') { injected = fakeOpen(s.created + 1); store.onCreate = null; } }; // one created after this one
  r = await pay4();
  ok(r.status === 200 && store.sessions.get(r.data.session_id).status === 'open', 'extras: a checkout created later doesn\'t make this one back off (that one backs off)');
  store.sessions.get(injected).status = 'expired';
  // an earlier checkout Stripe can't close: no second one
  const keep = r.data.session_id;
  n0 = store.sessions.size;
  fault('POST', /^\/checkout\/sessions\/cs_\w+\/expire$/, { status: 500, times: 3 });
  r = await pay4();
  ok(r.status === 503 && r.data.code === 'busy' && store.sessions.size === n0 && store.sessions.get(keep).status === 'open' && addonOpen(ref4).length === 1, 'extras: an earlier checkout that can\'t be closed → 503 busy, no second checkout');
}

/* F5: half an emoji after cutting text never breaks a Stripe call */
reset();
{
  ok(formEncode({ a: 'x\uD83D', b: '\uDE4F', c: '🌿' }) === 'a=x%EF%BF%BD&b=%EF%BF%BD&c=%F0%9F%8C%BF', 'formEncode never throws on half an emoji (U+FFFD)');
  ok(str('a'.repeat(39) + '🌿', 40) === 'a'.repeat(39) && cleanNote('n'.repeat(479) + '🙏 thanks') === 'n'.repeat(479) && str('🌿🌿', 3) === '🌿', 'str / cleanNote cut without leaving half an emoji');
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')], 'deposit', { addons: [{ id: S.kate, guest: 0 }] }), LIVE);
  const refE = r.data.ref, piE = complete(r.data.session_id);
  r = await adm({ action: 'note', ref: refE, note: 'Arrives late, vegan. '.repeat(23).slice(0, 479) + '🙏 thanks' });
  ok(r.status === 200 && r.data.ok && r.data.note.length === 479 && !lone(r.data.note) && store.pis.get(piE).metadata.aob_note === r.data.note, 'note: an emoji across the 480 cut → saved without it');
  const when = 'Tue 20 Jul 2027, 15:00 with Kate, room ' + '🌿';
  r = await adm({ action: 'svc_status', ref: refE, key: 'b0', status: 'scheduled', when });
  ok(r.status === 200 && r.data.when === when.slice(0, 39) && !lone(store.pis.get(piE).metadata.aob_svc), 'svc_status: an emoji across the 40 cut → saved without it');
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(2, 'twin-ensuite')], 'deposit', { diet: 'No nuts please. '.repeat(25).slice(0, 399) + '🥜' }), LIVE);
  ok(r.status === 200 && !lone(lastSession().metadata.aob_diet) && lastSession().metadata.aob_diet.length === 399, 'checkout: an emoji across the diet cut → booked');
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(3, 'twin-ensuite', { first: 'A'.repeat(60), last: 'B'.repeat(58) + '🌿' })]), LIVE);
  ok(r.status === 200 && lastSession().metadata.aob_lead_name === 'A'.repeat(60) + ' ' + 'B'.repeat(58) && lastSession().metadata.aob_g1.startsWith('A'.repeat(60) + ' ' + 'B'.repeat(58) + '🌿 |'), 'checkout: the lead name cut to 120 across an emoji → booked, the full name kept on the guest line');
}

/* plans: the team's keys on an ended plan (its subscription is canceled; the mock refuses updates to it) */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(3, 'glamping-single')], 'plan', { addons: [{ id: S.kate, guest: 0 }] }), LIVE);
  const pRef = r.data.ref, pCs = r.data.session_id, pSub = complete(pCs);
  wr = await hook(sessionEvent('checkout.session.completed', pCs)); // sets the plan's end
  r = await adm({ action: 'note', ref: pRef, note: 'Ground floor please' });
  ok(r.data.ok && store.subs.get(pSub).metadata.aob_note === 'Ground floor please', 'a running plan: the note is on its subscription');
  renew(pSub, nowS() + 200 * 86400);
  const firstPi = () => store.pis.get(store.invoices.find(i => i.subscription === pSub && i.billing_reason === 'subscription_create').payment_intent);
  ok(store.subs.get(pSub).status === 'canceled' && store.invoices.filter(i => i.subscription === pSub && i.status === 'paid').length === 3, 'the plan has ended (3 payments, subscription canceled)');
  r = await adm({ action: 'note', ref: 'BC2610-NOPE22', note: 'x' });
  const c0 = store.canceledSubPosts;
  r = await adm({ action: 'assign', ref: pRef, assign: { 0: 'Glamping Single 1' } });
  let ov = firstPi().metadata;
  ok(r.status === 200 && r.data.ok && ov.aob_admin_overlay === '1' && ov.aob_assign === '0=Glamping Single 1' && ov.aob_note === 'Ground floor please' && !store.subs.get(pSub).metadata.aob_assign && store.canceledSubPosts === c0, 'ended plan: the room assignment saves on its first invoice\'s payment (the note carried over)');
  r = await adm({ action: 'svc_status', ref: pRef, key: 'b0', status: 'scheduled', when: 'Tue 20 Jul, 15:00' });
  ok(r.status === 200 && firstPi().metadata.aob_svc === 'b0:scheduled:Tue 20 Jul, 15:00', 'ended plan: session status saves');
  r = await adm({ action: 'note', ref: pRef, note: '' });
  ok(r.status === 200 && !('aob_note' in firstPi().metadata) && store.subs.get(pSub).metadata.aob_note === 'Ground floor please', 'ended plan: a note cleared on the overlay …');
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  let pB = r.data.bookings.find(b => b.ref === pRef);
  const planPaid = store.invoices.filter(i => i.subscription === pSub && i.status === 'paid').reduce((a, i) => a + i.amount_paid, 0);
  ok(pB.note === '' && pB.assign['0'] === 'Glamping Single 1' && pB.addons[0].status === 'scheduled' && pB.addons[0].when === 'Tue 20 Jul, 15:00' && r.data.rooming['Glamping Single 1'].guests[0].ref === pRef, '… stays cleared; the assignment and session status read back (the overlay wins)');
  ok(pB.paid_cents === planPaid && pB.payments.length === 1 && pB.payments[0].id === pSub && r.data.totals.paid_cents === planPaid && pB.plan.overlay_pi === firstPi().id, 'the overlay payment never counts as a payment');
  r = await adm({ action: 'note', ref: pRef, note: 'n'.repeat(600) });
  r = await adm({ action: 'svc_status', ref: pRef, key: 'b0', status: 'done', when: 'w'.repeat(60) });
  ov = firstPi().metadata;
  ok(r.status === 200 && ov.aob_note.length === 480 && Object.keys(ov).length <= 50 && Object.values(ov).every(v => String(v).length <= 500), 'ended plan: the overlay stays within Stripe\'s metadata limits');
  // Stripe refuses the subscription although the booking looked running: the write falls back
  await saveAdminMeta(LIVE, { plan: { status: 'active' }, booking_pi: pSub }, { aob_note: 'via fallback' });
  ok(store.canceledSubPosts === c0 + 1 && firstPi().metadata.aob_note === 'via fallback', 'a refused subscription update ("You cannot update a canceled subscription.") falls back to the overlay');
  r = await availJ();
  const leftBefore = r.data.rooms['glamping-single'].left_any;
  r = await adm({ action: 'cancel', ref: pRef });
  ok(r.status === 200 && r.data.ok && firstPi().metadata.aob_status === 'cancelled' && !store.subs.get(pSub).metadata.aob_status, 'ended plan: cancelling it saves the status on the overlay');
  forgetBooking(pRef);
  const fB = await findBooking(LIVE, pRef);
  const inv0 = stripeCalls('GET', /^\/invoices$/);
  r = await availJ();
  ok(fB.booking.status === 'cancelled' && r.data.rooms['glamping-single'].left_any === leftBefore + 1, '… the booking reads as cancelled and its place is free again');
  ov = firstPi().metadata;
  ok(stripeCalls('GET', /^\/invoices$/) === inv0 && ov.aob_overlay_of === pSub && ov.aob_program === J1 && ov.aob_ref === pRef && !ov.aob_kind, 'the public availability finds the overlay in its usual search (no extra Stripe calls); the overlay has no aob_kind');
  // a balance payment that still comes in is flagged (the webhook reads the overlay)
  const bsId = `cs_test_mockbal${pad(++store.seq)}abcdef`;
  store.sessions.set(bsId, { id: bsId, object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', amount_total: 5000, currency: 'eur', created: nowS(), customer: null, customer_email: 't3@example.com',
    metadata: { aob_kind: 'balance', aob_program: J1, aob_ref: pRef, aob_lead_email: 't3@example.com' }, _params: {} });
  complete(bsId);
  wr = await hook(sessionEvent('checkout.session.completed', bsId));
  ok(wr.status === 200 && store.ghl.at(-1).event === 'booking_balance_paid_after_cancel', 'webhook: a payment after an ended plan was cancelled is flagged for the team');
}

/* extras lookup right after paying (30 s booking memo) */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', booking([guest(1, 'twin-ensuite')]), LIVE);
  const refM = r.data.ref; complete(r.data.session_id);
  r = await xa({ action: 'lookup', ref: refM, email: 't1@example.com' });
  r = await xa({ action: 'pay', ref: refM, email: 't1@example.com', addons: [{ id: S.kate, guest: 0 }] });
  const csK = r.data.session_id; complete(csK);
  r = await xa({ action: 'lookup', ref: refM, email: 't1@example.com' });
  ok(r.data.addons.length === 0, 'mock check: the lookup memo still holds the booking from before the payment');
  r = await call(session, 'GET', `/api/booking/session?id=${csK}`, null, LIVE);
  ok(r.data.state === 'paid', 'the confirmation sees the payment');
  r = await xa({ action: 'lookup', ref: refM, email: 't1@example.com' });
  ok(r.data.addons.length === 1 && r.data.addons[0].id === S.kate, 'extras lookup right after the confirmation shows the new session (the memo was cleared)');
  r = await xa({ action: 'pay', ref: refM, email: 't1@example.com', addons: [{ id: S.amy, guest: 0 }] });
  complete(r.data.session_id);
  r = await xa({ action: 'lookup', ref: refM, email: 't1@example.com', fresh: true });
  ok(r.data.addons.length === 2, 'extras lookup with fresh: true skips the memo');
}

/* demo bookings (Stripe test mode only) */
reset();
{
  r = await call(admin, 'POST', '/api/booking/admin', { action: 'seed_demo', program: J1, percent: 40 }, { ...LIVE, STRIPE_SECRET_KEY: 'sk_live_mock' }, AUTH);
  ok(r.status === 403 && store.pis.size === 0, 'demo bookings are refused with a live key');
  r = await call(admin, 'POST', '/api/booking/admin', { action: 'seed_demo', program: J1, percent: 40 }, LIVE, AUTH);
  const demo = [...store.pis.values()].filter(p => p.metadata.aob_demo === '1');
  const bookingsD = demo.filter(p => p.metadata.aob_kind === 'booking');
  const guestsD = bookingsD.reduce((n, p) => n + parseInt(p.metadata.aob_guests, 10), 0);
  ok(r.status === 200 && r.data.ok && r.data.created === bookingsD.length && r.data.guests === guestsD && r.data.target === Math.round(JP.program_spaces * 0.4), 'seed_demo reports what it created');
  ok(guestsD >= r.data.target - 2 && guestsD <= r.data.target, 'the week is filled to about 40% (' + guestsD + ' of ' + JP.program_spaces + ')');
  ok(bookingsD.every(p => p.amount === parseInt(p.metadata.aob_due_now, 10) && p.metadata.aob_program === J1 && /\.demo@example\.com$/.test(p.metadata.aob_lead_email)), 'every demo booking is priced like a real one and clearly marked');
  ok(demo.filter(p => p.metadata.aob_kind === 'balance').every(p => bookingsD.some(b => b.metadata.aob_ref === p.metadata.aob_ref)), 'demo balance payments belong to demo bookings');
  r = await call(avail, 'GET', `/api/booking/availability?program=${J1}`, null, LIVE);
  ok(r.data.program_left === JP.program_spaces - guestsD, 'public availability counts the demo bookings');
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  ok(r.data.bookings.length === bookingsD.length && r.data.bookings.every(b => b.demo === true), 'the dashboard lists them, marked as demo');
  const named = id => (JP.rooms.find(x => x.id === id).names || []).length > 0;
  const placedAll = r.data.bookings.every(b => b.guests.every((g, i) => !named(g.room) || (b.assign && b.assign[i])));
  const slots = Object.values(r.data.rooming || {});
  ok(placedAll && (r.data.unassigned || []).every(u => !named(u.room)), 'every demo guest is placed in a physical room (tents have none)');
  ok(slots.every(x => !x.conflict) && slots.some(x => x.guests.length), 'random placement keeps rooms single-gender and within their beds');
  ok(r.data.bookings.every(b => b.guests.every((g, i) => !b.assign || !b.assign[i] || (JP.rooms.find(x => x.id === g.room).names || []).includes(b.assign[i]))), 'each guest is placed in a room of the type they booked');
  // demo bookings made before placement existed: place_demo puts them in rooms
  [...store.pis.values()].filter(p => p.metadata.aob_demo === '1' && p.metadata.aob_kind === 'booking').forEach(p => { delete p.metadata.aob_assign; });
  r = await call(admin, 'POST', '/api/booking/admin', { action: 'place_demo', program: J1 }, LIVE, AUTH);
  ok(r.status === 200 && r.data.ok && r.data.bookings > 0 && r.data.unplaced === 0, 'place_demo places demo guests who had no room ');
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  ok(Object.values(r.data.rooming || {}).every(x => !x.conflict) && (r.data.unassigned || []).every(u => !named(u.room)), 'after place_demo: everyone placed, no conflicts');
  r = await call(admin, 'POST', '/api/booking/admin', { action: 'clear_demo', program: J1 }, LIVE, AUTH);
  ok(r.data.ok && r.data.removed === demo.length, 'clear_demo removes every demo payment');
  r = await call(avail, 'GET', `/api/booking/availability?program=${J1}`, null, LIVE);
  ok(r.data.program_left === JP.program_spaces, 'after removing them the week is empty again');
}

/* ================================================================== round 4: blocks, manual bookings, offline payments, calendar */
const RN = { a2: '2A · Temple Cottage', b2: '2B · Temple Cottage', c2: '2C · Temple Cottage', d2: '2D · Temple Cottage', b1: '1B · Peace Cottage', a1: '1A · Peace Cottage',
  solitude: '3 · Solitude Cottage', cottage2: '4C + 4D · Alchemy Cottage (combined)', gs: n => `Glamping Single ${n}`, gt: n => `Glamping Twin ${n}`, cv: n => `Campervan Spot ${n}`, ark: x => `5${x} · The Ark` };
const recCustomers = () => store.customers.filter(c => c.metadata && c.metadata.aob_rec_any === '1' && !c.deleted);
const callsOf = async fn => { const c0 = store.calls.length; const res = await fn(); return { res, calls: store.calls.slice(c0) }; };
const lng = (x, n) => x.repeat(Math.ceil(n / x.length)).slice(0, n);
const mg = (first, gender, room_name, extra = {}) => ({ first, last: 'Manual', gender, room_name, ...extra });

/* storage, availability per room type, cancel / restore / update / delete */
reset();
{
  r = await call(admin, 'POST', '/api/booking/admin', { action: 'block_create', rooms: [RN.a2], from: '2027-07-20', to: '2027-07-21' }, ADMIN_ONLY, AUTH);
  ok(r.status === 503, 'records need Stripe (demo: 503)');
  for (const [body, k, re, msg] of [
    [{ rooms: ['Nowhere 9'], from: '2027-07-20', to: '2027-07-21' }, 'rooms', /Unknown room: Nowhere 9/, 'an unknown room'],
    [{ rooms: [], from: '2027-07-20', to: '2027-07-21' }, 'rooms', /1 to 20/, 'no room'],
    [{ rooms: calendarRooms().rooms.slice(0, 21).map(x => x.name), from: '2027-07-20', to: '2027-07-21' }, 'rooms', /1 to 20/, 'more than 20 rooms'],
    [{ rooms: [RN.a2], from: '2027-07-21', to: '2027-07-21' }, 'to', /after the first night/, 'no nights'],
    [{ rooms: [RN.a2], from: '2027-01-01', to: '2027-06-01' }, 'to', /120 nights/, 'more than 120 nights'],
    [{ rooms: [RN.a2], from: '2025-12-30', to: '2026-01-02' }, 'from', /2026-01-01/, 'before 2026'],
    [{ rooms: [RN.a2], from: '2027-02-30', to: '2027-03-02' }, 'from', /./, 'a date that doesn\'t exist'],
    [{ rooms: [RN.a2], from: '2027-07-20', to: '2027-07-21', reason: 'party' }, 'reason', /maintenance/, 'a reason not on the list'],
  ]) {
    r = await adm({ action: 'block_create', ...body });
    ok(r.status === 422 && re.test(r.data.fields[k] || ''), `block_create refused: ${msg}`);
  }
  ok(recCustomers().length === 0, 'nothing stored for refused blocks');
  ok(blockInput({ rooms: ['x'.repeat(100), 'y'.repeat(100), 'z'.repeat(100), 'w'.repeat(100), 'v'.repeat(100)], from: '2027-07-20', to: '2027-07-21' },
    { rooms: ['x', 'y', 'z', 'w', 'v'].map(c => ({ name: c.repeat(100) })) }).errors.rooms === 'That is more room names than one block can hold. Split it into two blocks.', 'block: room names that wouldn\'t fit in 500 characters are refused (never cut)');

  r = await availJ(); const base1 = r.data; r = await availJ(LIVE, J2); const base2 = r.data;
  // a one-night block inside week 1 takes the room out for that whole week
  r = await adm({ action: 'block_create', rooms: [RN.a2], from: '2027-07-20', to: '2027-07-21', reason: 'maintenance', comment: '  Shower repair\u0007 ' });
  const blk = r.data.block, cusB = store.customers.find(c => c.id === blk.customer);
  ok(r.status === 200 && r.data.ok && /^BL-[A-Z0-9]{6}$/.test(blk.id) && blk.rooms.join() === RN.a2 && blk.from === '2027-07-20' && blk.to === '2027-07-21' && blk.nights === 1 && blk.reason === 'maintenance' && blk.comment === 'Shower repair' && blk.status === 'active', 'block_create: the block (comment cleaned)');
  ok(cusB && cusB.email === null && cusB.name === 'Block · 2A · Temple Cottage' && /^Blocked 20–21 Jul 2027 \(maintenance\): Shower repair$/.test(cusB.description) && cusB.metadata.aob_rec === 'block' && cusB.metadata.aob_rec_any === '1' && cusB.metadata.aob_id === blk.id && cusB.metadata.aob_rooms === RN.a2 && cusB.metadata.aob_reason === 'maintenance' && cusB.metadata.aob_status === 'active' && cusB.metadata.aob_from === '2027-07-20' && cusB.metadata.aob_to === '2027-07-21' && !Number.isNaN(Date.parse(cusB.metadata.aob_created_at)), 'a block is a Stripe customer without an email, its record in aob_* metadata');
  r = await availJ();
  ok(base1.rooms['twin-ensuite'].empty_units === 5 && r.data.rooms['twin-ensuite'].empty_units === 4 && r.data.rooms['twin-ensuite'].left.female === 8 && r.data.rooms['twin-ensuite'].capacity === 8 && r.data.program_left === 49, 'one blocked night in week 1: that twin room is out of the week (shared: one unit less); programme places unchanged');
  r = await availJ(LIVE, J2);
  ok(r.data.rooms['twin-ensuite'].empty_units === 5 && JSON.stringify(r.data.rooms) === JSON.stringify(base2.rooms), 'week 2 is untouched');
  r = await adm({ action: 'block_create', rooms: [RN.b1, RN.gs(1), RN.solitude], from: '2027-07-24', to: '2027-07-25', reason: 'staff' });
  ok(r.status === 200 && r.data.block.rooms.length === 3 && store.customers.find(c => c.id === r.data.block.customer).name === 'Block · 1B · Peace Cottage + 2 more', 'a block of three rooms for the night between the weeks');
  r = await availJ(); const x1 = r.data; r = await availJ(LIVE, J2); const x2 = r.data;
  ok(x1.rooms['twin-ensuite'].empty_units === 4 && x1.rooms['glamping-single'].left_any === 5 && x1.rooms['cottage-one'].left_any === 1 && JSON.stringify(x2.rooms) === JSON.stringify(base2.rooms), 'a block outside every week changes nothing');
  r = await adm({ action: 'block_create', rooms: [RN.gs(2), RN.cottage2, RN.ark('A')], from: '2027-07-23', to: '2027-07-26', reason: 'owner' });
  r = await availJ(); const y1 = r.data; r = await availJ(LIVE, J2); const y2 = r.data;
  ok(y1.rooms['glamping-single'].left_any === 4 && y1.rooms['single-ensuite'].left_any === 2 && y1.rooms['cottage-two'].units_left === 0 && y1.rooms['cottage-two'].sold_out && y1.rooms['cottage-two'].capacity_units === 0, 'block: one place less in rooms sold by the place, the cottage for two (sold by the unit) sold out');
  ok(y2.rooms['glamping-single'].left_any === 4 && y2.rooms['cottage-two'].sold_out && y2.rooms['single-ensuite'].left_any === 2, '… in both weeks it overlaps');

  // manual bookings
  r = await adm({ action: 'manual_create', from: '2027-07-19', to: '2027-07-22', guests: [mg('Ines', 'Female', RN.b1)], comment: 'Friend of the owner' });
  const mA = r.data.booking, cusA = store.customers.find(c => c.id === mA.manual.customer);
  ok(r.status === 200 && /^MB2707-[A-Z0-9]{6}$/.test(mA.ref) && mA.source === 'manual' && mA.program === J1 && mA.status === 'active' && mA.manual.from === '2027-07-19' && mA.manual.to === '2027-07-22' && mA.manual.nights === 3 && mA.manual.programme === 'no' && mA.manual.comment === 'Friend of the owner' && mA.total_cents === 0 && mA.paid_cents === 0 && mA.guests[0].room === 'twin-ensuite' && mA.guests[0].room_name === RN.b1 && mA.assign['0'] === RN.b1, 'manual_create: an MB reference, its dates, guests and rooms');
  ok(cusA.email === null && cusA.name === 'Ines Manual' && cusA.metadata.aob_rec === 'booking' && cusA.metadata.aob_rec_any === '1' && cusA.metadata.aob_id === mA.ref && cusA.metadata.aob_g1 === `Ines Manual |  | Female | ${RN.b1}` && cusA.metadata.aob_source === 'manual' && cusA.metadata.aob_programme === 'no' && cusA.metadata.aob_total === '0' && !cusA.metadata.aob_lead_email, 'a manual booking is a Stripe customer without an email, its guests in aob_g1…');
  r = await availJ();
  ok(r.data.rooms['twin-ensuite'].left.female === 7 && r.data.rooms['twin-ensuite'].left.male === 6 && r.data.rooms['twin-ensuite'].empty_units === 3 && r.data.program_left === 49, 'a manual guest takes her bed (the other bed is for a woman only); just staying: no programme place');
  r = await adm({ action: 'manual_create', from: '2027-07-18', to: '2027-07-24', programme: 'yes', total_cents: 150000, whatsapp: '0039 353 452 7348',
    guests: [mg('Paolo', 'Male', RN.cv(1), { email: 'Paolo@Example.com' }), mg('Gina', 'Female', RN.cv(2))] });
  const mB = r.data.booking;
  ok(r.status === 200 && mB.manual.programme === 'yes' && mB.total_cents === 150000 && mB.balance_cents === 150000 && mB.lead.whatsapp === '+393534527348' && mB.lead.email === 'paolo@example.com' && mB.guests[0].email === 'paolo@example.com' && mB.guests[1].email === '', 'manual booking attending the programme, with an agreed price');
  r = await availJ();
  ok(r.data.rooms.camper.left_any === 6 && r.data.program_left === 47 && r.data.rooms['twin-ensuite'].left.female === 7, 'its guests take 2 camper places and 2 programme places in week 1');
  r = await availJ(LIVE, J2);
  ok(r.data.program_left === 49 && r.data.rooms.camper.left_any === 8, '… not in week 2');
  r = await adm({ action: 'manual_create', from: '2027-07-20', to: '2027-07-21', guests: [mg('Al', 'Female', RN.c2), mg('Cy', 'Male', RN.c2)] });
  ok(r.status === 422 && /women or men only/.test(r.data.fields['guests.1.room_name']), 'manual: a woman and a man in one shared room are refused');
  r = await adm({ action: 'manual_create', from: '2027-07-20', to: '2027-07-21', guests: [mg('Al', 'Female', RN.gs(3)), mg('Bea', 'Female', RN.gs(3))] });
  ok(r.status === 422 && /holds 1 person/.test(r.data.fields['guests.1.room_name']), 'manual: no more guests in a room than it holds');
  r = await adm({ action: 'manual_create', from: '2027-07-20', to: '2027-07-21', programme: 'maybe', total_cents: '12x', whatsapp: '07700 900123',
    guests: [{ first: '=SUM(A1)', last: '', email: 'nope', gender: 'Other', room_name: 'Nowhere' }] });
  ok(r.status === 422 && r.data.fields['guests.0.first'] && r.data.fields['guests.0.last'] && r.data.fields['guests.0.email'] && r.data.fields['guests.0.gender'] && r.data.fields['guests.0.room_name'] && /country code/.test(r.data.fields.whatsapp) && r.data.fields.total_cents, 'manual: guests validated like a checkout (names, email, gender, room, WhatsApp, price)');
  r = await adm({ action: 'manual_create', from: '2027-08-10', to: '2027-08-12', programme: 'yes', guests: [mg('Al', 'Female', RN.gs(3))] });
  ok(r.status === 422 && /don't overlap a BreathCamp week/.test(r.data.fields.programme), 'manual: attending the programme needs dates in a week');
  r = await adm({ action: 'manual_create', from: '2027-07-20', to: '2027-07-21', guests: Array.from({ length: 13 }, (_, i) => mg('G' + 'abcdefghijklm'[i], 'Female', RN.cv(1))) });
  ok(r.status === 422 && /1 to 12/.test(r.data.fields.guests), 'manual: at most 12 guests');
  // women and men in one room, from two bookings (saved anyway): the whole room is out
  r = await adm({ action: 'manual_create', from: '2027-07-20', to: '2027-07-22', guests: [mg('Ana', 'Female', RN.c2)] });
  ok(r.status === 200, 'a woman in 2C');
  r = await adm({ action: 'manual_create', from: '2027-07-21', to: '2027-07-23', guests: [mg('Ben', 'Male', RN.c2)] });
  ok(r.status === 409 && r.data.code === 'conflict' && r.data.conflicts.length === 1 && /^2C · Temple Cottage: women and men in one room on Wed 21 Jul \(manual booking MB2707-[A-Z0-9]{6} \(Ana Manual\)\)\.$/.test(r.data.conflicts[0]), 'a man in her room on a night she is there → 409 conflict, named night and booking');
  const nRec = recCustomers().length;
  r = await adm({ action: 'manual_create', from: '2027-07-21', to: '2027-07-23', guests: [mg('Ben', 'Male', RN.c2)], force: true });
  ok(r.status === 200 && r.data.forced === true && recCustomers().length === nRec + 1, 'force: saved anyway');
  r = await availJ();
  ok(r.data.rooms['twin-ensuite'].empty_units === 2 && r.data.rooms['twin-ensuite'].left.female === 5 && r.data.rooms['twin-ensuite'].left.male === 4, 'women and men in one room: nobody else can join it (that room is out)');
  r = await adm({ action: 'manual_create', from: '2027-07-21', to: '2027-07-22', guests: [mg('Cleo', 'Female', RN.cv(1))] });
  ok(r.status === 409 && /Campervan Spot 1: 2 guests for 1 place on Wed 21 Jul/.test(r.data.conflicts[0]), 'a room sold by the place taken that night → conflict');
  r = await adm({ action: 'manual_create', from: '2027-07-24', to: '2027-07-26', guests: [mg('Cleo', 'Female', RN.cv(1))] });
  ok(r.status === 200, '… and free from the day the other guests leave');

  // cancel, restore, update
  r = await adm({ action: 'manual_cancel', ref: mB.ref.toLowerCase() });
  ok(r.data.ok && r.data.status === 'cancelled' && r.data.booking.status === 'cancelled' && store.customers.find(c => c.id === mB.manual.customer).metadata.aob_status === 'cancelled', 'manual_cancel');
  r = await availJ();
  ok(r.data.rooms.camper.left_any === 8 && r.data.program_left === 49, 'a cancelled manual booking gives back its rooms and programme places');
  r = await adm({ action: 'manual_cancel', ref: mB.ref });
  ok(r.data.ok && r.data.status === 'cancelled', 'cancelling twice is harmless');
  r = await adm({ action: 'manual_restore', ref: mB.ref });
  ok(r.data.ok && r.data.status === 'active' && !store.customers.find(c => c.id === mB.manual.customer).metadata.aob_status_at, 'manual_restore (nothing in the way)');
  r = await adm({ action: 'manual_update', ref: mB.ref, comment: 'Pays by bank transfer', total_cents: 160000 });
  ok(r.data.ok && r.data.booking.total_cents === 160000 && r.data.booking.manual.comment === 'Pays by bank transfer' && r.data.booking.balance_cents === 160000, 'manual_update: comment and agreed price');
  r = await adm({ action: 'note', ref: mB.ref, note: 'Arrives by train' });
  ok(r.data.ok && r.data.booking.manual.comment === 'Arrives by train' && r.data.booking.total_cents === 160000, 'note on a manual booking = its comment');
  r = await adm({ action: 'manual_update', ref: mB.ref, total_cents: -5 });
  ok(r.status === 422 && r.data.fields.total_cents, 'manual_update: a negative price refused');
  r = await adm({ action: 'manual_update', ref: mB.ref });
  ok(r.status === 422, 'manual_update: nothing to change');
  r = await adm({ action: 'assign', ref: mB.ref, assign: { 0: RN.cv(3) } });
  ok(r.status === 400, 'a manual booking\'s rooms are not moved with assign');
  r = await adm({ action: 'manual_cancel', ref: 'MB2707-ZZZZZZ' });
  ok(r.status === 404, 'unknown manual booking → 404');

  // delete a block
  r = await adm({ action: 'block_delete', id: mA.manual.customer });
  ok(r.status === 404 && !store.customers.find(c => c.id === mA.manual.customer).deleted, 'block_delete never deletes a manual booking');
  r = await adm({ action: 'block_delete', id: blk.id });
  ok(r.data.ok && r.data.id === blk.id && store.customers.find(c => c.id === blk.customer).deleted === true, 'block_delete removes the block\'s customer');
  r = await availJ();
  ok(r.data.rooms['twin-ensuite'].empty_units === 3 && r.data.rooms['twin-ensuite'].left.female === 7, 'the room is back');
  r = await adm({ action: 'block_delete', id: blk.id });
  ok(r.status === 404, 'deleting it twice → 404');
  r = await adm({ action: 'block_delete', id: 'nonsense' });
  ok(r.status === 404, 'block_delete: unknown id → 404');
  ok(store.metaChecks > 0 && recCustomers().every(c => Object.keys(c.metadata).length < 50 && Object.values(c.metadata).every(v => String(v).length <= 500)), 'records within Stripe\'s metadata limits');
}

/* checkout and the public availability with records: search lag, memo, Stripe calls per request */
reset();
{
  store.lagCustomers = true; // Stripe's search hasn't indexed new customers yet
  r = await adm({ action: 'block_create', rooms: [RN.solitude], from: '2027-07-22', to: '2027-07-23', reason: 'owner' });
  ok(r.status === 200, 'the only cottage for one is blocked for one night of week 1');
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  ok(r.data.blocks.length === 1 && r.data.rooming[RN.solitude].blocked.reason === 'owner' && r.data.availability.rooms['cottage-one'].sold_out, 'admin sees it at once (search lagging)');
  tick(4 * 60); // past this isolate's own copy of the write; search still lagging
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(1, 'cottage-one')]), LIVE);
  ok(r.status === 409 && r.data.code === 'unavailable' && /sold out/.test(r.data.error), 'checkout refused: the block took the last room (found in the real-time list of new records)');
  store.customers.forEach(c => { c._lagging = false; });
  r = await availJ();
  ok(r.data.rooms['cottage-one'].sold_out && r.data.rooms['cottage-one'].left_any === 0, 'public availability: sold out');
  store.lagCustomers = false;
  // Stripe calls per request
  clearAvailabilityMemo();
  let k = await callsOf(() => call(avail, 'GET', `/api/booking/availability?program=${J1}`, null, LIVE));
  const fresh1 = k.calls.length, recSearch = k.calls.filter(c => c.path === '/customers/search').length;
  ok(k.res.status === 200 && fresh1 === 6 && recSearch === 1 && !k.calls.some(c => c.path === '/customers'), `public availability: ${fresh1} Stripe calls on a fresh poll (the 5 of before + 1 records search)`);
  k = await callsOf(() => call(avail, 'GET', `/api/booking/availability?program=${J2}`, null, LIVE));
  ok(k.res.status === 200 && k.calls.length === 5 && !k.calls.some(c => /^\/customers/.test(c.path)), 'the other week within 15 s: the records come from their memo (no extra call)');
  k = await callsOf(() => call(avail, 'GET', `/api/booking/availability?program=${J1}`, null, LIVE));
  ok(k.calls.length === 0, 'a second poll within 15 s: no Stripe call at all');
  tick(16);
  k = await callsOf(() => call(avail, 'GET', `/api/booking/availability?program=${J1}`, null, LIVE));
  ok(k.calls.length === 6, 'after 15 s: one fresh round (records included)');
  r = await adm({ action: 'block_create', rooms: [RN.gs(1)], from: '2027-07-18', to: '2027-07-19', reason: 'staff' });
  k = await callsOf(() => call(avail, 'GET', `/api/booking/availability?program=${J1}`, null, LIVE));
  ok(k.calls.length === 6 && k.res.data.rooms['glamping-single'].left_any === 4, 'a record write clears the memo: the next poll is fresh and counts it');
  k = await callsOf(() => call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(2, 'twin-ensuite')]), LIVE));
  const ckCalls = k.calls.length, ckCus = k.calls.filter(c => /^\/customers/.test(c.path)).length;
  ok(k.res.status === 200 && ckCus === 2 && ckCalls <= 15, `checkout: ${ckCalls} Stripe calls (records: one search + one real-time list), far below Cloudflare's 50`);
  // snapshot with records: Stripe down → the last good read still has the block
  tick(16);
  fault('GET', /^\/checkout\/sessions$/, { status: 500, times: 3 });
  r = await call(avail, 'GET', `/api/booking/availability?program=${J1}`, null, LIVE);
  ok(r.status === 200 && r.data.degraded && r.data.rooms['cottage-one'].sold_out && r.data.rooms['glamping-single'].left_any === 4, 'Stripe down: the last good snapshot keeps the records');
  // a records search failure is a Stripe failure like the others
  clearAvailabilityMemo(undefined, { snapshot: true });
  fault('GET', /^\/customers\/search$/, { status: 500, times: 3 });
  r = await call(avail, 'GET', `/api/booking/availability?program=${J1}`, null, LIVE);
  ok(r.status === 503 && r.data.code === 'busy', 'records unreadable and no snapshot → 503 busy (never availability without the blocks)');
  fault('GET', /^\/customers\/search$/, { status: 500, times: 3 });
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(3, 'twin-ensuite')]), LIVE);
  ok(r.status === 503 && r.data.code === 'busy', 'checkout: records unreadable → 503 busy');
}

/* conflicts with online bookings; oversell; programme places; restore */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(1, 'twin-ensuite'), guest(2, 'twin-ensuite')]), LIVE);
  const oRef = r.data.ref; complete(r.data.session_id);
  r = await adm({ action: 'assign', ref: oRef, assign: { 0: RN.a2, 1: RN.a2 } });
  r = await adm({ action: 'block_create', rooms: [RN.a2, RN.b2], from: '2027-07-23', to: '2027-07-26', reason: 'maintenance' });
  ok(r.status === 409 && r.data.code === 'conflict' && r.data.conflicts.length === 2 && r.data.conflicts[0] === `2A · Temple Cottage: Test1 Guest (${oRef}, BreathCamp 1) is there 23–24 Jul 2027.` && recCustomers().length === 0, 'block over guests placed in the room → 409 conflict naming them; nothing saved');
  r = await adm({ action: 'block_create', rooms: [RN.a2, RN.b2], from: '2027-07-23', to: '2027-07-26', reason: 'maintenance', force: true });
  ok(r.status === 200 && r.data.forced === true, 'force: saved anyway');
  const bId = r.data.block.id;
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  const rm = r.data.rooming;
  ok(rm[RN.a2].blocked && rm[RN.a2].blocked.id === bId && rm[RN.a2].blocked.reason === 'maintenance' && rm[RN.a2].blocked.from === '2027-07-23' && rm[RN.a2].conflict === 'blocked' && rm[RN.b2].blocked && rm[RN.b2].conflict === null && r.data.blocks.length === 1 && r.data.blocks[0].rooms.length === 2, 'rooming: blocked rooms carry the block; guests in one → conflict blocked');
  r = await call(admin, 'GET', `/api/booking/admin?program=${J2}`, null, LIVE, AUTH);
  ok(r.data.rooming[RN.a2].blocked && r.data.blocks.length === 1 && r.data.availability.rooms['twin-ensuite'].empty_units === 3, 'the block shows in week 2 too (it overlaps both)');
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(3, 'twin-ensuite', { gender: 'Male' }), guest(4, 'twin-ensuite', { gender: 'Male' })]), LIVE);
  const oRef2 = r.data.ref; complete(r.data.session_id);
  r = await adm({ action: 'assign', ref: oRef2, assign: { 0: RN.b2 } });
  ok(r.data.ok && r.data.warnings.length === 1 && r.data.warnings[0] === '2B · Temple Cottage is blocked 23–26 Jul 2027 (maintenance).', 'assign into a blocked room: saved, with a warning');
  r = await adm({ action: 'assign', ref: oRef2, assign: { 0: RN.c2, 1: RN.c2 } });
  ok(r.data.ok && r.data.warnings.length === 0, 'assign elsewhere: no warning');
  r = await adm({ action: 'manual_create', from: '2027-07-18', to: '2027-07-20', guests: [mg('Dee', 'Female', RN.d2)] });
  ok(r.status === 200, 'a manual guest in 2D for two nights of week 1');
  r = await adm({ action: 'assign', ref: oRef, assign: { 0: RN.d2, 1: RN.d2 } });
  ok(r.data.ok && r.data.warnings.length === 1 && r.data.warnings[0] === '2D · Temple Cottage: 3 guests for 2 beds.', 'assign beside a manual guest: more people than beds → warning');
  r = await adm({ action: 'assign', ref: oRef, assign: { 0: RN.a2, 1: RN.a2 } });

  // oversell: every single room sold, then one blocked
  const singles = [];
  for (const n of [5, 6, 7]) { r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(n, 'single-ensuite')], 'full'), LIVE); singles.push(r.data.ref); complete(r.data.session_id); }
  r = await adm({ action: 'block_create', rooms: [RN.ark('B')], from: '2027-07-18', to: '2027-07-19', reason: 'staff' });
  ok(r.status === 409 && r.data.conflicts.length === 1 && r.data.conflicts[0] === 'BreathCamp 1: Private Single Room Ensuite would be overbooked. Its bookings and open checkouts need 1 more place than it would have.', 'block on a sold-out room type → conflict (oversell), even with nobody placed in that room');
  r = await adm({ action: 'block_create', rooms: [RN.ark('B')], from: '2027-07-25', to: '2027-07-26', reason: 'staff' });
  ok(r.status === 200, '… the same room in week 2 is fine');
  // an open checkout counts too (its guest may pay any moment)
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(8, 'cottage-one')]), LIVE);
  r = await adm({ action: 'block_create', rooms: [RN.solitude], from: '2027-07-19', to: '2027-07-20', reason: 'owner' });
  ok(r.status === 409 && /Private Cottage for One would be overbooked/.test(r.data.conflicts[0]), 'a room in someone\'s open checkout counts as taken');
  // a cottage for two booked online: blocking it oversells, and a manual booking can't take it
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(9, 'cottage-two'), guest(6, 'cottage-two', { gender: 'Male' })]), LIVE);
  complete(r.data.session_id);
  r = await adm({ action: 'manual_create', from: '2027-07-22', to: '2027-07-23', guests: [mg('Ola', 'Female', RN.cottage2)] });
  ok(r.status === 409 && r.data.conflicts.some(c => /Private Cottage for Two would be overbooked/.test(c)), 'manual booking in a room type that is sold out that week → conflict');
  // manual guests beside online guests placed in a room
  r = await adm({ action: 'manual_create', from: '2027-07-19', to: '2027-07-20', guests: [mg('Pia', 'Female', RN.c2)] });
  ok(r.status === 409 && r.data.conflicts.length === 1 && r.data.conflicts[0].startsWith(`2C · Temple Cottage: women and men in one room on Mon 19 Jul (Test3 Guest (${oRef2}, BreathCamp 1), Test4 Guest`), 'a woman in a twin where two men are placed that week → conflict');
  // the block vs manual guests (and the reverse)
  r = await adm({ action: 'manual_create', from: '2027-08-02', to: '2027-08-05', guests: [mg('Quin', 'Female', RN.ark('A'))], total_cents: 40000 });
  const mStay = r.data.booking;
  ok(r.status === 200 && mStay.program === 'stay', 'a manual stay outside every week');
  r = await adm({ action: 'block_create', rooms: [RN.ark('A')], from: '2027-08-04', to: '2027-08-06', reason: 'maintenance' });
  ok(r.status === 409 && r.data.conflicts[0] === `5A · The Ark: manual booking ${mStay.ref} (Quin Manual) is there 4–5 Aug 2027.`, 'a block over a manual guest → conflict');
  r = await adm({ action: 'manual_create', from: '2027-07-25', to: '2027-07-27', guests: [mg('Rae', 'Female', RN.a2)] });
  ok(r.status === 409 && r.data.conflicts[0] === '2A · Temple Cottage is blocked 23–26 Jul 2027 (maintenance).', 'a manual booking in a blocked room → conflict');
  r = await adm({ action: 'manual_create', from: '2027-07-26', to: '2027-07-27', guests: [mg('Rae', 'Female', RN.a2)] });
  ok(r.status === 200, '… from the day the block ends it is fine');
  // restore: something took the room meanwhile
  r = await adm({ action: 'manual_cancel', ref: mStay.ref });
  r = await adm({ action: 'block_create', rooms: [RN.ark('A')], from: '2027-08-03', to: '2027-08-04', reason: 'owner' });
  ok(r.status === 200, 'the room is blocked while the stay is cancelled');
  r = await adm({ action: 'manual_restore', ref: mStay.ref });
  ok(r.status === 409 && r.data.code === 'conflict' && /^Restoring MB/.test(r.data.error) && /5A · The Ark is blocked 3–4 Aug 2027 \(owner\)/.test(r.data.conflicts[0]) && store.customers.find(c => c.id === mStay.manual.customer).metadata.aob_status === 'cancelled', 'manual_restore re-checks: 409 conflict, still cancelled');
  r = await adm({ action: 'manual_restore', ref: mStay.ref, force: true });
  ok(r.data.ok && r.data.status === 'active', 'manual_restore with force');
  // an online booking restored into a week where a block took its place
  r = await adm({ action: 'cancel', ref: singles[0] });
  r = await adm({ action: 'block_create', rooms: [RN.ark('C')], from: '2027-07-20', to: '2027-07-21', reason: 'staff' });
  ok(r.status === 200, 'a single room blocked after a cancellation');
  r = await adm({ action: 'restore', ref: singles[0] });
  ok(r.status === 409 && r.data.code === 'conflict' && /sold out/.test(r.data.error), 'restoring an online booking counts the blocks (409 conflict)');
  // programme places
  const keepSpaces = JP.program_spaces;
  r = await availJ();
  const usedNow = keepSpaces - r.data.program_left;
  JP.program_spaces = usedNow + 3; // three programme places left
  const four = [mg('Sam', 'Male', RN.gt(4)), mg('Tom', 'Male', RN.gt(4)), mg('Uma', 'Female', RN.gt(3)), mg('Una', 'Female', RN.gt(3))];
  r = await adm({ action: 'manual_create', from: '2027-07-20', to: '2027-07-22', programme: 'yes', guests: four });
  ok(r.status === 409 && r.data.conflicts.length === 1 && r.data.conflicts[0] === `BreathCamp 1: the programme would have 1 more guest than its ${usedNow + 3} places.`, 'manual booking attending a full programme → conflict');
  r = await adm({ action: 'manual_create', from: '2027-07-20', to: '2027-07-22', programme: 'no', guests: four });
  ok(r.status === 200, '… just staying is fine');
  r = await adm({ action: 'manual_create', from: '2027-07-20', to: '2027-07-22', programme: 'yes', guests: [mg('Vic', 'Female', RN.gt(2)), mg('Wyn', 'Female', RN.gt(2)), mg('Xia', 'Female', RN.gt(1))] });
  const mYes = r.data.booking;
  ok(r.status === 200 && mYes.manual.programme === 'yes', 'three attending guests fit the last three places');
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(4, 'own-tent')]), LIVE);
  ok(r.status === 409 && /fully booked/.test(r.data.error), 'checkout: the programme places taken by hand count');
  JP.program_spaces = keepSpaces;
}

/* offline payments: math, overpay, void, balance page, search lag, customers */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(1, 'twin-ensuite')]), LIVE);
  const oRef = r.data.ref, total = r.data.quote.total_cents, due = r.data.quote.due_now_cents; complete(r.data.session_id);
  ok(total === 229500 && due === 116940, 'an online deposit booking (€2,295, €1,169.40 paid)');
  r = await adm({ action: 'balance_link', ref: oRef });
  const linkId = lastSession().id;
  for (const [body, k, msg] of [[{ amount_cents: 0 }, 'amount_cents', 'zero'], [{ amount_cents: 12.5 }, 'amount_cents', 'not whole cents'], [{ amount_cents: 100, method: 'cheque' }, 'method', 'unknown method'],
    [{ amount_cents: 100, method: 'other' }, 'comment', '"other" without a comment'], [{ amount_cents: 100, received: '2026-07-09' }, 'received', 'a future date'], [{ amount_cents: 100, received: '9 July' }, 'received', 'not a date']]) {
    r = await adm({ action: 'offline_payment', ref: oRef, ...body });
    ok(r.status === 422 && r.data.fields[k], `offline_payment refused: ${msg}`);
  }
  ok(!store.invoices.some(i => i.metadata && i.metadata.aob_kind), 'nothing recorded for refused payments');
  let k = await callsOf(() => adm({ action: 'offline_payment', ref: oRef, amount_cents: 50000, method: 'bank_transfer', received: '2026-06-30', comment: 'Revolut transfer, ref 1234' }));
  r = k.res;
  const inv1 = store.invoices.find(i => i.id === r.data.payment.invoice_id);
  ok(r.status === 200 && r.data.ok && r.data.booking.paid_cents === 166940 && r.data.booking.balance_cents === 62560 && r.data.payment.amount_cents === 50000 && r.data.payment.method === 'bank_transfer' && r.data.payment.received === '2026-06-30' && r.data.payment.comment === 'Revolut transfer, ref 1234', 'offline_payment: paid up, balance down');
  ok(inv1 && inv1.status === 'paid' && inv1.paid_out_of_band && inv1.collection_method === 'send_invoice' && inv1.days_until_due === 1 && inv1.auto_advance === false && inv1.customer === 'cus_mock1' && inv1.total === 50000 && inv1.lines.length === 1 && inv1.lines[0].description === `Bank transfer · BreathCamp 1 · ${oRef}` && inv1._params.pending_invoice_items_behavior === 'exclude' && !store.emailed, 'an invoice paid out of band on the booking\'s own customer, one line, never emailed');
  ok(inv1.metadata.aob_kind === 'offline' && inv1.metadata.aob_program === J1 && inv1.metadata.aob_ref === oRef && inv1.metadata.aob_method === 'bank_transfer' && inv1.metadata.aob_received === '2026-06-30' && inv1.metadata.aob_comment === 'Revolut transfer, ref 1234' && !Number.isNaN(Date.parse(inv1.metadata.aob_recorded_at)), 'offline payment metadata');
  ok(store.sessions.get(linkId).status === 'expired' && r.data.balance_links_closed === 1, 'the open balance link (asking for the old amount) is closed');
  ok(k.calls.length <= 20, `offline_payment: ${k.calls.length} Stripe calls`);
  await Promise.all(store.waits.splice(0));
  const g = store.ghl.at(-1);
  ok(g.event === 'offline_payment_recorded' && g.ref === oRef && g.amount === '500.00' && g.amount_cents === 50000 && g.method === 'bank_transfer' && g.comment === 'Revolut transfer, ref 1234' && g.balance === '625.60' && g.email === 't1@example.com' && g.tag === `${J1}-offline-paid`, 'GHL hears about it (offline_payment_recorded)');
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  let bk = r.data.bookings.find(b => b.ref === oRef), op = bk.payments.find(p => p.kind === 'offline');
  ok(bk.paid_cents === 166940 && bk.balance_cents === 62560 && op && op.amount_cents === 50000 && op.method === 'bank_transfer' && op.comment === 'Revolut transfer, ref 1234' && op.received === '2026-06-30' && op.invoice_id === inv1.id && r.data.totals.paid_cents === 166940, 'admin: the offline payment is in the booking\'s payments and totals');
  r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: oRef, email: 't1@example.com' }, LIVE);
  ok(r.status === 200 && r.data.paid_cents === 166940 && r.data.balance_cents === 62560, 'the guest\'s balance page counts it');
  r = await call(balance, 'POST', '/api/booking/balance', { action: 'pay', ref: oRef, email: 't1@example.com' }, LIVE);
  ok(r.status === 200 && store.sessions.get(lastSession().id).amount_total === 62560, '… and asks for what is left');
  r = await adm({ action: 'offline_payment', ref: oRef, amount_cents: 70000, method: 'cash' });
  ok(r.status === 409 && r.data.code === 'overpay' && r.data.balance_cents === 62560 && r.data.amount_cents === 70000 && /€700 is more than the €625.60 still to pay/.test(r.data.error), 'more than the balance → 409 overpay');
  r = await adm({ action: 'offline_payment', ref: oRef, amount_cents: 70000, method: 'cash', force: true });
  const inv2 = r.data.payment.invoice_id;
  ok(r.status === 200 && r.data.booking.paid_cents === 236940 && r.data.booking.balance_cents === 0 && r.data.forced === true, 'force: recorded, nothing left to pay (never negative)');
  r = await call(balance, 'POST', '/api/booking/balance', { ref: oRef, email: 't1@example.com' }, LIVE);
  ok(r.data.paid_in_full === true, 'balance page: paid in full');
  // undo
  r = await adm({ action: 'offline_void', invoice_id: inv1.id });
  ok(r.status === 422 && r.data.fields.reason, 'offline_void needs a reason');
  r = await adm({ action: 'offline_void', invoice_id: 'in_nosuch12345', reason: 'x' });
  ok(r.status === 404, 'offline_void: unknown invoice → 404');
  r = await adm({ action: 'offline_void', invoice_id: inv1.id, reason: 'Recorded on the wrong booking' });
  ok(r.data.ok && r.data.ref === oRef && /credit note/.test(r.data.message) && inv1.metadata.aob_kind === 'offline_void' && inv1.metadata.aob_void_reason === 'Recorded on the wrong booking' && inv1.metadata.aob_void_at && inv1.status === 'paid' && store.invoices.includes(inv1), 'offline_void: marked void (never deleted); the team is told about a credit note');
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  bk = r.data.bookings.find(b => b.ref === oRef);
  ok(bk.paid_cents === 186940 && bk.balance_cents === 42560 && bk.payments.filter(p => p.kind === 'offline').length === 1 && bk.payments.find(p => p.kind === 'offline').invoice_id === inv2, 'after undo: it no longer counts');
  r = await adm({ action: 'offline_void', invoice_id: inv1.id, reason: 'again' });
  ok(r.data.ok && r.data.already === true, 'undoing twice is harmless');
  r = await adm({ action: 'offline_void', invoice_id: 'in_1abc' , reason: 'x' });
  ok(r.status === 400, 'offline_void: an invoice id is checked before any Stripe call');
  // search lag: recorded a moment ago in another isolate (not in this one's copy, not yet searchable)
  store.lagInvoices = true;
  r = await adm({ action: 'offline_payment', ref: oRef, amount_cents: 10000, method: 'bank_transfer' });
  ok(r.status === 200 && r.data.payment.received === '2026-07-01' && r.data.booking.balance_cents === 32560, 'the received date defaults to today');
  tick(4 * 60); forgetBooking(oRef);
  r = await call(balance, 'POST', '/api/booking/balance', { action: 'lookup', ref: oRef, email: 't1@example.com' }, LIVE);
  ok(r.data.balance_cents === 32560, 'search lagging: the real-time list of new invoices still counts it');
  store.invoices.forEach(i => { i._lagging = false; }); store.lagInvoices = false;
  // the webhook ignores our out-of-band invoices
  const n0 = store.ghl.length;
  wr = await hook({ type: 'invoice.paid', data: { object: { ...inv1, billing_reason: 'manual' } } });
  ok(wr.status === 200 && store.ghl.length === n0, 'webhook: invoice.paid of an offline payment is ignored');
  // a booking without a Stripe customer (e.g. a demo payment): a customer with only a name is made, then reused
  const qx = quote(JP, { payment: 'deposit', programme: 'included', whatsapp: '+447700900123', terms: true, guests: [guest(7, 'glamping-single')] });
  const refX = 'BC2707-NOCUS2', mdX = bookingMetadata(JP, qx, refX, { ui: 'hosted' });
  store.pis.set('pi_nocus', { id: 'pi_nocus', object: 'payment_intent', status: 'succeeded', amount: qx.due_now_cents, amount_received: qx.due_now_cents, currency: 'eur', created: nowS(), customer: null, metadata: mdX, _refunded: 0 });
  const c0 = store.customers.length;
  r = await adm({ action: 'offline_payment', ref: refX, amount_cents: 20000 });
  const cx = store.customers[store.customers.length - 1];
  ok(r.status === 200 && store.customers.length === c0 + 1 && cx.name === 'Test7 Guest' && cx.email === null && cx.metadata.aob_ref === refX && !cx.metadata.aob_rec_any && store.invoices.find(i => i.id === r.data.payment.invoice_id).customer === cx.id, 'no Stripe customer on the booking: one is made (name and reference only, no email)');
  r = await adm({ action: 'offline_payment', ref: refX, amount_cents: 1000 });
  ok(r.status === 200 && store.customers.length === c0 + 1 && store.invoices.find(i => i.id === r.data.payment.invoice_id).customer === cx.id, '… and reused for the next offline payment');
  // a step that fails leaves no payable invoice behind
  fault('POST', /^\/invoices\/in_\w+\/finalize$/, { status: 400 });
  const drafts = store.invoices.length;
  r = await adm({ action: 'offline_payment', ref: refX, amount_cents: 1000 });
  ok(r.status === 502 && store.invoices.length === drafts, 'Stripe refuses a step: the draft invoice is deleted, nothing counts');
  // a running plan: offline payments count towards its total
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(5, 'camper')], 'plan'), LIVE);
  const pRef = r.data.ref; complete(r.data.session_id);
  r = await adm({ action: 'offline_payment', ref: pRef, amount_cents: 30000, comment: 'Paid the rest by transfer' });
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  const pb = r.data.bookings.find(b => b.ref === pRef);
  ok(pb.plan && pb.paid_cents === [...store.sessions.values()].find(x => x.metadata.aob_ref === pRef).amount_total + 30000 && pb.payments.some(p => p.kind === 'offline' && p.comment === 'Paid the rest by transfer'), 'plans: an offline payment counts towards the total');
  // GHL down: the payment is still recorded
  store.ghlStatus = 500;
  r = await adm({ action: 'offline_payment', ref: refX, amount_cents: 500 });
  await Promise.all(store.waits.splice(0));
  ok(r.status === 200 && r.data.ok, 'GHL failing never stops the admin action');
  store.ghlStatus = 200;
  ok(store.invoices.filter(i => i.metadata && i.metadata.aob_kind).every(i => Object.keys(i.metadata).length < 50 && Object.values(i.metadata).every(v => String(v).length <= 500)), 'offline payments within Stripe\'s metadata limits');
}

/* manual bookings with offline payments in the admin, the overview and the calendar */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(1, 'twin-ensuite')]), LIVE);
  const oRef = r.data.ref; complete(r.data.session_id);
  r = await adm({ action: 'assign', ref: oRef, assign: { 0: RN.d2 } });
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(2, 'camper', { gender: 'Male' })], 'full'), LIVE);
  const oRef2 = r.data.ref; complete(r.data.session_id);
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(3, 'own-tent')]), LIVE);
  const oRef3 = r.data.ref; complete(r.data.session_id, { pi: 'processing' });
  r = await adm({ action: 'manual_create', from: '2027-07-18', to: '2027-07-24', programme: 'yes', total_cents: 150000, comment: 'Scholarship family',
    guests: [mg('Lia', 'Female', RN.b1), mg('Mia', 'Female', RN.b1)] });
  const mW = r.data.booking;
  r = await adm({ action: 'offline_payment', ref: mW.ref, amount_cents: 100000, method: 'bank_transfer', received: '2026-06-29' });
  const invW = store.invoices.find(i => i.id === r.data.payment.invoice_id);
  ok(r.status === 200 && r.data.booking.paid_cents === 100000 && r.data.booking.balance_cents === 50000 && invW.customer === mW.manual.customer && invW.metadata.aob_program === J1 && invW.lines[0].description === `Bank transfer · BreathCamp 1 · ${mW.ref}`, 'offline payment on a manual booking: on its record customer, its week');
  r = await adm({ action: 'offline_payment', ref: mW.ref, amount_cents: 60000 });
  ok(r.status === 409 && r.data.code === 'overpay' && r.data.balance_cents === 50000, 'a manual booking with a price: overpay guard');
  r = await adm({ action: 'manual_create', from: '2027-08-02', to: '2027-08-05', total_cents: 40000, guests: [mg('Nia', 'Female', RN.gs(2))] });
  const mS = r.data.booking;
  r = await adm({ action: 'offline_payment', ref: mS.ref, amount_cents: 40000, method: 'cash', received: '2026-07-01' });
  ok(r.status === 200 && store.invoices.find(i => i.id === r.data.payment.invoice_id).metadata.aob_program === 'stay' && store.invoices.find(i => i.id === r.data.payment.invoice_id).lines[0].description === `Cash · Stay · ${mS.ref}`, 'a stay outside every week: aob_program stay');
  r = await adm({ action: 'manual_create', from: '2027-09-01', to: '2027-09-03', guests: [mg('Ora', 'Female', RN.gs(2))] });
  const mF = r.data.booking;
  r = await adm({ action: 'offline_payment', ref: mF.ref, amount_cents: 5000, method: 'other', comment: 'Voucher' });
  ok(r.status === 200 && r.data.booking.paid_cents === 5000 && r.data.booking.balance_cents === 0, 'no agreed price yet: no overpay guard');

  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  const mb = r.data.bookings.find(b => b.ref === mW.ref);
  ok(mb && mb.source === 'manual' && mb.total_cents === 150000 && mb.paid_cents === 100000 && mb.balance_cents === 50000 && mb.payments.length === 1 && mb.payments[0].kind === 'offline' && mb.payments[0].received === '2026-06-29' && mb.payments[0].invoice_id === invW.id && mb.manual.from === '2027-07-18' && mb.manual.programme === 'yes' && mb.manual.comment === 'Scholarship family' && mb.guests.length === 2 && mb.lead.name === 'Lia Manual', 'admin GET: the manual booking overlapping the week, with its offline payment');
  ok(!r.data.bookings.some(b => b.ref === mS.ref) && r.data.totals.bookings === 4 && r.data.totals.guests === 5 && r.data.totals.paid_cents === r.data.bookings.filter(b => b.status !== 'cancelled').reduce((s, b) => s + b.paid_cents, 0), 'admin totals include the manual booking (not the stay outside the week)');
  ok(r.data.rooming[RN.b1].guests.length === 2 && r.data.rooming[RN.b1].guests.every(x => x.manual === true && x.ref === mW.ref) && r.data.rooming[RN.b1].gender === 'Female' && r.data.rooming[RN.b1].conflict === null && r.data.rooming[RN.d2].guests[0].ref === oRef && r.data.availability.program_left === 49 - 3 - 2, 'rooming: manual guests in their room (manual: true); programme places count them');
  r = await call(admin, 'GET', '/api/booking/admin?overview=1', null, LIVE, AUTH);
  const w1 = r.data.weeks.find(w => w.program.id === J1);
  ok(w1.totals.bookings === 4 && w1.totals.paid_cents >= 100000 && w1.places.left === 44 && r.data.stay.totals.bookings === 2 && r.data.stay.totals.paid_cents === 45000 && r.data.stay.totals.balance_cents === 0, 'overview: the manual booking in its week; stays outside every week under stay');
  ok(r.data.totals.paid_cents === r.data.weeks.reduce((s, w) => s + w.totals.paid_cents, 0) + 45000 && r.data.totals.bookings === r.data.weeks.reduce((s, w) => s + w.totals.bookings, 0) + 2, 'overview totals = weeks + stays');
  ok(r.data.recent.some(x => x.ref === mS.ref && x.program === 'stay' && x.edition === 'Stay' && x.source === 'manual') && r.data.recent.some(x => x.ref === oRef && x.source === 'online'), 'overview: recent bookings include manual ones');
  r = await call(admin, 'GET', '/api/booking/admin?overview=1', null, ADMIN_ONLY, AUTH);
  ok(r.data.demo && r.data.stay.totals.bookings === 0, 'overview (demo): stay totals too');

  // the calendar
  let k = await callsOf(() => call(admin, 'GET', '/api/booking/admin?calendar=1&from=2027-07-11&to=2027-08-08', null, LIVE, AUTH));
  r = k.res;
  const cal = r.data;
  ok(r.status === 200 && cal.calendar === true && cal.from === '2027-07-11' && cal.to === '2027-08-08' && cal.nights === 28 && cal.today === '2026-07-01' && k.calls.length <= 20, `calendar: range and the day (${k.calls.length} Stripe calls)`);
  ok(cal.rooms.length === 31 && cal.areas.join('|') === 'Peace Cottage|Temple Cottage|Alchemy Cottage|Glamping Single|Glamping Twin|Campervan Spot|The Ark|Solitude Cottage', 'calendar: 31 physical rooms in 8 areas, in order (tents have no rooms)');
  ok(cal.rooms.slice(0, 3).map(x => x.name).join('|') === '1A · Peace Cottage|1B · Peace Cottage|1C · Peace Cottage' && cal.rooms.find(x => x.name === RN.cottage2).area === 'Alchemy Cottage' && cal.rooms.find(x => x.name === RN.gs(3)).area === 'Glamping Single' && cal.rooms.find(x => x.name === RN.cv(2)).area === 'Campervan Spot', 'calendar: rooms grouped by area and sorted (1A, 1B, 1C…); "(combined)" stays with its cottage');
  const r1b = cal.rooms.find(x => x.name === RN.b1), rc2 = cal.rooms.find(x => x.name === RN.cottage2), rgs = cal.rooms.find(x => x.name === RN.gs(1));
  ok(r1b.room_id === 'twin-ensuite' && r1b.room_name === 'Twin Room Ensuite' && r1b.capacity === 2 && r1b.same_gender === true && rc2.capacity === 2 && rc2.same_gender === false && rc2.unit === 'cottage' && rgs.capacity === 1, 'calendar room: type, beds, one-gender rule');
  ok(cal.programs.some(p => p.id === J1 && p.edition === 'BreathCamp 1' && p.dates.start === '2027-07-18') && cal.programs.some(p => p.id === J2), 'calendar: every week for the "jump to" chips');
  const sOn = cal.stays.find(x => x.ref === oRef), sOn2 = cal.stays.find(x => x.ref === oRef2), sOn3 = cal.stays.find(x => x.ref === oRef3);
  ok(sOn && sOn.kind === 'online' && sOn.program === J1 && sOn.room_name === RN.d2 && sOn.room_id === 'twin-ensuite' && sOn.from === '2027-07-18' && sOn.to === '2027-07-24' && sOn.pay_state === 'deposit' && sOn.demo === false && sOn.status === 'active' && sOn.index === 0 && sOn.name === 'Test1 Guest' && sOn.gender === 'Female', 'calendar: an online guest placed in a room, for the week');
  ok(sOn2 && sOn2.room_name === null && sOn2.pay_state === 'paid' && sOn3.pay_state === 'processing', 'calendar: unplaced guests have no room; pay states paid / processing');
  const sM = cal.stays.filter(x => x.ref === mW.ref), sS = cal.stays.find(x => x.ref === mS.ref);
  ok(sM.length === 2 && sM.every(x => x.kind === 'manual' && x.room_name === RN.b1 && x.from === '2027-07-18' && x.programme === 'yes' && x.comment === 'Scholarship family' && x.pay_state === 'deposit') && sS && sS.from === '2027-08-02' && sS.to === '2027-08-05' && sS.program === 'stay' && sS.pay_state === 'paid', 'calendar: manual stays with their own dates');
  ok(!cal.stays.some(x => x.ref === mF.ref), 'calendar: only stays in the range');
  ok(cal.unplaced.some(u => u.program === J1 && u.room_id === 'camper' && u.count === 1 && u.male === 1 && u.placeable) && cal.unplaced.some(u => u.room_id === 'own-tent' && !u.placeable), 'calendar: guests not placed yet per week and room type (tents can\'t be placed)');
  ok(cal.manual.length === 2 && cal.manual.every(b => b.source === 'manual' && b.manual) && cal.blocks.length === 0, 'calendar: the manual bookings in the range in full (for the drawer)');
  r = await adm({ action: 'block_create', rooms: [RN.d2, RN.cv(8)], from: '2027-08-01', to: '2027-08-03', reason: 'maintenance', comment: 'Paint' });
  r = await call(admin, 'GET', '/api/booking/admin?calendar=1&from=2027-07-11&to=2027-08-08', null, LIVE, AUTH);
  ok(r.data.blocks.length === 1 && r.data.blocks[0].rooms.join() === `${RN.d2},${RN.cv(8)}` && r.data.blocks[0].from === '2027-08-01' && r.data.blocks[0].reason === 'maintenance' && r.data.blocks[0].comment === 'Paint' && r.data.blocks[0].created_at, 'calendar: blocks in the range');
  r = await call(admin, 'GET', '/api/booking/admin?calendar=1', null, LIVE, AUTH);
  ok(r.status === 200 && r.data.from === addDays(listPrograms().map(p => p.dates.start).sort()[0], -7) && r.data.nights <= 120, `calendar default: from the earliest week − 7 days, at most 120 nights (${r.data.from} → ${r.data.to})`);
  for (const [q, msg] of [['from=2027-07-20&to=2027-07-20', 'no nights'], ['from=2027-01-01&to=2027-06-01', 'over 120 nights'], ['from=2027-02-30&to=2027-03-03', 'a date that doesn\'t exist'], ['from=tomorrow', 'not a date']]) {
    r = await call(admin, 'GET', `/api/booking/admin?calendar=1&${q}`, null, LIVE, AUTH);
    ok(r.status === 400 && r.data.error, `calendar refused: ${msg}`);
  }
  r = await call(admin, 'GET', '/api/booking/admin?calendar=1&from=2027-07-11&to=2027-08-08', null, LIVE);
  ok(r.status === 401, 'calendar needs the token');
  r = await call(admin, 'GET', '/api/booking/admin?calendar=1&from=2027-07-11&to=2027-08-08', null, ADMIN_ONLY, AUTH);
  ok(r.status === 200 && r.data.demo === true && r.data.rooms.length === 31 && r.data.areas.length === 8 && r.data.stays.length === 0 && r.data.blocks.length === 0 && r.data.unplaced.length === 0 && r.data.programs.length === listPrograms().length, 'calendar (demo): the rooms, no stays');
  ok(areaOf('Glamping Single 12', { name: 'x' }) === 'Glamping Single' && areaOf('Hut', { name: 'Garden huts' }) === 'Garden huts' && areaOf('7 · ', { name: 'Seven' }) === 'Seven', 'areas: after " · ", else without the number, else the room type');
  ok(rangeLabel('2027-07-30', '2027-08-02') === '30 Jul – 2 Aug 2027' && rangeLabel('2027-12-30', '2028-01-02') === '30 Dec 2027 – 2 Jan 2028', 'date ranges across months and years');

  // Stripe calls of the heaviest admin requests
  const heavy = [
    ['admin GET (week)', () => call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH)],
    ['overview', () => call(admin, 'GET', '/api/booking/admin?overview=1', null, LIVE, AUTH)],
    ['calendar (default range)', () => call(admin, 'GET', '/api/booking/admin?calendar=1', null, LIVE, AUTH)],
    ['manual_create over both weeks', () => adm({ action: 'manual_create', from: '2027-07-20', to: '2027-07-28', guests: [mg('Wil', 'Male', RN.gt(1)), mg('Xan', 'Male', RN.gt(1))], programme: 'yes' })],
    ['block_create over both weeks', () => adm({ action: 'block_create', rooms: [RN.gt(2), RN.gt(3), RN.gs(4)], from: '2027-07-20', to: '2027-07-28' })],
    ['manual_restore', async () => { await adm({ action: 'manual_cancel', ref: mW.ref }); return adm({ action: 'manual_restore', ref: mW.ref }); }],
    ['offline_payment (manual)', () => adm({ action: 'offline_payment', ref: mW.ref, amount_cents: 100 })],
    ['offline_payment (online)', () => adm({ action: 'offline_payment', ref: oRef, amount_cents: 100 })],
  ];
  const counts = [];
  for (const [name, fn] of heavy) { const x = await callsOf(fn); counts.push(`${name} ${x.calls.length}`); ok(x.res.status === 200 && x.calls.length < 30, `${name}: ${x.calls.length} Stripe calls (Cloudflare allows ~50)`); }
}

/* demo bookings respect the records; the rooming map with records */
reset();
{
  const blocked = [RN.b1, RN.a2, RN.b2, RN.c2, RN.gs(1), RN.gs(2), RN.gs(3), RN.solitude];
  r = await adm({ action: 'block_create', rooms: blocked, from: '2027-07-19', to: '2027-07-20', reason: 'maintenance' });
  r = await adm({ action: 'manual_create', from: '2027-07-18', to: '2027-07-24', guests: [mg('Yan', 'Male', RN.gt(1)), mg('Zoe', 'Female', RN.cv(1)), mg('Ama', 'Female', RN.cv(2))] });
  r = await call(admin, 'POST', '/api/booking/admin', { action: 'seed_demo', program: J1, percent: 70 }, LIVE, AUTH);
  ok(r.status === 200 && r.data.created > 0, 'seed_demo with blocks and a manual booking in the week');
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, LIVE, AUTH);
  const demoB = r.data.bookings.filter(b => b.demo), placed = demoB.flatMap(b => Object.values(b.assign || {}));
  ok(placed.length > 0 && !placed.some(n => blocked.includes(n)), 'demo guests are never placed in a blocked room');
  ok(!placed.includes(RN.cv(1)) && !placed.includes(RN.cv(2)) && demoB.every(b => b.guests.every((g, i) => b.assign[i] !== RN.gt(1) || g.gender === 'Male')), '… nor beside manual guests against the room\'s rules');
  ok(Object.values(r.data.rooming).every(x => !x.conflict), 'no conflicts in the rooming after seeding');
  ok(r.data.availability.rooms['twin-ensuite'].empty_units >= 0 && demoB.filter(b => b.guests.some(g => g.room === 'twin-ensuite')).reduce((s, b) => s + b.guests.filter(g => g.room === 'twin-ensuite').length, 0) <= 2, 'availability counted the blocks: at most one twin room (2 beds) was sold');
  // roomingMap / programWithRecords directly
  const recs = [
    { type: 'block', id: 'BL-AAAAAA', status: 'active', from: '2027-07-21', to: '2027-07-22', rooms: [RN.d2], reason: 'staff', comment: '' },
    { type: 'block', id: 'BL-BBBBBB', status: 'cancelled', from: '2027-07-21', to: '2027-07-22', rooms: [RN.c2], reason: 'staff', comment: '' },
    { type: 'booking', id: 'MB2707-AAAAAA', ref: 'MB2707-AAAAAA', status: 'active', from: '2027-07-10', to: '2027-07-19', programme: 'yes', guests: [{ name: 'Old Stay', gender: 'Male', room_name: RN.c2 }] },
    { type: 'booking', id: 'MB2707-BBBBBB', ref: 'MB2707-BBBBBB', status: 'active', from: '2027-08-10', to: '2027-08-19', programme: 'yes', guests: [{ name: 'Later', gender: 'Male', room_name: RN.b2 }] },
  ];
  const map = roomingMap(JP, [{ ref: 'R1', status: 'active', guests: [{ name: 'A', gender: 'Female', room: 'twin-ensuite' }], assign: { 0: RN.d2 } }], recs).rooming;
  ok(map[RN.d2].blocked.id === 'BL-AAAAAA' && map[RN.d2].conflict === 'blocked' && !map[RN.c2].blocked && map[RN.c2].guests[0].manual === true && map[RN.c2].guests[0].name === 'Old Stay' && !map[RN.b2].guests.length, 'roomingMap: active blocks only; manual guests overlapping the week (one night is enough), not later stays');
  const pw = programWithRecords(JP, recs);
  ok(pw !== JP && pw.rooms.find(x => x.id === 'twin-ensuite').units === 4 && pw.rooms.find(x => x.id === 'twin-ensuite').occupied.length === 1 && pw.program_spaces === 48 && JP.rooms.find(x => x.id === 'twin-ensuite').units === 5 && JP.program_spaces === 49 && JP.rooms.find(x => x.id === 'twin-ensuite').occupied.length === 0, 'programWithRecords works on a copy (the program itself is untouched)');
  ok(programWithRecords(JP, [{ ...recs[0], from: '2027-07-24', to: '2027-07-25' }]) === JP && availability(JP, { records: [] }).program_left === 49, 'no records overlapping the week: the program as it is');
  const o1 = overbooked(JP, { booked: { 'twin-ensuite': { female: 3, male: 3, other: 0, units: 0 } }, records: [{ ...recs[0] }] });
  ok(!o1.rooms['twin-ensuite'] && o1.programme === 0, 'overbooked: 3 women and 3 men fit the 4 twin rooms left');
  const o2 = overbooked(JP, { booked: { 'twin-ensuite': { female: 3, male: 3, other: 0, units: 0 } }, records: [{ ...recs[0], rooms: [RN.d2, RN.c2, RN.b2] }] });
  ok(o2.rooms['twin-ensuite'] === 3, 'overbooked: 3 women and 3 men need 4 twin rooms; with 2 left the 3 men don\'t fit');
}

/* metadata limits of the fullest records */
reset();
{
  const simple = [...[1, 2, 3, 4, 5].map(RN.gs), ...[1, 2, 3, 4, 5, 6, 7].map(RN.cv)];
  const big = simple.map((room_name, i) => ({ first: lng('Mariabella', 60), last: lng('Esperanza', 60), email: `${lng('guestname', 60)}${'abcdefghijkl'[i]}@${lng('example', 50)}.com`, gender: 'Female', room_name }));
  r = await adm({ action: 'manual_create', from: '2027-09-01', to: '2027-12-30', whatsapp: '+447700900123', programme: 'no', total_cents: 99999999, comment: lng('Long comment. ', 700), guests: big });
  const mBig = r.data.booking, cBig = store.customers.find(c => c.id === mBig.manual.customer);
  ok(r.status === 200 && mBig.guests.length === 12 && mBig.manual.comment.length === 480 && cBig.metadata.aob_g12, '12 guests with the longest names and emails, a full comment, 120 nights');
  r = await adm({ action: 'manual_cancel', ref: mBig.ref });
  r = await adm({ action: 'manual_update', ref: mBig.ref, comment: lng('Again. ', 900), total_cents: 100000000 });
  ok(r.status === 200 && Object.keys(cBig.metadata).length < 50 && Object.values(cBig.metadata).every(v => String(v).length <= 500), `the fullest manual booking stays within Stripe's metadata limits (${Object.keys(cBig.metadata).length} keys)`);
  r = await adm({ action: 'offline_payment', ref: mBig.ref, amount_cents: 100000000, method: 'other', comment: lng('Paid through the agency. ', 900) });
  const invBig = store.invoices.find(i => i.id === r.data.payment.invoice_id);
  r = await adm({ action: 'offline_void', invoice_id: invBig.id, reason: lng('Wrong. ', 400) });
  ok(r.status === 200 && Object.keys(invBig.metadata).length < 50 && Object.values(invBig.metadata).every(v => String(v).length <= 500), `the fullest offline payment, undone, stays within the limits (${Object.keys(invBig.metadata).length} keys)`);
  const all20 = calendarRooms().rooms.map(x => x.name).sort((a, b) => b.length - a.length).slice(0, 20);
  r = await adm({ action: 'block_create', rooms: all20, from: '2027-10-01', to: '2027-10-02', reason: 'owner', comment: lng('c', 600) });
  ok(r.status === 200 && r.data.block.rooms.length === 20 && Object.values(store.customers.find(c => c.id === r.data.block.customer).metadata).every(v => String(v).length <= 500), 'a block of 20 rooms (the longest names) fits');
  ok(parseRecord({ id: 'cus_x', metadata: { aob_rec_any: '1', aob_rec: 'block', aob_from: '2027-07-02', aob_to: '2027-07-01' } }) === null && parseRecord({ id: 'cus_y', metadata: { aob_rec: 'block', aob_from: '2027-07-01', aob_to: '2027-07-02' } }) === null, 'unreadable records are ignored');
}

/* ?stays=1: the manual bookings outside every week, for the All weeks lists */
reset();
{
  r = await call(admin, 'GET', '/api/booking/admin?stays=1', null, ADMIN_ONLY, AUTH);
  ok(r.status === 200 && r.data.stays && r.data.demo && r.data.bookings.length === 0 && r.data.program.id === 'stay', 'stays: demo mode answers an empty list');
  r = await call(admin, 'GET', '/api/booking/admin?stays=1', null, LIVE);
  ok(r.status === 401, 'stays: needs the admin token');
  const one = (await adm({ action: 'manual_create', from: '2027-07-12', to: '2027-07-13', total_cents: 9500, comment: 'One night', guests: [mg('Una', 'Female', RN.a1)] })).data.booking;
  const inWeek = (await adm({ action: 'manual_create', from: '2027-07-19', to: '2027-07-20', guests: [mg('Vera', 'Female', RN.d2)] })).data.booking;
  r = await adm({ action: 'offline_payment', ref: one.ref, amount_cents: 9500, method: 'bank_transfer', comment: 'SEPA, ref 4471' });
  ok(r.status === 200, 'stays: a bank transfer on the one-night stay');
  r = await call(admin, 'GET', '/api/booking/admin?stays=1', null, LIVE, AUTH);
  const s = r.data.bookings.find(b => b.ref === one.ref);
  ok(r.status === 200 && r.data.live && s && s.program === 'stay' && s.paid_cents === 9500 && s.balance_cents === 0 && s.payments.some(p => p.kind === 'offline' && p.comment === 'SEPA, ref 4471') && !r.data.bookings.some(b => b.ref === inWeek.ref) && r.data.totals.paid_cents === 9500,
    'stays: lists the one-night stay with its bank transfer, not the stay inside a week');
}

/* ================================================================== round 5: team users, sign-in, activity log */
const LIVEK = { ...LIVE, STRIPE_SECRET_KEY: 'sk_live_mock' };
const bearer = t => ({ Authorization: 'Bearer ' + t });
// each sign-in moves the clock 70 s on: never 10 tries for one username within 10 minutes by accident
const loginAs = (username, password, { env = LIVE, headers } = {}) => { tick(70); return call(loginApi, 'POST', '/api/booking/login', { username, password }, env, headers); };
const loginRaw = (body, headers, env = LIVE) => call(loginApi, 'POST', '/api/booking/login', body, env, headers);
const asUser = (token, body, env = LIVE) => call(admin, 'POST', '/api/booking/admin', body, env, bearer(token));
const getAs = (token, q, env = LIVE) => call(admin, 'GET', '/api/booking/admin?' + q, null, env, bearer(token));
const ownerGet = (q, env = LIVE) => call(admin, 'GET', '/api/booking/admin?' + q, null, env, AUTH);
const logbooks = () => store.customers.filter(c => c.metadata && c.metadata.aob_logbook === '1' && !c.deleted);
const userCus = () => store.customers.filter(c => c.metadata && c.metadata.aob_user === '1');
const entries = () => logbooks().flatMap(c => Object.entries(c.metadata).filter(([k]) => /^e[0-9a-z]+$/.test(k)).map(([k, v]) => ({ key: k, raw: v, ...JSON.parse(v) }))).sort((a, b) => (a.t - b.t) || (a.key < b.key ? -1 : 1));
const lastEntry = a => entries().filter(e => e.a === a).pop();
const cusOf = id => store.customers.find(c => c.id === id);
const eur2t = c => '€' + (c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PW_RE = /^[a-z]{4,6}-[a-z]{4,6}-[a-z]{4,6}-\d\d$/;
const USER_KEYS = 'created_at,id,last_login_at,name,role,status,test,username';
const OWNER_ME = JSON.stringify({ id: 'owner', name: 'Main admin', role: 'owner' });
const secrets = []; // every password handed out or tried: never in Stripe as text, never in the log or the failure logs

/* passwords */
{
  ok(PASSWORD_WORDS.length === 256 && new Set(PASSWORD_WORDS).size === 256 && PASSWORD_WORDS.every(w => /^[a-z]{4,6}$/.test(w)), 'password words: 256 distinct short lowercase words');
  const gen = Array.from({ length: 300 }, generatePassword);
  ok(gen.every(p => PW_RE.test(p) && p.split('-').slice(0, 3).every(w => PASSWORD_WORDS.includes(w))) && new Set(gen).size > 290, 'generated passwords: three words and two digits (lotus-amber-river-42), random');
  const h = await hashPassword('lotus-amber-river-42');
  ok(/^pbkdf2\$10000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(h) && h !== await hashPassword('lotus-amber-river-42'), 'password hash: PBKDF2-SHA256, 10,000 iterations, 16-byte salt, 32-byte hash (salted)');
  ok(await verifyPassword('lotus-amber-river-42', h) && !(await verifyPassword('lotus-amber-river-43', h)) && !(await verifyPassword('x', '')) && !(await verifyPassword('x', 'pbkdf2$99$a$b')), 'password check');
  ok(scrubText('Paid by jane.doe@example.com, call +44 7700 900123 (SEPA ref 4471, 2026-07-01)') === 'Paid by [email], call [number] (SEPA ref 4471, 2026-07-01)', 'free text in the log: no email addresses or phone numbers (short numbers and dates stay)');
}

/* users: create, list (owner) */
reset();
let anna, annaPw, ben, carol;
const benPw = 'benpw', carolPw = 'carol-pass-1';
secrets.push(benPw, carolPw);
{
  r = await availJ(); const availBefore = JSON.stringify(r.data.rooms);
  r = await ownerGet('users=1');
  ok(r.status === 200 && Array.isArray(r.data.users) && r.data.users.length === 0 && r.data.live === false && r.data.password_min === 5 && JSON.stringify(r.data.me) === OWNER_ME, 'users: none yet; test keys: passwords of 5+ characters; me = the main admin');
  r = await ownerGet('users=1', ADMIN_ONLY);
  ok(r.status === 200 && r.data.demo === true && r.data.users.length === 0 && r.data.me.role === 'owner', 'users (demo): empty');
  r = await ownerGet('activity=1', ADMIN_ONLY);
  ok(r.status === 200 && r.data.demo === true && r.data.entries.length === 0 && r.data.has_more === false && r.data.me.role === 'owner', 'activity (demo): empty');
  for (const q of [`program=${J1}`, 'overview=1', 'stays=1', 'calendar=1&from=2027-07-11&to=2027-08-08']) {
    r = await ownerGet(q, ADMIN_ONLY);
    ok(r.status === 200 && r.data.demo && JSON.stringify(r.data.me) === OWNER_ME, `demo GET ?${q.split('&')[0]} carries me`);
  }
  for (const [body, k, msg] of [
    [{ username: 'a b', name: 'Anna', role: 'team' }, 'username', 'a space'],
    [{ username: 'ab', name: 'Anna', role: 'team' }, 'username', 'too short'],
    [{ username: 'x'.repeat(33), name: 'Anna', role: 'team' }, 'username', 'too long'],
    [{ username: 'anna@x.com', name: 'Anna', role: 'team' }, 'username', 'an @'],
    [{ name: 'Anna', role: 'team' }, 'username', 'none'],
    [{ username: 'anna', name: '', role: 'team' }, 'name', 'no name'],
    [{ username: 'anna', name: 'A'.repeat(61), role: 'team' }, 'name', 'a name over 60 characters'],
    [{ username: 'anna', name: '=HYPERLINK("x")', role: 'team' }, 'name', 'a spreadsheet formula'],
    [{ username: 'anna', name: 'Anna', role: 'owner' }, 'role', 'role owner'],
    [{ username: 'anna', name: 'Anna' }, 'role', 'no role'],
    [{ username: 'anna', name: 'Anna', role: 'team', password: 'abcd' }, 'password', 'a 4-character password'],
    [{ username: 'anna', name: 'Anna', role: 'team', password: 'p'.repeat(101) }, 'password', 'a 101-character password'],
    [{ username: 'anna', name: 'Anna', role: 'team', password: 12345678 }, 'password', 'a number as password'],
  ]) {
    r = await adm({ action: 'user_create', ...body });
    ok(r.status === 422 && r.data.fields[k] && !r.data.password, `user_create refused: ${msg}`);
  }
  ok(userCus().length === 0 && logbooks().length === 0, 'nothing stored (or logged) for refused users');

  r = await adm({ action: 'user_create', username: ' Anna.K ', name: '  Anna Kowalska ', role: 'team' });
  anna = r.data.user; annaPw = r.data.password; secrets.push(annaPw);
  const cA = cusOf(anna.id);
  ok(r.status === 200 && r.data.ok && anna.username === 'anna.k' && anna.name === 'Anna Kowalska' && anna.role === 'team' && anna.status === 'active' && anna.test === false && anna.last_login_at === null && !Number.isNaN(Date.parse(anna.created_at)) && Object.keys(anna).sort().join() === USER_KEYS, 'user_create: the user (username lowercased, name trimmed)');
  ok(PW_RE.test(annaPw) && JSON.stringify(r.data).split(annaPw).length === 2, 'user_create: a generated password, in the answer once');
  ok(cA && cA.name === 'AoB team · Anna Kowalska' && cA.description === 'Booking dashboard user (do not delete)' && cA.email === null && cA.metadata.aob_user === '1' && cA.metadata.aob_username === 'anna.k' && cA.metadata.aob_uname === 'Anna Kowalska' && cA.metadata.aob_role === 'team' && cA.metadata.aob_uver === '1' && cA.metadata.aob_ustatus === 'active' && !Number.isNaN(Date.parse(cA.metadata.aob_ucreated)) && !cA.metadata.aob_utest && !cA.metadata.aob_ulast && !cA.metadata.aob_rec && !cA.metadata.aob_rec_any, 'a user is a Stripe customer without an email, the user in aob_* metadata (never a record)');
  ok(/^pbkdf2\$10000\$/.test(cA.metadata.aob_pw) && !JSON.stringify(cA).includes(annaPw) && await verifyPassword(annaPw, cA.metadata.aob_pw), 'only a PBKDF2 hash of the password is stored');
  r = await adm({ action: 'user_create', username: 'ANNA.K', name: 'Another Anna', role: 'viewer' });
  ok(r.status === 409 && r.data.fields.username === 'Already taken.' && r.data.error && userCus().length === 1, 'user_create: a username already taken (any case) → 409');
  r = await adm({ action: 'user_create', username: 'ben', name: 'Ben', role: 'viewer', password: ` ${benPw} ` });
  ben = r.data.user;
  ok(r.status === 200 && r.data.password === benPw && ben.role === 'viewer', 'user_create: a typed password (5 characters with test keys; spaces at the ends dropped)');
  r = await adm({ action: 'user_create', username: 'carol', name: 'Carol', role: 'team', password: carolPw });
  carol = r.data.user;
  r = await adm({ action: 'user_create', username: 'dan', name: 'Dan', role: 'team', password: 'ninechars' }, LIVEK);
  ok(r.status === 422 && r.data.fields.password === 'Use at least 10 characters.', 'live keys: passwords of 10+ characters');
  r = await ownerGet('users=1', LIVEK);
  ok(r.status === 200 && r.data.live === true && r.data.password_min === 10, 'users with live keys: live, password_min 10');
  r = await ownerGet('users=1');
  ok(r.status === 200 && r.data.users.map(u => u.username).join() === 'anna.k,ben,carol' && r.data.users.every(u => Object.keys(u).sort().join() === USER_KEYS) && !/pbkdf2|aob_pw|"pw"/.test(JSON.stringify(r.data)), 'users: oldest first, never a password hash');
  ok(entries().filter(e => e.a === 'user_create').map(e => e.s).join('|') === 'Added user anna.k (team)|Added user ben (view only)|Added user carol (team)' && entries().every(e => e.u === 'owner' && e.n === 'Main admin' && e.r === 'owner'), 'activity: users added, by the main admin');
  // users and logbooks are customers too, but never records
  const recs = await listRecords(LIVE, { recent: true });
  ok(recs.length === 0 && (await listRecords(LIVE, { cached: true })).length === 0, 'listRecords never sees users or logbooks');
  r = await availJ();
  ok(JSON.stringify(r.data.rooms) === availBefore, 'availability is untouched by users and logbooks');
  r = await ownerGet('calendar=1&from=2027-07-11&to=2027-08-08');
  ok(r.status === 200 && r.data.blocks.length === 0 && r.data.manual.length === 0 && r.data.stays.length === 0, 'the calendar shows no users or logbooks');
}

/* sign-in */
{
  r = await loginAs('anna.k', annaPw);
  const t1 = r.data.token;
  ok(r.status === 200 && r.data.ok && /^aobu\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(t1) && JSON.stringify(r.data.user) === JSON.stringify({ id: anna.id, username: 'anna.k', name: 'Anna Kowalska', role: 'team' }), 'login: a session token and the user');
  ok(Date.parse(r.data.expires_at) === (nowS() + 12 * 3600) * 1000, 'login: the session lasts 12 hours');
  const pl = JSON.parse(Buffer.from(t1.split('.')[1], 'base64url').toString());
  ok(pl.sub === anna.id && pl.v === 1 && pl.exp === nowS() + 12 * 3600 && Object.keys(pl).length === 3, 'token payload: sub, v, exp only');
  ok(cusOf(anna.id).metadata.aob_ulast === new Date(fakeNow).toISOString() && cusOf(anna.id).metadata.aob_uver === '1', 'login: last sign-in recorded (the version stays)');
  r = await ownerGet('users=1');
  ok(r.data.users.find(u => u.id === anna.id).last_login_at === cusOf(anna.id).metadata.aob_ulast, 'users: last sign-in');
  r = await loginAs(' ANNA.K ', annaPw);
  ok(r.status === 200, 'login: the username in any case, spaces ignored');
  r = await loginAs('anna.k', annaPw + 'x');
  const wrong = JSON.stringify(r.data);
  ok(r.status === 401 && r.data.error === 'Wrong username or password.' && Object.keys(r.data).length === 1, 'login: a wrong password → 401');
  r = await loginAs('nobody', annaPw);
  ok(r.status === 401 && JSON.stringify(r.data) === wrong, 'login: an unknown user → the same 401');
  r = await loginAs('a b', annaPw);
  ok(r.status === 401 && JSON.stringify(r.data) === wrong, 'login: an impossible username → the same 401');
  r = await loginAs('anna.k', '');
  ok(r.status === 400 && r.data.error === 'Enter your username and password.', 'login: an empty password → 400');
  r = await loginRaw('nope');
  ok(r.status === 400 && r.data.error === 'Invalid request.', 'login: not JSON → 400');
  r = await loginRaw({ username: 'anna.k', password: annaPw }, { 'Content-Type': 'text/plain' });
  ok(r.status === 415, 'login: JSON only (415)');
  r = await loginRaw({ username: 'anna.k', password: annaPw }, { Origin: 'https://evil.example' });
  ok(r.status === 403, 'login: a foreign Origin is refused');
  r = await call(loginApi, 'OPTIONS', '/api/booking/login', null, LIVE);
  ok(r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === ORIGIN, 'login: CORS preflight');
  for (const [env, msg] of [[{ ...LIVE, ADMIN_TOKEN: '' }, 'no ADMIN_TOKEN'], [{ ...LIVE, ADMIN_TOKEN: 'short-token' }, 'an ADMIN_TOKEN under 16 characters'], [ADMIN_ONLY, 'no Stripe key']]) {
    r = await loginRaw({ username: 'anna.k', password: annaPw }, {}, env);
    ok(r.status === 503 && r.data.code === 'unavailable' && /admin token/.test(r.data.error), `login unavailable: ${msg} → 503`);
  }
  // Stripe unreachable: 503 busy, never "wrong password"
  tick(31);
  fault('GET', /^\/customers\/search$/, { status: 500, times: 3 });
  r = await loginAs('carol', carolPw);
  ok(r.status === 503 && r.data.code === 'busy', 'login: Stripe unreachable → 503 busy');
  // rate limits: 10 tries per 10 minutes per address…
  for (let i = 0; i < 10; i++) r = await loginRaw({ username: `guess${i}`, password: `pw-guess-${i}` }, ip(77));
  ok(r.status === 401, 'login: 10 tries from one address are answered');
  r = await loginRaw({ username: 'carol', password: carolPw }, ip(77));
  ok(r.status === 429 && r.data.error === 'Too many attempts. Try again in a few minutes.' && Object.keys(r.data).length === 1, 'login: the 11th try from that address → 429 (even with the right password)');
  r = await loginRaw({ username: 'carol', password: carolPw }, { 'CF-Connecting-IP': '2001:db8:1:2:aaaa::1' });
  ok(r.status === 200, 'login: another address still signs in');
  for (let i = 0; i < 10; i++) r = await loginRaw({ username: `v6guess${i}`, password: `pw-v6-${i}` }, { 'CF-Connecting-IP': `2001:db8:5:6::${i + 1}` });
  r = await loginRaw({ username: 'ben', password: benPw }, { 'CF-Connecting-IP': '2001:db8:5:6:ffff::9' });
  ok(r.status === 429, 'login: IPv6 addresses count per /64');
  // …and 10 per 10 minutes per username, from any address (carol so far: the try while Stripe was down, 1 sign-in; + 8 wrong)
  for (let i = 0; i < 8; i++) r = await loginRaw({ username: 'carol', password: `pw-wrong-${i}` }, ip(100 + i));
  ok(r.status === 401, 'login: wrong passwords for carol from 8 addresses');
  r = await loginRaw({ username: 'carol', password: carolPw }, ip(120));
  ok(r.status === 429, 'login: the 11th try for one username (from a new address) → 429');
  tick(11 * 60);
  r = await loginRaw({ username: 'carol', password: carolPw }, ip(77));
  ok(r.status === 200, 'login: 10 minutes later both limits have passed');
  for (let i = 0; i < 10; i++) secrets.push(`pw-guess-${i}`, `pw-v6-${i}`, `pw-wrong-${i}`);
  // the log
  const ins = entries().filter(e => e.a === 'login'), outs = entries().filter(e => e.a === 'login_failed');
  ok(ins.length >= 4 && ins.every(e => e.u !== '-' && e.r !== '-' && /^Signed in as [a-z.]+$/.test(e.s)) && ins.some(e => e.u === anna.id && e.n === 'Anna Kowalska' && e.r === 'team' && e.s === 'Signed in as anna.k'), 'activity: sign-ins, with who');
  ok(outs.some(e => e.u === '-' && e.n === 'nobody' && e.r === '-' && e.s === 'Sign-in refused (unknown username)') && outs.some(e => e.u === '-' && e.n === 'anna.k' && e.s === 'Sign-in refused (wrong password)') && outs.some(e => e.n === 'guess9'), 'activity: refused sign-ins, named by the username tried, and why');
  ok(!outs.some(e => e.n === 'carol' && e.t === nowS() * 1000), '(a try refused with 429 is not logged)');
  r = await loginAs('x'.repeat(50), 'pw-long-name');
  ok(r.status === 401 && lastEntry('login_failed').n === 'x'.repeat(32), 'activity: the username tried is cut to 32 characters');
  r = await loginAs('jane.doe@example.com', 'pw-email-name');
  ok(r.status === 401 && lastEntry('login_failed').n === '[email]', 'activity: an email typed as username is not logged');
  secrets.push('pw-long-name', 'pw-email-name');
}

/* sessions: roles, ending, tampering */
let bRef, tA;
{
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(1, 'twin-ensuite')]), LIVE);
  bRef = r.data.ref; complete(r.data.session_id);
  const bPi = () => [...store.pis.values()].find(p => p.metadata.aob_ref === bRef);
  r = await loginAs('anna.k', annaPw); tA = r.data.token;
  r = await loginAs('ben', benPw); const tB = r.data.token;
  ok(JSON.stringify(await adminIdentity(req('GET', '/x', null, AUTH), LIVE)) === JSON.stringify({ kind: 'owner', id: 'owner', name: 'Main admin', role: 'owner' }) && JSON.stringify(await adminIdentity(req('GET', '/x', null, bearer(tA)), LIVE)) === JSON.stringify({ kind: 'user', id: anna.id, username: 'anna.k', name: 'Anna Kowalska', role: 'team' }) && await adminIdentity(req('GET', '/x', null, {}), LIVE) === null, 'adminIdentity: the owner, a user, or null');
  for (const q of [`program=${J1}`, 'overview=1', 'calendar=1&from=2027-07-11&to=2027-08-08', 'stays=1']) {
    r = await getAs(tA, q);
    ok(r.status === 200 && JSON.stringify(r.data.me) === JSON.stringify({ id: anna.id, name: 'Anna Kowalska', role: 'team', username: 'anna.k' }), `a team member reads ?${q.split('&')[0]} (me: the team member)`);
    r = await ownerGet(q);
    ok(r.status === 200 && JSON.stringify(r.data.me) === OWNER_ME, `the owner: ?${q.split('&')[0]} carries me`);
  }
  r = await ownerGet('calendar=1&from=2027-07-20&to=2027-07-20');
  ok(r.status === 400 && r.data.me.role === 'owner', 'an error answer carries me too');
  r = await getAs(tB, `program=${J1}`);
  ok(r.status === 200 && r.data.me.role === 'viewer' && r.data.me.username === 'ben' && r.data.bookings.some(b => b.ref === bRef), 'a viewer reads the week');
  r = await asUser(tA, { action: 'note', ref: bRef, note: 'Arrives late' });
  ok(r.status === 200 && r.data.note === 'Arrives late' && bPi().metadata.aob_note === 'Arrives late', 'a team member saves a note');
  const eN = lastEntry('note');
  ok(eN && eN.u === anna.id && eN.n === 'Anna Kowalska' && eN.r === 'team' && eN.f === bRef && eN.p === J1 && eN.s === `Note on ${bRef}`, 'activity: the note, by the team member');
  for (const action of ['user_create', 'user_update', 'test_users_create', 'seed_demo', 'place_demo', 'clear_demo', 'register_domains', 'repair_plans']) {
    r = await asUser(tA, { action, program: J1, id: anna.id, username: 'zed', name: 'Zed', role: 'team' });
    ok(r.status === 403 && r.data.code === 'owner_only' && r.data.error === 'Only the main admin can do this.', `a team member: ${action} → 403 owner_only`);
  }
  for (const q of ['users=1', 'activity=1']) {
    r = await getAs(tA, q);
    ok(r.status === 403 && r.data.code === 'owner_only' && r.data.error === 'Only the main admin can do this.' && !r.data.users && !r.data.entries, `a team member: GET ?${q} → 403 owner_only`);
    r = await getAs(tB, q);
    ok(r.status === 403 && r.data.code === 'owner_only', `a viewer: GET ?${q} → 403 owner_only`);
  }
  for (const body of [{ action: 'note', ref: bRef, note: 'x' }, { action: 'cancel', ref: bRef }, { action: 'assign', ref: bRef, assign: { 0: RN.b2 } },
    { action: 'block_create', rooms: [RN.a2], from: '2027-07-20', to: '2027-07-21' }, { action: 'manual_create', from: '2027-07-20', to: '2027-07-21', guests: [mg('Al', 'Female', RN.gs(3))] },
    { action: 'offline_payment', ref: bRef, amount_cents: 100 }, { action: 'create_link', program: J1 }, { action: 'user_create', username: 'zed', name: 'Zed', role: 'team' }, { action: 'seed_demo', program: J1 }]) {
    r = await asUser(tB, body);
    ok(r.status === 403 && r.data.code === 'read_only' && r.data.error === 'View-only access: you can look but not change anything.', `a viewer: ${body.action} → 403 read_only`);
  }
  ok(bPi().metadata.aob_note === 'Arrives late' && bPi().metadata.aob_status !== 'cancelled' && !store.customers.some(c => c.metadata && c.metadata.aob_rec_any) && userCus().length === 3 && !store.invoices.some(i => i.metadata && i.metadata.aob_kind === 'offline'), 'nothing changed by the refused actions');
  // altered or foreign tokens: 401 without a code
  const [h, p, sig] = tA.split('.');
  const forged = JSON.parse(Buffer.from(p, 'base64url').toString()); forged.v = 9; forged.exp += 3600;
  const owner2 = JSON.parse(Buffer.from(p, 'base64url').toString()); owner2.sub = ben.id;
  for (const [t, msg] of [[`${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`, 'payload changed'], [`${h}.${Buffer.from(JSON.stringify(owner2)).toString('base64url')}.${sig}`, 'another user'],
    [`${h}.${p}.${sig.slice(0, 20)}${sig[20] === 'A' ? 'B' : 'A'}${sig.slice(21)}`, 'signature changed'], [`${h}.${p}`, 'no signature'], ['aobu.x.y', 'garbage'], [tA + 'x', 'one character more'], [`xyz.${p}.${sig}`, 'another prefix']]) {
    r = await getAs(t, `program=${J1}`);
    ok(r.status === 401 && r.data.error === 'Not authorised.' && !r.data.code && !r.data.me, `an altered token is refused (401, no code): ${msg}`);
  }
  r = await asUser(`${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`, { action: 'note', ref: bRef, note: 'forged' });
  ok(r.status === 401 && bPi().metadata.aob_note === 'Arrives late', '… for actions too');
  r = await getAs(tA, `program=${J1}`, { ...LIVE, ADMIN_TOKEN: 'another-admin-token-0987654321' });
  ok(r.status === 401 && !r.data.code, 'a new ADMIN_TOKEN ends every team session');
  r = await getAs(tA, `program=${J1}`, ADMIN_ONLY);
  ok(r.status === 401, 'demo mode (no Stripe): team sessions can\'t be checked → 401');
  // Stripe unreachable while checking a session: a read from a moment ago is used, else 503 busy (never a sign-out)
  tick(20);
  fault('GET', /^\/customers\/cus_/, { status: 500, times: 3 });
  r = await getAs(tA, 'overview=1');
  ok(r.status === 200 && r.data.me.id === anna.id, 'session check: Stripe down → the user as read a moment ago');
  tick(3 * 60);
  fault('GET', /^\/customers\/cus_/, { status: 500, times: 3 });
  r = await getAs(tA, 'overview=1');
  ok(r.status === 503 && r.data.code === 'busy', 'session check: Stripe down and no recent read → 503 busy');
  fault('GET', /^\/customers\/cus_/, { status: 500, times: 3 });
  r = await asUser(tA, { action: 'note', ref: bRef, note: 'x' });
  ok(r.status === 503 && r.data.code === 'busy' && bPi().metadata.aob_note === 'Arrives late', '… for actions too (nothing done)');
  // 12 hours
  tick(12 * 3600 + 1);
  r = await getAs(tA, `program=${J1}`);
  ok(r.status === 401 && r.data.code === 'session_ended' && r.data.error === 'Not authorised.', 'after 12 hours: 401 session_ended');
  r = await asUser(tA, { action: 'note', ref: bRef, note: 'late' });
  ok(r.status === 401 && r.data.code === 'session_ended', '… for actions too');
}

/* user_update: role, status, password, name; each but the name ends the user's sessions */
{
  r = await loginAs('anna.k', annaPw); let t = r.data.token;
  r = await adm({ action: 'user_update', id: anna.id, role: 'viewer' });
  ok(r.status === 200 && r.data.ok && r.data.user.role === 'viewer' && !('password' in r.data) && cusOf(anna.id).metadata.aob_uver === '2' && lastEntry('user_update').s === 'Changed role of anna.k to view only', 'user_update: role → view only (version bumped, logged)');
  r = await getAs(t, `program=${J1}`);
  ok(r.status === 401 && r.data.code === 'session_ended', 'a role change ends the user\'s sessions (401 session_ended)');
  r = await loginAs('anna.k', annaPw); t = r.data.token;
  ok(r.data.user.role === 'viewer', 'signed in again: view only');
  r = await asUser(t, { action: 'note', ref: bRef, note: 'x' });
  ok(r.status === 403 && r.data.code === 'read_only', '… and can\'t change anything now');
  r = await adm({ action: 'user_update', id: anna.id, status: 'disabled' });
  ok(r.status === 200 && r.data.user.status === 'disabled' && lastEntry('user_update').s === 'Disabled anna.k', 'user_update: disabled');
  r = await getAs(t, 'overview=1');
  ok(r.status === 401 && r.data.code === 'session_ended', 'disabling ends the sessions');
  r = await loginAs('anna.k', annaPw);
  ok(r.status === 401 && r.data.error === 'Wrong username or password.' && lastEntry('login_failed').s === 'Sign-in refused (the user is disabled)', 'a disabled user can\'t sign in (the same 401; the log says why)');
  r = await adm({ action: 'user_update', id: anna.id, status: 'active', role: 'team' });
  ok(r.status === 200 && r.data.user.status === 'active' && r.data.user.role === 'team' && lastEntry('user_update').s === 'Updated anna.k: role team, active', 'enabled again as team (two changes, one entry)');
  r = await loginAs('anna.k', annaPw); t = r.data.token;
  ok(r.status === 200 && r.data.user.role === 'team', 'enabled: signs in again');
  r = await adm({ action: 'user_update', id: anna.id, reset_password: true });
  const annaPw2 = r.data.password; secrets.push(annaPw2);
  ok(r.status === 200 && PW_RE.test(annaPw2) && annaPw2 !== annaPw && lastEntry('user_update').s === 'Reset password of anna.k', 'reset_password: a new generated password, shown once');
  r = await getAs(t, 'overview=1');
  ok(r.status === 401 && r.data.code === 'session_ended', 'a password reset ends the sessions');
  r = await loginAs('anna.k', annaPw);
  ok(r.status === 401, 'the old password no longer works');
  r = await loginAs('anna.k', annaPw2); t = r.data.token;
  ok(r.status === 200, 'the new one does');
  r = await adm({ action: 'user_update', id: anna.id, name: 'Anna K.' });
  ok(r.status === 200 && r.data.user.name === 'Anna K.' && cusOf(anna.id).name === 'AoB team · Anna K.' && cusOf(anna.id).metadata.aob_uver === '5' && lastEntry('user_update').s === 'Renamed anna.k to "Anna K."', 'user_update: renamed (the version stays)');
  r = await getAs(t, 'overview=1');
  ok(r.status === 200 && r.data.me.name === 'Anna K.', 'a new name keeps the session (me has the new name)');
  r = await adm({ action: 'user_update', id: anna.id, password: 'typed-pass', reset_password: true });
  secrets.push('typed-pass');
  ok(r.status === 200 && r.data.password === 'typed-pass' && cusOf(anna.id).metadata.aob_uver === '6' && lastEntry('user_update').s === 'Set a new password for anna.k', 'user_update: a typed password wins over reset_password');
  const n0 = entries().length;
  r = await adm({ action: 'user_update', id: anna.id, name: 'Anna K.', role: 'team', status: 'active' });
  ok(r.status === 200 && r.data.unchanged === true && !('password' in r.data) && entries().length === n0 && cusOf(anna.id).metadata.aob_uver === '6', 'user_update: nothing different → { unchanged: true }, not logged');
  for (const [id, msg] of [['cus_nosuch000', 'an unknown id'], ['anna.k', 'not a customer id'], [logbooks()[0].id, 'a logbook (not a user)'], ['', 'no id']]) {
    r = await adm({ action: 'user_update', id, role: 'team' });
    ok(r.status === 404 && r.data.error === 'User not found.', `user_update: ${msg} → 404`);
  }
  for (const [body, k] of [[{ role: 'boss' }, 'role'], [{ status: 'gone' }, 'status'], [{ password: 'abc' }, 'password'], [{ name: '' }, 'name']]) {
    r = await adm({ action: 'user_update', id: anna.id, ...body });
    ok(r.status === 422 && r.data.fields[k], `user_update refused: a bad ${k}`);
  }
  tA = (await loginAs('anna.k', 'typed-pass')).data.token;
}

/* three test users in one click */
{
  r = await adm({ action: 'test_users_create' });
  const T = r.data.users;
  ok(r.status === 200 && r.data.ok && T.length === 3 && T.map(x => x.user.username).join() === 'test1,test2,test3' && T.map(x => x.user.name).join() === 'Test User 1,Test User 2,Test User 3' && T.map(x => x.user.role).join() === 'team,team,viewer' && T.every(x => x.user.test === true && x.user.status === 'active' && PW_RE.test(x.password) && Object.keys(x.user).sort().join() === USER_KEYS), 'test_users_create: test1, test2 (team), test3 (view only), generated passwords');
  ok(T.every(x => cusOf(x.user.id).metadata.aob_utest === '1' && cusOf(x.user.id).metadata.aob_uver === '1') && lastEntry('test_users_create').s === 'Created 3 test users' && lastEntry('test_users_create').u === 'owner', 'test users are marked aob_utest; logged');
  T.forEach(x => secrets.push(x.password));
  r = await loginAs('test1', T[0].password); const tT1 = r.data.token;
  ok(r.status === 200 && r.data.user.role === 'team', 'test1 signs in (team)');
  r = await loginAs('test3', T[2].password);
  ok(r.status === 200 && r.data.user.role === 'viewer', 'test3 signs in (view only)');
  r = await adm({ action: 'user_update', id: T[1].user.id, status: 'disabled' });
  r = await adm({ action: 'user_update', id: T[0].user.id, role: 'viewer' });
  r = await adm({ action: 'test_users_create' });
  const T2 = r.data.users;
  ok(r.status === 200 && T2.length === 3 && T2.every((x, i) => x.user.id === T[i].user.id && x.password !== T[i].password && x.user.status === 'active' && x.user.role === T[i].user.role) && ['test1', 'test2', 'test3'].every(u => userCus().filter(c => c.metadata.aob_username === u).length === 1), 'test_users_create again: the same three users (no duplicates), active, their roles, new passwords');
  ok(cusOf(T[0].user.id).metadata.aob_uver === '3' && cusOf(T[1].user.id).metadata.aob_uver === '3' && cusOf(T[2].user.id).metadata.aob_uver === '2' && lastEntry('test_users_create').s === 'Reset 3 test users (new passwords)', '… versions bumped; logged');
  T2.forEach(x => secrets.push(x.password));
  r = await getAs(tT1, 'overview=1');
  ok(r.status === 401 && r.data.code === 'session_ended', 'test1\'s old session ended');
  r = await loginAs('test1', T[0].password);
  ok(r.status === 401, 'test1\'s old password no longer works');
  r = await loginAs('test1', T2[0].password);
  ok(r.status === 200 && r.data.user.role === 'team', '… its new one does');
  r = await adm({ action: 'test_users_create' }, LIVEK);
  ok(r.status === 403 && r.data.code === 'live_mode' && userCus().length === 6, 'test_users_create with live keys → 403');
  r = await asUser(tA, { action: 'test_users_create' });
  ok(r.status === 403 && r.data.code === 'owner_only' && userCus().length === 6, 'test_users_create by a team member → 403 owner_only');
}

/* the activity log: what each action writes, and reading it */
{
  const step = () => tick(1);
  step(); r = await adm({ action: 'create_link', ...jBooking([guest(4, 'twin-ensuite')], 'full'), discount: { type: 'amount', value: 10000, scope: 'room', reason: 'Friend' } });
  let e = lastEntry('create_link');
  ok(r.status === 200 && e.s === `Booking link · BreathCamp 1 · 1 guest · ${eur2t(r.data.quote.total_cents)} · discount €100` && e.f === r.data.ref && e.p === J1 && e.u === 'owner', 'activity: create_link (week, guests, total, discount)');
  step(); r = await asUser(tA, { action: 'assign', ref: bRef, assign: { 0: RN.b2 } });
  e = lastEntry('assign');
  ok(r.status === 200 && e.s === `Rooms on ${bRef}: 2B` && e.u === anna.id && e.f === bRef && e.p === J1, 'activity: assign (short room names), by the team member');
  step(); r = await asUser(tA, { action: 'balance_link', ref: bRef });
  ok(r.status === 200 && lastEntry('balance_link').s === `Balance link for ${bRef} · ${eur2t(r.data.balance_cents)}`, 'activity: balance_link');
  step(); r = await asUser(tA, { action: 'cancel', ref: bRef });
  ok(r.status === 200 && lastEntry('cancel').s === `Cancelled ${bRef}`, 'activity: cancel');
  step(); r = await asUser(tA, { action: 'restore', ref: bRef });
  ok(r.status === 200 && lastEntry('restore').s === `Restored ${bRef}`, 'activity: restore');
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(5, 'twin-ensuite')], 'deposit', { addons: [{ id: S.kate, guest: 0 }] }), LIVE);
  const sRef = r.data.ref; complete(r.data.session_id);
  step(); r = await asUser(tA, { action: 'svc_status', ref: sRef, key: 'b0', status: 'scheduled', when: 'Tue 20 Jul, 15:00' });
  ok(r.status === 200 && /^Session ".+ \d+ min" on BC2707-[A-Z0-9]+ → scheduled$/.test(lastEntry('svc_status').s) && lastEntry('svc_status').f === sRef, `activity: svc_status (${lastEntry('svc_status').s})`);
  step(); r = await adm({ action: 'manual_create', from: '2027-07-14', to: '2027-07-15', total_cents: 9500, whatsapp: '+44 7700 900123', guests: [mg('Mia', 'Female', RN.a1, { email: 'mia@example.com' })] });
  const mB = r.data.booking;
  e = lastEntry('manual_create');
  ok(r.status === 200 && e.s === `Manual booking ${mB.ref} · 1 guest · 14–15 Jul 2027` && e.f === mB.ref && e.p === 'stay', 'activity: manual_create');
  step(); r = await asUser(tA, { action: 'offline_payment', ref: mB.ref, amount_cents: 9500, method: 'bank_transfer', comment: 'SEPA ref 4471 from mia@example.com, +44 7700 900123' });
  const inv = r.data.payment.invoice_id;
  ok(r.status === 200 && lastEntry('offline_payment').s === `€95.00 bank transfer recorded on ${mB.ref} · "SEPA ref 4471 from [email], [number]"` && lastEntry('offline_payment').u === anna.id && lastEntry('offline_payment').f === mB.ref && lastEntry('offline_payment').p === 'stay', 'activity: offline_payment (the comment without email or phone)');
  step(); r = await adm({ action: 'offline_payment', ref: mB.ref, amount_cents: 500, method: 'cash', comment: 'Tip jar '.repeat(30), force: true });
  ok(r.status === 200 && lastEntry('offline_payment').s === `€5.00 cash recorded on ${mB.ref} · "${'Tip jar '.repeat(30).trim().slice(0, 79)}…" · more than the balance`, 'activity: a long comment is cut to 80 characters; overpaid');
  step(); r = await adm({ action: 'offline_void', invoice_id: inv, reason: 'Recorded twice' });
  ok(r.status === 200 && lastEntry('offline_void').s === `Undid €95.00 payment on ${mB.ref} · "Recorded twice"` && lastEntry('offline_void').f === mB.ref, 'activity: offline_void');
  step(); r = await adm({ action: 'manual_update', ref: mB.ref, comment: 'Late check-in', total_cents: 12000 });
  ok(r.status === 200 && lastEntry('manual_update').s === `Edited manual booking ${mB.ref} (comment, price €120.00)` && lastEntry('manual_update').p === 'stay', 'activity: manual_update (which fields)');
  step(); r = await adm({ action: 'note', ref: mB.ref, note: 'Quiet room' });
  ok(r.status === 200 && lastEntry('note').s === `Note on ${mB.ref}` && lastEntry('note').p === 'stay', 'activity: a note on a manual booking');
  step(); r = await adm({ action: 'manual_cancel', ref: mB.ref });
  ok(r.status === 200 && lastEntry('manual_cancel').s === `Cancelled manual booking ${mB.ref}`, 'activity: manual_cancel');
  step(); r = await adm({ action: 'manual_restore', ref: mB.ref });
  ok(r.status === 200 && lastEntry('manual_restore').s === `Restored manual booking ${mB.ref}`, 'activity: manual_restore');
  step(); r = await adm({ action: 'block_create', rooms: [RN.c2], from: '2027-07-13', to: '2027-07-14', reason: 'maintenance' });
  const blk = r.data.block;
  ok(r.status === 200 && lastEntry('block_create').s === 'Blocked 2C · Temple Cottage · 13–14 Jul 2027 (1 night) · maintenance' && lastEntry('block_create').f === blk.id, 'activity: block_create');
  step(); r = await asUser(tA, { action: 'block_create', rooms: [RN.c2, RN.d2, RN.a2, RN.b1], from: '2027-07-13', to: '2027-07-15', reason: 'staff', force: true });
  ok(r.status === 200 && lastEntry('block_create').s === 'Blocked 2C · Temple Cottage, 2D · Temple Cottage + 2 more · 13–15 Jul 2027 (2 nights) · staff · saved over a clash', 'activity: a block of four rooms, saved over a clash');
  step(); r = await adm({ action: 'block_delete', id: blk.id });
  ok(r.status === 200 && lastEntry('block_delete').s === `Removed block ${blk.id}` && lastEntry('block_delete').f === blk.id, 'activity: block_delete');
  step(); r = await adm({ action: 'register_domains' });
  ok(lastEntry('register_domains').s === 'Registered the payment domains', 'activity: register_domains');
  step(); r = await adm({ action: 'repair_plans' });
  ok(lastEntry('repair_plans').s === 'Repaired payment plans', 'activity: repair_plans');
  step(); r = await adm({ action: 'clear_demo', program: J1 });
  ok(lastEntry('clear_demo').s === 'Removed demo bookings · BreathCamp 1' && lastEntry('clear_demo').p === J1, 'activity: clear_demo');
  const n1 = entries().length;
  r = await asUser(tA, { action: 'note', ref: 'BC2707-NOSUCH', note: 'x' });
  r = await adm({ action: 'block_create', rooms: ['Nowhere'], from: '2027-07-13', to: '2027-07-14' });
  r = await adm({ action: 'nonsense', ref: bRef });
  ok(entries().length === n1, 'activity: refused or failed actions (4xx) are not logged');
  // nothing personal, no passwords, within Stripe's limits
  const all = entries(), blob = JSON.stringify(logbooks().map(c => c.metadata));
  ok(all.length > 40 && all.every(x => x.raw.length <= 500 && Number.isInteger(x.t) && x.u && typeof x.n === 'string' && x.r && x.a && typeof x.s === 'string'), `every entry: compact JSON of ≤ 500 characters (${all.length} entries)`);
  ok(!blob.includes('@') && !/7700|900123|mia|Mia/.test(blob), 'no email address, phone number or guest name in the log');
  ok(secrets.every(p => !blob.includes(p)) && secrets.every(p => logs.every(l => !l.includes(p))), `no password in the log or the failure logs (${secrets.length} checked)`);
  ok(logbooks().every(c => c.name === 'AoB dashboard activity log' && c.description === '(do not delete)' && c.email === null && !c.metadata.aob_rec_any && Object.keys(c.metadata).length <= LOGBOOK_MAX + 1), 'logbooks: named, no email, never records, at most 48 entries');
  // reading it
  r = await ownerGet('activity=1');
  const A = r.data.entries;
  ok(r.status === 200 && JSON.stringify(r.data.me) === OWNER_ME && r.data.has_more === false && A.length === all.length, 'activity: every entry');
  ok(A.every((x, i) => i === 0 || A[i - 1].t >= x.t) && A[0].t === Math.max(...all.map(x => x.t)), 'activity: newest first');
  ok(A.every(x => Object.keys(x).sort().join() === 'action,actor,at,id,program,ref,summary,t' && Date.parse(x.at) === x.t && /^e[0-9a-z]+$/.test(x.id) && Object.keys(x.actor).sort().join() === 'id,name,role'), 'activity entry: { id, t, at, actor: { id, name, role }, action, ref, program, summary }');
  const top = A[0];
  ok(top.action === 'clear_demo' && top.actor.id === 'owner' && top.actor.name === 'Main admin' && top.actor.role === 'owner' && top.program === J1 && top.ref === null, 'activity: the newest entry read back');
  r = await ownerGet(`activity=1&user=${anna.id}`);
  ok(r.data.entries.length > 5 && r.data.entries.every(x => x.actor.id === anna.id) && r.data.entries.length === A.filter(x => x.actor.id === anna.id).length, 'activity: one person\'s entries (user=<actor id>)');
  r = await ownerGet('activity=1&user=-');
  ok(r.data.entries.length > 0 && r.data.entries.every(x => x.action === 'login_failed'), 'activity: user=- → the refused sign-ins');
}

/* the activity log: paging, the 1000 cap, fresh entries, rollover */
{
  // 25 more logbooks of 48 entries (as if written over months), all newer than what is there
  const base = fakeNow + 1000;
  for (let b = 0; b < 25; b++) {
    const md = { aob_logbook: '1' };
    for (let i = 0; i < 48; i++) { const t = base + (b * 48 + i) * 1000; md['e' + t.toString(36) + 'aa'] = JSON.stringify({ t, u: 'owner', n: 'Main admin', r: 'owner', a: 'note', f: 'BC2707-AAAAAA', p: J1, s: `Old note ${b * 48 + i}` }); }
    store.customers.push({ id: 'cus_logx' + pad(b), object: 'customer', name: 'AoB dashboard activity log', email: null, description: '(do not delete)', metadata: md, created: nowS() - 86400 * (40 - b) });
  }
  const total = entries().length;
  r = await ownerGet('activity=1&limit=5000');
  ok(r.status === 200 && r.data.entries.length === 1000 && r.data.has_more === true && r.data.entries[0].summary === 'Old note 1199', 'activity: at most 1000 entries at a time (has_more)');
  r = await ownerGet('activity=1');
  ok(r.data.entries.length === 200 && r.data.has_more === true, 'activity: 200 by default');
  r = await ownerGet('activity=1&limit=abc');
  ok(r.data.entries.length === 200, 'activity: a bad limit → 200');
  r = await ownerGet('activity=1&limit=3');
  const p1 = r.data.entries;
  ok(p1.length === 3 && r.data.has_more && p1.map(x => x.summary).join() === 'Old note 1199,Old note 1198,Old note 1197', 'activity: limit');
  r = await ownerGet(`activity=1&limit=3&before=${p1[2].t}`);
  ok(r.data.entries.map(x => x.summary).join() === 'Old note 1196,Old note 1195,Old note 1194', 'activity: before = the oldest t shown → the next older ones');
  // every page in turn: nothing lost, nothing twice (entries of one millisecond are never split)
  const seen = new Set(); let before = '', pages = 0, more = true;
  while (more && pages < 60) {
    r = await ownerGet(`activity=1&limit=37${before}`);
    r.data.entries.forEach(x => seen.add(x.id)); more = r.data.has_more; pages++;
    before = `&before=${r.data.entries[r.data.entries.length - 1].t}`;
  }
  ok(!more && seen.size === total, `activity: paging through all ${total} entries (${pages} pages) loses none`);
  r = await ownerGet(`activity=1&user=${anna.id}&limit=2`);
  ok(r.data.entries.length === 2 && r.data.has_more === true && r.data.entries.every(x => x.actor.id === anna.id), 'activity: one person, a page at a time');
  r = await ownerGet(`activity=1&before=${base}&user=owner&limit=1000`);
  ok(r.data.has_more === false && r.data.entries.every(x => x.actor.id === 'owner' && x.t < base) && r.data.entries.length === entries().filter(x => x.u === 'owner' && x.t < base).length, 'activity: user and before together; has_more false at the end');
  // what this isolate wrote a moment ago is there even while Stripe's search lags behind
  store.customers.forEach(c => { if (c.metadata && c.metadata.aob_logbook) c._lagging = true; });
  tick(11 * 60); // nothing in the real-time list of new customers either
  r = await adm({ action: 'note', ref: bRef, note: 'While search lags' });
  r = await ownerGet('activity=1&limit=1');
  ok(r.data.entries[0].summary === `Note on ${bRef}` && r.data.entries[0].t === fakeNow, 'activity: an entry written a moment ago shows at once (search lag)');
  store.customers.forEach(c => { c._lagging = false; });
}

/* rollover: a logbook holds 48 entries */
reset();
{
  const actor = { id: 'owner', name: 'Main admin', role: 'owner' };
  const k = await callsOf(() => logActivity(LIVE, actor, { action: 'note', ref: 'BC2707-AAAAAA', summary: 'First' }));
  ok(logbooks().length === 1 && k.calls.length === 3, `the first entry: one search, one real-time list, one new logbook (${k.calls.length} Stripe calls)`);
  const k2 = await callsOf(() => logActivity(LIVE, actor, { action: 'note', summary: 'Second' }));
  ok(k2.calls.length === 1 && k2.calls[0].method === 'POST' && /^\/customers\/cus_/.test(k2.calls[0].path), 'the next: one metadata update');
  for (let i = 2; i < 48; i++) { tick(1); await logActivity(LIVE, actor, { action: 'offline_payment', ref: 'MB2707-ABCDEF', summary: `"${'x\\'.repeat(400)}` }); }
  ok(logbooks().length === 1 && Object.keys(logbooks()[0].metadata).length === 49 && Object.values(logbooks()[0].metadata).every(v => v.length <= 500), 'a full logbook: aob_logbook + 48 entries, each ≤ 500 characters');
  tick(1);
  await logActivity(LIVE, actor, { action: 'note', summary: 'The 49th' });
  let lb = logbooks().sort((a, b) => (a.created - b.created) || (a.id < b.id ? -1 : 1));
  ok(lb.length === 2 && Object.keys(lb[0].metadata).length === 49 && Object.keys(lb[1].metadata).length === 2 && Object.values(lb[1].metadata).some(v => v.includes('The 49th')), 'the 49th entry starts a new logbook');
  // other isolates wrote to the current logbook as well: Stripe's 50-key limit → a new logbook
  const cur = lb[1];
  for (let i = 0; i < 48; i++) cur.metadata['eother' + i.toString(36).padStart(2, '0')] = JSON.stringify({ t: fakeNow - i, u: 'owner', n: 'Main admin', r: 'owner', a: 'note', s: 'Elsewhere' });
  tick(1);
  ok(await logActivity(LIVE, actor, { action: 'note', summary: 'After the others' }) === true, 'the entry is written…');
  lb = logbooks();
  ok(lb.length === 3 && Object.keys(cur.metadata).length === 50 && lb.some(c => c !== cur && Object.values(c.metadata).some(v => v.includes('After the others'))), '… in a new logbook when other isolates filled the current one (Stripe 400 on the 51st key)');
  // a fresh isolate finds the newest logbook with room
  forgetTeam(); tick(1);
  await logActivity(LIVE, actor, { action: 'note', summary: 'Cold isolate' });
  ok(logbooks().length === 3 && logbooks().some(c => Object.keys(c.metadata).length === 3 && Object.values(c.metadata).some(v => v.includes('Cold isolate'))), 'a fresh isolate adds to the newest logbook with room');
  // the longest entry
  const big = activityEntry({ id: 'cus_' + 'x'.repeat(60), name: '"\\'.repeat(40), role: 'team' }, { action: 'offline_payment', ref: 'MB2707-ABCDEF', program: 'stay', summary: '"\\😀'.repeat(400) }, fakeNow);
  const bo = JSON.parse(big);
  ok(big.length <= 500 && bo.s.endsWith('…') && bo.s.length > 100 && bo.u.length <= 40 && bo.n.length <= 60 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(bo.s), 'the longest entry is cut to 500 characters (the summary, with …; never half an emoji), still JSON');
  ok(logbooks().every(c => Object.keys(c.metadata).length <= 50 && Object.keys(c.metadata).every(x => x.length <= 40) && Object.values(c.metadata).every(v => String(v).length <= 500)), 'every logbook within Stripe\'s metadata limits');
  // the fullest user
  r = await adm({ action: 'user_create', username: 'u'.repeat(32), name: '😀'.repeat(30), role: 'viewer', password: 'p'.repeat(100) });
  const fu = r.data.user;
  ok(r.status === 200 && fu.name.length === 60, 'the longest username and name, a 100-character password');
  r = await adm({ action: 'test_users_create' });
  r = await loginAs('u'.repeat(32), 'p'.repeat(100));
  ok(r.status === 200, '… signs in');
  r = await adm({ action: 'user_update', id: fu.id, role: 'team', status: 'disabled', reset_password: true, name: 'N'.repeat(60) });
  ok(r.status === 200 && lastEntry('user_update').s === `Updated ${'u'.repeat(32)}: renamed to "${'N'.repeat(60)}", role team, disabled, password reset`, 'every change at once: one entry');
  ok(userCus().every(c => Object.keys(c.metadata).length <= 12 && Object.keys(c.metadata).every(x => x.length <= 40) && Object.values(c.metadata).every(v => String(v).length <= 500) && c.name.length <= 256), 'users stay far within Stripe\'s metadata limits');
}

/* the log never fails or holds up an action */
reset();
{
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(1, 'twin-ensuite')]), LIVE);
  const ref = r.data.ref; complete(r.data.session_id);
  r = await adm({ action: 'note', ref, note: 'one' });
  const n0 = entries().length, l0 = logs.length;
  ok(r.status === 200 && n0 === 1, 'a logbook exists');
  fault('POST', /^\/customers\/cus_/, { status: 500, times: 3 });
  r = await adm({ action: 'note', ref, note: 'two' });
  ok(r.status === 200 && r.data.note === 'two' && [...store.pis.values()].find(p => p.metadata.aob_ref === ref).metadata.aob_note === 'two' && entries().length === n0, 'the log write failing never fails the action (the entry is lost)');
  ok(logs.slice(l0).some(l => l.includes('"route":"activity.log"') && l.includes('"status":500')) && logs.slice(l0).every(l => !l.includes('@') && !l.includes('Note on')), 'the failure is in the error log, without personal data');
  r = await ownerGet('activity=1');
  ok(r.data.entries.length === n0, '… and is not shown as written');
  // without waitUntil (another runtime): written before answering
  let res = await admin.onRequestPost({ request: req('POST', '/api/booking/admin', { action: 'note', ref, note: 'three' }, AUTH), env: LIVE });
  ok(res.status === 200 && entries().length === n0 + 1, 'without waitUntil: the entry is written before the answer');
  fault('POST', /^\/customers\/cus_/, { status: 500, times: 3 });
  res = await admin.onRequestPost({ request: req('POST', '/api/booking/admin', { action: 'note', ref, note: 'four' }, AUTH), env: LIVE });
  ok(res.status === 200 && (await res.json()).note === 'four' && entries().length === n0 + 1, '… and a failing write still doesn\'t fail the action');
  // a sign-in whose log write fails still signs in
  r = await adm({ action: 'user_create', username: 'erin', name: 'Erin', role: 'team', password: 'erin-pass' }); secrets.push('erin-pass');
  fault('POST', /^\/customers\/cus_/, { status: 500, times: 6 });
  r = await loginAs('erin', 'erin-pass');
  ok(r.status === 200 && r.data.token, 'login: a failing log (or last sign-in) write never fails the sign-in');
  store.faults.length = 0;
  // a flood of refused sign-ins is logged at most 30 times per 10 minutes per isolate
  const f0 = entries().filter(x => x.a === 'login_failed').length;
  forgetRateLimits();
  for (let i = 0; i < 40; i++) await loginRaw({ username: `flood${i}`, password: `pw-flood-${i}` }, ip(150 + i));
  ok(entries().filter(x => x.a === 'login_failed').length - f0 === 30, 'refused sign-ins: at most 30 log entries per 10 minutes per isolate');
  tick(11 * 60);
}

/* ================================================================== round 6: Uplisting → booking system */
const UPL = { ...LIVE, UPLISTING_API_KEY: UPK, UPLISTING_WEBHOOK_SECRET: 'wh-secret-0123456789abcdef' };
const UP = { b1: '251801', a2: '251802', cottage: '251810', gt: '251820', camper: '251830', solo: '268715' };
const HOST = 'website-5h3.pages.dev', PEACE_1C = '1C · Peace Cottage';
const MAP = { [UP.b1]: [RN.b1], [UP.a2]: [RN.a2], [UP.cottage]: [RN.a1, RN.b1, PEACE_1C], [`${UP.gt}_9001`]: [RN.gt(1)], [`${UP.gt}_9002`]: [RN.gt(2)], [UP.solo]: [RN.ark('A')] };
// (a JSON object lists integer-like keys first whatever order they were written in: compare by content)
const sameMap = (a, b) => { const j = o => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]])); return j(a) === j(b); };
const upProp = (id, name, nickname, units = []) => ({ id: String(id), type: 'properties', attributes: { name, nickname, currency: 'EUR', time_zone: 'Europe/Rome', maximum_capacity: 2, bedrooms: 1 },
  relationships: { multi_units: { data: units.map(x => ({ id: String(x), type: 'multi_units' })) }, address: { data: { id: '1', type: 'addresses' } } } });
function upFixtures() {
  // not in id order on purpose; two listings share their public name (only the nickname tells them apart)
  up.props = [upProp(UP.solo, 'Solo Retreat Room • Pool', '5A Ark'), upProp(UP.a2, 'Twin Retreat Ensuite • Pool • Tuscan Valley Views', '2A Temple'),
    upProp(UP.b1, 'Twin Retreat Ensuite • Pool • Tuscan Valley Views', '1B Peace'), upProp(UP.cottage, 'Private Cottage For 6 • Pool', 'Peace Cottage (whole)'),
    upProp(UP.gt, 'Glamping Twin • Pool', 'Glamping twins', [9002, 9001, 9003]), upProp(UP.camper, 'Campervan Spot 1', 'Camper 1')];
  up.included = [{ id: '9001', type: 'multi_units', attributes: { name: 'GT 1' } }, { id: '9002', type: 'multi_units', attributes: { nickname: 'GT two' } },
    { id: '9003', type: 'multi_units', attributes: {} }, { id: '1', type: 'addresses', attributes: { city: 'Volterra' } }];
  for (const p of up.props) up.bookings.set(p.id, []);
}
let ubSeq = 700000;
const ub = (pid, check_in, check_out, extra = {}) => ({
  id: ++ubSeq, property_id: +pid, property_name: ((up.props.find(p => p.id === String(pid)) || {}).attributes || {}).name || 'Listing', check_in, check_out,
  number_of_nights: nightsBetween(check_in, check_out), arrival_time: '15:00:00', departure_time: '11:00:00', guest_name: 'Jon Snow', preferred_guest_name: 'King of the North',
  guest_email: 'jon.snow@castleblack.example', guest_phone: '+44797978889991', lock_code: '4321', note: 'Bringing the dragon', status: 'confirmed', channel: 'airbnb_official',
  external_reservation_id: 'HMXQ7ZZ9', number_of_guests: 2, multi_unit_id: null, multi_unit_name: null, currency: 'EUR', total_payout: 388.5, booked_at: '2026-06-30T10:00:00Z', ...extra,
});
const addUb = (...a) => { const b = ub(...a); up.bookings.get(String(b.property_id)).push(b); return b; };
const dropUb = b => { const l = up.bookings.get(String(b.property_id)); l.splice(l.indexOf(b), 1); };
const upAdm = (body, env = UPL) => call(admin, 'POST', '/api/booking/admin', body, env, AUTH);
const upGet = (q = '', env = UPL) => call(admin, 'GET', '/api/booking/admin?uplisting=1' + q, null, env, AUTH);
const upRecs = () => store.customers.filter(c => !c.deleted && c.metadata && c.metadata.aob_ext === 'uplisting');
const upRecOf = id => upRecs().filter(c => c.metadata.aob_ext_id === String(id));
const settingsCus = () => store.customers.filter(c => !c.deleted && c.metadata && c.metadata.aob_settings === 'uplisting');
const hookReq = (payload, { key = UPL.UPLISTING_WEBHOOK_SECRET, event = 'booking_updated', raw } = {}) => {
  const q = new URLSearchParams();
  if (key != null) q.set('key', key);
  if (event) q.set('event', event);
  return new Request(`https://${HOST}/api/booking/uplisting?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Uplisting' }, body: raw != null ? raw : JSON.stringify(payload) });
};
async function upHook(payload, opts = {}) {
  const res = await uplistingApi.onRequestPost({ request: hookReq(payload, opts), env: opts.env || UPL, waitUntil: p => store.waits.push(p) });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  const done = await Promise.all(store.waits.splice(0));
  return { status: res.status, data, result: done[0] === undefined ? null : done[0] };
}
const kCalls = async fn => { const s0 = store.calls.length, u0 = up.calls.length; const res = await fn(); const s = store.calls.length - s0, u = up.calls.length - u0; return { res, stripe: s, upl: u, total: s + u }; };
/* a sync to the end: each call's subrequests (Stripe + Uplisting, the activity log included), waiting when asked */
async function syncAll(env = UPL, { cursor = null, headers = AUTH, max = 120 } = {}) {
  const slices = []; let r;
  for (let i = 0; i < max; i++) {
    const k = await kCalls(() => call(admin, 'POST', '/api/booking/admin', { action: 'uplisting_sync', ...(cursor ? { cursor } : {}) }, env, headers));
    r = k.res; slices.push({ status: r.status, total: k.total, data: r.data });
    if (r.status !== 200 || r.data.done) break;
    cursor = r.data.cursor;
    if (r.data.paused) tick(r.data.retry_after + 1);
  }
  return { r, slices, max: Math.max(...slices.map(x => x.total)) };
}

/* off: health, the panel, the actions, the webhook */
reset();
{
  r = await call(health, 'GET', '/api/booking/health', null, LIVE);
  ok(r.data.uplisting === 'off', 'health: uplisting off without UPLISTING_API_KEY');
  r = await call(health, 'GET', '/api/booking/health', null, { ...LIVE, UPLISTING_API_KEY: UPK });
  ok(r.data.uplisting === 'no_webhook_secret', 'health: a key but no webhook secret');
  r = await call(health, 'GET', '/api/booking/health', null, { ...UPL, UPLISTING_WEBHOOK_SECRET: 'fifteen-chars-x' });
  ok(r.data.uplisting === 'no_webhook_secret', 'health: a webhook secret under 16 characters counts as none');
  r = await call(health, 'GET', '/api/booking/health', null, UPL);
  ok(r.data.uplisting === 'on' && !JSON.stringify(r.data).includes(UPK) && !JSON.stringify(r.data).includes(UPL.UPLISTING_WEBHOOK_SECRET), 'health: on (never the values)');
  let k = await kCalls(() => upGet('', LIVE));
  r = k.res;
  ok(r.status === 200 && r.data.uplisting === true && r.data.status === 'off' && r.data.configured.api_key === false && r.data.configured.webhook_secret === false && r.data.account === null && r.data.properties.length === 0
    && r.data.hooks === null && r.data.last_sync === null && JSON.stringify(r.data.mapping) === '{}' && r.data.imported.active === 0 && r.data.imported.upcoming === 0 && !r.data.error && k.upl === 0 && JSON.stringify(r.data.me) === OWNER_ME,
  'panel off: configured false, no Uplisting call');
  ok(r.data.rooms.length === 31 && r.data.rooms[0] === RN.a1 && r.data.room_groups.length === 8 && r.data.room_groups[0].area === 'Peace Cottage' && r.data.room_groups[0].rooms.length === 3
    && r.data.webhook_url_hint === `https://${HOST}/api/booking/uplisting` && r.data.max_keys === 47 && r.data.hooks_other_hosts.length === 0, 'panel: calendar rooms (grouped by area), the webhook URL without its key');
  r = await upGet('', ADMIN_ONLY);
  ok(r.status === 200 && r.data.status === 'off' && JSON.stringify(r.data.mapping) === '{}' && r.data.rooms.length === 31, 'panel in demo mode (no Stripe)');
  for (const action of ['uplisting_map', 'uplisting_hooks', 'uplisting_sync']) {
    r = await upAdm({ action, mapping: {} }, LIVE);
    ok(r.status === 503 && r.data.code === 'uplisting_off', `${action} without UPLISTING_API_KEY → 503 uplisting_off`);
  }
  for (const [env, msg] of [[LIVE, 'no key'], [{ ...LIVE, UPLISTING_API_KEY: UPK }, 'no webhook secret'], [{ ...UPL, STRIPE_SECRET_KEY: '' }, 'no Stripe']]) {
    k = await kCalls(() => upHook({ id: 1, property_id: 2 }, { env }));
    ok(k.res.status === 503 && k.res.data.error && k.total === 0 && k.res.result === null, `webhook off (${msg}) → 503, nothing read`);
  }
  ok(REC_REASONS.includes('uplisting') && !BLOCK_REASONS.includes('uplisting'), 'reason uplisting: a record reason, not one the team can choose');
  r = await adm({ action: 'block_create', rooms: [RN.cv(3)], from: '2027-09-02', to: '2027-09-03', reason: 'uplisting' });
  ok(r.status === 422 && /maintenance/.test(r.data.fields.reason) && !/uplisting/.test(r.data.fields.reason), 'block_create: the reason uplisting is refused');
  ok(channelLabel('airbnb_official') === 'Airbnb' && channelLabel('booking_dot_com') === 'Booking.com' && channelLabel('home_away') === 'Vrbo' && channelLabel('google') === 'Google'
    && channelLabel('uplisting') === 'Direct (Uplisting)' && channelLabel('expedia') === 'expedia', 'channel labels (others as they are)');
  ok(guestShort('Jon Snow') === 'Jon S.' && guestShort('Stefan') === 'Stefan' && guestShort('mary jane watson') === 'mary W.' && guestShort('  ') === '' && guestShort('Ana 2') === 'Ana', 'guests in summaries: first name + last initial');
  ok(authHeader('abc') === 'Basic YWJj', 'Authorization: Basic + base64 of the key');
}

/* the panel with a key: account, listings (JSON:API, multi-units), webhooks; 5-minute copy; errors */
reset(); upFixtures();
let tT, tV;
{
  let k = await kCalls(() => upGet());
  r = k.res;
  ok(r.status === 200 && r.data.status === 'on' && r.data.configured.api_key && r.data.configured.webhook_secret && JSON.stringify(r.data.account) === '{"name":"ASHA Tuscany"}' && !r.data.error && k.upl === 3,
    'panel: the account name (only), 3 Uplisting calls');
  ok(r.data.properties.map(p => p.id).join() === '251801,251802,251810,251820,251830,268715', 'listings by id');
  const pB1 = r.data.properties.find(p => p.id === UP.b1), pA2 = r.data.properties.find(p => p.id === UP.a2), pGt = r.data.properties.find(p => p.id === UP.gt);
  ok(pB1.name === pA2.name && pB1.nickname === '1B Peace' && pA2.nickname === '2A Temple' && pB1.units.length === 0 && Object.keys(pB1).join() === 'id,name,nickname,units', 'listings: name and nickname (two with the same name)');
  ok(pGt.units.map(u => `${u.id}:${u.name}`).join('|') === '9002:GT two|9001:GT 1|9003:Unit 9003', 'multi-units: name, else nickname, else "Unit <id>"');
  ok(JSON.stringify(r.data.hooks) === JSON.stringify({ booking_created: false, booking_updated: false, booking_removed: false }), 'webhooks: none yet');
  ok(up.calls.length === 3 && up.calls.every(c => c.auth === 'Basic ' + Buffer.from(UPK).toString('base64') && c.ct === 'application/json'), 'every Uplisting call: Authorization Basic base64(key), Content-Type application/json');
  const doc = { data: { id: '11033', type: 'properties', attributes: { name: 'Chic apt', nickname: 'BDC' } }, included: [{ id: '68', type: 'multi_units', attributes: { name: '5G' }, relationships: { property: { data: { id: '11033', type: 'properties' } } } }] };
  ok(JSON.stringify(parseProperties(doc)) === JSON.stringify([{ id: '11033', name: 'Chic apt', nickname: 'BDC', units: [{ id: '68', name: '5G' }] }]) && parseProperties(null).length === 0 && parseProperties({ data: [{ id: 'bad id' }] }).length === 0,
    'parseProperties: one property, units found from the included side, junk ignored');
  k = await kCalls(() => upGet());
  ok(k.res.status === 200 && k.upl === 0 && k.res.data.properties.length === 6 && k.res.data.account.name === 'ASHA Tuscany', 'within 5 minutes: the isolate\'s copy (no Uplisting call)');
  k = await kCalls(() => upGet('&refresh=1'));
  ok(k.upl === 3, 'refresh=1: read again');
  tick(5 * 60 + 1);
  k = await kCalls(() => upGet());
  ok(k.upl === 3, 'after 5 minutes: read again');
  // every role reads it
  await adm({ action: 'user_create', username: 'tina', name: 'Tina', role: 'team', password: 'tina-pass' });
  await adm({ action: 'user_create', username: 'vic', name: 'Vic', role: 'viewer', password: 'vic-pass' });
  secrets.push('tina-pass', 'vic-pass');
  tT = (await loginAs('tina', 'tina-pass')).data.token; tV = (await loginAs('vic', 'vic-pass')).data.token;
  r = await getAs(tT, 'uplisting=1', UPL);
  ok(r.status === 200 && r.data.me.role === 'team' && r.data.properties.length === 6, 'a team member reads the panel');
  r = await getAs(tV, 'uplisting=1', UPL);
  ok(r.status === 200 && r.data.me.role === 'viewer' && r.data.properties.length === 6, 'a viewer reads the panel');
  r = await call(admin, 'GET', '/api/booking/admin?uplisting=1', null, UPL);
  ok(r.status === 401, 'the panel needs a sign-in');
  // errors: still 200 with the text
  k = await kCalls(() => upGet('&refresh=1', { ...UPL, UPLISTING_API_KEY: 'wrong-key' }));
  ok(k.res.status === 200 && /refused the API key/.test(k.res.data.error) && k.res.data.account === null && k.res.data.properties.length === 0 && k.res.data.hooks === null && k.res.data.configured.api_key, 'a wrong API key: 200 with the error');
  upFault(/^\/properties/, { status: 503 });
  k = await kCalls(() => upGet('&refresh=1'));
  ok(k.res.status === 200 && /could not be reached/.test(k.res.data.error) && k.res.data.properties.length === 0 && k.res.data.account.name === 'ASHA Tuscany' && k.res.data.hooks, 'Uplisting failing one call: the rest shown, with the error');
  fault('GET', /^\/customers\/search$/, { status: 500, times: 6 }); // both searches (settings, records) fail
  r = await upGet();
  ok(r.status === 502 && /Stripe/.test(r.data.error), 'Stripe unreadable → 502 (a mapping that can\'t be read never looks empty)');
}

/* the mapping */
{
  r = await upAdm({ action: 'uplisting_map', mapping: MAP });
  let sc = settingsCus();
  const snap = JSON.stringify(sc[0] && sc[0].metadata);
  ok(r.status === 200 && r.data.ok && sameMap(r.data.mapping, MAP) && r.data.mapping[UP.cottage].join('|') === [RN.a1, RN.b1, PEACE_1C].join('|'), 'uplisting_map: saved');
  ok(sc.length === 1 && sc[0].name === 'AoB booking settings · Uplisting (do not delete)' && sc[0].email === null && sc[0].metadata.aob_settings === 'uplisting' && sc[0].metadata.m251801 === RN.b1
    && sc[0].metadata.m251820_9001 === RN.gt(1) && sc[0].metadata.m251810 === [RN.a1, RN.b1, PEACE_1C].join('|') && !sc[0].metadata.aob_rec_any && Object.keys(sc[0].metadata).length === 7, 'the settings customer: no email, never a record, m<listing>[_<unit>] = rooms');
  ok(lastEntry('uplisting_map').s === 'Uplisting mapping: 6 listings mapped' && lastEntry('uplisting_map').u === 'owner', 'activity: uplisting_map');
  r = await upGet();
  ok(sameMap(r.data.mapping, MAP), 'the panel shows the mapping');
  for (const [mapping, f, re, msg] of [
    [{ 999999: [RN.a2] }, 'mapping.999999', /not in Uplisting/, 'a listing Uplisting doesn\'t have'],
    [{ '251820_9999': [RN.a2] }, 'mapping.251820_9999', /unit is not part/, 'a unit the listing doesn\'t have'],
    [{ '251801_9001': [RN.a2] }, 'mapping.251801_9001', /unit is not part/, 'a unit of another listing'],
    [{ 'abc def': [RN.a2] }, 'mapping.abc def', /Unknown listing/, 'not a listing id'],
    [{ [UP.b1]: ['Nowhere 9'] }, 'mapping.251801', /Unknown room: Nowhere 9/, 'an unknown room'],
    [{ [UP.b1]: RN.b1 }, 'mapping.251801', /Choose rooms/, 'a room name instead of a list'],
    [{ [UP.b1]: calendarRooms().rooms.map(x => x.name) }, 'mapping.251801', /Too many rooms/, 'all 31 rooms (over 500 characters)'],
  ]) {
    r = await upAdm({ action: 'uplisting_map', mapping });
    ok(r.status === 422 && re.test(r.data.fields[f] || ''), `uplisting_map refused: ${msg}`);
  }
  r = await upAdm({ action: 'uplisting_map', mapping: [RN.a2] });
  ok(r.status === 422 && r.data.fields.mapping, 'uplisting_map refused: not an object');
  ok(JSON.stringify(settingsCus()[0].metadata) === snap && settingsCus().length === 1, 'nothing saved for refused mappings');
  // 47 keys at most (+ aob_settings, aob_last_sync, aob_last_sync_result = Stripe's 50)
  const extra = Array.from({ length: 48 }, (_, i) => String(300000 + i));
  up.props.push(...extra.map(id => upProp(id, 'Extra ' + id, '')));
  await upGet('&refresh=1');
  r = await upAdm({ action: 'uplisting_map', mapping: Object.fromEntries(extra.map(id => [id, [RN.cv(1)]])) });
  ok(r.status === 422 && r.data.fields.mapping === 'At most 47 listings and units can be mapped.' && MAP_MAX_KEYS === 47, 'uplisting_map refused: 48 keys');
  r = await upAdm({ action: 'uplisting_map', mapping: Object.fromEntries(extra.slice(0, 47).map(id => [id, [RN.cv(1)]])) });
  sc = settingsCus();
  ok(r.status === 200 && Object.keys(sc[0].metadata).length === 48 && !sc[0].metadata.m251801, '47 keys fit; the keys that went are removed (the mapping is replaced)');
  // a sync over 47 listings (unknown to the bookings endpoint: errors) adds aob_last_sync + result: exactly Stripe's 50 keys
  tick(61);
  let s = await syncAll();
  ok(s.r.status === 200 && s.r.data.done && s.r.data.stats.errors === 47 && Object.keys(settingsCus()[0].metadata).length === 50 && s.max <= 45, `47 listings: done in ${s.slices.length} calls, the settings at 50 keys`);
  up.props = up.props.filter(p => !extra.includes(p.id));
  await upGet('&refresh=1');
  r = await upAdm({ action: 'uplisting_map', mapping: { ...MAP, [UP.solo]: [] } });
  ok(r.status === 200 && !r.data.mapping[UP.solo] && Object.keys(settingsCus()[0].metadata).filter(x => /^m\d/.test(x)).length === 5, 'an empty list removes a listing');
  r = await upAdm({ action: 'uplisting_map', mapping: MAP });
  // two settings customers (made by two isolates at once): merged, the newest wins per key; a save clears the older one
  store.customers.push({ id: 'cus_setold01', object: 'customer', name: 'AoB booking settings · Uplisting (do not delete)', email: null, description: null,
    metadata: { aob_settings: 'uplisting', m251830: RN.cv(1), m251801: RN.d2 }, created: nowS() - 86400 });
  forgetUplisting();
  r = await upGet();
  ok(r.data.mapping[UP.camper].join() === RN.cv(1) && r.data.mapping[UP.b1].join() === RN.b1, 'several settings customers: merged, the newest wins per key');
  r = await upAdm({ action: 'uplisting_map', mapping: MAP });
  const old = cusOf('cus_setold01');
  ok(r.status === 200 && !old.metadata.m251830 && !old.metadata.m251801 && old.metadata.aob_settings === 'uplisting', 'a save clears the older one\'s mapping (a removed listing can\'t come back)');
  r = await upGet();
  ok(!r.data.mapping[UP.camper] && sameMap(r.data.mapping, MAP), '… the panel shows exactly what was saved');
  ok(mergeSettings([{ id: 'cus_a', created: 1, metadata: { aob_settings: 'uplisting', m1: 'A', aob_last_sync_result: '{bad' , aob_last_sync: 'x' } }]).last_sync.result === null, 'an unreadable last result reads as null');
  // permissions
  r = await asUser(tT, { action: 'uplisting_map', mapping: MAP }, UPL);
  ok(r.status === 403 && r.data.code === 'owner_only', 'uplisting_map by a team member → 403 owner_only');
  r = await asUser(tT, { action: 'uplisting_hooks' }, UPL);
  ok(r.status === 403 && r.data.code === 'owner_only', 'uplisting_hooks by a team member → 403 owner_only');
  for (const action of ['uplisting_map', 'uplisting_hooks', 'uplisting_sync']) {
    r = await asUser(tV, { action, mapping: MAP }, UPL);
    ok(r.status === 403 && r.data.code === 'read_only', `${action} by a viewer → 403 read_only`);
  }
  // Uplisting down while saving: not saved
  forgetUplisting();
  upFault(/^\/properties/, { status: 500 });
  r = await upAdm({ action: 'uplisting_map', mapping: { [UP.b1]: [RN.c2] } });
  ok(r.status === 503 && r.data.code === 'uplisting_busy' && /not saved/.test(r.data.error) && settingsCus().some(c => c.metadata.m251801 === RN.b1), 'Uplisting unreachable: the mapping is not saved (503)');
  await upGet();
  up.props.push(upProp('270001', 'Glamping Single • New', 'GS new')); up.bookings.set('270001', []);
  const k = await kCalls(() => upAdm({ action: 'uplisting_map', mapping: { ...MAP, 270001: [RN.gs(4)] } }));
  ok(k.res.status === 200 && k.res.data.mapping['270001'].join() === RN.gs(4) && k.upl === 1, 'a listing added in Uplisting since the 5-minute copy: the listings are read again once, then saved');
  r = await upAdm({ action: 'uplisting_map', mapping: MAP });
}

/* webhooks: register, again, rotate the secret */
{
  const want = (ev, secret = UPL.UPLISTING_WEBHOOK_SECRET) => `https://${HOST}/api/booking/uplisting?key=${encodeURIComponent(secret)}&event=${ev}`;
  let k = await kCalls(() => upAdm({ action: 'uplisting_hooks' }));
  r = k.res;
  ok(r.status === 200 && r.data.ok && r.data.created === 3 && r.data.removed === 0 && Object.values(r.data.hooks).every(Boolean) && up.hooks.map(h => h.event).join() === 'booking_created,booking_updated,booking_removed'
    && up.hooks.every(h => h.target_url === want(h.event)), 'uplisting_hooks: the three booking events, each to this host with the key and the event');
  ok(up.calls.filter(c => c.method === 'POST').every(c => JSON.parse(c.body).target_url && Object.keys(JSON.parse(c.body)).sort().join() === 'event,target_url'), 'POST /hooks { target_url, event }');
  ok(!JSON.stringify(r.data).includes(UPL.UPLISTING_WEBHOOK_SECRET) && lastEntry('uplisting_hooks').s === 'Uplisting webhooks: 3 of 3 connected (3 added, 0 removed)'
    && !JSON.stringify(entries()).includes(UPL.UPLISTING_WEBHOOK_SECRET), 'activity: uplisting_hooks; the key never in the answer or the log');
  r = await upGet();
  ok(Object.values(r.data.hooks).every(Boolean) && !JSON.stringify(r.data).includes(UPL.UPLISTING_WEBHOOK_SECRET), 'panel: connected, without the key');
  r = await upAdm({ action: 'uplisting_hooks' });
  ok(r.data.created === 0 && r.data.removed === 0 && up.hooks.length === 3, 'again: nothing to do');
  // another app's hook and ours on the custom domain stay; a duplicate of ours goes
  up.hooks.push({ id: 1, target_url: 'https://hooks.zapier.com/hooks/catch/1/x/', event: 'booking_created' }, { id: 2, target_url: 'https://alchemyofbreath.com/api/booking/uplisting?key=old&event=booking_created', event: 'booking_created' },
    { id: 3, target_url: want('booking_updated'), event: 'booking_updated' });
  const ROT = { ...UPL, UPLISTING_WEBHOOK_SECRET: 'rotated-secret-ABCDEFGHIJ' };
  r = await upGet('&refresh=1', ROT);
  ok(r.data.hooks && !Object.values(r.data.hooks).some(Boolean) && r.data.hooks_other_hosts.join() === 'alchemyofbreath.com', 'a new secret: the old hooks don\'t count; another host of ours is listed');
  r = await upAdm({ action: 'uplisting_hooks' }, ROT);
  ok(r.status === 200 && r.data.removed === 4 && r.data.created === 3 && up.hooks.length === 5 && up.hooks.some(h => h.id === 1) && up.hooks.some(h => h.id === 2)
    && up.hooks.filter(h => h.target_url.startsWith(`https://${HOST}/`)).every(h => h.target_url === want(h.event, ROT.UPLISTING_WEBHOOK_SECRET)), 'rotated secret: our 4 old hooks (one a duplicate) removed, 3 new; other hosts and apps untouched');
  r = await upHook({ id: 1, property_id: UP.b1 }, { env: ROT });
  ok(r.status === 401, 'the old key is refused once the secret changed');
  r = await upAdm({ action: 'uplisting_hooks' }, { ...UPL, UPLISTING_WEBHOOK_SECRET: '' });
  ok(r.status === 409 && r.data.code === 'no_webhook_secret', 'uplisting_hooks without a secret → 409');
  upFault(/^\/hooks$/, { method: 'POST', status: 429, retryAfter: 20 });
  r = await upAdm({ action: 'uplisting_hooks' });
  ok(r.status === 503 && r.data.code === 'uplisting_busy' && r.data.retry_after === 20 && r.data.removed === 3, 'Uplisting rate-limits the registration → 503 with retry_after');
  r = await upAdm({ action: 'uplisting_hooks' });
  ok(r.status === 200 && r.data.created === 3 && up.hooks.filter(h => h.target_url.startsWith(`https://${HOST}/`)).length === 3, '… again: done');
}

/* the webhook: key, unmapped, created from the API's copy, duplicates, changes, cancellations */
{
  let k = await kCalls(() => upHook({ id: 1, property_id: UP.b1 }, { key: null }));
  ok(k.res.status === 401 && k.res.data.error === 'Not authorised.' && k.total === 0 && k.res.result === null, 'webhook: no key → 401, nothing read');
  for (const key of ['wrong', UPL.UPLISTING_WEBHOOK_SECRET + 'x', UPL.UPLISTING_WEBHOOK_SECRET.slice(0, -1), '']) {
    k = await kCalls(() => upHook({ id: 1, property_id: UP.b1 }, { key }));
    ok(k.res.status === 401 && k.total === 0, `webhook: a wrong key (${key.length} characters) → 401`);
  }
  const bc = addUb(UP.camper, '2027-07-19', '2027-07-21');
  k = await kCalls(() => upHook(bc, { event: 'booking_created' }));
  ok(k.res.status === 200 && JSON.stringify(k.res.data) === '{"ok":true}' && k.res.result.action === 'ignored' && k.res.result.reason === 'unmapped' && k.upl === 0 && upRecOf(bc.id).length === 0, 'an unmapped listing: 200, ignored (no Uplisting call, nothing stored)');
  // a new booking, a cold isolate: everything counted
  const b1 = addUb(UP.b1, '2027-07-19', '2027-07-22');
  forgetTeam(); forgetUplisting(); forgetWrites();
  k = await kCalls(() => upHook({ ...b1, check_out: '2027-07-20', multi_unit_id: 9001, property_name: 'Fake', guest_name: 'Someone Else', number_of_guests: 7 }, { event: 'booking_created' }));
  const c1 = upRecOf(b1.id)[0], m1 = c1 && c1.metadata;
  ok(k.res.status === 200 && k.res.result.action === 'created' && upRecOf(b1.id).length === 1, 'booking_created: a record');
  ok(m1.aob_rec === 'block' && m1.aob_rec_any === '1' && m1.aob_id === `UP-${b1.id}` && m1.aob_from === '2027-07-19' && m1.aob_to === '2027-07-22' && m1.aob_rooms === RN.b1 && m1.aob_reason === 'uplisting' && m1.aob_status === 'active'
    && m1.aob_ext === 'uplisting' && m1.aob_ext_id === String(b1.id) && m1.aob_ext_prop === UP.b1 && !('aob_ext_unit' in m1) && m1.aob_ext_pname === b1.property_name && m1.aob_ext_channel === 'airbnb_official'
    && m1.aob_ext_guest === 'Jon Snow' && m1.aob_ext_n === '2' && m1.aob_ext_ustatus === 'confirmed' && !m1.aob_ext_sync && !m1.aob_created_at, 'the record: the API\'s dates, listing, guest and count (the payload\'s ignored)');
  ok(c1.email === null && c1.name === `Uplisting · Jon Snow · ${b1.property_name}` && c1.description === 'Imported from Uplisting (managed by sync)', 'its customer: name and description, no email');
  ok(k.total <= 10, `webhook: ${k.total} subrequests on a cold isolate (Stripe ${k.stripe}, Uplisting ${k.upl}), under ~10`);
  const q1 = up.calls.filter(c => c.path === `/bookings/${UP.b1}`).pop();
  ok(q1 && /from=2027-07-18/.test(q1.search) && /to=2027-07-21/.test(q1.search) && /per_page=50/.test(q1.search) && /page=0/.test(q1.search), 'read back by the payload\'s dates, a day either side');
  ok(store.calls.some(c => c.method === 'POST' && c.path === '/customers' && new RegExp(`^uplisting-${b1.id}-2027-07-19-2027-07-22-[0-9a-z]+$`).test(c.key || '')), 'Idempotency-Key uplisting-<id>-<check-in>-<check-out>-<rooms hash>');
  const eB = lastEntry('uplisting_booking');
  ok(eB && eB.s === 'Airbnb booking · 1B · Peace Cottage · 19–22 Jul 2027 (3 nights) · Jon S. · 2 guests' && eB.u === 'uplisting' && eB.n === 'Uplisting' && eB.r === 'system' && eB.f === `UP-${b1.id}` && eB.p === J1,
    'activity: uplisting_booking by the Uplisting system actor');
  r = await ownerGet('activity=1&user=uplisting', UPL);
  ok(r.data.entries.length === 1 && r.data.entries[0].actor.role === 'system' && r.data.entries[0].actor.name === 'Uplisting', 'activity: user=uplisting');
  // seen everywhere a block is
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, UPL, AUTH);
  const blB = r.data.blocks.find(x => x.id === `UP-${b1.id}`);
  ok(blB && blB.reason === 'uplisting' && blB.rooms.join() === RN.b1 && blB.status === 'active' && blB.ext && blB.ext.source === 'uplisting' && blB.ext.id === String(b1.id) && blB.ext.property_id === UP.b1
    && blB.ext.property_name === b1.property_name && blB.ext.channel === 'airbnb_official' && blB.ext.guest === 'Jon Snow' && blB.ext.guests === 2 && blB.ext.status === 'confirmed' && blB.ext.unit === '' && blB.ext.synced_at === blB.created_at
    && Object.keys(blB.ext).sort().join() === 'channel,guest,guests,id,property_id,property_name,source,status,synced_at,unit', 'week GET: blocks[] with ext');
  ok(r.data.rooming[RN.b1].blocked.id === `UP-${b1.id}` && r.data.rooming[RN.b1].blocked.ext.guest === 'Jon Snow' && r.data.rooming[RN.a2].blocked === undefined, 'rooming: blocked with ext');
  ok(r.data.availability.rooms['twin-ensuite'].empty_units === 4, 'week 1 admin availability: one twin room less');
  r = await call(admin, 'GET', '/api/booking/admin?calendar=1&from=2027-07-11&to=2027-08-08', null, UPL, AUTH);
  ok(r.data.blocks.some(x => x.id === `UP-${b1.id}` && x.ext && x.ext.channel === 'airbnb_official'), 'calendar: blocks[] with ext');
  ok(!JSON.stringify(r.data).includes('castleblack') && !JSON.stringify(r.data).includes('7978978'), 'no guest email or phone in the answers');
  r = await availJ(UPL);
  ok(r.data.rooms['twin-ensuite'].empty_units === 4 && r.data.rooms['twin-ensuite'].left.female === 8, 'public availability: BreathCamp 1 has one twin room less');
  r = await availJ(UPL, J2);
  ok(r.data.rooms['twin-ensuite'].empty_units === 5, '… BreathCamp 2 untouched');
  // duplicates
  const n0 = entries().length;
  r = await upHook(b1, { event: 'booking_created' });
  ok(r.result.action === 'unchanged' && upRecOf(b1.id).length === 1 && entries().length === n0, 'the same webhook again: unchanged (not logged)');
  const b2 = addUb(UP.a2, '2027-08-02', '2027-08-05');
  await Promise.all([0, 1, 2].map(i => uplistingApi.onRequestPost({ request: hookReq(b2, { event: i ? 'booking_updated' : 'booking_created' }), env: UPL, waitUntil: p => store.waits.push(p) })));
  const three = await Promise.all(store.waits.splice(0));
  ok(three.map(x => x.action).sort().join() === 'created,unchanged,unchanged' && upRecOf(b2.id).length === 1, 'three webhooks of one booking at once: one record');
  forgetWrites(); forgetUplisting(); upRecOf(b2.id)[0]._lagging = true;
  r = await upHook(b2);
  ok(r.result.action === 'unchanged' && upRecOf(b2.id).length === 1, 'another isolate while search lags: found in the real-time list of new customers');
  forgetWrites(); forgetUplisting(); tick(11 * 60);
  r = await upHook(b2);
  ok(r.result.action === 'created' && upRecOf(b2.id).length === 1 && r.result.rec.customer === upRecOf(b2.id)[0].id, 'neither search nor the list sees it: the same Idempotency-Key and body give back the same customer (one record)');
  upRecOf(b2.id)[0]._lagging = false;
  // changed in Uplisting
  Object.assign(b1, { check_in: '2027-07-25', check_out: '2027-07-27', number_of_guests: 1, guest_name: 'Jon Targaryen' });
  r = await upHook(b1);
  let m = upRecOf(b1.id)[0].metadata;
  ok(r.result.action === 'updated' && m.aob_from === '2027-07-25' && m.aob_to === '2027-07-27' && m.aob_ext_n === '1' && m.aob_ext_guest === 'Jon Targaryen' && !Number.isNaN(Date.parse(m.aob_ext_sync))
    && upRecOf(b1.id)[0].name === `Uplisting · Jon Targaryen · ${b1.property_name}` && upRecOf(b1.id).length === 1, 'booking_updated: new dates (the same record), renamed, aob_ext_sync');
  ok(lastEntry('uplisting_booking').s === 'Airbnb booking · 1B · Peace Cottage · 25–27 Jul 2027 (2 nights) · Jon T. · 1 guest' && lastEntry('uplisting_booking').p === J2, 'activity: the change');
  r = await availJ(UPL);
  const w1 = r.data.rooms['twin-ensuite'].empty_units;
  r = await availJ(UPL, J2);
  ok(w1 === 5 && r.data.rooms['twin-ensuite'].empty_units === 4, 'the room is free in week 1 again, taken in week 2');
  r = await upHook({ ...b1, check_in: '2027-07-19', check_out: '2027-07-22' });
  ok(r.result.action === 'unchanged' && upRecOf(b1.id)[0].metadata.aob_status === 'active', 'a late webhook with the old dates: looked up where our record is, not cancelled');
  // moved to a unit of another listing
  dropUb(b2); Object.assign(b2, { property_id: +UP.gt, multi_unit_id: 9002, property_name: 'Glamping Twin • Pool' }); up.bookings.get(UP.gt).push(b2);
  r = await upHook(b2);
  m = upRecOf(b2.id)[0].metadata;
  ok(r.result.action === 'updated' && m.aob_ext_prop === UP.gt && m.aob_ext_unit === '9002' && m.aob_rooms === RN.gt(2) && m.aob_ext_pname === 'Glamping Twin • Pool', 'moved to a unit of another listing: that unit\'s room');
  b2.multi_unit_id = null;
  r = await upHook(b2);
  m = upRecOf(b2.id)[0].metadata;
  ok(r.result.action === 'updated' && !('aob_ext_unit' in m) && m.aob_rooms === RN.gt(2), 'the unit id gone: keeps its unit\'s room while that is free (no move)');
  // cancelled, again, restored, deleted
  b1.status = 'cancelled';
  r = await upHook(b1, { event: 'booking_removed' });
  m = upRecOf(b1.id)[0].metadata;
  ok(r.result.action === 'cancelled' && m.aob_status === 'cancelled' && /^\d+$/.test(m.aob_status_at) && m.aob_ext_ustatus === 'cancelled' && upRecOf(b1.id).length === 1, 'cancelled in Uplisting: our record cancelled (kept for history)');
  ok(lastEntry('uplisting_cancel').s === 'Airbnb booking cancelled · 1B · Peace Cottage · 25–27 Jul 2027 · Jon T.' && lastEntry('uplisting_cancel').r === 'system' && lastEntry('uplisting_cancel').f === `UP-${b1.id}`, 'activity: uplisting_cancel');
  r = await availJ(UPL, J2);
  ok(r.data.rooms['twin-ensuite'].empty_units === 5, 'its room is back on sale');
  r = await call(admin, 'GET', '/api/booking/admin?calendar=1&from=2027-07-11&to=2027-08-08', null, UPL, AUTH);
  ok(!r.data.blocks.some(x => x.id === `UP-${b1.id}`), 'calendar: a cancelled one is not drawn');
  r = await upHook(b1, { event: 'booking_removed' });
  ok(r.result.action === 'unchanged', 'cancelled twice: nothing to do');
  b1.status = 'confirmed';
  r = await upHook(b1);
  m = upRecOf(b1.id)[0].metadata;
  ok(r.result.action === 'updated' && m.aob_status === 'active' && !m.aob_status_at && m.aob_ext_ustatus === 'confirmed', 'confirmed again: active again');
  dropUb(b1);
  r = await upHook({ id: b1.id, property_id: b1.property_id, check_in: b1.check_in, check_out: b1.check_out, channel: 'uplisting', guest_name: 'Jon Targaryen', reason: 'destroyed', timestamp: '2026-07-01T09:00:00Z' }, { event: 'booking_removed' });
  m = upRecOf(b1.id)[0].metadata;
  ok(r.result.action === 'cancelled' && m.aob_status === 'cancelled' && m.aob_ext_ustatus === 'removed' && lastEntry('uplisting_cancel').s.startsWith('Airbnb booking removed in Uplisting · 1B · Peace Cottage'), 'deleted in Uplisting (the reduced payload): not found by the API → cancelled');
  const b3 = addUb(UP.solo, '2027-09-01', '2027-09-04');
  r = await upHook(b3, { event: 'booking_created' });
  r = await upHook({ ...b3, status: 'cancelled', reason: 'cancelled' }, { event: 'booking_removed' });
  ok(r.result.action === 'unchanged' && upRecOf(b3.id)[0].metadata.aob_status === 'active', 'booking_removed while the API has it confirmed: the API\'s copy wins');
  const l0 = logs.length, u0 = up.calls.length;
  upFault(/^\/bookings\//, { status: 500, times: 3 });
  r = await upHook({ ...b3, status: 'cancelled' });
  ok(r.status === 200 && r.result.action === 'failed' && up.calls.length - u0 === 3 && upRecOf(b3.id)[0].metadata.aob_status === 'active', 'Uplisting down while reading: 200 for Uplisting, tried 3 times, nothing changed');
  ok(logs.slice(l0).some(l => l.includes('"route":"uplisting.webhook_read"') && l.includes('"status":500') && l.includes(`"booking":"${b3.id}"`)) && logs.slice(l0).every(l => !/Jon|Snow|@|7978|dragon/.test(l)), '… logged without personal data');
  upFault(/^\/bookings\//, { status: 503 });
  b3.status = 'cancelled';
  r = await upHook(b3);
  ok(r.result.action === 'cancelled', '… one failure: the retry gets it');
  const b4 = addUb(UP.solo, '2027-10-01', '2027-10-03');
  r = await upHook({ data: b4 });
  ok(r.result.action === 'created', 'the booking under data works too');
  for (const raw of ['not json', '[]', '{}', JSON.stringify({ id: 'a b', property_id: 1 }), JSON.stringify({ id: 5 })]) {
    r = await upHook(null, { raw });
    ok(r.status === 200 && r.data.ok === true && r.result.action === 'ignored', `a body without a booking (${raw.slice(0, 12)}): 200, ignored`);
  }
  const b5 = addUb(UP.solo, '2027-10-10', '2027-10-12');
  r = await upHook({ id: b5.id, property_id: b5.property_id });
  ok(r.result.action === 'ignored' && r.result.reason === 'no_dates' && upRecOf(b5.id).length === 0, 'no dates and no record of it: ignored (the sync brings it in)');
  r = await upHook({ id: b4.id, property_id: b4.property_id, guest_name: 'Changed' });
  ok(r.result.action === 'unchanged', 'no dates but a record: read by the record\'s dates');
  // block_delete refused
  r = await upAdm({ action: 'block_delete', id: `UP-${b4.id}` });
  ok(r.status === 409 && r.data.code === 'external' && r.data.error === 'This booking comes from Uplisting: change or cancel it there and it will update here.', 'block_delete of an Uplisting booking (by its id) → 409 external');
  r = await upAdm({ action: 'block_delete', id: upRecOf(b4.id)[0].id });
  ok(r.status === 409 && r.data.code === 'external' && !upRecOf(b4.id)[0].deleted && upRecOf(b4.id)[0].metadata.aob_status === 'active', '… by its customer id → 409; still there');
  r = await upAdm({ action: 'block_delete', id: 'UP-999' });
  ok(r.status === 404, 'block_delete of an unknown UP- id → 404');
  const blob = JSON.stringify(store.customers) + JSON.stringify(entries()) + logs.join('\n');
  ok(!/castleblack|7978978|HMXQ7ZZ9|dragon|King of the North/.test(blob), 'no guest email, phone, reservation code, note or preferred name stored or logged');
}

/* rooms: whole cottages, units, clashes */
reset(); upFixtures();
{
  r = await upAdm({ action: 'uplisting_map', mapping: MAP });
  const w = addUb(UP.cottage, '2027-08-10', '2027-08-13', { channel: 'booking_dot_com', guest_name: 'Ada Lovelace', number_of_guests: 5 });
  r = await upHook(w);
  ok(r.result.action === 'created' && upRecOf(w.id)[0].metadata.aob_rooms === [RN.a1, RN.b1, PEACE_1C].join('|') && r.result.clash.length === 0, 'a whole-cottage listing: the booking takes every room mapped to it');
  ok(lastEntry('uplisting_booking').s === `Booking.com booking · ${RN.a1}, ${RN.b1}, ${PEACE_1C} · 10–13 Aug 2027 (3 nights) · Ada L. · 5 guests`, 'activity: all its rooms');
  const s1 = addUb(UP.b1, '2027-08-12', '2027-08-14', { channel: 'home_away', guest_name: 'Grace' });
  r = await upHook(s1);
  ok(r.result.action === 'created' && upRecOf(s1.id)[0].metadata.aob_rooms === RN.b1 && r.result.clash.join() === `UP-${w.id}`
    && lastEntry('uplisting_booking').s === `Vrbo booking · ${RN.b1} · 12–14 Aug 2027 (2 nights) · Grace · 2 guests · clash with UP-${w.id}`, 'a room booked over the whole cottage\'s nights: saved, a clash');
  // multi-unit listing
  const u2 = addUb(UP.gt, '2027-09-10', '2027-09-12', { multi_unit_id: 9002, channel: 'google' });
  r = await upHook(u2);
  ok(upRecOf(u2.id)[0].metadata.aob_rooms === RN.gt(2) && upRecOf(u2.id)[0].metadata.aob_ext_unit === '9002' && lastEntry('uplisting_booking').s.startsWith('Google booking · Glamping Twin 2 · '), 'a booking of unit 9002: that unit\'s room');
  const u0 = addUb(UP.gt, '2027-09-11', '2027-09-13', { channel: 'uplisting' });
  r = await upHook(u0);
  ok(upRecOf(u0.id)[0].metadata.aob_rooms === RN.gt(1) && r.result.clash.length === 0 && lastEntry('uplisting_booking').s.startsWith('Direct (Uplisting) booking · Glamping Twin 1'), 'no unit id: the first unit (by id) whose rooms are free');
  const u3 = addUb(UP.gt, '2027-09-12', '2027-09-13');
  r = await upHook(u3);
  ok(upRecOf(u3.id)[0].metadata.aob_rooms === RN.gt(2) && r.result.clash.length === 0, 'no unit id, the first unit taken: the next free one');
  const u4 = addUb(UP.gt, '2027-09-11', '2027-09-12');
  r = await upHook(u4);
  ok(upRecOf(u4.id)[0].metadata.aob_rooms === RN.gt(1) && r.result.clash.join() === `UP-${u0.id}`, 'no unit free: the first unit, a clash');
  const u9 = addUb(UP.gt, '2027-09-20', '2027-09-21', { multi_unit_id: 9003 });
  r = await upHook(u9);
  ok(r.result.action === 'unmapped' && upRecOf(u9.id).length === 0, 'a unit that isn\'t mapped (and no whole-listing mapping): ignored');
  ok(JSON.stringify(roomSets({ 1: ['A'], '1_7': ['B'] }, '1', '7')) === '[{"unit":"7","rooms":["B"]}]' && JSON.stringify(roomSets({ 1: ['A'] }, '1', '7')) === '[{"unit":"","rooms":["A"]}]'
    && JSON.stringify(roomSets({ '1_8': ['C'], '1_7': ['B'], 1: ['A'] }, '1', '')) === '[{"unit":"7","rooms":["B"]},{"unit":"8","rooms":["C"]}]' && roomSets({ 12: ['A'] }, '1', '').length === 0, 'roomSets: unit, else the listing; units by id; 12 is not 1');
  ok(chooseRooms([{ rooms: ['A'] }, { rooms: ['B'] }], { rooms: ['B'] }, [], '2027-01-01', '2027-01-02').rooms[0] === 'B', 'chooseRooms: a booking keeps its free unit');
  // clashes with an online guest placed in the room and a manual booking
  r = await call(checkout, 'POST', '/api/booking/checkout', jBooking([guest(1, 'twin-ensuite')]), UPL);
  const oRef = r.data.ref; complete(r.data.session_id);
  r = await upAdm({ action: 'assign', ref: oRef, assign: { 0: RN.a2 } });
  r = await upAdm({ action: 'manual_create', from: '2027-07-20', to: '2027-07-22', guests: [mg('Mona', 'Female', RN.a2)] });
  const mRef = r.data.booking.ref;
  const c2 = addUb(UP.a2, '2027-07-21', '2027-07-23', { guest_name: 'Zed Last' });
  let k = await kCalls(() => upHook(c2));
  ok(k.res.result.action === 'created' && k.res.result.clash.join() === `${mRef},${oRef}` && lastEntry('uplisting_booking').s === `Airbnb booking · ${RN.a2} · 21–23 Jul 2027 (2 nights) · Zed L. · 2 guests · clash with ${mRef} / ${oRef}`,
    'clash with the manual booking and the online guest placed in 2A: saved, named in the log');
  ok(k.total <= 10, `a webhook with the week\'s placed guests read: ${k.total} subrequests`);
  r = await call(admin, 'GET', `/api/booking/admin?program=${J1}`, null, UPL, AUTH);
  ok(r.data.rooming[RN.a2].blocked.ext.id === String(c2.id) && r.data.rooming[RN.a2].conflict === 'blocked', 'rooming: the online guest in a room taken through Uplisting → conflict blocked');
  const c3 = addUb(UP.a2, '2027-07-22', '2027-07-24'), l1 = logs.length;
  fault('GET', /^\/payment_intents\/search$/, { status: 500, times: 3 });
  r = await upHook(c3);
  ok(r.result.action === 'created' && r.result.clash.join() === `UP-${c2.id}` && logs.slice(l1).some(l => l.includes('"route":"uplisting.clash"')), 'the week\'s placed guests unreadable: saved anyway, the clash check without them (logged)');
  // the team's block / manual booking / room assignment over an Uplisting booking
  const sA = addUb(UP.solo, '2027-09-01', '2027-09-04');
  r = await upHook(sA);
  const lbl = `(Airbnb · Jon S. · UP-${sA.id})`;
  r = await upAdm({ action: 'block_create', rooms: [RN.ark('A')], from: '2027-09-02', to: '2027-09-03', reason: 'maintenance' });
  ok(r.status === 409 && r.data.code === 'conflict' && r.data.conflicts[0] === `5A · The Ark has an Uplisting booking 1–4 Sep 2027 ${lbl}.`, 'block_create over an Uplisting booking → 409 conflict');
  r = await upAdm({ action: 'manual_create', from: '2027-09-03', to: '2027-09-05', guests: [mg('Nell', 'Female', RN.ark('A'))] });
  ok(r.status === 409 && r.data.conflicts[0] === `5A · The Ark has an Uplisting booking 1–4 Sep 2027 ${lbl}.`, 'manual_create in a room with an Uplisting booking → 409 conflict');
  const cB = addUb(UP.b1, '2027-07-19', '2027-07-20');
  r = await upHook(cB);
  r = await upAdm({ action: 'assign', ref: oRef, assign: { 0: RN.b1 } });
  ok(r.status === 200 && r.data.warnings[0] === `1B · Peace Cottage has an Uplisting booking 19–20 Jul 2027 (Airbnb · Jon S. · UP-${cB.id}).`, 'assign into a room with an Uplisting booking: saved, with a warning');
  ok(store.customers.every(c => !c.metadata || (Object.keys(c.metadata).length <= 50 && Object.keys(c.metadata).every(x => x.length <= 40) && Object.values(c.metadata).every(v => String(v).length <= 500))), 'every customer within Stripe\'s metadata limits');
  const big = addUb(UP.cottage, '2027-11-01', '2027-11-05', { guest_name: 'jane@example.com ' + 'Maximiliana '.repeat(20), property_name: 'P'.repeat(300), channel: 'c'.repeat(80), status: 's'.repeat(80), number_of_guests: 9999 });
  r = await upHook(big);
  const mb = upRecOf(big.id)[0];
  ok(r.result.action === 'created' && mb.metadata.aob_ext_guest.length <= 60 && mb.metadata.aob_ext_guest.startsWith('[email] Maximiliana') && mb.metadata.aob_ext_pname.length === 60 && mb.metadata.aob_ext_channel.length === 40
    && mb.metadata.aob_ext_ustatus.length === 40 && mb.metadata.aob_ext_n === '999' && mb.name.length <= 200 && Object.keys(mb.metadata).length <= 20 && Object.values(mb.metadata).every(v => String(v).length <= 500), 'the fullest record: values cut, an email in the name scrubbed, within the limits');
  ok(JSON.stringify(normBooking({ id: 1, property_id: 2, guest_email: 'a@b.co', guest_phone: '+441234567890', check_in: '2027-01-01', check_out: '2027-01-02' })).match(/@|1234567890/) === null, 'normBooking keeps no email or phone');
}

/* the sync: slices, cursor, subrequests, 429, gone bookings, unmapped listings */
reset(); upFixtures();
{
  r = await upAdm({ action: 'uplisting_sync' });
  ok(r.status === 409 && r.data.code === 'no_mapping', 'uplisting_sync without a mapping → 409 no_mapping');
  r = await upAdm({ action: 'uplisting_map', mapping: MAP });
  const days = (start, n, step) => Array.from({ length: n }, (_, i) => addDays(start, i * step));
  const b1s = days('2026-07-05', 120, 3).map(d => addUb(UP.b1, d, addDays(d, 1)));
  const a2s = days('2026-08-01', 60, 5).map((d, i) => addUb(UP.a2, d, addDays(d, 2), i % 12 === 0 ? { status: 'cancelled' } : { channel: 'booking_dot_com' }));
  const cot = ['2027-10-01', '2027-10-05', '2027-10-09'].map(d => addUb(UP.cottage, d, addDays(d, 3)));
  addUb(UP.gt, '2027-05-01', '2027-05-03', { multi_unit_id: 9001 }); addUb(UP.gt, '2027-05-05', '2027-05-06', { multi_unit_id: 9001 });
  addUb(UP.gt, '2027-05-01', '2027-05-02', { multi_unit_id: 9002 }); addUb(UP.gt, '2027-05-01', '2027-05-02', { multi_unit_id: 9003 });
  addUb(UP.solo, '2026-03-01', '2026-03-03'); const soloIn = addUb(UP.solo, '2026-12-01', '2026-12-03'); addUb(UP.solo, '2028-06-01', '2028-06-03');
  addUb(UP.camper, '2026-12-01', '2026-12-02');
  tick(120);
  let s = await syncAll();
  ok(s.r.status === 200 && s.r.data.done === true && s.r.data.cursor === null && s.slices.length >= 5, `first sync: done in ${s.slices.length} calls`);
  ok(s.max <= 45, `every call ≤ 45 subrequests, Stripe + Uplisting (largest ${s.max})`);
  ok(s.slices.slice(0, -1).every(x => x.data.done === false && typeof x.data.cursor === 'string' && x.data.cursor.length > 40), 'a cursor between calls');
  ok(s.slices.every((x, i) => i === 0 || x.data.progress.listings_done >= s.slices[i - 1].data.progress.listings_done) && s.slices.every(x => x.data.progress.listings_total === 5), 'progress: listings done of 5 (the mapped ones)');
  ok(JSON.stringify(s.r.data.stats) === JSON.stringify({ created: 182, updated: 0, cancelled: 0, unchanged: 5, unmapped: 1, clashes: 0, errors: 0 }), `stats: 182 new, 5 cancelled ones never imported, 1 unmapped unit (${JSON.stringify(s.r.data.stats)})`);
  ok(upRecs().length === 182 && new Set(upRecs().map(c => c.metadata.aob_ext_id)).size === 182 && upRecOf(soloIn.id).length === 1 && upRecs().every(c => c.metadata.aob_ext_sync === undefined), 'one record per booking in the window (not before, not after, not the unmapped listing)');
  ok(upRecs().filter(c => c.metadata.aob_ext_prop === UP.cottage).every(c => c.metadata.aob_rooms.split('|').length === 3), 'the cottage\'s bookings take its three rooms');
  ok(up.calls.filter(c => c.path === `/bookings/${UP.b1}` && /[?&]page=0&/.test(c.search)).length >= 2 && s.slices.some(x => x.data.progress.listings_done === 0 && !x.data.done), 'a slice can stop inside a page: the next one reads that page again and goes on from that booking');
  ok(entries().filter(e => e.a === 'uplisting_sync').length === 1 && lastEntry('uplisting_sync').s === 'Uplisting sync: 182 new, 0 changed, 0 cancelled, 0 clashes, 1 not mapped' && lastEntry('uplisting_sync').u === 'owner'
    && !entries().some(e => e.a === 'uplisting_booking'), 'one activity entry for the whole sync (none per booking)');
  const sc = settingsCus()[0];
  ok(!Number.isNaN(Date.parse(sc.metadata.aob_last_sync)) && JSON.parse(sc.metadata.aob_last_sync_result).created === 182 && Object.keys(JSON.parse(sc.metadata.aob_last_sync_result)).join() === 'created,updated,cancelled,unchanged,unmapped,clashes,errors', 'aob_last_sync and the result saved');
  r = await upGet();
  ok(r.data.last_sync.at === sc.metadata.aob_last_sync && r.data.last_sync.result.created === 182 && r.data.imported.active === 182 && r.data.imported.upcoming === 182, 'panel: last sync and imported counts');
  // nothing new: everything unchanged
  tick(61);
  s = await syncAll();
  ok(s.r.data.done && s.r.data.stats.created === 0 && s.r.data.stats.unchanged === 187 && s.r.data.stats.updated === 0 && s.slices.length <= 2 && s.max <= 45, `a second sync: all unchanged (${s.slices.length} call(s))`);
  // changes in Uplisting between syncs, a booking over the cottage
  b1s[10].check_out = addDays(b1s[10].check_in, 2); b1s[11].status = 'cancelled';
  addUb(UP.cottage, '2026-08-02', '2026-08-05');
  tick(61);
  s = await syncAll();
  ok(s.r.data.done && s.r.data.stats.updated === 1 && s.r.data.stats.cancelled === 1 && s.r.data.stats.created === 1 && s.r.data.stats.clashes === 1 && upRecOf(b1s[11].id)[0].metadata.aob_status === 'cancelled'
    && !Number.isNaN(Date.parse(upRecOf(b1s[10].id)[0].metadata.aob_ext_sync)) && lastEntry('uplisting_sync').s === 'Uplisting sync: 1 new, 1 changed, 1 cancelled, 1 clash, 1 not mapped', 'changes: updated, cancelled, a new booking clashing (1B is in both listings)');
  // a booking deleted in Uplisting: only cancelled once its listing was read in full
  const gone = b1s[100];
  dropUb(gone);
  upFault(/^\/bookings\/251801\?.*&page=1&/, { status: 429, retryAfter: 20 });
  tick(61);
  r = await upAdm({ action: 'uplisting_sync' });
  ok(r.status === 200 && r.data.paused === 'rate_limited' && r.data.retry_after === 20 && r.data.done === false && r.data.stats.errors === 0 && r.data.cursor && upRecOf(gone.id)[0].metadata.aob_status === 'active', '429 on the listing\'s 2nd page: paused (retry_after 20), not an error, nothing cancelled yet');
  ok(entries().filter(e => e.a === 'uplisting_sync').length === 3, 'an unfinished sync is not logged');
  tick(21);
  s = await syncAll(UPL, { cursor: r.data.cursor });
  ok(s.r.data.done && s.r.data.stats.cancelled === 1 && upRecOf(gone.id)[0].metadata.aob_status === 'cancelled' && upRecOf(gone.id)[0].metadata.aob_ext_ustatus === 'removed', '… continued with the cursor: the listing read in full, the gone booking cancelled');
  // missing from the pages (they shift while bookings come in) but there by its dates: kept
  const hid = b1s[50];
  up.hideWide.add(String(hid.id));
  tick(61);
  s = await syncAll();
  ok(s.r.data.done && s.r.data.stats.cancelled === 0 && upRecOf(hid.id)[0].metadata.aob_status === 'active' && up.calls.some(c => c.path === `/bookings/${UP.b1}` && /from=/.test(c.search) && nightsBetween(new URLSearchParams(c.search).get('from'), new URLSearchParams(c.search).get('to')) < 10),
    'missing from the listing\'s pages but found by its own dates: not cancelled');
  up.hideWide.clear();
  // busy: Uplisting 5xx, Stripe 5xx
  upFault(/^\/bookings\/251802/, { status: 502 });
  tick(61);
  r = await upAdm({ action: 'uplisting_sync' });
  let c0 = r.data.cursor;
  ok(r.data.paused === 'busy' && r.data.retry_after > 0 && r.data.stats.errors === 0 && r.data.cursor, 'Uplisting 5xx: paused busy');
  a2s.slice(1, 4).forEach(b => { b.guest_name = 'New Name'; });
  tick(11);
  fault('POST', /^\/customers\/cus_/, { status: 500, times: 3 });
  s = await syncAll(UPL, { cursor: c0 });
  ok(s.r.data.done && s.slices.some(x => x.data.paused === 'busy') && s.r.data.stats.updated >= 3, 'Stripe 5xx on a write: paused busy, the cursor repeats it');
  // a listing Uplisting no longer has: counted as an error, its bookings kept
  up.bookings.delete(UP.solo);
  tick(61);
  s = await syncAll();
  ok(s.r.data.done && s.r.data.stats.errors === 1 && upRecOf(soloIn.id)[0].metadata.aob_status === 'active', 'a listing Uplisting answers 404 for: an error, nothing cancelled');
  up.bookings.set(UP.solo, [soloIn]);
  // pacing: 5 bookings a page → 24 pages for one listing: this isolate stays under 14 calls a minute per listing
  uplistingConfig.perPage = 5;
  tick(61);
  s = await syncAll();
  ok(s.r.data.done && s.slices.some(x => x.data.paused === 'rate_limited' && x.data.retry_after > 0 && x.data.retry_after <= 60) && s.max <= 45 && s.r.data.stats.errors === 0, `pacing: paused with retry_after under Uplisting's per-listing limit (${s.slices.length} calls, largest ${s.max})`);
  const perMin = up.calls.filter(c => c.path === `/bookings/${UP.b1}`).map(c => c.t);
  ok(perMin.every((t, i) => perMin.filter(x => x > t - 60000 && x <= t).length <= 15), 'never more than 15 calls a minute for one listing');
  uplistingConfig.perPage = 50;
  // cursor checks
  upFault(/^\/bookings\/251802\?/, { status: 429, retryAfter: 5 });
  tick(61);
  r = await upAdm({ action: 'uplisting_sync' });
  const cur = r.data.cursor;
  ok(r.data.paused === 'rate_limited' && typeof cur === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cur), 'the cursor: base64url state + signature');
  const flip = cur.slice(0, 10) + (cur[10] === 'A' ? 'B' : 'A') + cur.slice(11);
  r = await upAdm({ action: 'uplisting_sync', cursor: flip });
  ok(r.status === 400 && r.data.code === 'bad_cursor', 'a changed cursor → 400 bad_cursor');
  r = await upAdm({ action: 'uplisting_sync', cursor: 'garbage' });
  ok(r.status === 400 && r.data.code === 'bad_cursor', 'garbage → 400');
  r = await upAdm({ action: 'uplisting_sync', cursor: cur }, { ...UPL, ADMIN_TOKEN: 'another-admin-token-0987654321' });
  ok(r.status === 401, '(a new admin token: signed out)');
  tick(7 * 3600);
  r = await upAdm({ action: 'uplisting_sync', cursor: cur });
  ok(r.status === 400 && r.data.code === 'bad_cursor', 'a cursor older than 6 hours → 400');
  // the team can sync; the entry names them
  await adm({ action: 'user_create', username: 'tom', name: 'Tom', role: 'team', password: 'tom-pass' }); secrets.push('tom-pass');
  const tTom = (await loginAs('tom', 'tom-pass')).data.token;
  tick(61);
  s = await syncAll(UPL, { headers: bearer(tTom) });
  ok(s.r.status === 200 && s.r.data.done && lastEntry('uplisting_sync').n === 'Tom' && lastEntry('uplisting_sync').r === 'team', 'a team member runs the sync; the entry names them');
  // a listing no longer mapped: its bookings (from today on) are released by the next sync
  const a2Active = upRecs().filter(c => c.metadata.aob_ext_prop === UP.a2 && c.metadata.aob_status === 'active').length;
  r = await upAdm({ action: 'uplisting_map', mapping: { ...MAP, [UP.a2]: [] } });
  tick(61);
  s = await syncAll();
  ok(s.r.data.done && s.r.data.stats.cancelled === a2Active && a2Active > 40 && upRecs().filter(c => c.metadata.aob_ext_prop === UP.a2).every(c => c.metadata.aob_status === 'cancelled') && s.max <= 45 && s.slices.length >= 2,
    `unmapped listing: its ${a2Active} bookings released in slices (${s.slices.length} calls, largest ${s.max})`);
  tick(61);
  r = await upAdm({ action: 'uplisting_sync' }, { ...UPL, UPLISTING_API_KEY: 'bad-key' });
  ok(r.status === 502 && r.data.code === 'uplisting_auth' && /API key/.test(r.data.error), 'a key Uplisting refuses → 502 uplisting_auth');
  ok(store.customers.every(c => !c.metadata || (Object.keys(c.metadata).length <= 50 && Object.values(c.metadata).every(v => String(v).length <= 500))), 'every customer within Stripe\'s metadata limits after the syncs');
  const blob = JSON.stringify(store.customers) + JSON.stringify(entries()) + logs.join('\n');
  ok(!/castleblack|7978978|HMXQ7ZZ9|dragon/.test(blob), 'no guest email or phone stored or logged by the sync');
}

/* nothing personal in the logs */
ok(logs.length > 0 && logs.every(l => !l.includes('@')), 'failure logs carry no email addresses');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
