/* AoB booking system ⇄ Uplisting (the channel manager that sells ASHA's rooms on Airbnb, Booking.com, Vrbo,
   Google and as direct bookings). Uplisting is the source of truth for everything sold elsewhere:
   - Inbound bookings: a booking made there takes the matching physical rooms here (off sale for BreathCamp
     online booking, in the rooming calendar and the week boards, flagged when it clashes).
   - Inbound closed nights: nights closed there without a booking (the RetreatGuru ↔ Uplisting routine's
     'RG sync — …' blocks, iCal imports, the owner's own blocks, season closures) come in as "Closed in
     Uplisting" records of the listing's room (single-room listings only, see closureListings).
   - Outbound push (OFF by default, the owner turns it on): the nights the booking system fills (online guests
     placed in a room, manual bookings, the team's blocks) are closed in Uplisting on every listing that
     contains that room, and reopened when they free up — only nights WE closed (the push ledger) are ever
     reopened. Nothing is written to Uplisting while it is off (only the three webhooks we register).
   - Auto-place (on by default): a paid online booking's guests are put in free physical rooms of their type.

   Environment (Cloudflare Pages → Settings → Variables and secrets; never in the repo)
   - UPLISTING_API_KEY         the raw API key (Uplisting → Connect → API). Turns the integration on.
   - UPLISTING_WEBHOOK_SECRET  16+ random characters, part of the webhook URL (?key=…). Uplisting doesn't
                               sign its webhooks: this key is what tells its posts apart from anyone else's.
                               Shorter than 16 characters counts as not set. The same key opens the scheduled
                               sync (?key=…&action=sync) and Uplisting's answers to calendar changes (&notify=1).
   uplistingStatus: 'off' (no API key) | 'no_webhook_secret' | 'on'.

   Uplisting API (https://connect.uplisting.io): Authorization: Basic base64(API key) on every call.
   GET /users/me, GET /properties (JSON:API; multi-units as relationships + included), GET
   /bookings/:property_id?from&to&page (0-based)&per_page (≤ 50) → { bookings, meta: { total_pages } }
   (cancelled bookings included), GET/POST /hooks, DELETE /hooks/:id, GET /calendar/:id?from&to (≤ 12 months,
   both days included) → { calendar: { days: [{ date, available, available_count, … }] } }, POST /calendar/:id
   { notification_url?, calendar: { days: [{ available, from, to (the morning after the last night) } | { available,
   date }] } } → 202 { request_id } (applied a moment later and broadcast to every channel; past days ignored;
   ≤ 3 years ahead; the notification_url gets the result with Authorization = Basic base64(API key)). Limits: 5
   requests a second and 100 a minute per IP, 15 a minute per property (429 beyond). This isolate paces itself
   under 80 a minute and 14 a minute per listing (paceWait); a 429 stops a slice, which hands back its cursor.

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
   Closed nights: the same kind of record with aob_ext_kind 'closed', aob_id = aob_ext_id 'UC-<listing>-<first
   night>', aob_ext_prop, aob_rooms (the listing's one room), aob_comment 'Closed in Uplisting', aob_ext_pname
   (when known); name 'Uplisting · closed · <listing>'. ext.kind is 'booking' | 'closed' on every record.

   Settings: one settings Customer, metadata aob_settings 'uplisting' (name 'AoB booking settings · Uplisting
   (do not delete)'): the mapping (below), aob_last_sync, aob_last_sync_result, aob_push 'on' (absent: off) and
   aob_autoplace 'off' (absent: on). Stripe's 50 keys: the mapping can have 47 keys minus the flags set.
   The push ledger: a second Customer, aob_settings 'uplisting_push' (name 'AoB booking settings · Uplisting push
   (do not delete)'): p<listing id> → the nights we closed there, 'YYYYMMDD+N,…' (≤ 500 characters; nights before
   yesterday are dropped), aob_run (JSON { at, by, n, sa }: the last finished sync, who ran it — 'scheduled' or a
   user — and when the scheduled one last finished) and aob_push_last (JSON: the last push run's result).

   Mapping (which rooms a listing is): keys m<property id> (the whole listing) and
   m<property id>_<unit id> (one unit of a multi-unit listing) → room names joined by '|' (as
   calendarRooms() names them). A booking takes EVERY room mapped to its listing (a whole-cottage listing blocks each
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

   Sync (syncSlice): every mapped listing's bookings from today − 60 days to today + 540 days, then the closed
   nights of the single-room listings (today − 1 to today + 540), then, with the push on, a full push
   reconcile; in slices that stay under 45 subrequests (Stripe + Uplisting, the activity log included); the
   caller calls again with the cursor (opaque, signed, 6 hours) until done. A record of a listing that is no
   longer in Uplisting is cancelled only after all that listing's pages were read without error AND a narrow
   read of that booking (by its dates) doesn't find it either (pages shift while bookings come in). */
import {
  stripe, searchAll, nowSec, logError, str, cut, timingSafeEqual, validDay, addDays, todayIso, overlaps, weekRange, listPrograms, qs,
  calendarRooms, listRecords, recentCustomers, parseRecord, recordsChanged, programPayments, groupBookings, rangeLabel, channelLabel, guestShort,
  timeoutSignal, countSubrequest, isBusy, nightsBetween, recentRaw, isExternal, parseAssign, assignToString, saveAdminMeta, currentBookingMeta,
  forgetBooking, physicalRooms, placeGuests, rateLimited, groupPayments, paysOf, overlappingPrograms, programsPayments,
} from './core.js';
import { logActivity, scrubText, UPLISTING_ACTOR, SYSTEM_ACTOR } from './team.js';

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
  // a slice works within sliceLimit − sliceReserve subrequests; what it writes when it ends (settings, the run
  // record, the activity log) stays within the rest of Cloudflare's 50 (45 in all, with a margin)
  sliceLimit: 40, sliceReserve: 8, sliceUpCalls: 14, perMinute: 80, perListingMinute: 14,
  cursorTtlSec: 6 * 3600, seenMax: 1500,
  triggerBudget: 22, previewUpCalls: 20, previewLimit: 40,
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
  return { customer: list.length ? list[list.length - 1].id : null, rows: list, mapping, last_sync: md.aob_last_sync ? { at: md.aob_last_sync, result } : null,
    push: md.aob_push === 'on' ? 'on' : 'off', autoplace: md.aob_autoplace === 'off' ? 'off' : 'on' };
}
/* The flags take settings keys only when they differ from the default (aob_push 'on', aob_autoplace 'off'):
   the mapping can have MAP_MAX_KEYS minus those (Stripe's 50 keys). */
const flagKeys = s => (s.push === 'on' ? 1 : 0) + (s.autoplace === 'off' ? 1 : 0);
export const mapLimit = s => MAP_MAX_KEYS - flagKeys(s);
function cmpMapKey(a, b) {
  const [pa, ua = ''] = a.split('_'), [pb, ub = ''] = b.split('_');
  return cmpId(pa, pb) || (!ua ? -1 : !ub ? 1 : cmpId(ua, ub));
}
/* The settings. cached: from this isolate's 30 s copy when there is one. fresh: each settings customer read
   directly (search lags a minute behind an update). recentRows: the real-time list of new customers
   (recentCustomers(), a promise of it, or a function giving one) when the caller reads it anyway. */
