/* AoB booking system ← Uplisting (the channel manager that sells ASHA's rooms on Airbnb, Booking.com, Vrbo,
   Google and as direct bookings). Inbound only: a booking made there takes the matching physical rooms
   here (off sale for BreathCamp online booking, in the rooming calendar and the week boards, flagged
   when it clashes). Nothing is ever written to Uplisting except the three webhooks we register.

   Environment (Cloudflare Pages → Settings → Variables and secrets; never in the repo)
   - UPLISTING_API_KEY         the raw API key (Uplisting → Connect → API). Turns the integration on.
   - UPLISTING_WEBHOOK_SECRET  16+ random characters, part of the webhook URL (?key=…). Uplisting doesn't
                               sign its webhooks: this key is what tells its posts apart from anyone else's.
                               Shorter than 16 characters counts as not set.
   uplistingStatus: 'off' (no API key) | 'no_webhook_secret' | 'on'.

   Uplisting API (https://connect.uplisting.io): Authorization: Basic base64(API key) on every call.
   GET /users/me, GET /properties (JSON:API; multi-units as relationships + included), GET
   /bookings/:property_id?from&to&page (0-based)&per_page (≤ 50) → { bookings, meta: { total_pages } }
   (cancelled bookings included), GET/POST /hooks, DELETE /hooks/:id. Limits: 5 requests a second and
   100 a minute per IP, 15 a minute per property (429 beyond). This isolate paces itself under 80 a
   minute and 14 a minute per listing (paceWait); a 429 stops a sync slice, which hands back its cursor.

   Records: an Uplisting booking is a block record (see core.js): a Stripe Customer with aob_rec 'block',
   aob_rec_any '1', aob_id 'UP-<booking id>', aob_from / aob_to (check-in / check-out day), aob_rooms (every
   room the booking takes, '|'), aob_reason 'uplisting', aob_status ('cancelled' when it is cancelled or
   gone in Uplisting: kept for history) + aob_status_at, and aob_ext 'uplisting', aob_ext_id,
   aob_ext_prop, aob_ext_unit (multi_unit_id or none), aob_ext_pname (property name, ≤ 60),
   aob_ext_channel, aob_ext_guest (guest name, ≤ 60, no email address or phone number), aob_ext_n
   (guests), aob_ext_ustatus (Uplisting's status, or 'removed' when it is gone there), aob_ext_sync
   (ISO time of the last sync or webhook that changed it; a new record has none: its creation time).
   Name 'Uplisting · <guest> · <property>', description 'Imported from Uplisting (managed by sync)'.
   Guest emails and phone numbers are never read into anything we store or log. A record is created with
   Idempotency-Key 'uplisting-<id>-<check_in>-<check_out>-<rooms hash>' and a body that only depends on the
   booking (no timestamps), so two webhooks racing in two isolates make one customer.

   Mapping (which rooms a listing is): one settings Customer, metadata aob_settings 'uplisting' (name
   'AoB booking settings · Uplisting (do not delete)'), keys m<property id> (the whole listing) and
   m<property id>_<unit id> (one unit of a multi-unit listing) → room names joined by '|' (as
   calendarRooms() names them), at most 47 of them (+ aob_settings, aob_last_sync, aob_last_sync_result =
   Stripe's 50 keys). A booking takes EVERY room mapped to its listing (a whole-cottage listing blocks each
   room of the cottage). A booking with a multi_unit_id takes the rooms of that unit (else the listing's);
   a booking of a listing with unit mappings but without a unit id takes the first unit (by unit id)
   whose rooms are all free over its nights (other records only), else the unit it had, else the first
   unit (and that is a clash). An unmapped listing's bookings are ignored (counted as unmapped); a
   record whose listing is no longer mapped is cancelled by the next sync.
   Clash: a room the booking takes has, on one of its nights, another active record (a block, a manual
   booking, another Uplisting booking) or an online guest the team placed there (aob_assign) in a
   BreathCamp week. It is reported (sync stats, the activity log); the record is saved anyway.

   Webhook (functions/api/booking/uplisting.js → handleWebhook): answered at once, the work in waitUntil.
   The booking is read again from the API (the payload's dates and units are never trusted); not found or
   cancelled there → our record is cancelled. Logged as uplisting_booking / uplisting_cancel by the
   'Uplisting' system actor. About 5 to 10 subrequests (Cloudflare's free plan allows 50).

   Sync (syncSlice): every mapped listing's bookings from today − 60 days to today + 540 days, in slices
   that stay under 40 subrequests (Stripe + Uplisting) each; the admin calls again with the cursor (opaque,
   signed, 6 hours) until done. A record of a listing that is no longer in Uplisting is cancelled only after
   all that listing's pages were read without error AND a narrow read of that booking (by its dates) doesn't
   find it either (pages shift while bookings come in). */
import {
  stripe, searchAll, nowSec, logError, str, cut, timingSafeEqual, validDay, addDays, todayIso, overlaps, weekRange, listPrograms, qs,
  calendarRooms, listRecords, recentCustomers, parseRecord, recordsChanged, programPayments, groupBookings, rangeLabel, channelLabel, guestShort,
  timeoutSignal, countSubrequest, isBusy,
} from './core.js';
import { logActivity, scrubText, UPLISTING_ACTOR } from './team.js';

export const UPLISTING_API = 'https://connect.uplisting.io';
export const HOOK_PATH = '/api/booking/uplisting';
export const HOOK_EVENTS = ['booking_created', 'booking_updated', 'booking_removed'];
export const MAP_MAX_KEYS = 47;
export const MAP_VALUE_MAX = 500;
export const STATS_KEYS = ['created', 'updated', 'cancelled', 'unchanged', 'unmapped', 'clashes', 'errors'];
export const RECORD_DESCRIPTION = 'Imported from Uplisting (managed by sync)';
export const SETTINGS_NAME = 'AoB booking settings · Uplisting (do not delete)';
const SETTINGS_DESCRIPTION = 'Which rooms each Uplisting listing is, and the last sync (do not delete)';
const SETTINGS_QUERY = "metadata['aob_settings']:'uplisting'";
/* Tunables (tests shorten the waits). */
export const uplistingConfig = {
  timeoutMs: 8000, webhookRetryMs: [1000, 3000], cacheMs: 5 * 60 * 1000, settingsMs: 30 * 1000, writeMs: 3 * 60 * 1000,
  daysBack: 60, daysAhead: 540, perPage: 50,
  sliceLimit: 40, sliceReserve: 5, sliceUpCalls: 14, perMinute: 80, perListingMinute: 14,
  cursorTtlSec: 6 * 3600, seenMax: 1500,
};
const cfg = uplistingConfig;
const ID_RE = /^[A-Za-z0-9-]{1,24}$/;
const KEY_RE = /^([A-Za-z0-9-]{1,24})(?:_([A-Za-z0-9-]{1,24}))?$/;
const CANCELLED = s => s === 'cancelled' || s === 'canceled';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder();

const apiKey = env => String((env && env.UPLISTING_API_KEY) || '').trim();
const hookSecret = env => { const s = String((env && env.UPLISTING_WEBHOOK_SECRET) || ''); return s.length >= 16 ? s : ''; };
/* 'off' | 'no_webhook_secret' | 'on' */
export function uplistingStatus(env) { return !apiKey(env) ? 'off' : hookSecret(env) ? 'on' : 'no_webhook_secret'; }
/* Uplisting ids are numbers: shorter first, then by text (deterministic for anything else). */
export const cmpId = (a, b) => { a = String(a); b = String(b); return (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0); };

