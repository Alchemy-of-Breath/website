// Contract tests execute the shipped inline scripts with synthetic data only.
// No network requests, live submissions, CRM writes or Meta events are made.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import { attribution as serverAttribution } from '../../application-lib/attribution.js';

const html = readFileSync(new URL('../../facilitator-application/index.html', import.meta.url), 'utf8');
const helper = html.match(/<script id="application-tracking">([\s\S]*?)<\/script>/)[1];
const main = html.match(/<script>\s*\(function \(\) \{\s*'use strict';([\s\S]*?)<\/script>/)[1];
function storage() {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), map };
}
function setup(variant = 'default', store = storage()) {
  const context = vm.createContext({ window: {}, TextEncoder, URLSearchParams });
  vm.runInContext(helper, context);
  const api = context.window.AoBApplication;
  return { api, store, make: () => api.create({ variant, storage: store, crypto: webcrypto, now: () => Date.parse('2026-11-09T12:00:00Z') }) };
}
const input = { email: 'synthetic@example.invalid', variant: 'default', outcome: 'booking' };

test('unchanged attempts retain application/event IDs and timestamp across reload; changed answers get a new identity', async () => {
  const { make, store } = setup();
  const first = await make().prepare(input);
  const retry = await make().prepare(input);
  assert.equal(first.application_id, retry.application_id);
  assert.equal(first.meta_event_id, retry.meta_event_id);
  assert.equal(first.submitted_at, retry.submitted_at);
  assert.match(first.application_id, /^aob-[0-9a-f-]{36}$/);
  const changed = await make().prepare({ ...input, outcome: 'not_facilitator' });
  assert.notEqual(changed.application_id, first.application_id);
  const metadata = [...store.map.values()].join();
  assert.ok(!metadata.includes(input.email), 'pending identity storage contains no application answers');
  assert.equal(Object.hasOwn(first, 'ghl_contact_id'), false, 'browser never invents or trusts a contact ID');
});

test('accepted applications and explicit restarts get a new identity; variants stay separate', async () => {
  const { make, store } = setup(); const controller = make();
  const first = await controller.prepare(input); controller.accepted(first);
  assert.notEqual((await make().prepare(input)).application_id, first.application_id);
  const pending = await controller.prepare(input); controller.reset();
  assert.notEqual((await controller.prepare(input)).application_id, pending.application_id);
  const coach = setup('coaches', store).make();
  assert.notEqual((await coach.prepare(input)).application_id, first.application_id);
});

test('blocked storage retains retry identity in memory and reports reduced persistence', async () => {
  const { make } = setup('default', null); const controller = make();
  const a = await controller.prepare(input); const b = await controller.prepare(input);
  assert.equal(a.application_id, b.application_id);
  assert.equal(a.identity_persistence, 'memory');
});

test('corrupt and expired pending metadata cannot reuse a stale identity', async () => {
  const { make, store } = setup(); const key = 'aob-application-pending-v1-default';
  store.setItem(key, '{invalid');
  const a = await make().prepare(input);
  const saved = JSON.parse(store.getItem(key)); saved.submitted_at = '2025-01-01T00:00:00Z';
  store.setItem(key, JSON.stringify(saved));
  assert.notEqual((await make().prepare(input)).application_id, a.application_id);
});

test('both variants emit one application event; qualified applicants also emit a distinct Lead event', async () => {
  for (const variant of ['default', 'coaches']) for (const outcome of ['booking', 'not_facilitator']) {
    const controller = setup(variant).make(); const calls = [];
    const p = await controller.prepare({ ...input, variant, outcome });
    const pixel = (...args) => calls.push(args);
    controller.events(p, pixel); controller.events(p, pixel);
    const qualified = outcome === 'booking';
    assert.equal(calls.length, qualified ? 2 : 1);
    assert.equal(calls[0][1], 'SubmitApplication');
    assert.equal(calls[0][3].eventID, p.meta_event_id);
    assert.equal(calls[0][2].application_id, p.application_id);
    if (qualified) {
      assert.equal(calls[1][1], 'Lead');
      assert.notEqual(calls[0][3].eventID, calls[1][3].eventID);
    }
  }
});