export async function readSettings(env, { cached: useMemo = true, fresh = false, recentRows = null } = {}) {
  const now = Date.now();
  if (useMemo && !fresh && settingsMemo.rows && now - settingsMemo.at < cfg.settingsMs && now >= settingsMemo.at) return { ...mergeSettings(settingsMemo.rows), memo: true };
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
  if (Object.keys(mapping).length > mapLimit(s)) return { status: 422, data: { error: 'Please check the mapping.', fields: { mapping: `At most ${mapLimit(s)} listings and units can be mapped.` } } };
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
const upBookingRecs = records => upRecords(records).filter(r => r.ext.kind !== 'closed');
const upClosureRecs = records => upRecords(records).filter(r => r.ext.kind === 'closed');
/* Our records of one Uplisting booking: the active one first, then the oldest. */
const byExtId = (records, id) => upBookingRecs(records).filter(r => r.ext.id === id)
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

/* ------------------------------------------------------------------ nights */
const nightsIn = (from, to) => { const out = []; for (let d = from; d < to; d = addDays(d, 1)) out.push(d); return out; };
const minDay = list => list.reduce((a, b) => (a < b ? a : b));
const maxDay = list => list.reduce((a, b) => (a > b ? a : b));
/* Nights (any order, repeats allowed) → [{ from, to }] (to: the morning after the last night), merged. */
export function rangesOf(nights) {
  const out = [];
  for (const d of [...new Set(nights)].sort()) {
    const last = out[out.length - 1];
    if (last && last.to === d) last.to = addDays(d, 1); else out.push({ from: d, to: addDays(d, 1) });
  }
  return out;
}

/* ------------------------------------------------------------------ calendar */
const CAL_CHUNK = 365; // GET /calendar answers at most 12 months at a time
const calChunks = (from, to) => Math.ceil(nightsBetween(from, to) / CAL_CHUNK);
/* Uplisting's calendar of one listing for the nights [from, to): Map night → available (true | false); a night
   it doesn't list is not in the map. upOk(pid) is asked before each call (false: stop, → null). Errors throw
   (upFetch). */
export async function readCalendar(env, pid, from, to, upOk = null) {
  const out = new Map();
  for (let cur = from; cur < to;) {
    const end = addDays(cur, CAL_CHUNK) < to ? addDays(cur, CAL_CHUNK) : to;
    if (upOk && !upOk(pid)) return null;
    const r = await upFetch(env, 'GET', `/calendar/${encodeURIComponent(pid)}?` + qs({ from: cur, to: addDays(end, -1) }), null, { pid });
    const days = r && r.calendar && Array.isArray(r.calendar.days) ? r.calendar.days : Array.isArray(r && r.days) ? r.days : [];
    for (const d of days) {
      if (!d || !validDay(d.date) || d.date < cur || d.date >= end) continue;
      out.set(d.date, d.available === true || (d.available == null && Number(d.available_count) > 0));
    }
    cur = end;
  }
  return out;
}

/* ------------------------------------------------------- the push ledger */
/* What we closed in Uplisting, per listing: p<listing id> → 'YYYYMMDD+N,…' (N nights from that night). */
export const LEDGER_MAX = 500;
const LEDGER_RE = /^(\d{4})(\d{2})(\d{2})\+(\d{1,4})$/;
const LEDGER_KEY = /^p([A-Za-z0-9-]{1,24})$/;
export function parseLedger(v) {
  const out = new Set();
  for (const part of String(v || '').split(',')) {
    const m = LEDGER_RE.exec(part.trim());
    if (!m) continue;
    const from = `${m[1]}-${m[2]}-${m[3]}`, n = parseInt(m[4], 10);
    if (!validDay(from) || n < 1 || n > 1200) continue;
    for (let i = 0, d = from; i < n; i++, d = addDays(d, 1)) out.add(d);
  }
  return out;
}
export const encodeLedger = nights => rangesOf([...nights]).map(r => `${r.from.replace(/-/g, '')}+${nightsBetween(r.from, r.to)}`).join(',');
/* The ledger after a change: nights before yesterday dropped (they are past: Uplisting ignores them), reopened
   nights out, closed nights in. */
export function nextLedger(ledger, close, reopen, today) {
  const keep = addDays(today, -1), drop = new Set(reopen), out = new Set();
  for (const d of ledger) if (d >= keep && !drop.has(d)) out.add(d);
  for (const d of close) out.add(d);
  return out;
}
const PUSH_QUERY = "metadata['aob_settings']:'uplisting_push'";
export const PUSH_NAME = 'AoB booking settings · Uplisting push (do not delete)';
const PUSH_DESCRIPTION = 'The nights the booking system closed in Uplisting, and the last sync (do not delete)';
const isPushCus = c => !!c && !c.deleted && (c.metadata || {}).aob_settings === 'uplisting_push';
const jsonOr = v => { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
/* Push customers (normally one) merged oldest → newest, the newest wins per key. → { customer, rows, ledger: {
   pid: Set of nights }, run: { at, by, n, sa } | null, last: the last push result | null } */
export function mergePush(rows) {
  const list = (rows || []).filter(isPushCus).sort((a, b) => ((a.created || 0) - (b.created || 0)) || (a.id < b.id ? -1 : 1));
  const md = {};
  for (const c of list) for (const [k, v] of Object.entries(c.metadata || {})) if (v !== '' && v != null) md[k] = v;
  const ledger = {};
  for (const k of Object.keys(md)) { const m = LEDGER_KEY.exec(k); if (m) { const set = parseLedger(md[k]); if (set.size) ledger[m[1]] = set; } }
  return { customer: list.length ? list[list.length - 1].id : null, rows: list, ledger, run: jsonOr(md.aob_run), last: jsonOr(md.aob_push_last) };
}
/* The push customer, read directly (search lags behind updates and the ledger must never be read stale): one
   search + one read (recentRows: the real-time list of new customers, already read). */
export async function readPush(env, { recentRows = null } = {}) {
  const recent = typeof recentRows === 'function' ? recentRows() : recentRows || recentCustomers(env);
  const [found, latest] = await Promise.all([searchAll(env, PUSH_QUERY, 100, 'customers'), recent]);
  const byId = new Map();
  for (const c of [...found, ...(latest || [])]) if (isPushCus(c)) byId.set(c.id, c);
  const rows = (await Promise.all([...byId.values()].map(c => stripe(env, 'GET', `/customers/${c.id}`).catch(e => { if (e.status === 404) return null; throw e; })))).filter(isPushCus);
  return mergePush(rows);
}
const newPushCustomer = (env, key) => stripe(env, 'POST', '/customers', { name: PUSH_NAME, description: PUSH_DESCRIPTION, metadata: { aob_settings: 'uplisting_push' } }, key ? { idempotencyKey: key } : {});
/* Merge `fields` into the push customer (made when there is none: one per day's idempotency key, so two
   isolates make one). Older duplicates lose those keys (they must not come back through the merge). */
async function writePush(env, push, fields) {
  if (!push.customer) { const c = await newPushCustomer(env, `aob-uplisting-push-${todayIso()}`); push.customer = c.id; push.rows = [...push.rows.filter(x => x.id !== c.id), c]; }
  let c;
  try { c = await stripe(env, 'POST', `/customers/${push.customer}`, { metadata: fields }); }
  catch (e) {
    if (e.status !== 404) throw e;
    // deleted since (or the idempotency key gave back one deleted today): a new one
    const n = await newPushCustomer(env, null);
    push.rows = push.rows.filter(x => x.id !== push.customer); push.customer = n.id;
    c = await stripe(env, 'POST', `/customers/${n.id}`, { metadata: fields });
  }
  for (const o of push.rows.filter(x => x.id !== c.id)) {
    const clear = Object.fromEntries(Object.keys(fields).filter(k => (o.metadata || {})[k] !== undefined).map(k => [k, '']));
    if (!Object.keys(clear).length) continue;
    try { const u = await stripe(env, 'POST', `/customers/${o.id}`, { metadata: clear }); o.metadata = u.metadata; } catch (e) { logError('uplisting.push_duplicate', e); }
  }
  push.rows = [...push.rows.filter(x => x.id !== c.id), c];
  return c;
}
/* What Uplisting took (202) is remembered in the run's memory at once (push.ledger, push.pending) and written
   by flushLedger: the push customer read again right before the write (another isolate may have written it a
   moment ago), each listing's ledger minus what we reopened, plus what we closed; one write for every listing
   of the run (2 subrequests). Callers flush in a finally: what Uplisting took is never left unrecorded. */
function noteLedger(push, pid, close, reopen, today) {
  const p = push.pending || (push.pending = {});
  const cur = p[pid] || (p[pid] = { close: new Set(), reopen: new Set() });
  for (const d of reopen) { cur.reopen.add(d); cur.close.delete(d); }
  for (const d of close) { cur.close.add(d); cur.reopen.delete(d); }
  const next = nextLedger(push.ledger[pid] || new Set(), close, reopen, today);
  if (next.size) push.ledger[pid] = next; else delete push.ledger[pid];
}
async function flushLedger(env, push, today) {
  const pending = push.pending || {};
  const pids = Object.keys(pending);
  if (!pids.length) return;
  let md = null;
  if (push.customer) {
    try { const cur = await stripe(env, 'GET', `/customers/${push.customer}`); if (isPushCus(cur)) md = cur.metadata || {}; }
    catch (e) { if (e.status !== 404) throw e; }
  }
  const fields = {};
  for (const pid of pids) {
    const base = md ? parseLedger(md[`p${pid}`]) : (push.ledger[pid] || new Set());
    let next = nextLedger(base, [...pending[pid].close], [...pending[pid].reopen], today);
    if (encodeLedger(next).length > LEDGER_MAX) next = nextLedger(base, [], [...pending[pid].reopen], today);
    fields[`p${pid}`] = encodeLedger(next);
    if (next.size) push.ledger[pid] = next; else delete push.ledger[pid];
  }
  if (!push.customer && Object.values(fields).every(v => !v)) { push.pending = {}; return; }
  await writePush(env, push, fields);
  push.pending = {};
}
/* flushLedger that never throws (logged; a warning for the caller). → true when written */
async function flushSafe(env, push, today, warnings = null) {
  if (!push) return true;
  try { await flushLedger(env, push, today); return true; }
  catch (e) {
    logError('uplisting.push_ledger', e, { listings: Object.keys(push.pending || {}).join(',').slice(0, 200) });
    if (warnings && warnings.length < 10) warnings.push('Uplisting took the changes, but they could not be recorded here (Stripe). Check those listings\' calendars in Uplisting.');
    return false;
  }
}

/* ------------------------------------------------------------- occupancy */
/* The nights the booking system fills, per physical room: online guests placed in a room (aob_assign) for
   their week, manual bookings' guests, and the team's blocks (never Uplisting's own records: those came
   from there). weeks: [{ program, bookings (groupBookings) }]. → Map room → [{ from, to, ref }] */
export function aobOccupancy(weeks, records) {
  const occ = new Map();
  const add = (room, from, to, ref) => { if (!room || !ref) return; if (!occ.has(room)) occ.set(room, []); occ.get(room).push({ from, to, ref }); };
  for (const { program, bookings } of weeks || []) {
    const wk = weekRange(program);
    for (const b of bookings || []) {
      if (b.status === 'cancelled' || b.source === 'manual') continue;
      for (const [i, name] of Object.entries(b.assign || {})) if (name && b.guests[i]) add(name, wk.from, wk.to, b.ref);
    }
  }
  for (const r of records || []) {
    if (!r || r.status !== 'active') continue;
    if (r.type === 'booking') r.guests.forEach(g => add(g.room_name, r.from, r.to, r.ref));
    else if (r.reason !== 'uplisting' && !isExternal(r)) r.rooms.forEach(n => add(n, r.from, r.to, r.id));
  }
  return occ;
}
/* A booking as it is right after a change this request made (search lags behind it): { ref, assign?, status? } */
function withOverride(bookings, o) {
  if (!o || !o.ref) return bookings;
  return bookings.map(b => (b.ref !== o.ref ? b : { ...b, ...(o.assign ? { assign: { ...o.assign } } : {}), ...(o.status ? { status: o.status } : {}) }));
}
const weeksIn = (from, to) => listPrograms().filter(p => overlaps(weekRange(p), { from, to })).sort((a, b) => (a.dates.start < b.dates.start ? -1 : 1));
/* Stripe calls to read the weeks [from, to) overlaps: 2 real-time lists + 2 searches per 10 weeks (one OR'ed search
   for them all, see programsPayments) */
const weeksCost = (from, to) => { const n = weeksIn(from, to).length; return n ? 2 + 2 * Math.ceil(n / 10) : 0; };
async function loadWeeks(env, from, to, override = null) {
  const progs = weeksIn(from, to);
  if (!progs.length) return [];
  const every = await programsPayments(env, progs);
  return progs.map(p => ({ program: p, bookings: withOverride(groupBookings(p, paysOf(every, p.id)), override) }));
}

/* -------------------------------------------------------------- the push */
/* The listings the push writes to: the ones mapped as a whole (Uplisting's calendar is per listing: a listing
   mapped by units is left out), with their rooms. → Map pid → [room names] */
export function pushListings(mapping) {
  const out = new Map();
  for (const k of Object.keys(mapping || {}).sort(cmpMapKey)) if (!k.includes('_')) out.set(k, mapping[k].slice());
  return out;
}
const unitOnly = mapping => mappedProperties(mapping).filter(pid => !mapping[pid]);
/* What the push does for one listing over [from, to): desired (night → Set of references: the occupancy of
   any of its rooms), close (desired, not ours, available — or not checked when cal is null), reclose (ours
   and desired but available again: verify only), skipped (desired, not ours, already closed: left alone),
   unknown (not in the calendar's answer), reopen (ours, no longer desired). */
export function planListing({ rooms, occ, ledger, cal = null, from, to, verify = false }) {
  const desired = new Map();
  for (const room of rooms || []) {
    for (const iv of occ.get(room) || []) {
      const a = iv.from > from ? iv.from : from, b = iv.to < to ? iv.to : to;
      for (let d = a; d < b; d = addDays(d, 1)) { if (!desired.has(d)) desired.set(d, new Set()); desired.get(d).add(iv.ref); }
    }
  }
  const close = [], reclose = [], skipped = [], unknown = [], reopen = [];
  for (const d of [...desired.keys()].sort()) {
    const av = cal ? cal.get(d) : undefined;
    if (!ledger.has(d)) {
      if (!cal || av === true) close.push(d); else if (av === false) skipped.push(d); else unknown.push(d);
    } else if (verify && cal && av === true) reclose.push(d);
  }
  for (const d of [...ledger].sort()) if (d >= from && d < to && !desired.has(d)) reopen.push(d);
  return { desired, close, reclose, skipped, unknown, reopen };
}
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
/* Where Uplisting answers a calendar change (needs the webhook secret and a public host), or null. */
export function notifyUrl(env, host, pid) {
  const secret = hookSecret(env);
  if (!secret || !host || LOCAL_HOST.test(host)) return null;
  return `https://${host}${HOOK_PATH}?key=${encodeURIComponent(secret)}&notify=1&listing=${encodeURIComponent(pid)}`;
}
/* '1 (Full) - Peace Cottage' → '1 (Full)' (the listing as the team calls it), else its name, else 'listing <id>' */
const shortNick = p => { const n = str(p && (p.nickname || p.name), 120); const i = n.indexOf(' - '); return i > 0 ? n.slice(0, i).trim() : n; };
const listingLabel = (props, pid) => shortNick(props && props.get(pid)) || `listing ${pid}`;
const nicknameOf = (props, pid) => { const p = props && props.get(pid); return p ? str(p.nickname || p.name, 200) : ''; };
const refsText = refs => (refs.length <= 3 ? refs.join(', ') : `${refs.slice(0, 3).join(', ')} + ${refs.length - 3} more`);
/* The activity entry of what one run closed (kind 'close') or reopened ('reopen') in Uplisting. items: [{ pid,
   from, to, refs }]. Listings closed over the same nights for the same bookings share one part: 'Closed in
   Uplisting: 1B · Peace Cottage (+ 1 (Full)) 18–24 Jul 2027 · BC2707-…' (the room of a one-room listing first). */
export function pushSummary(kind, items, { props = null, listings = new Map(), ref = null } = {}) {
  if (!items || !items.length) return null;
  const byRange = new Map();
  for (const it of items) {
    const refs = [...new Set(it.refs || [])].sort(), k = `${it.from}|${it.to}|${refs.join(',')}`;
    if (!byRange.has(k)) byRange.set(k, { from: it.from, to: it.to, refs, pids: [] });
    const g = byRange.get(k);
    if (!g.pids.includes(it.pid)) g.pids.push(it.pid);
  }
  const groups = new Map();
  for (const g of byRange.values()) {
    g.pids.sort(cmpId);
    const k = `${g.pids.join(',')}|${g.refs.join(',')}`;
    if (!groups.has(k)) groups.set(k, { pids: g.pids, refs: g.refs, ranges: [] });
    groups.get(k).ranges.push(g);
  }
  const parts = [...groups.values()].map(g => {
    const one = g.pids.find(pid => (listings.get(pid) || []).length === 1);
    const head = one ? listings.get(one)[0] : listingLabel(props, g.pids[0]);
    const others = g.pids.filter(pid => pid !== (one || g.pids[0])).map(pid => listingLabel(props, pid));
    const ranges = g.ranges.sort((a, b) => (a.from < b.from ? -1 : 1)).map(r => rangeLabel(r.from, r.to)).join(', ');
    const refs = g.refs.length ? g.refs : ref ? [ref] : [];
    return `${head}${others.length ? ` (+ ${others.join(', ')})` : ''} ${ranges}${refs.length ? ` · ${refsText(refs)}` : ''}`;
  });
  const firstRef = ref || ((items.find(x => (x.refs || []).length) || {}).refs || [])[0] || null;
  const home = weeksIn(items[0].from, items[0].to)[0];
  return { action: kind === 'close' ? 'uplisting_push_close' : 'uplisting_push_reopen', ref: firstRef, program: home ? home.id : null,
    summary: `${kind === 'close' ? 'Closed' : 'Reopened'} in Uplisting: ${parts.join('; ')}` };
}
const zeroPush = () => ({ closed: 0, reopened: 0, skipped_closed: 0, refused: 0, listings: 0, errors: 0 });
const PUSH_KEYS = Object.keys(zeroPush());
const pushWarn = (ctx, text) => { if (ctx.warnings.length < 10 && !ctx.warnings.includes(text)) ctx.warnings.push(cut(text, 200)); };
/* One listing: plan (reading Uplisting's calendar for the nights to check), then — writing — one POST with every
   range to close and reopen, then the ledger. ctx: { env, mode: 'write' | 'preview', verify, listings, occ,
   push, props, today, host, fits(n), upOk(pid), failed(e, pid) → 'stop' | 'skip', stats, warnings, closeItems,
   reopenItems, preview: { close, reopen, skipped } }. → 'ok' | 'budget' (call again with more room) | 'stop'
   (rate-limited or busy: ctx.failed / upOk said why) | 'skip' (this listing failed) */
async function pushListing(ctx, pid, from, to) {
  const write = ctx.mode === 'write', rooms = ctx.listings.get(pid) || [], ledger = ctx.push.ledger[pid] || new Set();
  const base = planListing({ rooms, occ: ctx.occ, ledger, from, to });
  const check = ctx.verify ? [...base.desired.keys()] : base.close;
  let cal = null, unchecked = false;
  if (check.length) {
    const cf = minDay(check), ct = addDays(maxDay(check), 1);
    if (!ctx.fits(calChunks(cf, ct) + (write ? 3 : 0))) { if (write) return 'budget'; unchecked = true; } // + the POST and the ledger's write
    else {
      try { cal = await readCalendar(ctx.env, pid, cf, ct, ctx.upOk); }
      catch (e) { const r = ctx.failed(e, pid); if (r === 'stop' || write) return r; unchecked = true; }
      if (!cal && !unchecked) { if (write) return 'stop'; unchecked = true; }
    }
  } else if (write && base.reopen.length && !ctx.fits(3)) return 'budget';
  const plan = cal ? planListing({ rooms, occ: ctx.occ, ledger, cal, from, to, verify: ctx.verify }) : base;
  let close = plan.close;
  if (close.length && encodeLedger(nextLedger(ledger, close, plan.reopen, ctx.today)).length > LEDGER_MAX) {
    ctx.stats.refused++;
    pushWarn(ctx, `${listingLabel(ctx.props, pid)}: too many separate closed ranges to remember (500 characters), so no more nights are closed there. Reopen or merge some in the booking system first.`);
    close = [];
  }
  if (plan.unknown.length) pushWarn(ctx, `${listingLabel(ctx.props, pid)}: Uplisting's calendar didn't list ${plan.unknown.length} of the nights, so they were left alone.`);
  const because = nights => [...new Set(nights.flatMap(d => [...(plan.desired.get(d) || [])]))].sort();
  const withRefs = nights => rangesOf(nights).map(r => ({ ...r, nights: nightsBetween(r.from, r.to), because: because(nightsIn(r.from, r.to)) }));
  const closing = [...close, ...plan.reclose];
  if (!write) {
    const nick = nicknameOf(ctx.props, pid);
    withRefs(closing).forEach(r => ctx.preview.close.push({ listing_id: pid, nickname: nick, from: r.from, to: r.to, nights: r.nights, because: r.because, ...(unchecked ? { unchecked: true } : {}) }));
    rangesOf(plan.reopen).forEach(r => ctx.preview.reopen.push({ listing_id: pid, nickname: nick, from: r.from, to: r.to, nights: nightsBetween(r.from, r.to), because: [] }));
    withRefs(plan.skipped).forEach(r => ctx.preview.skipped.push({ listing_id: pid, nickname: nick, from: r.from, to: r.to, nights: r.nights, because: r.because }));
    if (unchecked) ctx.unchecked.push(pid);
    return 'ok';
  }
  ctx.stats.skipped_closed += plan.skipped.length;
  if (!closing.length && !plan.reopen.length) return 'ok';
  if (!ctx.upOk(pid)) return 'stop';
  const days = [...rangesOf(closing).map(r => ({ available: false, from: r.from, to: r.to })), ...rangesOf(plan.reopen).map(r => ({ available: true, from: r.from, to: r.to }))];
  const body = { calendar: { days } }, url = notifyUrl(ctx.env, ctx.host, pid);
  if (url) body.notification_url = url;
  try { await upFetch(ctx.env, 'POST', `/calendar/${encodeURIComponent(pid)}`, body, { pid }); }
  catch (e) { return ctx.failed(e, pid); }
  noteLedger(ctx.push, pid, close, plan.reopen, ctx.today);
  ctx.stats.listings++; ctx.stats.closed += closing.length; ctx.stats.reopened += plan.reopen.length;
  withRefs(closing).forEach(r => ctx.closeItems.push({ pid, from: r.from, to: r.to, refs: r.because }));
  rangesOf(plan.reopen).forEach(r => ctx.reopenItems.push({ pid, from: r.from, to: r.to, refs: [] }));
  return 'ok';
}
/* The properties for labels (this isolate's 5-minute copy; one call when there is none and room for it). */
async function propsFor(env, may = () => true) {
  const c = cached(env, 'properties', false);
  if (c) return new Map(c.map(p => [p.id, p]));
  if (!may()) return new Map();
  try { return new Map((await getProperties(env)).map(p => [p.id, p])); }
  catch (e) { if (e.type !== 'uplisting_error') throw e; logError('uplisting.properties', e); return new Map(); }
}
/* The push setting as it is now: a memo copy of the settings is confirmed by a fresh read (it may have just
   been turned off in another isolate: nothing is written to Uplisting unless it is on). */
async function pushIsOn(env, settings, recentRows) {
  if (settings.push !== 'on') return false;
  if (!settings.memo) return true;
  return (await readSettings(env, { cached: false, fresh: true, recentRows })).push === 'on';
}

/* After a change that moves the booking system's occupancy (a paid booking placed, assign, cancel, restore,
   manual bookings, blocks): the listings containing `rooms` reconciled over [from, to) (today on), when the
   push is on. Best effort, its own budget (cfg.triggerBudget subrequests: what doesn't fit waits for the next
   sync's full reconcile), never throws. actor: who triggered it (activity log). override: { ref, assign?,
   status? } (a booking this request changed: search lags). weeks / records: already read. → a summary */
export async function pushAfter(envIn, { actor, host = '', rooms = [], from, to, override = null, weeks = null, records = null, ref = null } = {}) {
  try {
    if (uplistingStatus(envIn) === 'off' || !envIn.STRIPE_SECRET_KEY || !rooms.length || !validDay(from) || !validDay(to)) return { skipped: 'off' };
    const env = { ...envIn, subrequests: { n: 0 } };
    const used = () => env.subrequests.n, fits = n => used() + n <= cfg.triggerBudget;
    // the real-time list of new customers only when something is read (with the push off: this isolate's memo, no call)
    let freshP = null;
    const fresh = () => { if (!freshP) { freshP = recentCustomers(env); freshP.catch(() => {}); } return freshP; };
    const settings = await readSettings(env, { cached: true, recentRows: fresh });
    if (!(await pushIsOn(env, settings, fresh))) return { skipped: 'off' };
    const today = todayIso(), horizon = addDays(today, cfg.daysAhead);
    const f = from > today ? from : today, t = to < horizon ? to : horizon;
    if (f >= t) return { skipped: 'past' };
    const listings = pushListings(settings.mapping), want = new Set(rooms);
    const pids = [...listings.keys()].filter(pid => listings.get(pid).some(r => want.has(r))).sort(cmpId);
    if (!pids.length) return { skipped: 'unmapped' };
    const [push, recs, wk] = await Promise.all([readPush(env, { recentRows: fresh }), records || listRecords(env, { recentRows: fresh() }), weeks || loadWeeks(env, f, t, override)]);
    const props = await propsFor(env, () => fits(6) && !paceWait(''));
    let stop = null;
    const ctx = {
      env, mode: 'write', verify: false, listings, occ: aobOccupancy(withOverrideWeeks(wk, override), recs), push, props, today, host, fits,
      upOk: pid => { const w = paceWait(pid); if (w) { stop = 'rate_limited'; return false; } return true; },
      failed: (e, pid) => {
        if (e.type !== 'uplisting_error') throw e;
        logError('uplisting.push_trigger', e, { property: pid });
        if (upBusy(e) || e.code === 'auth') { stop = e.status === 429 ? 'rate_limited' : e.code === 'auth' ? 'auth' : 'busy'; return 'stop'; }
        ctx.stats.errors++; return 'skip';
      },
      stats: zeroPush(), warnings: [], closeItems: [], reopenItems: [],
    };
    const left = [];
    try {
      for (const pid of pids) {
        if (stop) { left.push(pid); continue; }
        const r = await serial(`push:${pid}`, () => pushListing(ctx, pid, f, t));
        if (r === 'budget' || r === 'stop') left.push(pid);
      }
    } finally { if (!(await flushSafe(env, push, today, ctx.warnings))) ctx.stats.errors++; }
    if (left.length) logError('uplisting.push_trigger', { type: stop || 'budget' }, { left: left.join(',').slice(0, 200) });
    const refText = ref || (override && override.ref) || null;
    for (const kind of ['close', 'reopen']) {
      const e = pushSummary(kind, kind === 'close' ? ctx.closeItems : ctx.reopenItems, { props, listings, ref: refText });
      if (e) await logActivity(envIn, actor || SYSTEM_ACTOR, e);
    }
    return { ...ctx.stats, left, warnings: ctx.warnings, subrequests: used() };
  } catch (e) { logError('uplisting.push_trigger', e); return { error: true }; }
}
const withOverrideWeeks = (weeks, o) => (o && o.ref ? weeks.map(w => ({ ...w, bookings: withOverride(w.bookings, o) })) : weeks);

/* GET ?uplisting_push_preview=1: what a push would close and reopen now, over every listing (today to today +
   540), without writing anything. Uplisting's calendar is read for as many listings as fit in one request; the
   others are worked out without it (unchecked: true, and a warning). → { status, data: { push, close, reopen,
   skipped_closed, warnings, listings, checked } } */
export async function pushPreview(envIn) {
  if (!apiKey(envIn)) return { status: 503, data: { error: 'Uplisting is not connected: set UPLISTING_API_KEY in Cloudflare first.', code: 'uplisting_off' } };
  const env = { ...envIn, subrequests: { n: 0 } };
  const used = () => env.subrequests.n;
  let upCalls = 0;
  const fresh = recentCustomers(env);
  fresh.catch(() => {});
  const [settings, push, recs] = await Promise.all([readSettings(env, { cached: false, fresh: true, recentRows: fresh }), readPush(env, { recentRows: fresh }), listRecords(env, { recentRows: fresh })]);
  const today = todayIso(), horizon = addDays(today, cfg.daysAhead);
  const weeks = await loadWeeks(env, today, horizon);
  const warnings = [];
  const props = await propsFor(env);
  const listings = pushListings(settings.mapping);
  const R = [...new Set([...listings.keys(), ...Object.keys(push.ledger)])].sort(cmpId);
  const ctx = {
    env, mode: 'preview', verify: true, listings, occ: aobOccupancy(weeks, recs), push, props, today, host: '',
    fits: n => upCalls + n <= cfg.previewUpCalls && used() + n <= cfg.previewLimit,
    upOk: pid => { if (paceWait(pid)) return false; upCalls++; return true; },
    failed: (e, pid) => { if (e.type !== 'uplisting_error') throw e; logError('uplisting.preview', e, { property: pid }); pushWarn(ctx, `${listingLabel(props, pid)}: ${upErrorText(e)}`); return 'skip'; },
    stats: zeroPush(), warnings, closeItems: [], reopenItems: [], preview: { close: [], reopen: [], skipped: [] }, unchecked: [],
  };
  for (const pid of R) await pushListing(ctx, pid, today, horizon);
  for (const pid of unitOnly(settings.mapping)) pushWarn(ctx, `${listingLabel(props, pid)} is mapped by units: it is not pushed (Uplisting's calendar is per listing).`);
  if (ctx.unchecked.length) pushWarn(ctx, `The calendars of ${ctx.unchecked.length} ${ctx.unchecked.length === 1 ? 'listing were' : 'listings were'} not read in this preview (${ctx.unchecked.map(pid => listingLabel(props, pid)).slice(0, 5).join(', ')}${ctx.unchecked.length > 5 ? '…' : ''}): nights already closed there may show under close.`);
  return { status: 200, data: { push: settings.push, close: ctx.preview.close, reopen: ctx.preview.reopen, skipped_closed: ctx.preview.skipped, warnings, listings: R.length, checked: R.length - ctx.unchecked.length } };
}

/* uplisting_push { mode } / uplisting_autoplace { mode } (owner): the settings flags. → { status, data } */
export async function saveFlag(env, flag, mode) {
  if (mode !== 'on' && mode !== 'off') return { status: 422, data: { error: 'Choose on or off.', fields: { mode: 'Choose on or off.' } } };
  if (flag === 'push' && !apiKey(env)) return { status: 503, data: { error: 'Uplisting is not connected: set UPLISTING_API_KEY in Cloudflare first.', code: 'uplisting_off' } };
  const s = await readSettings(env, { cached: false, fresh: true });
  if (s[flag] === mode) return { status: 200, data: { ok: true, [flag]: mode, unchanged: true } };
  if (Object.keys(s.mapping).length > mapLimit({ ...s, [flag]: mode })) {
    return { status: 409, data: { error: `The Uplisting settings are full (${Object.keys(s.mapping).length} listings and units mapped): unmap one first.`, code: 'settings_full' } };
  }
  const key = flag === 'push' ? 'aob_push' : 'aob_autoplace';
  const value = flag === 'push' ? (mode === 'on' ? 'on' : '') : (mode === 'off' ? 'off' : '');
  await writeSettings(env, s, { [key]: value });
  for (const c of s.rows.slice(0, -1)) if ((c.metadata || {})[key] !== undefined) rememberSettings(await stripe(env, 'POST', `/customers/${c.id}`, { metadata: { [key]: '' } }));
  return { status: 200, data: { ok: true, [flag]: mode } };
}

/* -------------------------------------------------- Uplisting's answer to a change */
/* POST /api/booking/uplisting?key=…&notify=1&listing=<id>: Uplisting reports whether a calendar change was
   applied. Its Authorization header must be base64(API key) (with or without 'Basic '). A failure, and a
   wrong header with the right key, go to the activity log. → { status, failed } */
const notifyFailed = b => !!b && typeof b === 'object' && (b.success === false || /^(fail|failed|failure|error|errored|rejected)$/i.test(String(b.status || ''))
  || (Array.isArray(b.errors) ? b.errors.length > 0 : !!b.errors && typeof b.errors === 'object' ? Object.keys(b.errors).length > 0 : !!b.errors) || !!b.error);
const errorsText = b => {
  const e = b.errors || b.error || b.message || '';
  const t = Array.isArray(e) ? e.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ') : typeof e === 'object' ? JSON.stringify(e) : String(e);
  return cut(scrubText(t), 160);
};
export async function handleNotify(env, { authorization = '', listing = '', body = null } = {}) {
  const want = b64(enc.encode(apiKey(env))), got = String(authorization || '').replace(/^Basic\s+/i, '').trim();
  const pid = ID_RE.test(String(listing || '')) ? String(listing) : '';
  if (!apiKey(env) || !got || !timingSafeEqual(await sha256hex(got), await sha256hex(want))) {
    if (!rateLimited('uplisting-notify-auth', 1, 60000)) {
      await logActivity(env, SYSTEM_ACTOR, { action: 'uplisting_push_error', summary: `Refused an answer to a calendar change${pid ? ` (listing ${pid})` : ''}: its Authorization header is not Uplisting's.` });
    }
    return { status: 401, failed: null };
  }
  const failed = notifyFailed(body);
  if (failed) {
    const req = body && /^[A-Za-z0-9-]{1,64}$/.test(String(body.request_id || '')) ? String(body.request_id) : '';
    const why = errorsText(body);
    await logActivity(env, SYSTEM_ACTOR, { action: 'uplisting_push_error',
      summary: `Uplisting could not apply a calendar change${pid ? ` for listing ${pid}` : ''}${req ? ` (request ${req})` : ''}${why ? `: ${why}` : ''}. The next sync tries again.` });
  }
  return { status: 200, failed };
}

/* ------------------------------------------------------------- auto-place */
/* A paid online booking's guests who have no room yet go into free physical rooms of their room type for the
   week (placeGuests: same-gender sharing, partly used rooms of their gender first, one booking's guests
   together, never a blocked or Uplisting-taken room), saved as aob_assign. Runs with the Uplisting integration
   (an API key) and the aob_autoplace setting on (the default). Idempotent (Stripe retries webhooks): placed
   guests stay where they are. Then, with the push on, the rooms are closed in Uplisting (returned as `push`,
   a promise for waitUntil). md: the booking's metadata (aob_g*: who and which room types). */
export async function autoPlace(env, program, md, { host = '', actor = SYSTEM_ACTOR } = {}) {
  const ref = md && md.aob_ref;
  if (!program || !ref || md.aob_kind !== 'booking') return { placed: 0, reason: 'not_a_booking' };
  if (uplistingStatus(env) === 'off' || !env.STRIPE_SECRET_KEY) return { placed: 0, reason: 'uplisting_off' };
  const named = id => !!((program.rooms.find(r => r.id === id) || {}).names || []).length;
  let any = false;
  for (let i = 1; i <= 12; i++) { const v = md[`aob_g${i}`]; if (v && named(v.split(' | ')[3])) any = true; }
  if (!any) return { placed: 0, reason: 'no_rooms' };
  const settings = await readSettings(env, { cached: true });
  if (settings.autoplace === 'off') return { placed: 0, reason: 'off' };
  const recent = recentRaw(env);
  recent.catch(() => {});
  // the programs overlapping this week share its rooms: their placed guests are read in the same searches
  const [every, records] = await Promise.all([groupPayments(env, program, { recent }), listRecords(env, { recent: true })]);
  const all = groupBookings(program, paysOf(every, program.id)), booking = all.find(b => b.ref === ref);
  const near = overlappingPrograms(program).map(q => ({ program: q, bookings: groupBookings(q, paysOf(every, q.id)) }));
  if (!booking) return { placed: 0, reason: 'not_found' };
  const cur = await currentBookingMeta(env, booking); // fresh: the team may have placed someone a moment ago
  if (cur.aob_status === 'cancelled' || booking.status === 'cancelled') return { placed: 0, reason: 'cancelled' };
  const have = parseAssign(cur.aob_assign);
  const guests = booking.guests.map((g, i) => ({ i, gender: g.gender, room: g.room })).filter(g => !have[g.i] && named(g.room));
  if (!guests.length) return { placed: 0, reason: 'placed' };
  const others = all.map(b => (b.ref === ref ? { ...b, assign: have } : b));
  const add = placeGuests(program, physicalRooms(program, others, records, near), guests, null, ref);
  const n = Object.keys(add).length;
  if (!n) return { placed: 0, unplaced: guests.length, reason: 'no_room' };
  const assign = { ...have, ...add }, s = assignToString(assign);
  if (s.length > 490) return { placed: 0, reason: 'too_long' };
  await saveAdminMeta(env, booking, { aob_assign: s });
  forgetBooking(ref);
  const names = [...new Set(Object.keys(add).sort((a, b) => a - b).map(k => String(add[k]).split(' · ')[0]))];
  const unplaced = guests.length - n, wk = weekRange(program);
  await logActivity(env, actor, { action: 'autoplace', ref, program: program.id,
    summary: `Placed ${ref} ${n === 1 ? 'guest' : 'guests'} in ${names.join(', ')} automatically${unplaced ? ` · ${unplaced} not placed (no free room)` : ''}` });
  const result = { placed: n, unplaced, assign };
  if (settings.push === 'on') {
    const rooms = [...new Set(Object.values(assign))];
    result.push = pushAfter(env, { actor, host, rooms, from: wk.from, to: wk.to, override: { ref, assign }, weeks: [{ program, bookings: all }, ...near], records, ref });
  }
  return result;
}

/* ---------------------------------------------------------------- the panel */
/* GET ?uplisting=1: everything the Setup panel shows. Stripe errors throw (the admin answers 502: an
   unreadable mapping must never look empty); Uplisting errors leave `error` text (still 200). */
export async function uplistingPanel(env, request, { refresh = false } = {}) {
  const host = hostOf(request), { rooms, areas } = calendarRooms();
  const out = {
    uplisting: true, status: uplistingStatus(env), configured: { api_key: !!apiKey(env), webhook_secret: !!hookSecret(env) },
    account: null, properties: [], mapping: {}, rooms: rooms.map(r => r.name), room_groups: areas.map(area => ({ area, rooms: rooms.filter(r => r.area === area).map(r => r.name) })),
    hooks: null, hooks_other_hosts: [], webhook_url_hint: `https://${host}${HOOK_PATH}`, last_sync: null,
    imported: { active: 0, upcoming: 0, closed: 0, closed_upcoming: 0, closed_nights: 0 }, max_keys: MAP_MAX_KEYS,
    push: 'off', autoplace: 'on', last_push: null, push_warnings: [], pushed: { listings: 0, nights: 0 },
    last_scheduled_sync: null, sync_url_hint: `https://${host}${HOOK_PATH}?key=…&action=sync`,
  };
  if (env.STRIPE_SECRET_KEY) {
    const fresh = recentCustomers(env);
    fresh.catch(() => {});
    const [s, recs] = await Promise.all([readSettings(env, { cached: false, fresh: true, recentRows: fresh }), listRecords(env, { recentRows: fresh })]);
    out.mapping = s.mapping; out.last_sync = s.last_sync ? { ...s.last_sync, by: null } : null;
    out.push = s.push; out.autoplace = s.autoplace; out.max_keys = mapLimit(s);
    const today = todayIso(), act = upBookingRecs(recs).filter(r => r.status === 'active'), closed = upClosureRecs(recs).filter(r => r.status === 'active');
    const ahead = closed.filter(r => r.to > today);
    out.imported = { active: act.length, upcoming: act.filter(r => r.to > today).length, closed: closed.length, closed_upcoming: ahead.length,
      closed_nights: ahead.reduce((n, r) => n + nightsBetween(r.from > today ? r.from : today, r.to), 0) };
    // after the two reads above (their failure answers 502 first); the run record is only shown
    try {
      const p = await readPush(env, { recentRows: fresh });
      if (p.run && out.last_sync && p.run.at === out.last_sync.at) out.last_sync.by = byOut(p.run.by, p.run.n);
      if (p.run && validIso(p.run.sa)) out.last_scheduled_sync = { at: p.run.sa, result: p.run.sr && typeof p.run.sr === 'object' ? counts(p.run.sr, STATS_KEYS) : null };
      if (p.last && validIso(p.last.at)) {
        out.last_push = { at: p.last.at, result: counts(p.last.r, PUSH_KEYS), by: byOut(p.last.by, p.last.n) };
        out.push_warnings = Array.isArray(p.last.w) ? p.last.w.filter(x => typeof x === 'string').map(x => cut(x, 200)).slice(0, 10) : [];
      }
      const future = Object.values(p.ledger).map(set => [...set].filter(d => d >= today).length);
      out.pushed = { listings: future.filter(Boolean).length, nights: future.reduce((a, b) => a + b, 0) };
    } catch (e) { logError('uplisting.panel_push', e); }
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
const validIso = v => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/* ---------------------------------------------------------- closed nights */
export const CLOSED_COMMENT = 'Closed in Uplisting';
/* The listings whose closed nights come in: mapped (all their keys together) to exactly one room. Listings of
   several rooms (a whole cottage, '1 (Full)') are left out: their closed nights are mostly the cascade of their
   parts' bookings and blocks. Listings of the same room (4C, 4D and '4C + 4D (Combined)' all being our combined
   cottage) are one group: their closed nights together are one set of records, kept under the group's first
   listing (by id). → [{ pid (the first), room, pids }] by id */
export function closureListings(mapping) {
  const groups = new Map();
  for (const pid of mappedProperties(mapping || {})) {
    const rooms = new Set(Object.keys(mapping).filter(k => k === pid || k.startsWith(pid + '_')).flatMap(k => mapping[k]));
    if (rooms.size !== 1) continue;
    const room = [...rooms][0];
    if (!groups.has(room)) groups.set(room, { pid, room, pids: [] });
    groups.get(room).pids.push(pid);
  }
  return [...groups.values()];
}
/* The nights a room is closed in Uplisting over [from, to) by one of its listings (cal: its calendar):
   unavailable nights that no active Uplisting booking taking that room covers (its own, or a linked listing's)
   and that we didn't close ourselves (ours: the nights in the push ledger of any listing containing that room). */
export function closedNights({ room, cal, from, to, records, ours }) {
  const covered = new Set();
  for (const r of upBookingRecs(records)) {
    if (r.status !== 'active' || !r.rooms.includes(room) || !overlaps(r, { from, to })) continue;
    for (let d = r.from > from ? r.from : from; d < r.to && d < to; d = addDays(d, 1)) covered.add(d);
  }
  const nights = [];
  for (let d = from; d < to; d = addDays(d, 1)) if (cal.get(d) === false && !covered.has(d) && !ours.has(d)) nights.push(d);
  return nights;
}
const closureName = (pid, pname) => cut(`Uplisting · closed · ${pname || `listing ${pid}`}`, 200);
function closureMetadata(pid, room, rg, pname) {
  const id = `UC-${pid}-${rg.from}`;
  const md = { aob_rec: 'block', aob_rec_any: '1', aob_id: id, aob_from: rg.from, aob_to: rg.to, aob_rooms: room, aob_reason: 'uplisting', aob_status: 'active',
    aob_comment: CLOSED_COMMENT, aob_ext: 'uplisting', aob_ext_kind: 'closed', aob_ext_id: id, aob_ext_prop: pid };
  if (pname) md.aob_ext_pname = cut(pname, 60);
  return md;
}
const zeroClosures = () => ({ created: 0, updated: 0, cancelled: 0, unchanged: 0, listings: 0, errors: 0 });
const CLOSURE_KEYS = Object.keys(zeroClosures());
/* One listing's closure records brought in line with `ranges` (rangesOf(closedNights)) over the window win { from, to }.
   A range that starts on the window's first night continues the record that covers that night; a range that
   reaches the window's end keeps a later end its record has; a record no range continues is cancelled (one
   that started before the window keeps its past nights: it ends where the window starts). run: { env, records,
   iso, fits(n), kd (customers written by this sync for this listing), cs (stats), pname(pid) }. → 'ok' |
   'budget' | 'busy' */
async function applyClosures(run, pid, room, ranges, win) {
  const recs = upClosureRecs(run.records).filter(r => r.ext.property_id === pid);
  const active = recs.filter(r => r.status === 'active' && r.to > win.from);
  const done = new Set(run.kd), used = new Set(), acts = [];
  for (const rg of ranges) {
    let rec = rg.from === win.from ? active.find(r => !used.has(r.customer) && r.from <= win.from) : null;
    if (!rec) rec = active.find(r => !used.has(r.customer) && r.from === rg.from);
    if (rec) {
      used.add(rec.customer);
      const to = rg.to >= win.to && rec.to >= win.to ? rec.to : rg.to, md = {};
      if (rec.to !== to) md.aob_to = to;
      if (rec.rooms.join('|') !== room) md.aob_rooms = room;
      acts.push(Object.keys(md).length ? { type: 'update', rec, md } : { type: 'same', rec });
      continue;
    }
    const old = recs.find(r => r.status !== 'active' && r.id === `UC-${pid}-${rg.from}`);
    acts.push(old ? { type: 'restore', rec: old, md: { aob_status: 'active', aob_status_at: '', aob_to: rg.to, aob_rooms: room } } : { type: 'create', rg });
  }
  for (const r of active) {
    if (used.has(r.customer)) continue;
    acts.push(r.from < win.from ? { type: 'update', rec: r, md: { aob_to: win.from } } : { type: 'cancel', rec: r });
  }
  for (const a of acts) {
    if (a.rec && done.has(a.rec.customer)) continue; // written by an earlier slice of this sync
    if (a.type === 'same') { run.cs.unchanged++; continue; }
    if (!run.fits(a.type === 'create' ? 2 : 1)) return 'budget';
    let c;
    try {
      if (a.type === 'create') {
        const pname = await run.pname(pid), md = closureMetadata(pid, room, a.rg, pname);
        c = await stripe(run.env, 'POST', '/customers', { name: closureName(pid, pname), description: RECORD_DESCRIPTION, metadata: md },
          { idempotencyKey: `uplisting-closed-${pid}-${a.rg.from}-${a.rg.to}-${fnv(`${room}|${pname || ''}`)}` });
      } else if (a.type === 'cancel') {
        c = await stripe(run.env, 'POST', `/customers/${a.rec.customer}`, { metadata: { aob_status: 'cancelled', aob_status_at: String(nowSec()), aob_ext_sync: run.iso } });
      } else c = await stripe(run.env, 'POST', `/customers/${a.rec.customer}`, { metadata: { ...a.md, aob_ext_sync: run.iso } });
    } catch (e) {
      if (isBusy(e)) return 'busy';
      logError('uplisting.closed_write', e, { property: pid });
      run.cs.errors++;
      continue;
    }
    recordsChanged(c);
    replaceRecord(run.records, parseRecord(c));
    run.kd.push(c.id); done.add(c.id);
    run.cs[a.type === 'create' || a.type === 'restore' ? 'created' : a.type === 'cancel' ? 'cancelled' : 'updated']++;
  }
  return 'ok';
}
/* 'Closed in Uplisting (sync): 2 new, 1 changed, 1 removed' (null: nothing changed) */
export function closuresSummary(cs) {
  if (!cs || !(cs.created || cs.updated || cs.cancelled)) return null;
  return `Closed in Uplisting (sync): ${cs.created || 0} new, ${cs.updated || 0} changed, ${cs.cancelled || 0} removed${cs.errors ? `, ${cs.errors} ${cs.errors === 1 ? 'error' : 'errors'}` : ''}`;
}
/* 'Uplisting sync: 182 new, 0 changed, 0 cancelled, 0 clashes, 1 not mapped' */
export function syncSummary(x = {}) {
  const n = (k, one, many) => `${x[k] || 0} ${(x[k] || 0) === 1 ? one : many}`;
  return `Uplisting sync: ${x.created || 0} new, ${x.updated || 0} changed, ${x.cancelled || 0} cancelled, ${n('clashes', 'clash', 'clashes')}`
    + `${x.unmapped ? `, ${x.unmapped} not mapped` : ''}${x.errors ? `, ${n('errors', 'error', 'errors')}` : ''}`;
}
/* 'Push to Uplisting: closed 12 nights, reopened 0 nights on 2 listings' */
export function pushRunSummary(ps = {}) {
  const nn = k => `${ps[k] || 0} ${(ps[k] || 0) === 1 ? 'night' : 'nights'}`;
  return `Push to Uplisting: closed ${nn('closed')}, reopened ${nn('reopened')} on ${ps.listings || 0} ${(ps.listings || 0) === 1 ? 'listing' : 'listings'}`
    + `${ps.skipped_closed ? `, ${nn('skipped_closed')} already closed there (left alone)` : ''}${ps.refused ? `, ${ps.refused} ${ps.refused === 1 ? 'listing' : 'listings'} full (not closed)` : ''}`
    + `${ps.errors ? `, ${ps.errors} ${ps.errors === 1 ? 'error' : 'errors'}` : ''}`;
}
/* Who ran something, as the panel shows it: 'scheduled' or { id, name } (null: unknown) */
const byOut = (by, n) => (by === 'scheduled' ? 'scheduled' : by && by !== '-' ? { id: str(by, 60), name: str(n, 60) } : null);
/* aob_push_last: { at, by, n, r (stats), w (warnings, as many as fit in Stripe's 500 characters) } */
function pushLastValue(iso, by, n, ps, warnings) {
  const o = { at: iso, by, n, r: counts(ps, PUSH_KEYS), w: [] };
  for (const w of warnings || []) { const next = { ...o, w: [...o.w, cut(w, 160)] }; if (JSON.stringify(next).length > 500) break; o.w = next.w; }
  return JSON.stringify(o);
}

/* -------------------------------------------------------------------- sync */
/* The cursor: base64url(JSON state) + '.' + HMAC-SHA256 (key: ADMIN_TOKEN and the API key), 6 hours. The
   state: { v, m ('sync' | 'push': a push run alone), s (start, ISO: aob_ext_sync of what it changes), f, t (the
   bookings' window), kf (the closed nights' first night: yesterday), L (listing ids), i (the listing), ph ('p'
   pages | 'v' verify | 'c' release unmapped | 'k' closed nights | 'r' push | 'd' done), p (page), k (booking on
   that page), seen (ids read of this listing), x (seen overflowed: no cancellations), q (records to verify), st
   (stats), K (listings whose closed nights come in), R (listings the push reconciles), j (the one of K or R),
   kd (records this sync wrote for K[j]), cs (closed nights' stats), ps (push stats), w (warnings), exp }.
   Signed so nobody can hand in a cursor that skips pages (that would cancel bookings). */
const cursorKey = env => `uplisting-sync|${(env && env.ADMIN_TOKEN) || ''}|${apiKey(env)}`;
async function mac(env, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(cursorKey(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data))));
}
async function sealCursor(env, st) {
  const body = b64url(enc.encode(JSON.stringify({ ...st, exp: st.exp || nowSec() + cfg.cursorTtlSec })));
  return `${body}.${await mac(env, body)}`;
}
const PHASES = ['p', 'v', 'c', 'k', 'r', 'd'];
const counts = (o, keys) => Object.fromEntries(keys.map(k => [k, o && Number.isInteger(o[k]) && o[k] >= 0 ? o[k] : 0]));
async function openCursor(env, token) {
  if (typeof token !== 'string' || token.length > 30000) return null;
  const [body, sig, more] = token.split('.');
  if (!body || !sig || more !== undefined || !timingSafeEqual(await mac(env, body), sig)) return null;
  let st;
  try { st = JSON.parse(new TextDecoder().decode(fromB64url(body))); } catch { return null; }
  const ints = ['i', 'p', 'k', 'x'], ids = v => v == null || (Array.isArray(v) && v.length <= 200 && v.every(x => ID_RE.test(x)));
  if (!st || st.v !== 1 || !(st.exp > nowSec()) || !Array.isArray(st.L) || !st.L.every(x => ID_RE.test(x)) || !ints.every(k => Number.isInteger(st[k]) && st[k] >= 0)
    || !PHASES.includes(st.ph) || !Array.isArray(st.seen) || !Array.isArray(st.q) || !validDay(st.f) || !validDay(st.t) || !st.st || typeof st.st !== 'object'
    || !(st.m == null || st.m === 'sync' || st.m === 'push') || !ids(st.K) || !ids(st.R)) return null;
  st.m = st.m || 'sync';
  st.st = counts(st.st, STATS_KEYS);
  st.K = st.K || null; st.R = st.R || null;
  st.j = Number.isInteger(st.j) && st.j >= 0 ? st.j : 0;
  st.kf = validDay(st.kf) ? st.kf : st.f;
  st.kd = Array.isArray(st.kd) ? st.kd.filter(x => typeof x === 'string' && /^cus_[A-Za-z0-9]{1,64}$/.test(x)).slice(0, 200) : [];
  st.cs = counts(st.cs, CLOSURE_KEYS); st.ps = counts(st.ps, PUSH_KEYS);
  st.w = Array.isArray(st.w) ? st.w.filter(x => typeof x === 'string').map(x => cut(x, 200)).slice(0, 10) : [];
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
const PHASE_NAMES = { p: 'bookings', v: 'bookings', c: 'bookings', k: 'closures', r: 'push', d: 'done' };
/* uplisting_sync { cursor? } (mode 'sync': bookings, then closed nights, then — push on — the full push
   reconcile) and uplisting_push_run { cursor? } (mode 'push': the push reconcile alone): one slice.
   → { status, data: { ok, done, cursor | null, progress: { listings_done, listings_total, phase, … }, stats (sync),
   closures (sync), push (when it ran), warnings?, paused?: 'rate_limited' | 'busy', retry_after? (seconds: wait
   before the next call) }, activity: [{ action, summary, ref?, program? }] (for the caller to log, with who ran it) }
   or an error answer ({ error, code }: no_mapping 409, push_off 409, bad_cursor 400, uplisting_auth 502, too_big 503).
   actor: { id, name } of who runs it ('scheduled' for the GitHub job): the run record. host: for Uplisting's answers. */
export async function syncSlice(envIn, { cursor = null, mode = 'sync', host = '', actor = null } = {}) {
  const env = { ...envIn, subrequests: { n: 0 } };
  const used = () => env.subrequests.n, fits = n => used() + n <= cfg.sliceLimit - cfg.sliceReserve;
  let st = null;
  if (cursor != null && cursor !== '') {
    st = await openCursor(env, cursor);
    if (!st || st.m !== mode) return { status: 400, data: { error: 'This sync can\'t be continued (it is too old, or the keys changed). Start it again.', code: 'bad_cursor' } };
  }
  const fresh = recentCustomers(env);
  fresh.catch(() => {});
  const [settings, all] = await Promise.all([readSettings(env, { cached: !!st, fresh: !st, recentRows: fresh }), listRecords(env, { recentRows: fresh })]);
  const mapping = settings.mapping, today = todayIso(), horizon = addDays(today, cfg.daysAhead);
  if (!st) {
    const base = { v: 1, m: mode, s: new Date().toISOString(), L: [], i: 0, ph: 'p', p: 0, k: 0, seen: [], x: 0, q: [], st: zeroStats(),
      K: null, R: null, j: 0, kd: [], cs: zeroClosures(), ps: zeroPush(), w: [] };
    if (mode === 'push') {
      if (settings.push !== 'on') return { status: 409, data: { error: 'Push to Uplisting is off: turn it on first.', code: 'push_off' } };
      st = { ...base, f: today, t: horizon, kf: today, ph: 'r' };
    } else {
      const L = mappedProperties(mapping);
      if (!L.length) return { status: 409, data: { error: 'Map at least one Uplisting listing to rooms first.', code: 'no_mapping' } };
      st = { ...base, f: addDays(today, -cfg.daysBack), t: horizon, kf: addDays(today, -1), L };
    }
  }
  const memo = new Map();
  const ctx = { env, mapping, records: all.slice(), iso: st.s, placed: (f, t) => placedGuests(env, f, t, memo), clashAll: true };
  const stats = st.st, at = () => JSON.stringify([st.i, st.ph, st.p, st.k, st.q.length, st.j, st.kd.length, !!st.K, !!st.R, stats, st.cs, st.ps]), start = at();
  let stop = null, retry = 0, upCalls = 0;
  const upOk = pid => {
    if (upCalls >= cfg.sliceUpCalls || !fits(1)) { stop = 'budget'; return false; }
    const w = paceWait(pid);
    if (w) { stop = 'rate_limited'; retry = Math.max(retry, w); return false; }
    upCalls++;
    return true;
  };
  // the listings' names (labels, closed nights' records): this isolate's copy, or one call when there is room
  const mayCall = () => { if (upCalls >= cfg.sliceUpCalls || !fits(1) || paceWait('')) return false; upCalls++; return true; };
  let props = null;
  const labels = async () => props || (props = await propsFor(env, mayCall));
  // an Uplisting error: 'stop' (try this again later), else the listing is skipped (counted, nothing cancelled)
  const upFailed = (e, pid, into = stats) => {
    if (e.type !== 'uplisting_error') throw e;
    if (e.code === 'auth') throw e;
    if (upBusy(e)) { stop = e.status === 429 ? 'rate_limited' : 'busy'; retry = Math.max(retry, e.retryAfter || (e.status === 429 ? 30 : 10)); return 'stop'; }
    logError('uplisting.sync', e, { property: pid });
    into.errors++;
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
  let push = null, occ = null, pushOn = null, pc = null;
  const pushState = async () => push || (push = await readPush(env, { recentRows: fresh }));
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
          st.q = st.x ? [] : upBookingRecs(ctx.records).filter(x => x.status === 'active' && x.ext.property_id === pid && x.from >= st.f && x.to <= st.t && !seen.has(x.ext.id)).map(x => x.ext.id);
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
        const orphans = upBookingRecs(ctx.records).filter(x => x.status === 'active' && x.to > today && !roomSets(mapping, x.ext.property_id, x.ext.unit).length);
        for (const x of orphans) {
          if (!fits(1)) { stop = 'budget'; break loop; }
          try { await cancelRecord(ctx, x, x.ext.status); stats.cancelled++; }
          catch (e) { if (stripeFailed(e, x.ext.id) === 'stop') break loop; }
        }
        // closed nights of listings that no longer come in (unmapped, now several rooms, or no longer first of their room)
        const elig = new Set(closureListings(mapping).map(x => x.pid));
        for (const x of upClosureRecs(ctx.records).filter(r => r.status === 'active' && r.to > today && !elig.has(r.ext.property_id))) {
          if (!fits(1)) { stop = 'budget'; break loop; }
          try { await cancelRecord(ctx, x, 'released'); st.cs.cancelled++; }
          catch (e) { if (stripeFailed(e, x.ext.id) === 'stop') break loop; }
        }
        st.ph = 'k';
        continue;
      }
      if (st.ph === 'k') {
        // the closed nights of each room with listings of its own (one group per room), today − 1 to today + 540
        const elig = closureListings(mapping), win = { from: st.kf, to: st.t };
        if (!st.K) { st.K = elig.map(x => x.pid); st.j = 0; st.kd = []; }
        while (st.j < st.K.length) {
          const pid = st.K[st.j], info = elig.find(x => x.pid === pid);
          if (!info) { st.j++; st.kd = []; continue; } // mapped otherwise since the sync started
          if (!push) { if (!fits(2)) { stop = 'budget'; break loop; } await pushState(); }
          // a room's listings must fit in one slice (each calendar is read again when a slice stops inside a group)
          const chunks = calChunks(win.from, win.to), most = Math.max(1, Math.floor((cfg.sliceUpCalls - 2) / chunks));
          if (info.pids.length > most) pushWarn({ warnings: st.w }, `${info.room}: ${info.pids.length} listings are mapped to it; only the closed nights of the first ${most} are read.`);
          const group = info.pids.slice(0, most);
          if (!fits(chunks * group.length + 1)) { stop = 'budget'; break loop; }
          // ours: what the push closed on any listing containing this room (a linked listing's closure cascades)
          const ours = new Set();
          for (const lp of info.pids) for (const d of push.ledger[lp] || []) ours.add(d);
          for (const [lp, rooms] of pushListings(mapping)) if (rooms.includes(info.room)) for (const d of push.ledger[lp] || []) ours.add(d);
          const nights = new Set();
          let failed = false;
          for (const lp of group) {
            let cal;
            try { cal = await readCalendar(env, lp, win.from, win.to, upOk); }
            catch (e) { if (upFailed(e, lp, st.cs) === 'stop') break loop; failed = true; break; }
            if (!cal) break loop; // upOk said why
            closedNights({ room: info.room, cal, from: win.from, to: win.to, records: ctx.records, ours }).forEach(d => nights.add(d));
          }
          if (failed) { st.j++; st.kd = []; continue; } // a calendar unreadable: this room's records stay as they are
          const ranges = rangesOf([...nights]);
          const run = { env, records: ctx.records, iso: st.s, fits, kd: st.kd, cs: st.cs, pname: async p => nicknameOf(await labels(), p) };
          const r = await applyClosures(run, pid, info.room, ranges, win);
          if (r === 'budget') { stop = 'budget'; break loop; }
          if (r === 'busy') { stop = 'busy'; retry = Math.max(retry, 5); break loop; }
          st.cs.listings++; st.j++; st.kd = [];
        }
        st.ph = 'r'; st.j = 0;
        continue;
      }
      if (st.ph === 'r') {
        if (pushOn === null) {
          if (settings.memo && settings.push === 'on' && !fits(2)) { stop = 'budget'; break; }
          pushOn = await pushIsOn(env, settings, fresh);
        }
        if (!pushOn) { st.ph = 'd'; continue; } // never written while it is off
        if (!push) { if (!fits(2)) { stop = 'budget'; break; } await pushState(); }
        if (!st.R) { st.R = [...new Set([...pushListings(mapping).keys(), ...Object.keys(push.ledger)])].sort(cmpId); st.j = 0; }
        if (st.j < st.R.length) {
          if (!occ) {
            if (!fits(weeksCost(today, horizon) + 1)) { stop = 'budget'; break; }
            occ = aobOccupancy(await loadWeeks(env, today, horizon), ctx.records);
          }
          pc = pc || { env, mode: 'write', verify: true, listings: pushListings(mapping), occ, push, props: await labels(), today, host, fits, upOk,
            failed: (e, pid) => (upFailed(e, pid, st.ps) === 'stop' ? 'stop' : 'skip'), stats: st.ps, warnings: st.w, closeItems: [], reopenItems: [] };
          while (st.j < st.R.length) {
            const pid = st.R[st.j];
            const r = await serial(`push:${pid}`, () => pushListing(pc, pid, today, horizon));
            if (r === 'budget') { if (!stop) stop = 'budget'; break loop; }
            if (r === 'stop') { if (!stop) stop = 'budget'; break loop; }
            st.j++;
          }
        }
        st.ph = 'd';
        continue;
      }
      break; // 'd'
    }
  } catch (e) {
    if (e.type === 'uplisting_error' && e.code === 'auth') { logError('uplisting.sync', e); return { status: 502, data: { error: upErrorText(e), code: 'uplisting_auth' } }; }
    throw e;
  } finally {
    // what Uplisting took in this slice is recorded whatever happened
    if (push && !(await flushSafe(env, push, today, st.w))) st.ps.errors++;
  }
  const done = st.ph === 'd' && !stop;
  // the records alone took the whole budget: calling again would never get further
  if (stop === 'budget' && at() === start) {
    return { status: 503, data: { error: 'There are too many records to sync within one request. Please tell the developer.', code: 'too_big' } };
  }
  const activity = [];
  if (pc) for (const kind of ['close', 'reopen']) { const e = pushSummary(kind, kind === 'close' ? pc.closeItems : pc.reopenItems, { props: pc.props, listings: pc.listings }); if (e) activity.push(e); }
  if (done) {
    const iso = new Date().toISOString(), by = actor ? cut(str(actor.id, 60), 60) || '-' : '-', n = actor ? cut(str(actor.name, 60), 60) : '';
    if (mode === 'sync') {
      try { await writeSettings(env, settings, { aob_last_sync: iso, aob_last_sync_result: JSON.stringify(stats) }); }
      catch (e) { logError('uplisting.sync_save', e); }
      const cl = closuresSummary(st.cs);
      if (cl) activity.push({ action: 'uplisting_closed', summary: cl });
    }
    try {
      const p = await pushState(), fields = {};
      if (mode === 'sync') {
        const sched = by === 'scheduled', prev = p.run || {};
        fields.aob_run = JSON.stringify({ at: iso, by, n, sa: sched ? iso : validIso(prev.sa) ? prev.sa : null, sr: sched ? stats : prev.sr && typeof prev.sr === 'object' ? counts(prev.sr, STATS_KEYS) : null });
      }
      if (st.R) fields.aob_push_last = pushLastValue(iso, by, n, st.ps, st.w);
      if (Object.keys(fields).length) await writePush(env, p, fields);
    } catch (e) { logError('uplisting.run_save', e); }
  }
  const phase = done ? 'done' : PHASE_NAMES[st.ph];
  const data = { ok: true, done, cursor: done ? null : await sealCursor(env, st) };
  if (mode === 'sync') {
    data.progress = { listings_done: Math.min(st.i, st.L.length), listings_total: st.L.length, phase,
      closures_done: st.K ? (st.ph === 'k' ? st.j : st.K.length) : 0, closures_total: st.K ? st.K.length : closureListings(mapping).length,
      ...(st.R ? { push_done: st.ph === 'r' ? st.j : st.R.length, push_total: st.R.length } : {}) };
    data.stats = { ...stats };
    data.closures = { ...st.cs };
    if (st.R) data.push = { ...st.ps };
  } else {
    data.progress = { listings_done: st.R ? (st.ph === 'r' ? st.j : st.R.length) : 0, listings_total: st.R ? st.R.length : 0, phase };
    data.stats = { ...st.ps };
  }
  if (st.w.length) data.warnings = st.w.slice();
  if (stop === 'rate_limited' || stop === 'busy') { data.paused = stop; data.retry_after = Math.max(1, Math.min(retry || 10, 300)); }
  return { status: 200, data, activity };
}

/* A fresh start for this isolate's caches (tests). */
export function forgetUplisting() {
  cache.key = null; cache.account = cache.properties = cache.hooks = null;
  settingsMemo.rows = null; settingsMemo.at = 0; settingsWrites.clear(); locks.clear(); callLog.length = 0;
}