/* ------------------------------------------------------------------ encoding */
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
const b64url = bytes => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64url(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), c => c.charCodeAt(0));
}
/* Authorization header value: Basic + base64 of the key (UTF-8). */
export const authHeader = key => 'Basic ' + b64(enc.encode(key));
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
/* FNV-1a 32 bits in base 36: a short, stable fingerprint (idempotency keys) */
function fnv(s) {
  let h = 0x811c9dc5;
  for (const ch of enc.encode(s)) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/* ------------------------------------------------------------------ pacing */
const callLog = []; // { t, pid } of this isolate's Uplisting calls in the last minute
function prune(now) { while (callLog.length && (now - callLog[0].t >= 60000 || now < callLog[0].t - 60000)) callLog.shift(); }
function noteCall(pid) {
  const now = Date.now(); prune(now);
  callLog.push({ t: now, pid: pid || '' });
  if (callLog.length > 2000) callLog.shift();
}
/* Seconds before this isolate should call Uplisting again (0: now): under 80 calls a minute in all and
   14 a minute for one listing (Uplisting allows 100 per IP and 15 per property). */
export function paceWait(pid) {
  const now = Date.now(); prune(now);
  let wait = 0;
  if (callLog.length >= cfg.perMinute) wait = callLog[callLog.length - cfg.perMinute].t + 60000 - now;
  if (pid) {
    const mine = callLog.filter(c => c.pid === pid);
    if (mine.length >= cfg.perListingMinute) wait = Math.max(wait, mine[mine.length - cfg.perListingMinute].t + 60000 - now);
  }
  return wait > 0 ? Math.max(1, Math.ceil(wait / 1000)) : 0;
}

/* --------------------------------------------------------------------- API */
function upError(status, code, retryAfter = null) {
  const e = new Error(status === 0 ? 'Uplisting could not be reached' : `Uplisting answered ${status}`);
  e.status = status; e.type = 'uplisting_error'; e.code = code; e.retryAfter = retryAfter;
  return e;
}
const kindOf = s => s === 429 ? 'rate_limited' : s === 401 || s === 403 ? 'auth' : s === 404 ? 'not_found' : s >= 500 ? 'unavailable' : 'refused';
/* One Uplisting call (no retries: callers decide). pid: the listing it is about (pacing). Errors carry
   status (0: network), type 'uplisting_error', code ('network' | 'rate_limited' | 'auth' | 'not_found' |
   'unavailable' | 'refused' | 'unreadable') and retryAfter (seconds, from a 429's Retry-After). Never
   anything from the answer's body (it can carry guests' details). */
export async function upFetch(env, method, path, body = null, { pid = '', timeoutMs = cfg.timeoutMs } = {}) {
  noteCall(pid); countSubrequest(env);
  let res;
  try {
    res = await fetch(UPLISTING_API + path, {
      method, body: body == null ? undefined : JSON.stringify(body), signal: timeoutSignal(timeoutMs),
      headers: { Authorization: authHeader(apiKey(env)), 'Content-Type': 'application/json', Accept: 'application/json' },
    });
  } catch { throw upError(0, 'network'); }
  let text = '';
  try { text = await res.text(); } catch {}
  if (!res.ok) {
    const ra = parseInt(res.headers.get('Retry-After') || '', 10);
    throw upError(res.status, kindOf(res.status), Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) : null);
  }
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw upError(res.status, 'unreadable'); }
}
/* Worth trying again later: unreachable, rate-limited, Uplisting's 5xx, an unreadable answer. */
export const upBusy = e => !!e && e.type === 'uplisting_error' && (e.status === 0 || e.status === 429 || e.status >= 500 || e.code === 'unreadable');
export function upErrorText(e) {
  if (!e || e.type !== 'uplisting_error') return 'Uplisting could not be reached just now. Try again in a moment.';
  if (e.code === 'auth') return 'Uplisting refused the API key. Check UPLISTING_API_KEY in Cloudflare (the key from Uplisting → Connect → API).';
  if (e.code === 'rate_limited') return 'Uplisting asked us to slow down. Try again in a minute.';
  if (e.code === 'not_found') return 'Uplisting doesn\'t know that listing (it may have been removed there).';
  if (e.status === 0 || e.status >= 500 || e.code === 'unreadable') return 'Uplisting could not be reached just now. Try again in a moment.';
  return `Uplisting refused the request (${e.status}).`;
}

/* JSON:API properties → [{ id, name, nickname, units: [{ id, name }] }] by id. Multi-units are read from
   the property's relationships (or included units pointing back at it); a unit's name: name, else
   nickname, else 'Unit <id>'. */
const relId = (x, k) => { const d = x && x.relationships && x.relationships[k] && x.relationships[k].data; return d && !Array.isArray(d) && d.id != null ? String(d.id) : null; };
export function parseProperties(doc) {
  const data = Array.isArray(doc && doc.data) ? doc.data : doc && doc.data && typeof doc.data === 'object' ? [doc.data] : [];
  const inc = Array.isArray(doc && doc.included) ? doc.included : [];
  const units = new Map(inc.filter(x => x && x.type === 'multi_units' && x.id != null).map(x => [String(x.id), x]));
  const out = [];
  for (const p of data) {
    if (!p || p.id == null || (p.type && p.type !== 'properties')) continue;
    const id = String(p.id);
    if (!ID_RE.test(id) || out.some(x => x.id === id)) continue;
    const a = p.attributes || {};
    const rel = p.relationships && p.relationships.multi_units && p.relationships.multi_units.data;
    let ids = Array.isArray(rel) ? rel.map(x => x && x.id != null ? String(x.id) : '').filter(Boolean) : [];
    if (!ids.length) ids = [...units.values()].filter(u => relId(u, 'property') === id).map(u => String(u.id));
    const list = [...new Set(ids)].filter(u => ID_RE.test(u)).map(uid => {
      const ua = (units.get(uid) || {}).attributes || {};
      return { id: uid, name: str(ua.name, 120) || str(ua.nickname, 120) || `Unit ${uid}` };
    });
    out.push({ id, name: str(a.name, 200) || `Listing ${id}`, nickname: str(a.nickname, 200), units: list });
  }
  return out.sort((x, y) => cmpId(x.id, y.id));
}
/* JSON:API hooks → [{ id, target_url, event }] */
export function parseHooks(doc) {
  const data = Array.isArray(doc && doc.data) ? doc.data : Array.isArray(doc) ? doc : [];
  return data.map(h => { const a = (h && h.attributes) || h || {}; return { id: h && h.id != null ? String(h.id) : '', target_url: String(a.target_url || ''), event: String(a.event || '') }; })
    .filter(h => h.id && h.target_url);
}

/* Account, properties and hooks: 5 minutes per isolate (per API key). Errors are not kept. */
const cache = { key: null, account: null, properties: null, hooks: null };
function cached(env, name, refresh) {
  const k = apiKey(env);
  if (cache.key !== k) { cache.key = k; cache.account = cache.properties = cache.hooks = null; }
  const c = cache[name], now = Date.now();
  return !refresh && c && now - c.at < cfg.cacheMs && now >= c.at ? c.v : null;
}
const keep = (name, v) => { cache[name] = { v, at: Date.now() }; return v; };
export async function getAccount(env, { refresh = false } = {}) {
  return cached(env, 'account', refresh) || keep('account', { name: str(((await upFetch(env, 'GET', '/users/me')) || {}).name, 120) || null });
}
export async function getProperties(env, { refresh = false } = {}) {
  return cached(env, 'properties', refresh) || keep('properties', parseProperties(await upFetch(env, 'GET', '/properties')));
}
export async function getHooks(env, { refresh = false } = {}) {
  return cached(env, 'hooks', refresh) || keep('hooks', parseHooks(await upFetch(env, 'GET', '/hooks')));
}

