/* AoB booking dashboard: team users, their sign-in sessions and the activity log.

   Who is asking (resolveAdmin / adminIdentity)
   - The main admin ("owner") sends Authorization: Bearer <ADMIN_TOKEN> (unchanged, see adminAuthorized).
   - A team member signs in at /api/booking/login with a username and password and then sends
     Authorization: Bearer <session token>. The token is
       'aobu.' + base64url(JSON { sub: <user's customer id>, v: <user version>, exp: <unix s> })
       + '.' + base64url(HMAC-SHA256(key = ADMIN_TOKEN, 'aobu.' + <that payload part>))
     and lasts 12 hours. It is honoured only while the user exists, is active and its version
     (aob_uver) is still the token's: changing a user's role, status or password bumps the version,
     which ends their sessions everywhere (changing ADMIN_TOKEN ends every team session too). Each
     isolate checks the user against Stripe at most every 15 s, so another isolate may honour an
     ended session for up to 15 s.
   - Roles: owner (everything), team (every booking action, not the owner-only ones), viewer (read only).
   Team sign-in needs ADMIN_TOKEN (>= 16 characters) and STRIPE_SECRET_KEY (teamAvailable).

   Users are Stripe Customers (the repo is public: no user or password lives here), never with an
   email: name 'AoB team · <name>', description 'Booking dashboard user (do not delete)', metadata
   aob_user '1', aob_username (lowercase, 3-32 of a-z 0-9 . _ -, unique), aob_uname (display name),
   aob_role 'team' | 'viewer', aob_pw 'pbkdf2$<iterations>$<salt b64url>$<hash b64url>' (PBKDF2-SHA256,
   10,000 iterations, 16-byte salt, 32-byte hash), aob_uver (version, from '1'), aob_ustatus 'active' |
   'disabled', aob_utest '1' (test users), aob_ucreated, aob_ulast (last sign-in, ISO). They carry no
   aob_rec_any, so listRecords never sees them. Users are never deleted (that is permanent): disabled.
   Plaintext passwords exist only in the one response that set them.

   The activity log ("who did what, when") lives in "logbook" Customers: name 'AoB dashboard activity
   log', description '(do not delete)', metadata aob_logbook '1' plus up to 48 entries. Entry key:
   'e' + Date.now() in base 36 + 2 random base-36 characters; value: compact JSON
   { t: unix ms, u: actor id ('owner' | customer id | 'uplisting' | 'system' | 'scheduled' | '-'), n: actor name, r: role ('owner' | 'team' |
     'viewer' | 'system' | '-'), a: action,
     f: booking reference or record id (optional), p: program id (optional), s: summary }
   (never more than 500 characters: the summary is cut). One entry is one metadata merge on the current
   logbook (adding a key leaves the others alone, so isolates writing at once don't clobber each other);
   a full logbook (48 entries, or Stripe's 50-key limit when other isolates wrote too) starts a new one.
   Logging never fails or holds up an action (recordActivity: context.waitUntil when there is one). */
import { stripe, searchAll, listAll, nowSec, liveMode, logError, timingSafeEqual, adminAuthorized, str, cut } from './core.js';