test('paid Meta, organic social, other sources and missing attribution remain distinguishable', () => {
  const { api } = setup();
  const cases = [
    ['utm_source=meta&utm_medium=paid_social', 'Meta Ads', 'captured_utm'],
    ['utm_source=facebook&utm_medium=organic', 'Social Direct', 'captured_utm'],
    ['utm_source=facebook', 'facebook', 'captured_utm'],
    ['utm_source=newsletter&utm_medium=email', 'newsletter', 'captured_utm'],
    ['fbclid=synthetic-click', 'Unknown', 'unknown'],
    ['for=coaches', 'Unknown', 'unknown']
  ];
  for (const [query, source, status] of cases) {
    const data = api.attribution(new URLSearchParams(query));
    assert.equal(data.application_lead_source, source); assert.equal(data.attribution_status, status);
  }
  const ids = api.attribution(new URLSearchParams('campaign_id=11111&adset_id=22222&ad_id=33333&utm_content=copy&fbc_id=legacy&utm_id=raw'));
  assert.equal(ids.meta_campaign_id, '11111'); assert.equal(ids.meta_adset_id, '22222'); assert.equal(ids.meta_ad_id, '33333');
  assert.equal(ids.fbc_id, 'legacy'); assert.equal(ids.utm_id, 'raw'); assert.equal(ids.utm_content, 'copy');
  assert.equal(api.attribution(new URLSearchParams('utm_id=raw&fbc_id=legacy')).meta_campaign_id, '');
});

test('preview/local hosts cannot call the live webhook or bootstrap the production pixel', () => {
  const { api } = setup();
  for (const host of ['localhost', '127.0.0.1', 'branch.website-5h3.pages.dev', 'alchemyofbreath.com.example.invalid']) {
    assert.equal(api.productionHost(host), false);
  }
  assert.equal(api.productionHost('website-5h3.pages.dev'), true);
  const isDemo = main.match(/function isDemo\(\) \{[^}]+\}/)[0];
  const context = vm.createContext({ CONFIG: { webhookUrl: 'https://example.invalid/hook' }, window: { AoBApplication: api }, location: { hostname: 'localhost' } });
  vm.runInContext(isDemo, context); assert.equal(vm.runInContext('isDemo()', context), true);
  assert.match(html, /var live=window\.AoBApplication\.productionHost\(location\.hostname\) &&/);
});

test('actual submission handler retries one payload, blocks double submit, and does not turn pixel failure into a CRM retry', async () => {
  const { make } = setup('coaches'); const controller = make();
  const calls = []; let failFirst = true; let resolveEnd;
  const ended = new Promise(resolve => { resolveEnd = resolve; });
  const code = main.slice(main.indexOf('  function post(payload)'), main.indexOf('  function calendarLink(p)'));
  const context = vm.createContext({
    application: controller, busy: false, submitted: false, CONFIG: { webhookUrl: 'https://example.invalid/hook' },
    screens: { email: { btn: {}, status: {} } }, outcome: () => 'booking',
    buildPayload: () => ({ ...input, variant: 'coaches' }), isDemo: () => false,
    fetch: async (url, opts) => { calls.push(JSON.parse(opts.body)); if (failFirst) { failFirst = false; throw new Error('ambiguous network failure'); } return { ok: true, json: async () => ({ application_id: calls.at(-1).application_id, status: 'accepted', ghl_contact_id: 'contact-test', crm_state: 'saved', workflow_state: 'acknowledged' }) }; },
    AbortController, setTimeout: (fn, ms) => { if (ms === 1500) queueMicrotask(fn); return 1; }, clearTimeout: () => {},
    clearDraft: () => {}, window: { fbq: () => { throw new Error('pixel blocked'); } },
    renderEnd: () => {}, show: () => resolveEnd(),
    setError: () => assert.fail('pixel failure must not report a failed application')
  });
  vm.runInContext(code, context);
  vm.runInContext("submit({ id: 'email', type: 'email' }); submit({ id: 'email', type: 'email' });", context);
  await ended;
  assert.equal(calls.length, 2, 'one initial attempt plus one network retry');
  assert.deepEqual(calls[0], calls[1], 'retry carries identical ID, timestamp, event ID and answers');
  vm.runInContext("submit({ id: 'email', type: 'email' });", context);
  assert.equal(calls.length, 2, 'accepted submission is not posted again');
});