/* -------------------------------------------------------------- webhooks */
const hostOf = request => { try { return new URL(request.url).host; } catch { return ''; } };
function ourHook(h, host) {
  try { const u = new URL(h.target_url); return u.protocol === 'https:' && u.host === host && u.pathname === HOOK_PATH ? u : null; } catch { return null; }
}
/* { booking_created, booking_updated, booking_removed }: registered for this host with the current secret */
export function hookState(hooks, host, secret) {
  const out = Object.fromEntries(HOOK_EVENTS.map(ev => [ev, false]));
  if (!secret) return out;
  for (const h of hooks) {
    const u = ourHook(h, host);
    if (u && HOOK_EVENTS.includes(h.event) && timingSafeEqual(u.searchParams.get('key') || '', secret)) out[h.event] = true;
  }
  return out;
}
/* Other hosts our webhook path is registered for (e.g. the custom domain while the admin is on pages.dev). */
const otherHookHosts = (hooks, host) => [...new Set(hooks.map(h => { try { const u = new URL(h.target_url); return u.pathname === HOOK_PATH && u.host !== host ? u.host : null; } catch { return null; } }).filter(Boolean))].sort();
export const hookUrl = (host, secret, event) => `https://${host}${HOOK_PATH}?key=${encodeURIComponent(secret)}&event=${event}`;

/* uplisting_hooks: the three booking events registered for this host with the current secret; ours
   (same host and path) with another key (a rotated secret), another event, or twice are removed.
   → { status, data: { ok, hooks, created, removed } | { error, code } } */
export async function connectHooks(env, request) {
  if (!apiKey(env)) return { status: 503, data: { error: 'Uplisting is not connected: set UPLISTING_API_KEY in Cloudflare first.', code: 'uplisting_off' } };
  const secret = hookSecret(env);
  if (!secret) return { status: 409, data: { error: 'Set UPLISTING_WEBHOOK_SECRET (16 or more random characters) in Cloudflare first, then redeploy.', code: 'no_webhook_secret' } };
  const host = hostOf(request);
  if (!host || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return { status: 409, data: { error: 'Connect the webhooks from the live site (Uplisting can\'t reach this address).', code: 'bad_host' } };
  let created = 0, removed = 0;
  try {
    const list = await getHooks(env, { refresh: true });
    const kept = new Map(), left = [];
    for (const h of list) {
      const u = ourHook(h, host);
      if (!u) { left.push(h); continue; }
      const good = HOOK_EVENTS.includes(h.event) && timingSafeEqual(u.searchParams.get('key') || '', secret) && !kept.has(h.event);
      if (good) { kept.set(h.event, h); left.push(h); continue; }
      await upFetch(env, 'DELETE', `/hooks/${encodeURIComponent(h.id)}`);
      removed++;
    }
    for (const event of HOOK_EVENTS) {
      if (kept.has(event)) continue;
      const target_url = hookUrl(host, secret, event);
      const r = await upFetch(env, 'POST', '/hooks', { target_url, event });
      left.push({ id: String((r && r.id) || `new-${event}`), target_url, event });
      created++;
    }
    keep('hooks', left);
    return { status: 200, data: { ok: true, hooks: hookState(left, host, secret), created, removed } };
  } catch (e) {
    cache.hooks = null;
    logError('uplisting.hooks', e);
    if (e.type !== 'uplisting_error') throw e;
    return { status: upBusy(e) ? 503 : 502, data: { error: upErrorText(e), code: e.code === 'auth' ? 'uplisting_auth' : upBusy(e) ? 'uplisting_busy' : 'uplisting', created, removed, ...(upBusy(e) ? { retry_after: e.retryAfter || 30 } : {}) } };
  }
}

/* ---------------------------------------------------------------- settings */
const isSettings = c => !!c && !c.deleted && (c.metadata || {}).aob_settings === 'uplisting';
const settingsMemo = { rows: null, at: 0 };
const settingsWrites = new Map(); // id → { c, at }: this isolate's writes (search lags behind them)
function rememberSettings(c) {
  if (!c || !c.id) return;
  settingsWrites.delete(c.id); settingsWrites.set(c.id, { c, at: Date.now() });
  if (settingsMemo.rows) settingsMemo.rows = [...settingsMemo.rows.filter(x => x.id !== c.id), c];
}
/* metadata key m<key> → '<property id>' | '<property id>_<unit id>' (null: not a mapping key) */
const mapKeyOf = k => { if (k[0] !== 'm') return null; const m = KEY_RE.exec(k.slice(1)); return m ? k.slice(1) : null; };
/* Settings customers (several when two were made at once): merged oldest → newest, the newest wins per
   key. → { customer: newest id | null, rows (oldest first), mapping: { key: [room names] } (keys by id),
   last_sync: { at, result } | null } */
export function mergeSettings(rows) {
  const list = (rows || []).filter(isSettings).sort((a, b) => ((a.created || 0) - (b.created || 0)) || (a.id < b.id ? -1 : 1));
  const md = {};
  for (const c of list) for (const [k, v] of Object.entries(c.metadata || {})) if (v !== '' && v != null) md[k] = v;
  const keys = Object.keys(md).map(k => [k, mapKeyOf(k)]).filter(([, key]) => key).sort((a, b) => cmpMapKey(a[1], b[1]));
  const mapping = {};
  for (const [k, key] of keys) { const rooms = String(md[k]).split('|').filter(Boolean); if (rooms.length) mapping[key] = rooms; }
  let result = null;
  if (md.aob_last_sync_result) { try { const o = JSON.parse(md.aob_last_sync_result); if (o && typeof o === 'object') result = Object.fromEntries(STATS_KEYS.map(k => [k, Number.isInteger(o[k]) ? o[k] : 0])); } catch {} }
  return { customer: list.length ? list[list.length - 1].id : null, rows: list, mapping, last_sync: md.aob_last_sync ? { at: md.aob_last_sync, result } : null };
}
function cmpMapKey(a, b) {
  const [pa, ua = ''] = a.split('_'), [pb, ub = ''] = b.split('_');
  return cmpId(pa, pb) || (!ua ? -1 : !ub ? 1 : cmpId(ua, ub));
}
/* The settings. cached: from this isolate's 30 s copy when there is one. fresh: each settings customer read
   directly (search lags a minute behind an update). recentRows: the real-time list of new customers
   (recentCustomers(), a promise of it, or a function giving one) when the caller reads it anyway. */
export async function readSettings(env, { cached: useMemo = true, fresh = false, recentRows = null } = {}) {
  const now = Date.now();
  if (useMemo && !fresh && settingsMemo.rows && now - settingsMemo.at < cfg.settingsMs && now >= settingsMemo.at) return mergeSettings(settingsMemo.rows);
  const recent = typeof recentRows === 'function' ? recentRows() : recentRows || recentCustomers(env);
  const [found, latest] = await Promise.all([searchAll(env, SETTINGS_QUERY, 100, 'customers'), recent]);
  const byId = new Map();
  for (const c of [...found, ...(latest || [])]) if (isSettings(c)) byId.set(c.id, c);
  for (const [id, w] of settingsWrites) { if (now - w.at > cfg.writeMs || now < w.at) settingsWrites.delete(id); else byId.set(id, w.c); }
  let rows = [...byId.values()];
  if (fresh && rows.length) {
    rows = (await Promise.all(rows.map(c => stripe(env, 'GET', `/customers/${c.id}`).catch(e => { if (e.status === 404) return null; throw e; })))).filter(isSettings);
  }
  settingsMemo.rows = rows; settingsMemo.at = Date.now();
  return mergeSettings(rows);
}
/* Merge `fields` into the newest settings customer (made when there is none). → the customer */
async function writeSettings(env, settings, fields) {
  let c;
  if (settings.customer) c = await stripe(env, 'POST', `/customers/${settings.customer}`, { metadata: fields });
  else {
    const md = { aob_settings: 'uplisting' };
    for (const [k, v] of Object.entries(fields)) if (v !== '') md[k] = v;
    c = await stripe(env, 'POST', '/customers', { name: SETTINGS_NAME, description: SETTINGS_DESCRIPTION, metadata: md });
  }
  rememberSettings(c);
  return c;
}

/* ------------------------------------------------------------------ mapping */
/* The listings a mapping covers (property ids, in id order). */
export const mappedProperties = mapping => [...new Set(Object.keys(mapping).map(k => k.split('_')[0]))].sort(cmpId);
export const isMapped = (mapping, pid) => !!mapping[pid] || Object.keys(mapping).some(k => k.startsWith(pid + '_'));
/* The room sets a booking can take: [{ unit, rooms }]. One set (take all its rooms), or one per mapped
   unit (a booking without a unit id of a listing with unit mappings: one of them is chosen), or none
   (unmapped). */
export function roomSets(mapping, pid, unit) {
  const whole = mapping[pid];
  if (unit) {
    const u = mapping[`${pid}_${unit}`];
    return u ? [{ unit, rooms: u }] : whole ? [{ unit: '', rooms: whole }] : [];
  }
  const units = Object.keys(mapping).filter(k => k.startsWith(pid + '_')).map(k => k.slice(pid.length + 1)).sort(cmpId);
  if (units.length) return units.map(u => ({ unit: u, rooms: mapping[`${pid}_${u}`] }));
  return whole ? [{ unit: '', rooms: whole }] : [];
}
/* uplisting_map { mapping: { '<property id>': [room names], '<property id>_<unit id>': [...] } } (owner):
   listings and units must exist in Uplisting (the 5-minute copy, read when there is none), rooms in
   the calendar; at most 47 keys, each value ≤ 500 characters; an empty list removes a key. The whole
   mapping is replaced. → { status, data: { ok, mapping } | { error, fields } | { error, code } } */
export async function saveMapping(env, body) {
  if (!apiKey(env)) return { status: 503, data: { error: 'Uplisting is not connected: set UPLISTING_API_KEY in Cloudflare first.', code: 'uplisting_off' } };
  const raw = body && body.mapping;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 422, data: { error: 'Please check the mapping.', fields: { mapping: 'Send the mapping as { "<listing id>": ["room", …] }.' } } };
  let props;
  try {
    props = await getProperties(env);
    // a listing (or unit) added in Uplisting since this isolate's 5-minute copy: read them again once
    const knownKey = k => { const m = KEY_RE.exec(String(k)), p = m && props.find(x => x.id === m[1]); return !m || (p && (!m[2] || p.units.some(u => u.id === m[2]))); };
    if (!Object.keys(raw).every(knownKey)) props = await getProperties(env, { refresh: true });
  }
  catch (e) {
    logError('uplisting.map', e);
    if (e.type !== 'uplisting_error') throw e;
    return { status: upBusy(e) ? 503 : 502, data: { error: `${upErrorText(e)} The mapping was not saved.`, code: e.code === 'auth' ? 'uplisting_auth' : upBusy(e) ? 'uplisting_busy' : 'uplisting' } };
  }
  const known = new Set(calendarRooms().rooms.map(r => r.name)), byId = new Map(props.map(p => [p.id, p]));
  const fields = {}, mapping = {};
  for (const [key, val] of Object.entries(raw)) {
    const f = `mapping.${String(key).slice(0, 60)}`, m = KEY_RE.exec(String(key));
    if (!m || `m${key}`.length > 40) { fields[f] = 'Unknown listing.'; continue; }
    const p = byId.get(m[1]);
    if (!p) { fields[f] = 'This listing is not in Uplisting (any more).'; continue; }
    if (m[2] && !p.units.some(u => u.id === m[2])) { fields[f] = 'This unit is not part of the listing in Uplisting.'; continue; }
    if (val == null || (Array.isArray(val) && !val.length)) continue; // nothing mapped
    if (!Array.isArray(val) || val.some(n => typeof n !== 'string')) { fields[f] = 'Choose rooms from the list.'; continue; }
    const rooms = [...new Set(val.map(n => n.trim()).filter(Boolean))];
    const bad = rooms.find(n => !known.has(n) || n.includes('|'));
    if (bad) { fields[f] = `Unknown room: ${cut(bad, 80)}.`; continue; }
    if (!rooms.length) continue;
    if (rooms.join('|').length > MAP_VALUE_MAX) { fields[f] = 'Too many rooms for one listing.'; continue; }
    mapping[key] = rooms;
  }
  if (Object.keys(mapping).length > MAP_MAX_KEYS) fields.mapping = `At most ${MAP_MAX_KEYS} listings and units can be mapped.`;
  if (Object.keys(fields).length) return { status: 422, data: { error: 'Please check the mapping.', fields } };
  // the whole mapping is replaced: read the settings as they are now (search lags), clear the keys that go
  const s = await readSettings(env, { cached: false, fresh: true });
  const newest = s.rows[s.rows.length - 1] || null, md = {};
  if (newest) for (const k of Object.keys(newest.metadata || {})) if (mapKeyOf(k) && !mapping[mapKeyOf(k)]) md[k] = '';
  for (const k of Object.keys(mapping).sort(cmpMapKey)) md[`m${k}`] = mapping[k].join('|');
  if (Object.keys(md).length) await writeSettings(env, s, md);
  // older duplicates (made by two isolates at once) must not bring keys back through the merge
  for (const c of s.rows.slice(0, -1)) {
    const clear = Object.fromEntries(Object.keys(c.metadata || {}).filter(mapKeyOf).map(k => [k, '']));
    if (Object.keys(clear).length) rememberSettings(await stripe(env, 'POST', `/customers/${c.id}`, { metadata: clear }));
  }
  const out = Object.fromEntries(Object.keys(mapping).sort(cmpMapKey).map(k => [k, mapping[k]]));
  return { status: 200, data: { ok: true, mapping: out } };
}