export const ROLES = ['team', 'viewer'];
export const ROLE_LABELS = { owner: 'Main admin', team: 'Team', viewer: 'View only', system: 'System' };
export const OWNER = Object.freeze({ kind: 'owner', id: 'owner', name: 'Main admin', role: 'owner' });
/* Changes nobody on the team made (the Uplisting webhook): logged with this actor, role 'system'. */
export const UPLISTING_ACTOR = Object.freeze({ kind: 'system', id: 'uplisting', name: 'Uplisting', role: 'system' });
/* The booking system itself (auto-place of a paid booking, Uplisting's answer to a calendar change). */
export const SYSTEM_ACTOR = Object.freeze({ kind: 'system', id: 'system', name: 'Booking system', role: 'system' });
/* The scheduled Uplisting sync (GitHub Actions → /api/booking/uplisting?action=sync). */
export const SCHEDULE_ACTOR = Object.freeze({ kind: 'system', id: 'scheduled', name: 'Automatic sync', role: 'system' });
export const SESSION_HOURS = 12;
export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
export const PASSWORD_MAX = 100;
export const PBKDF2_ITERATIONS = 10000;
export const LOGBOOK_MAX = 48;
const TOKEN_PREFIX = 'aobu';
const USER_QUERY = "metadata['aob_user']:'1'";
const LOGBOOK_QUERY = "metadata['aob_logbook']:'1'";
const USER_DESCRIPTION = 'Booking dashboard user (do not delete)';
const LOGBOOK_NAME = 'AoB dashboard activity log', LOGBOOK_DESCRIPTION = '(do not delete)';
const RECENT_SEC = 10 * 60;               // real-time list of customers created lately (search lags)
const USERS_TTL_MS = 30 * 1000;           // the users list, per isolate
const USER_TTL_MS = 15 * 1000;            // one user read for a session check
const USER_STALE_OK_MS = 2 * 60 * 1000;   // Stripe unreachable: a session check may use a read this old
const WRITE_TTL_MS = 3 * 60 * 1000;       // this isolate's own user writes win over search for this long
const OWN_ENTRIES_MS = 10 * 60 * 1000;    // this isolate's own log entries merged into reads for this long
const LOGBOOK_FIND_DAYS = 30;             // a cold isolate looks for a logbook with room among the last 30 days'
const LOGBOOK_FRESH = 3;                  // the newest logbooks are read directly (search lags behind updates)
const ENTRY_KEY = /^e[0-9a-z]{4,20}$/;

export const teamAvailable = env => !!(env && env.STRIPE_SECRET_KEY && env.ADMIN_TOKEN && String(env.ADMIN_TOKEN).length >= 16);
export const passwordMin = env => liveMode(env) ? 10 : 5;