test('failed delivery emits no conversion and preserves identity for a later manual retry', async () => {
  const { make } = setup(); const controller = make(); const calls = []; const pixels = [];
  let fail = true; let done;
  let terminal = new Promise(resolve => { done = resolve; });
  const code = main.slice(main.indexOf('  function post(payload)'), main.indexOf('  function calendarLink(p)'));
  const context = vm.createContext({ application: controller, busy: false, submitted: false,
    CONFIG: { webhookUrl: 'https://example.invalid/hook' }, screens: { email: { btn: {}, status: {} } },
    outcome: () => 'booking', buildPayload: () => ({ ...input }), isDemo: () => false,
    fetch: async (url, opts) => {
      if (url === '/api/application/events') return { ok: true };
      const sent = JSON.parse(opts.body); calls.push(sent);
      return { ok: !fail, status: fail ? 503 : 200, json: async () => ({ application_id: sent.application_id, status: 'accepted', ghl_contact_id: 'contact-test', crm_state: 'saved', workflow_state: 'acknowledged' }) };
    },
    AbortController, setTimeout: (fn, ms) => { if (ms === 1500) queueMicrotask(fn); return 1; }, clearTimeout: () => {},
    clearDraft: () => {}, window: { fbq: (...args) => pixels.push(args) },
    renderEnd: () => {}, show: () => done(), setError: () => done()
  });
  vm.runInContext(code, context); vm.runInContext("submit({ id: 'email', type: 'email' });", context);
  await terminal; assert.equal(pixels.length, 0); assert.equal(calls.length, 2);
  fail = false; terminal = new Promise(resolve => { done = resolve; });
  vm.runInContext("submit({ id: 'email', type: 'email' });", context); await terminal;
  assert.equal(calls[0].application_id, calls[2].application_id); assert.equal(pixels.filter(x => x[1] === 'SubmitApplication').length, 1); assert.equal(pixels.filter(x => x[1] === 'Lead').length, 1);
});

test('all shipped inline JavaScript parses, and calendar handoff carries correlation IDs', () => {
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (m[0].includes('application/ld+json')) continue;
    new vm.Script(m[1]);
  }
  const code = main.slice(main.indexOf('  function calendarLink(p)'), main.indexOf('  function goTop(url)'));
  const { api } = setup();
  const context = vm.createContext({ URL, CONFIG: { calendarUrl: 'https://example.invalid/calendar', prefillCalendar: false }, TRACK_KEYS: api.trackingKeys });
  vm.runInContext(code, context);
  const url = new URL(vm.runInContext("calendarLink({ application_id: 'aob-synthetic', campaign_id: '111', ad_id: '333' })", context));
  assert.equal(url.searchParams.get('application_id'), 'aob-synthetic');
  assert.equal(url.searchParams.get('ad_id'), '333');
});


test('browser and server agree on current Meta traffic, future sources, unknowns and legacy numeric IDs', () => {
  const { api } = setup();
  for (const query of [
    'utm_source=facebook&utm_medium=ppc&utm_id=120254405385540483&utm_term=120254405387700483',
    'utm_source=facebook&utm_medium=paid', 'utm_source=meta&utm_medium=paid_social',
    'utm_source=meta-ads&utm_medium=paid_social', 'utm_source=newsletter&utm_medium=email',
    'utm_source=google&utm_medium=cpc', 'utm_source=facebook&utm_medium=organic',
    'fbclid=synthetic', '', 'utm_source=facebook&utm_medium=ppc&campaign_id=123456&adset_id=234567&ad_id=345678'
  ]) {
    const params = new URLSearchParams(query);
    const browser = api.attribution(params);
    const server = serverAttribution(Object.fromEntries(params));
    for (const [key, value] of Object.entries(server)) assert.equal(browser[key], value, key + ': ' + query);
  }
});