/* ---------------------------------------------------------------- bookings */
/* An API booking (or webhook payload) → what we keep of it, or null without an id and property id.
   Never the guest's email address or phone number. */
export function normBooking(b, pid = '') {
  if (!b || typeof b !== 'object') return null;
  const id = b.id == null ? '' : String(b.id), prop = b.property_id == null || b.property_id === '' ? String(pid || '') : String(b.property_id);
  if (!ID_RE.test(id) || !ID_RE.test(prop)) return null;
  const unit = b.multi_unit_id == null || b.multi_unit_id === '' ? '' : String(b.multi_unit_id);
  const n = typeof b.number_of_guests === 'number' ? b.number_of_guests : /^\d{1,4}$/.test(String(b.number_of_guests || '')) ? parseInt(b.number_of_guests, 10) : 0;
  return {
    id, property_id: prop, unit: ID_RE.test(unit) ? unit : '', check_in: str(b.check_in, 10), check_out: str(b.check_out, 10),
    status: cut(str(b.status, 40).toLowerCase(), 40) || 'confirmed', channel: cut(str(b.channel, 40), 40),
    guest: cut(scrubText(str(b.guest_name, 200)), 60), guests: Number.isInteger(n) && n > 0 ? Math.min(n, 999) : null,
    property_name: cut(str(b.property_name, 200), 60),
  };
}
const bookingsOf = r => Array.isArray(r && r.bookings) ? r.bookings : Array.isArray(r && r.data) ? r.data : [];
const pagesOf = r => { const n = parseInt(r && r.meta && r.meta.total_pages, 10); return Number.isInteger(n) && n >= 0 ? n : 1; };
const bookingsPath = (pid, q) => `/bookings/${encodeURIComponent(pid)}?` + qs(q);
/* One booking read from the API by its dates (a day either side), up to 4 pages.
   → { booking: raw | null, complete: false when there were more pages }. retries: on busy answers. */