/* ------------------------------------------------------------- encoding */
const enc = new TextEncoder();
function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------ passwords */
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(await pbkdf2(String(password), salt, PBKDF2_ITERATIONS))}`;
}
const STORED_PW = /^pbkdf2\$(\d{4,6})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{43})$/;
/* Constant-time check. Without a stored hash (unknown user) it does the same work and answers false,
   so the answer time doesn't tell which usernames exist. */
export async function verifyPassword(password, stored) {
  const m = STORED_PW.exec(String(stored || ''));
  const iterations = m ? parseInt(m[1], 10) : 0;
  if (!m || iterations < 1000 || iterations > 100000) { await pbkdf2(String(password), new Uint8Array(16), PBKDF2_ITERATIONS); return false; }
  const got = b64url(await pbkdf2(String(password), fromB64url(m[2]), iterations));
  return timingSafeEqual(got, m[3]);
}

/* Generated passwords: three short words and two digits, e.g. 'lotus-amber-river-42' (about 30 bits;
   sign-in is limited to 10 tries per 10 minutes per address and per username). */
const WORDS = `acacia acorn agave alder almond alpine amber anchor angel apple apron arbor arrow aspen aster atlas
  autumn azure badger bagel bamboo banjo barley basil beach beacon bear bell berry birch bison bloom blue
  bluff bonsai breeze briar brick bronze brook brush cabin cactus camel cameo candle canoe canyon caper
  carrot cashew cedar cello chalk cherry chime cider cinder citrus clay cliff cloud clover coast cobalt
  cocoa cocoon comet copper coral cosmos cotton cove crane creek cress crest crow cumin cymbal dahlia
  daisy dawn delta desert dingo dove drift dune dusk eagle earth echo elder ember fable falcon fennel fern
  ferry fiddle field finch fjord flame flax flint flora flute forest fresco frost gale garden garnet gecko
  ginger glade glow gold grain grape gravel grove guava gull harbor harp hawk hazel heron hill hive hollow
  honey iris island ivory jade jasper kayak kelp kite koala lagoon lake larch lark laurel lava lemon lilac
  lily lime linen lotus lunar lynx mango maple marble marsh meadow melon mesa mint mist moon moss nectar
  nest nova nutmeg oasis ocean olive onyx opal orbit orchid otter palm panda paper parrot peach pearl
  pebble pepper petal pine plum pollen pond poppy prism quail quartz quill rain raven reed reef ridge
  river robin rose ruby sage sail salt sand satin shell shore sierra silk silver slate snow solar spark
  spice spring spruce star stone storm stream summit swan tango teal thyme tide tiger timber topaz torch
  trail tulip tundra twig valley velvet violet walnut wave willow wind winter wren yarrow zebra zenith
  zephyr`.split(/\s+/);
export const PASSWORD_WORDS = WORDS;
/* uniform in 0..n-1 (n <= 256), rejection sampling: no modulo bias */
function randomBelow(n) {
  const limit = 256 - (256 % n), b = new Uint8Array(1);
  for (;;) { crypto.getRandomValues(b); if (b[0] < limit) return b[0] % n; }
}
export function generatePassword() {
  return [0, 1, 2].map(() => WORDS[randomBelow(WORDS.length)]).join('-') + '-' + String(randomBelow(100)).padStart(2, '0');
}

/* -------------------------------------------------------------- sessions */
let hmacCache = { secret: null, key: null };
function hmacKey(env) {
  if (hmacCache.secret !== env.ADMIN_TOKEN) {
    hmacCache = { secret: env.ADMIN_TOKEN, key: crypto.subtle.importKey('raw', enc.encode(env.ADMIN_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) };
  }
  return hmacCache.key;
}
async function mac(env, data) {
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(data))));
}
/* → { token, expires_at (ISO), exp (unix s) } */
export async function issueSession(env, user, now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_HOURS * 3600;
  const head = `${TOKEN_PREFIX}.${b64url(enc.encode(JSON.stringify({ sub: user.id, v: user.version, exp })))}`;
  return { token: `${head}.${await mac(env, head)}`, expires_at: new Date(exp * 1000).toISOString(), exp };
}
/* A session token's payload { sub, v, exp } when it is ours and unaltered (expiry not checked), else null. */
export async function readSession(env, token) {
  if (typeof token !== 'string' || token.length > 1000 || !teamAvailable(env)) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !/^[A-Za-z0-9_-]{8,600}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
  if (!timingSafeEqual(await mac(env, `${parts[0]}.${parts[1]}`), parts[2])) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))); } catch { return null; }
  if (!p || typeof p !== 'object' || typeof p.sub !== 'string' || !/^cus_[A-Za-z0-9]{1,250}$/.test(p.sub)
    || !Number.isInteger(p.v) || p.v < 1 || !Number.isInteger(p.exp)) return null;
  return p;
}
/* → { me: identity | null, code?: 'session_ended' }. me: OWNER, or { kind: 'user', id, username, name,
   role: 'team' | 'viewer' }. code 'session_ended': a genuine session token that has expired or was
   ended (user disabled or gone, role / status / password changed). Throws when Stripe can't be reached
   to check a user (answer 503 busy, not 401: the session may well be fine). */
export async function resolveAdmin(request, env) {
  if (adminAuthorized(request, env)) return { me: OWNER };
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token.startsWith(TOKEN_PREFIX + '.')) return { me: null };
  const p = await readSession(env, token);
  if (!p) return { me: null };
  if (p.exp <= nowSec()) return { me: null, code: 'session_ended' };
  const u = await userById(env, p.sub);
  if (!u || u.status !== 'active' || u.version !== p.v) return { me: null, code: 'session_ended' };
  return { me: { kind: 'user', id: u.id, username: u.username, name: u.name, role: u.role } };
}
/* The identity behind a request (see resolveAdmin), or null. */
export async function adminIdentity(request, env) {
  return (await resolveAdmin(request, env)).me;
}
/* `me` in the admin answers */
export const meOut = me => me.kind === 'user' ? { id: me.id, name: me.name, role: me.role, username: me.username } : { id: me.id, name: me.name, role: me.role };

/* ----------------------------------------------------------------- users */
const isUserCustomer = c => !!c && !c.deleted && (c.metadata || {}).aob_user === '1';
export function parseUser(c) {
  if (!isUserCustomer(c)) return null;
  const md = c.metadata, username = String(md.aob_username || '').toLowerCase();
  if (!USERNAME_RE.test(username)) return null;
  const v = parseInt(md.aob_uver || '1', 10);
  return {
    id: c.id, username, name: md.aob_uname || username,
    role: md.aob_role === 'team' ? 'team' : 'viewer',              // anything else: the least access
    status: md.aob_ustatus === 'active' ? 'active' : 'disabled',
    version: Number.isInteger(v) && v > 0 ? v : 1, test: md.aob_utest === '1',
    created_at: md.aob_ucreated || new Date((c.created || 0) * 1000).toISOString(), last_login_at: md.aob_ulast || null,
    created: c.created || 0, pw: md.aob_pw || '',
  };
}
/* What the dashboard sees of a user (never the password hash) */
export const userOut = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, status: u.status, test: u.test, created_at: u.created_at, last_login_at: u.last_login_at });
export const normalizeUsername = v => typeof v === 'string' ? v.trim().toLowerCase() : '';
const customerName = name => cut(`AoB team · ${name}`, 200);

const usersMemo = { rows: null, at: 0 };   // id → customer: search + real-time list, 30 s
const userWrites = new Map();              // id → { c, at }: this isolate's writes (search lags behind them)
const userCache = new Map();               // id → { c, at }: single reads for session checks, 15 s
function rememberUser(c) {
  if (!c || !c.id) return;
  const at = Date.now();
  userWrites.delete(c.id); userWrites.set(c.id, { c, at });
  while (userWrites.size > 200) userWrites.delete(userWrites.keys().next().value);
  userCache.set(c.id, { c, at });
  if (usersMemo.rows) usersMemo.rows.set(c.id, c);
}
/* customers found by a search plus those created in the last 10 minutes (real-time list wins), kept by `keep` */
async function customersWithRecent(env, query, keep, cap = 2000) {
  const [found, fresh] = await Promise.all([
    searchAll(env, query, cap, 'customers'),
    listAll(env, '/customers', { 'created[gte]': nowSec() - RECENT_SEC }),
  ]);
  const byId = new Map();
  for (const c of [...found, ...fresh]) if (keep(c)) byId.set(c.id, c);
  return byId;
}
/* Every user (disabled ones too), oldest first. From a 30 s per-isolate memo unless fresh. */
export async function listUsers(env, { fresh = false } = {}) {
  const now = Date.now();
  if (fresh || !usersMemo.rows || now - usersMemo.at >= USERS_TTL_MS || now < usersMemo.at) {
    const rows = await customersWithRecent(env, USER_QUERY, isUserCustomer);
    const t = Date.now();
    for (const [id, w] of userWrites) { if (t - w.at > WRITE_TTL_MS) userWrites.delete(id); else rows.set(id, w.c); }
    usersMemo.rows = rows; usersMemo.at = t;
  }
  return [...usersMemo.rows.values()].map(parseUser).filter(Boolean).sort((a, b) => (a.created - b.created) || (a.id < b.id ? -1 : 1));
}
/* One user read from Stripe (fresh), or from this isolate's 15 s copy. null: no such user. */
async function userById(env, id, { fresh = false } = {}) {
  const hit = userCache.get(id), now = Date.now();
  const age = hit ? now - hit.at : Infinity;
  if (!fresh && hit && age >= 0 && age < USER_TTL_MS) return parseUser(hit.c);
  let c;
  try { c = await stripe(env, 'GET', `/customers/${encodeURIComponent(id)}`); }
  catch (e) {
    if (e.status === 404) { userCache.delete(id); return null; }
    if (!fresh && hit && age >= 0 && age < USER_STALE_OK_MS) return parseUser(hit.c);
    throw e;
  }
  if (!isUserCustomer(c)) { userCache.delete(id); return null; }
  userCache.set(id, { c, at: now });
  while (userCache.size > 500) userCache.delete(userCache.keys().next().value);
  return parseUser(c);
}
/* A user read fresh from Stripe (before any change: search lags), or null. */
export const readUser = (env, id) => userById(env, id, { fresh: true });
/* The user with this username, read fresh (its password, status and version as they are now), or null. */
export async function findUserByUsername(env, username) {
  if (!USERNAME_RE.test(username)) return null;
  let u = (await listUsers(env)).find(x => x.username === username);
  // a user made a moment ago in another isolate: look again (at most every 5 s)
  if (!u && Date.now() - usersMemo.at > 5000) u = (await listUsers(env, { fresh: true })).find(x => x.username === username);
  if (!u) return null;
  const cur = await readUser(env, u.id);
  return cur && cur.username === username ? cur : null;
}

/* user_create / user_update input → { errors, values }. create: username, name and role required;
   update: only what is given. A password is optional (empty: the caller generates one). */
export function passwordError(p, env) {
  const min = passwordMin(env);
  if (p.length < min) return `Use at least ${min} characters.`;
  if (p.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}
export function userInput(body, env, { create = false } = {}) {
  const errors = {}, values = {};
  if (create) {
    const username = normalizeUsername(body.username);
    if (!USERNAME_RE.test(username)) errors.username = 'Use 3 to 32 characters: lowercase letters, numbers, dots, dashes or underscores.';
    else values.username = username;
  }
  if (create || body.name !== undefined) {
    const name = str(body.name, 200);
    if (!name || name.length > 60) errors.name = 'Add a name (up to 60 characters).';
    else if (/^[=+\-@]/.test(name)) errors.name = 'Please start the name with a letter.';
    else values.name = name;
  }
  if (create || body.role !== undefined) {
    if (!ROLES.includes(body.role)) errors.role = 'Choose Team or View only.'; else values.role = body.role;
  }
  if (!create && body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') errors.status = 'Choose active or disabled.'; else values.status = body.status;
  }
  if (body.password !== undefined && body.password !== null && body.password !== '') {
    if (typeof body.password !== 'string') errors.password = 'Enter the password as text.';
    else {
      const p = body.password.trim(), pe = passwordError(p, env);
      if (pe) errors.password = pe; else values.password = p;
    }
  }
  return { errors, values };
}
export async function createUser(env, { username, name, role, password, test = false }) {
  const metadata = { aob_user: '1', aob_username: username, aob_uname: name, aob_role: role, aob_pw: await hashPassword(password),
    aob_uver: '1', aob_ustatus: 'active', aob_ucreated: new Date().toISOString() };
  if (test) metadata.aob_utest = '1';
  const c = await stripe(env, 'POST', '/customers', { name: customerName(name), description: USER_DESCRIPTION, metadata });
  rememberUser(c);
  return parseUser(c);
}
/* cur: the user read fresh (readUser). A new role, status or password bumps the version (ends the
   user's sessions); a new name doesn't. → the user as it is now */
export async function updateUser(env, cur, { name, role, status, password, test } = {}) {
  const md = {};
  let bump = false;
  if (name !== undefined && name !== cur.name) md.aob_uname = name;
  if (role !== undefined && role !== cur.role) { md.aob_role = role; bump = true; }
  if (status !== undefined && status !== cur.status) { md.aob_ustatus = status; bump = true; }
  if (password) { md.aob_pw = await hashPassword(password); bump = true; }
  if (test && !cur.test) md.aob_utest = '1';
  if (bump) md.aob_uver = String(cur.version + 1);
  if (!Object.keys(md).length) return cur;
  const params = { metadata: md };
  if (md.aob_uname) params.name = customerName(md.aob_uname);
  const c = await stripe(env, 'POST', `/customers/${cur.id}`, params);
  rememberUser(c);
  return parseUser(c);
}
/* aob_ulast after a sign-in (best effort; it changes nothing else) */
export async function touchLogin(env, user, at = new Date()) {
  const iso = at.toISOString();
  await stripe(env, 'POST', `/customers/${user.id}`, { metadata: { aob_ulast: iso } });
  for (const m of [usersMemo.rows && usersMemo.rows.get(user.id), (userWrites.get(user.id) || {}).c, (userCache.get(user.id) || {}).c]) {
    if (m && m.metadata) m.metadata = { ...m.metadata, aob_ulast: iso };
  }
}

/* ----------------------------------------------------------- activity log */
const isLogbook = c => !!c && !c.deleted && (c.metadata || {}).aob_logbook === '1';
const entryCount = md => Object.keys(md || {}).filter(k => ENTRY_KEY.test(k)).length;
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export function newEntryKey(now = Date.now()) {
  const b = crypto.getRandomValues(new Uint8Array(2));
  return 'e' + Math.floor(now).toString(36) + B36[b[0] % 36] + B36[b[1] % 36];
}
/* Free text that goes into a summary (comments, reasons, names typed at sign-in): no email addresses or
   phone numbers (9 digits or more). */
export const scrubText = s => str(s, 2000)
  .replace(/[^\s@"'<>,;()]+@[^\s@"'<>,;()]+/g, '[email]')
  .replace(/\+?\d[\d\s().-]{7,}\d/g, m => (m.replace(/\D/g, '').length >= 9 ? '[number]' : m));
/* The entry's JSON (<= 500 characters: the summary is cut, with '…', to fit). actor: { id, name, role } */
export function activityEntry(actor, { action, ref, program, summary }, now = Date.now()) {
  const e = { t: Math.floor(now), u: cut(str(actor.id, 60) || '-', 40), n: cut(str(actor.name, 120), 60), r: cut(str(actor.role, 20), 20) || '-', a: cut(str(action, 60), 40) || '-' };
  if (ref) e.f = cut(str(ref, 80), 60);
  if (program) e.p = cut(str(program, 80), 60);
  const s = str(summary, 2000);
  e.s = s;
  let json = JSON.stringify(e);
  if (json.length <= 500) return json;
  // the longest start of the summary that fits (escaping makes JSON longer than the text: search)
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    e.s = cut(s, mid) + '…';
    if (JSON.stringify(e).length <= 500) lo = mid; else hi = mid - 1;
  }
  e.s = cut(s, lo) + '…';
  return JSON.stringify(e);
}

const book = { id: null, count: 0, known: false, finding: null }; // this isolate's current logbook
let lastT = 0; // entries of one isolate never share a millisecond (their order stays the order they were made in)
const ownEntries = new Map();                                       // key → { value, at }: appended here lately
/* The newest logbook with room among those created in the last 30 days (or null): one bounded search
   plus the real-time list of customers created in the last 10 minutes. */
async function findLogbook(env) {
  const since = nowSec() - LOGBOOK_FIND_DAYS * 86400;
  const rows = [...(await customersWithRecent(env, `${LOGBOOK_QUERY} AND created>${since}`, isLogbook, 500)).values()];
  const open = rows.filter(c => entryCount(c.metadata) < LOGBOOK_MAX).sort((a, b) => (b.created - a.created) || (a.id < b.id ? 1 : -1));
  return open[0] ? { id: open[0].id, count: entryCount(open[0].metadata) } : null;
}
function currentLogbook(env) {
  if (book.known) return Promise.resolve(book);
  if (!book.finding) {
    const p = findLogbook(env).then(b => {
      if (book.finding === p) { book.id = b ? b.id : null; book.count = b ? b.count : 0; book.known = true; book.finding = null; }
      return book;
    }, e => { if (book.finding === p) book.finding = null; throw e; });
    book.finding = p;
  }
  return book.finding;
}
const isMetadataError = e => e.status === 400 && (e.param === 'metadata' || /metadata/i.test(e.message || ''));
async function appendEntry(env, key, value) {
  const b = await currentLogbook(env);
  if (b.id && b.count < LOGBOOK_MAX) {
    try {
      const c = await stripe(env, 'POST', `/customers/${b.id}`, { metadata: { [key]: value } });
      if (book.id === c.id) book.count = entryCount(c.metadata);
      return c.id;
    } catch (e) {
      if (e.status !== 404 && !isMetadataError(e)) throw e; // gone, or filled by other isolates: start a new one
    }
  }
  const c = await stripe(env, 'POST', '/customers', { name: LOGBOOK_NAME, description: LOGBOOK_DESCRIPTION, metadata: { aob_logbook: '1', [key]: value } });
  book.id = c.id; book.count = entryCount(c.metadata); book.known = true;
  return c.id;
}
/* Write one entry. actor: { id, name, role }; info: { action, ref?, program?, summary }. → a promise that
   never rejects (true: written), or null when there is nowhere to write (no Stripe). */
export function logActivity(env, actor, info) {
  if (!env || !env.STRIPE_SECRET_KEY || !actor || !info) return null;
  let key, value;
  try { const now = Math.max(Date.now(), lastT + 1); lastT = now; key = newEntryKey(now); value = activityEntry(actor, info, now); }
  catch (e) { logError('activity.entry', e); return null; }
  ownEntries.set(key, { value, at: Date.now() });
  while (ownEntries.size > 500) ownEntries.delete(ownEntries.keys().next().value);
  return appendEntry(env, key, value).then(() => true, e => {
    ownEntries.delete(key);
    logError('activity.log', e, { action: cut(str(info.action, 60), 30) });
    return false;
  });
}
/* Log without holding up the answer: context.waitUntil when the runtime gives one, else awaited here. */
export async function recordActivity(context, env, actor, info) {
  const p = logActivity(env, actor, info);
  if (!p) return;
  if (context && typeof context.waitUntil === 'function') { try { context.waitUntil(p); return; } catch {} }
  await p;
}

function parseEntry(id, value) {
  let o;
  try { o = JSON.parse(value); } catch { return null; }
  if (!o || typeof o !== 'object' || !Number.isFinite(o.t) || typeof o.a !== 'string') return null;
  return { id, t: o.t, at: new Date(o.t).toISOString(), actor: { id: String(o.u || '-'), name: String(o.n || ''), role: String(o.r || '') },
    action: o.a, ref: o.f ? String(o.f) : null, program: o.p ? String(o.p) : null, summary: String(o.s || '') };
}
/* Entries, newest first: { entries: [{ id, t, at, actor: { id, name, role }, action, ref, program, summary }],
   has_more }. Reads every logbook (search + real-time list, at most 2000 logbooks; the 3 newest read
   directly), plus what this isolate wrote in the last 10 minutes. user: one actor id; before: entries
   older than this (unix ms). A page never splits entries of the same millisecond (before = the last t).
   Entries are ordered by the time in their key and only read (JSON) as far as the page needs. */
const keyTime = k => { const t = parseInt(k.slice(1, -2), 36); return Number.isFinite(t) ? t : 0; };
export async function listActivity(env, { limit = 200, user = null, before = null } = {}) {
  const rows = await customersWithRecent(env, LOGBOOK_QUERY, isLogbook, 2000);
  const newest = [...rows.values()].sort((a, b) => (b.created - a.created) || (a.id < b.id ? 1 : -1)).slice(0, LOGBOOK_FRESH);
  const fresh = await Promise.all(newest.map(c => stripe(env, 'GET', `/customers/${c.id}`).catch(() => null)));
  fresh.forEach(c => { if (isLogbook(c)) rows.set(c.id, c); });
  const raw = new Map(); // key → JSON
  for (const c of rows.values()) {
    for (const [k, v] of Object.entries(c.metadata || {})) if (ENTRY_KEY.test(k)) raw.set(k, v);
  }
  const now = Date.now();
  for (const [k, w] of ownEntries) {
    if (now - w.at > OWN_ENTRIES_MS || now < w.at) ownEntries.delete(k);
    else if (!raw.has(k)) raw.set(k, w.value);
  }
  let keys = [...raw.keys()].map(k => ({ k, t: keyTime(k) }));
  if (before != null) keys = keys.filter(x => x.t < before);
  keys.sort((a, b) => (b.t - a.t) || (a.k < b.k ? 1 : a.k > b.k ? -1 : 0));
  const entries = [];
  let more = false;
  for (const { k } of keys) {
    const e = parseEntry(k, raw.get(k));
    if (!e || (user && e.actor.id !== user)) continue;
    if (entries.length >= limit && e.t !== entries[entries.length - 1].t) { more = true; break; }
    entries.push(e);
  }
  return { entries, has_more: more };
}

/* A fresh start for this isolate's memos (tests). */
export function forgetTeam() {
  usersMemo.rows = null; usersMemo.at = 0;
  userWrites.clear(); userCache.clear(); ownEntries.clear();
  book.id = null; book.count = 0; book.known = false; book.finding = null; lastT = 0;
  hmacCache = { secret: null, key: null };
}