export async function readOne(env, pid, id, from, to, { retries = 0, timeoutMs = cfg.timeoutMs } = {}) {
  const q = { from: addDays(from, -1), to: addDays(to, 1), per_page: cfg.perPage };
  for (let page = 0; page < 4; page++) {
    let r;
    for (let a = 0; ; a++) {
      try { r = await upFetch(env, 'GET', bookingsPath(pid, { ...q, page }), null, { pid, timeoutMs }); break; }
      catch (e) {
        if (!upBusy(e) || a >= retries) throw e;
        await sleep(Math.min(5000, e.retryAfter ? e.retryAfter * 1000 : cfg.webhookRetryMs[Math.min(a, cfg.webhookRetryMs.length - 1)]));
      }
    }
    const list = bookingsOf(r), hit = list.find(x => x && String(x.id) === id);
    if (hit) return { booking: hit, complete: true };
    if (page + 1 >= pagesOf(r) || !list.length) return { booking: null, complete: true };
  }
  return { booking: null, complete: false };
}

const upRecords = records => (records || []).filter(r => r && r.type === 'block' && r.ext && r.ext.source === 'uplisting');
/* Our records of one Uplisting booking: the active one first, then the oldest. */
const byExtId = (records, id) => upRecords(records).filter(r => r.ext.id === id)
  .sort((a, b) => ((a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)) || (a.created - b.created) || (a.customer < b.customer ? -1 : 1));
function replaceRecord(records, rec) {
  if (!rec) return;
  const i = records.findIndex(r => r.customer === rec.customer);
  if (i >= 0) records[i] = rec; else records.push(rec);
}
const usesRoom = (r, room) => r.type === 'block' ? r.rooms.includes(room) : r.guests.some(g => g.room_name === room);
/* The set of rooms a booking takes (see roomSets): the one there is; else the set it has if all free,
   else the first all-free set, else the set it has, else the first. others: the other active records. */
export function chooseRooms(sets, existing, others, from, to) {
  if (sets.length <= 1) return sets[0] || null;
  const range = { from, to }, near = others.filter(r => overlaps(r, range));
  const free = set => set.rooms.every(n => !near.some(r => usesRoom(r, n)));
  const same = set => !!existing && existing.rooms.length === set.rooms.length && set.rooms.every(n => existing.rooms.includes(n));
  const cur = existing ? sets.find(same) || null : null;
  if (cur && free(cur)) return cur;
  return sets.find(free) || cur || sets[0];
}
/* References of what is in these rooms on these nights: other active records (block ids, manual booking
   references, UP-… ids) and online guests placed there ({ ref, room, from, to }). */
export function clashRefs(rooms, from, to, others, placed = []) {
  const range = { from, to }, refs = [];
  for (const r of others) if (r.status === 'active' && overlaps(r, range) && rooms.some(n => usesRoom(r, n))) refs.push(r.type === 'block' ? r.id : r.ref);
  for (const p of placed) if (rooms.includes(p.room) && overlaps(p, range)) refs.push(p.ref);
  return [...new Set(refs)];
}
const NO_RECENT = { pis: [], subs: [] };
const weeksFor = (from, to) => listPrograms().filter(p => overlaps({ from, to }, weekRange(p))).sort((a, b) => (a.dates.start < b.dates.start ? -1 : 1));
const weeksToLoad = (from, to, memo) => weeksFor(from, to).filter(p => !memo.has(p.id)).length;
/* Online guests the team placed in rooms (aob_assign) in the weeks [from, to) overlaps: [{ ref, room, from,
   to }]. One PaymentIntent search and one subscription search per week, kept in memo for the call. */
async function placedGuests(env, from, to, memo) {
  const out = [];
  for (const p of weeksFor(from, to)) {
    if (!memo.has(p.id)) {
      const load = programPayments(env, p, { recent: NO_RECENT }).then(pays => {
        const wk = weekRange(p), list = [];
        for (const b of groupBookings(p, pays)) {
          if (b.status === 'cancelled') continue;
          for (const [i, room] of Object.entries(b.assign || {})) if (room && b.guests[i]) list.push({ ref: b.ref, room, ...wk });
        }
        return list;
      });
      memo.set(p.id, load);
      load.catch(() => { if (memo.get(p.id) === load) memo.delete(p.id); });
    }
    out.push(...await memo.get(p.id));
  }
  return out;
}

export const recordName = b => cut(`Uplisting · ${b.guest || 'Guest'} · ${b.property_name || `listing ${b.property_id}`}`, 200);
/* The record's metadata for a booking taking `rooms` ('' = no value). */
function wanted(b, rooms) {
  return {
    aob_rec: 'block', aob_rec_any: '1', aob_id: `UP-${b.id}`, aob_from: b.check_in, aob_to: b.check_out, aob_rooms: rooms.join('|'), aob_reason: 'uplisting',
    aob_status: 'active', aob_ext: 'uplisting', aob_ext_id: b.id, aob_ext_prop: b.property_id, aob_ext_unit: b.unit, aob_ext_pname: b.property_name,
    aob_ext_channel: b.channel, aob_ext_guest: b.guest, aob_ext_n: b.guests ? String(b.guests) : '', aob_ext_ustatus: b.status,
  };
}
/* What differs between a record and the metadata it should have: { key: value ('' removes) }. */
function changesOf(rec, md) {
  const e = rec.ext, have = {
    aob_from: rec.from, aob_to: rec.to, aob_rooms: rec.rooms.join('|'), aob_ext_prop: e.property_id, aob_ext_unit: e.unit, aob_ext_pname: e.property_name,
    aob_ext_channel: e.channel, aob_ext_guest: e.guest, aob_ext_n: e.guests ? String(e.guests) : '', aob_ext_ustatus: e.status,
  };
  const out = {};
  for (const k of Object.keys(have)) if ((md[k] || '') !== (have[k] || '')) out[k] = md[k] || '';
  if (rec.status !== 'active') { out.aob_status = 'active'; out.aob_status_at = ''; }
  return out;
}
async function writeRecord(ctx, rec, metadata, name) {
  const params = { metadata };
  if (name) params.name = name;
  const c = await stripe(ctx.env, 'POST', `/customers/${rec.customer}`, params);
  recordsChanged(c);
  const out = parseRecord(c);
  replaceRecord(ctx.records, out);
  return out;
}
async function cancelRecord(ctx, rec, ustatus) {
  return writeRecord(ctx, rec, { aob_status: 'cancelled', aob_status_at: String(nowSec()), aob_ext_ustatus: cut(str(ustatus, 40), 40) || rec.ext.status || 'cancelled', aob_ext_sync: ctx.iso });
}
async function createRecord(ctx, b, rooms) {
  const metadata = Object.fromEntries(Object.entries(wanted(b, rooms)).filter(([, v]) => v !== ''));
  const key = `uplisting-${b.id}-${b.check_in}-${b.check_out}-${fnv(rooms.join('|'))}`;
  const c = await stripe(ctx.env, 'POST', '/customers', { name: recordName(b), description: RECORD_DESCRIPTION, metadata }, { idempotencyKey: key });
  recordsChanged(c);
  const rec = parseRecord(c);
  replaceRecord(ctx.records, rec);
  return rec;
}
/* Bring our record of one booking in line with Uplisting's copy (b: normBooking). ctx: { env, mapping,
   records (all, kept up to date here), iso (aob_ext_sync), placed(from, to) → online guests placed, clashAll
   (also check unchanged ones) }. → { action: 'created' | 'updated' | 'unchanged' | 'cancelled' | 'ignored'
   (cancelled there, never imported) | 'unmapped' | 'invalid' (no usable dates), rec, clash: [refs],
   cancelled_existing (unmapped: our record was cancelled) } */
export async function applyBooking(ctx, b, retried = false) {
  const all = byExtId(ctx.records, b.id), existing = all[0] || null;
  const res = { action: 'unchanged', rec: existing, clash: [], cancelled_existing: false };
  // two records of one booking (two isolates racing on a first import): keep one, cancel the others
  for (const d of all.slice(1)) if (d.status === 'active') await cancelRecord(ctx, d, 'duplicate');
  if (CANCELLED(b.status)) {
    if (!existing) return { ...res, action: 'ignored' };
    if (existing.status !== 'active') return res;
    return { ...res, action: 'cancelled', rec: await cancelRecord(ctx, existing, b.status) };
  }
  const sets = roomSets(ctx.mapping, b.property_id, b.unit);
  if (!sets.length) {
    if (existing && existing.status === 'active') return { ...res, action: 'unmapped', rec: await cancelRecord(ctx, existing, b.status), cancelled_existing: true };
    return { ...res, action: 'unmapped' };
  }
  if (!validDay(b.check_in) || !validDay(b.check_out) || b.check_in >= b.check_out) return { ...res, action: 'invalid' };
  const others = ctx.records.filter(r => r.status === 'active' && !(r.ext && r.ext.id === b.id));
  const rooms = chooseRooms(sets, existing, others, b.check_in, b.check_out).rooms.slice();
  if (existing) {
    const md = changesOf(existing, wanted(b, rooms));
    if (Object.keys(md).length) {
      md.aob_ext_sync = ctx.iso;
      const renamed = 'aob_ext_guest' in md || 'aob_ext_pname' in md;
      res.rec = await writeRecord(ctx, existing, md, renamed ? recordName(b) : null);
      res.action = 'updated';
    }
  } else {
    try { res.rec = await createRecord(ctx, b, rooms); res.action = 'created'; }
    catch (e) {
      // the same key with other details: another isolate made this booking's record a moment ago
      if (e.type !== 'idempotency_error' || retried) throw e;
      const fresh = (await recentCustomers(ctx.env)).map(parseRecord).filter(r => r && r.ext && r.ext.id === b.id);
      if (!fresh.length) throw e;
      fresh.forEach(r => replaceRecord(ctx.records, r));
      return applyBooking(ctx, b, true);
    }
  }
  if (res.rec && res.rec.status === 'active' && ctx.placed && (ctx.clashAll || res.action !== 'unchanged')) {
    // the week's placed guests can't be read just now: the clash check goes without them (the record is saved)
    let placed = [];
    try { placed = await ctx.placed(b.check_in, b.check_out); } catch (e) { logError('uplisting.clash', e, { booking: b.id }); }
    res.clash = clashRefs(rooms, b.check_in, b.check_out, others.filter(r => r.customer !== res.rec.customer), placed);
  }
  return res;
}

/* ------------------------------------------------------------- activity */
const roomsText = names => names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} + ${names.length - 2} more`;
const nightsText = n => `${n} ${n === 1 ? 'night' : 'nights'}`;
/* 'Airbnb booking · 1B · Peace Cottage · 12–15 Jul 2027 (3 nights) · Jon S. · 2 guests · clash with BC2707-… / MB… / BL-…' */
export function bookingSummary(rec, clash = []) {
  const e = rec.ext || {}, g = guestShort(e.guest);
  let s = `${channelLabel(e.channel)} booking · ${roomsText(rec.rooms)} · ${rangeLabel(rec.from, rec.to)} (${nightsText(rec.nights)})`;
  if (g) s += ` · ${g}`;
  if (e.guests) s += ` · ${e.guests} ${e.guests === 1 ? 'guest' : 'guests'}`;
  if (clash.length) s += ` · clash with ${clash.slice(0, 3).join(' / ')}${clash.length > 3 ? ` + ${clash.length - 3} more` : ''}`;
  return s;
}
/* 'Airbnb booking cancelled · 1B · Peace Cottage · 12–15 Jul 2027 · Jon S.' (why: 'removed' | 'unmapped') */
export function cancelSummary(rec, why = null) {
  const e = rec.ext || {}, g = guestShort(e.guest);
  const what = why === 'removed' ? 'removed in Uplisting' : why === 'unmapped' ? 'released (its listing is no longer mapped)' : 'cancelled';
  return `${channelLabel(e.channel)} booking ${what} · ${roomsText(rec.rooms)} · ${rangeLabel(rec.from, rec.to)}${g ? ` · ${g}` : ''}`;
}
async function logOutcome(env, res, why) {
  if (!res || !res.rec) return;
  let info = null;
  if (res.action === 'created' || res.action === 'updated') info = { action: 'uplisting_booking', summary: bookingSummary(res.rec, res.clash) };
  else if (res.action === 'cancelled' || res.cancelled_existing) info = { action: 'uplisting_cancel', summary: cancelSummary(res.rec, res.cancelled_existing ? 'unmapped' : why) };
  if (!info) return;
  const home = weeksFor(res.rec.from, res.rec.to)[0];
  await logActivity(env, UPLISTING_ACTOR, { ...info, ref: res.rec.id, program: home ? home.id : null });
}

/* ------------------------------------------------------------------ webhook */
/* The webhook's key, compared in constant time (hashes of both: the length doesn't show either). */
export async function webhookKeyOk(env, key) {
  const secret = hookSecret(env);
  if (!secret || typeof key !== 'string' || !key || key.length > 512) return false;
  const [a, b] = await Promise.all([sha256hex(key), sha256hex(secret)]);
  return timingSafeEqual(a, b);
}
const WEBHOOK_TIMEOUT_MS = 6000; // 3 tries + waits stay inside the ~30 s Cloudflare gives work after the answer
const locks = new Map(); // booking id → the work in flight in this isolate (webhooks of one booking, one at a time)
async function serial(key, fn) {
  const prev = locks.get(key);
  let release;
  const mine = new Promise(r => { release = r; });
  locks.set(key, mine);
  try { if (prev) await prev; return await fn(); }
  finally { release(); if (locks.get(key) === mine) locks.delete(key); }
}
/* One webhook (body: the JSON posted; the booking is body.data when that is an object, else body; event:
   'booking_created' | 'booking_updated' | 'booking_removed' | null). → { action, ... } (for tests and logs) */
export async function handleWebhook(env, body, event = null) {
  const p = body && typeof body === 'object' ? (body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body) : null;
  const id = p && p.id != null ? String(p.id) : '', pid = p && p.property_id != null ? String(p.property_id) : '';
  if (!ID_RE.test(id) || !ID_RE.test(pid)) return { action: 'ignored', reason: 'no_booking' };
  return serial(id, () => webhookBooking(env, p, id, pid, event));
}
async function webhookBooking(env, p, id, pid, event) {
  let freshP = null;
  const fresh = () => freshP || (freshP = recentCustomers(env));
  const settings = await readSettings(env, { cached: true, recentRows: fresh });
  if (!isMapped(settings.mapping, pid)) return { action: 'ignored', reason: 'unmapped' };
  let from = str(p.check_in, 10), to = str(p.check_out, 10);
  const datesOk = validDay(from) && validDay(to) && from < to;
  const recordsP = listRecords(env, { recentRows: fresh() });
  let records, read, readPid = pid;
  const failed = e => {
    if (e.type !== 'uplisting_error') throw e;
    // the next webhook of this booking, or the next sync, brings it in line
    logError('uplisting.webhook_read', e, { booking: id, property: pid });
    return { action: 'failed', reason: e.code };
  };
  try {
    if (datesOk) [read, records] = await Promise.all([readOne(env, pid, id, from, to, { retries: 2, timeoutMs: WEBHOOK_TIMEOUT_MS }), recordsP]);
    else {
      records = await recordsP;
      const ex = byExtId(records, id)[0];
      if (!ex) return { action: 'ignored', reason: 'no_dates' };
      from = ex.from; to = ex.to;
      read = await readOne(env, pid, id, from, to, { retries: 2, timeoutMs: WEBHOOK_TIMEOUT_MS });
    }
  } catch (e) { return failed(e); }
  const memo = new Map();
  const ctx = { env, mapping: settings.mapping, records: records.slice(), iso: new Date().toISOString(), placed: (f, t) => placedGuests(env, f, t, memo), clashAll: false };
  const ex = byExtId(ctx.records, id)[0];
  // not there by the payload's listing and dates: a late, out-of-date webhook (Uplisting retries for days)
  // must not cancel a booking that has moved since: look where our record says it is before cancelling
  if (!read.booking && read.complete && ex && ex.status === 'active' && (ex.ext.property_id !== pid || ex.from !== from || ex.to !== to) && ID_RE.test(ex.ext.property_id)) {
    readPid = ex.ext.property_id;
    try { read = await readOne(env, readPid, id, ex.from, ex.to, { retries: 2, timeoutMs: WEBHOOK_TIMEOUT_MS }); } catch (e) { return failed(e); }
  }
  let res;
  if (!read.booking) {
    if (!read.complete || !ex || ex.status !== 'active') return { action: 'ignored', reason: read.complete ? 'not_found' : 'unknown' };
    res = { action: 'cancelled', rec: await cancelRecord(ctx, ex, 'removed'), clash: [] };
    await logOutcome(env, res, 'removed');
    return { ...res, event };
  }
  const b = normBooking(read.booking, readPid);
  if (!b) return { action: 'ignored', reason: 'unreadable' };
  res = await applyBooking(ctx, b);
  await logOutcome(env, res, null);
  return { ...res, event };
}

/* ---------------------------------------------------------------- the panel */
/* GET ?uplisting=1: everything the Setup panel shows. Stripe errors throw (the admin answers 502: an
   unreadable mapping must never look empty); Uplisting errors leave `error` text (still 200). */
export async function uplistingPanel(env, request, { refresh = false } = {}) {
  const host = hostOf(request), { rooms, areas } = calendarRooms();
  const out = {
    uplisting: true, status: uplistingStatus(env), configured: { api_key: !!apiKey(env), webhook_secret: !!hookSecret(env) },
    account: null, properties: [], mapping: {}, rooms: rooms.map(r => r.name), room_groups: areas.map(area => ({ area, rooms: rooms.filter(r => r.area === area).map(r => r.name) })),
    hooks: null, hooks_other_hosts: [], webhook_url_hint: `https://${host}${HOOK_PATH}`, last_sync: null, imported: { active: 0, upcoming: 0 }, max_keys: MAP_MAX_KEYS,
  };
  if (env.STRIPE_SECRET_KEY) {
    const fresh = recentCustomers(env);
    fresh.catch(() => {});
    const [s, recs] = await Promise.all([readSettings(env, { cached: false, fresh: true, recentRows: fresh }), listRecords(env, { recentRows: fresh })]);
    out.mapping = s.mapping; out.last_sync = s.last_sync;
    const today = todayIso(), act = upRecords(recs).filter(r => r.status === 'active');
    out.imported = { active: act.length, upcoming: act.filter(r => r.to > today).length };
  }
  if (!apiKey(env)) return out;
  const [acc, props, hooks] = await Promise.allSettled([getAccount(env, { refresh }), getProperties(env, { refresh }), getHooks(env, { refresh })]);
  if (acc.status === 'fulfilled') out.account = acc.value;
  if (props.status === 'fulfilled') out.properties = props.value.map(p => ({ id: p.id, name: p.name, nickname: p.nickname, units: p.units.map(u => ({ ...u })) }));
  if (hooks.status === 'fulfilled') { out.hooks = hookState(hooks.value, host, hookSecret(env)); out.hooks_other_hosts = otherHookHosts(hooks.value, host); }
  const bad = [acc, props, hooks].find(x => x.status === 'rejected');
  if (bad) {
    if (bad.reason && bad.reason.type !== 'uplisting_error') throw bad.reason;
    logError('uplisting.panel', bad.reason);
    out.error = upErrorText(bad.reason);
  }
  return out;
}

/* -------------------------------------------------------------------- sync */
/* The cursor: base64url(JSON state) + '.' + HMAC-SHA256 (key: ADMIN_TOKEN and the API key), 6 hours. The
   state: { v, s (start, ISO: aob_ext_sync of what it changes), f, t (the window), L (listing ids), i (the
   listing), ph ('p' pages | 'v' verify | 'c' release unmapped | 'd' done), p (page), k (booking on that
   page), seen (ids read of this listing), x (seen overflowed: no cancellations), q (records to verify),
   st (stats), exp }. Signed so nobody can hand in a cursor that skips pages (that would cancel bookings). */
const cursorKey = env => `uplisting-sync|${(env && env.ADMIN_TOKEN) || ''}|${apiKey(env)}`;
async function mac(env, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(cursorKey(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data))));
}
async function sealCursor(env, st) {
  const body = b64url(enc.encode(JSON.stringify({ ...st, exp: st.exp || nowSec() + cfg.cursorTtlSec })));
  return `${body}.${await mac(env, body)}`;
}
async function openCursor(env, token) {
  if (typeof token !== 'string' || token.length > 30000) return null;
  const [body, sig, more] = token.split('.');
  if (!body || !sig || more !== undefined || !timingSafeEqual(await mac(env, body), sig)) return null;
  let st;
  try { st = JSON.parse(new TextDecoder().decode(fromB64url(body))); } catch { return null; }
  const ints = ['i', 'p', 'k', 'x'];
  if (!st || st.v !== 1 || !(st.exp > nowSec()) || !Array.isArray(st.L) || !st.L.every(x => ID_RE.test(x)) || !ints.every(k => Number.isInteger(st[k]) && st[k] >= 0)
    || !['p', 'v', 'c', 'd'].includes(st.ph) || !Array.isArray(st.seen) || !Array.isArray(st.q) || !validDay(st.f) || !validDay(st.t) || !st.st || typeof st.st !== 'object') return null;
  st.st = Object.fromEntries(STATS_KEYS.map(k => [k, Number.isInteger(st.st[k]) ? st.st[k] : 0]));
  return st;
}
const zeroStats = () => Object.fromEntries(STATS_KEYS.map(k => [k, 0]));
function nextListing(st) { st.i++; st.ph = 'p'; st.p = 0; st.k = 0; st.seen = []; st.x = 0; st.q = []; }
function countResult(stats, res) {
  if (res.action === 'created') stats.created++;
  else if (res.action === 'updated') stats.updated++;
  else if (res.action === 'cancelled') stats.cancelled++;
  else if (res.action === 'unmapped') { stats.unmapped++; if (res.cancelled_existing) stats.cancelled++; }
  else if (res.action === 'invalid') stats.errors++;
  else stats.unchanged++;
  if (res.clash && res.clash.length) stats.clashes++;
}
/* uplisting_sync { cursor? }: one slice. → { status, data: { ok, done, cursor | null, progress: { listings_done,
   listings_total }, stats, paused?: 'rate_limited' | 'busy', retry_after? (seconds: wait before the next call) } }
   or an error answer ({ error, code }: no_mapping 409, bad_cursor 400, uplisting_auth 502, too_big 503). */
export async function syncSlice(envIn, { cursor = null } = {}) {
  const env = { ...envIn, subrequests: { n: 0 } };
  const used = () => env.subrequests.n, fits = n => used() + n <= cfg.sliceLimit - cfg.sliceReserve;
  let st = null;
  if (cursor != null && cursor !== '') {
    st = await openCursor(env, cursor);
    if (!st) return { status: 400, data: { error: 'This sync can\'t be continued (it is too old, or the keys changed). Start it again.', code: 'bad_cursor' } };
  }
  const fresh = recentCustomers(env);
  fresh.catch(() => {});
  const [settings, all] = await Promise.all([readSettings(env, { cached: !!st, fresh: !st, recentRows: fresh }), listRecords(env, { recentRows: fresh })]);
  const mapping = settings.mapping;
  if (!st) {
    const L = mappedProperties(mapping);
    if (!L.length) return { status: 409, data: { error: 'Map at least one Uplisting listing to rooms first.', code: 'no_mapping' } };
    const today = todayIso();
    st = { v: 1, s: new Date().toISOString(), f: addDays(today, -cfg.daysBack), t: addDays(today, cfg.daysAhead), L, i: 0, ph: 'p', p: 0, k: 0, seen: [], x: 0, q: [], st: zeroStats() };
  }
  const memo = new Map();
  const ctx = { env, mapping, records: all.slice(), iso: st.s, placed: (f, t) => placedGuests(env, f, t, memo), clashAll: true };
  const stats = st.st, at = () => JSON.stringify([st.i, st.ph, st.p, st.k, st.q.length]), start = at();
  let stop = null, retry = 0, upCalls = 0;
  const upOk = pid => {
    if (upCalls >= cfg.sliceUpCalls || !fits(1)) { stop = 'budget'; return false; }
    const w = paceWait(pid);
    if (w) { stop = 'rate_limited'; retry = Math.max(retry, w); return false; }
    upCalls++;
    return true;
  };
  // an Uplisting error: 'stop' (try this again later), else the listing is skipped (counted, nothing cancelled)
  const upFailed = (e, pid) => {
    if (e.type !== 'uplisting_error') throw e;
    if (e.code === 'auth') throw e;
    if (upBusy(e)) { stop = e.status === 429 ? 'rate_limited' : 'busy'; retry = Math.max(retry, e.retryAfter || (e.status === 429 ? 30 : 10)); return 'stop'; }
    logError('uplisting.sync', e, { property: pid });
    stats.errors++;
    return 'skip';
  };
  // a Stripe error on one booking: busy → stop the slice here (the cursor repeats it), else counted and skipped
  const stripeFailed = (e, id) => {
    if (e.type === 'uplisting_error') throw e;
    if (isBusy(e)) { stop = 'busy'; retry = Math.max(retry, 5); return 'stop'; }
    logError('uplisting.sync_write', e, { booking: id });
    stats.errors++;
    return 'skip';
  };
  const today = todayIso();
  try {
    loop: while (!stop) {
      if (st.ph === 'p') {
        if (st.i >= st.L.length) { st.ph = 'c'; continue; }
        const pid = st.L[st.i];
        if (!isMapped(mapping, pid)) { nextListing(st); continue; } // unmapped since the sync started
        if (!upOk(pid)) break;
        let r;
        try { r = await upFetch(env, 'GET', bookingsPath(pid, { from: st.f, to: st.t, page: st.p, per_page: cfg.perPage }), null, { pid }); }
        catch (e) { if (upFailed(e, pid) === 'stop') break; nextListing(st); continue; }
        const list = bookingsOf(r), pages = pagesOf(r);
        for (let k = st.k; k < list.length; k++) {
          const b = normBooking(list[k], pid);
          if (!b) { stats.errors++; continue; }
          if (!fits(1 + 2 * weeksToLoad(b.check_in, b.check_out, memo))) { st.k = k; stop = 'budget'; break loop; }
          let res;
          try { res = await applyBooking(ctx, b); }
          catch (e) { if (stripeFailed(e, b.id) === 'stop') { st.k = k; break loop; } res = null; }
          if (res) countResult(stats, res);
          if (!st.x && !st.seen.includes(b.id)) {
            st.seen.push(b.id);
            if (st.seen.length > cfg.seenMax) { st.x = 1; st.seen = []; }
          }
        }
        st.p++; st.k = 0;
        if (st.p >= pages || !list.length) {
          // every page of this listing read: our active records of it in the window that weren't there are checked one by one
          const seen = new Set(st.seen);
          st.q = st.x ? [] : upRecords(ctx.records).filter(x => x.status === 'active' && x.ext.property_id === pid && x.from >= st.f && x.to <= st.t && !seen.has(x.ext.id)).map(x => x.ext.id);
          st.ph = 'v'; st.seen = [];
        }
        continue;
      }
      if (st.ph === 'v') {
        const pid = st.L[st.i];
        while (st.q.length) {
          const id = st.q[0], rec = byExtId(ctx.records, id)[0];
          if (!rec || rec.status !== 'active') { st.q.shift(); continue; }
          if (!fits(2 + 2 * weeksToLoad(rec.from, rec.to, memo)) || !upOk(pid)) { if (!stop) stop = 'budget'; break loop; }
          let read;
          try { read = await readOne(env, pid, id, rec.from, rec.to); }
          catch (e) { if (upFailed(e, pid) === 'stop') break loop; st.q.shift(); continue; }
          try {
            if (read.booking) { const b = normBooking(read.booking, pid); if (b) countResult(stats, await applyBooking(ctx, b)); else stats.errors++; }
            else if (read.complete) { await cancelRecord(ctx, rec, 'removed'); stats.cancelled++; }
          } catch (e) { if (stripeFailed(e, id) === 'stop') break loop; }
          st.q.shift();
        }
        nextListing(st);
        continue;
      }
      if (st.ph === 'c') {
        // records of listings (or units) no longer mapped: their rooms are free again
        const orphans = upRecords(ctx.records).filter(x => x.status === 'active' && x.to > today && !roomSets(mapping, x.ext.property_id, x.ext.unit).length);
        for (const x of orphans) {
          if (!fits(1)) { stop = 'budget'; break loop; }
          try { await cancelRecord(ctx, x, x.ext.status); stats.cancelled++; }
          catch (e) { if (stripeFailed(e, x.ext.id) === 'stop') break loop; }
        }
        st.ph = 'd';
        continue;
      }
      break; // 'd'
    }
  } catch (e) {
    if (e.type === 'uplisting_error' && e.code === 'auth') { logError('uplisting.sync', e); return { status: 502, data: { error: upErrorText(e), code: 'uplisting_auth' } }; }
    throw e;
  }
  const done = st.ph === 'd' && !stop;
  // the records alone took the whole budget: calling again would never get further
  if (stop === 'budget' && at() === start) {
    return { status: 503, data: { error: 'There are too many records to sync within one request. Please tell the developer.', code: 'too_big' } };
  }
  if (done) {
    try { await writeSettings(env, settings, { aob_last_sync: new Date().toISOString(), aob_last_sync_result: JSON.stringify(stats) }); }
    catch (e) { logError('uplisting.sync_save', e); }
  }
  const data = { ok: true, done, cursor: done ? null : await sealCursor(env, st), progress: { listings_done: Math.min(st.i, st.L.length), listings_total: st.L.length }, stats: { ...stats } };
  if (stop === 'rate_limited' || stop === 'busy') { data.paused = stop; data.retry_after = Math.max(1, Math.min(retry || 10, 300)); }
  return { status: 200, data };
}

/* A fresh start for this isolate's caches (tests). */
export function forgetUplisting() {
  cache.key = null; cache.account = cache.properties = cache.hooks = null;
  settingsMemo.rows = null; settingsMemo.at = 0; settingsWrites.clear(); locks.clear(); callLog.length = 0;
}
