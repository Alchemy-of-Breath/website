// /api/booking/login — team sign-in for the booking dashboard (users and sessions: booking-lib/team.js).
// POST { username, password } (JSON) → 200 { ok: true, token, expires_at (ISO), user: { id, username, name, role } }
//   role 'team' | 'viewer'. Send the token as Authorization: Bearer <token> to /api/booking/admin. It lasts
//   12 hours and ends early when the main admin changes the user's role, status or password (the admin
//   answers 401 { error, code: 'session_ended' } then). The main admin doesn't sign in here: the admin token
//   itself is their Bearer.
// 400 { error: 'Enter your username and password.' } (either one empty), { error: 'Invalid request.' }
// 401 { error: 'Wrong username or password.' } — the same for an unknown user, a wrong password and a disabled user
// 429 { error: 'Too many attempts. Try again in a few minutes.' } — 10 tries per 10 minutes per address
//     (IPv6: per /64) and 10 per 10 minutes per username (best effort, per isolate)
// 503 { error, code: 'unavailable' } team sign-in isn't set up (needs ADMIN_TOKEN of 16+ characters and
//     STRIPE_SECRET_KEY), or { error, code: 'busy', retry_after } when Stripe can't be reached.
// Every sign-in ('login') and refused sign-in ('login_failed': actor '-', named by the username tried, cut to
// 32 characters) goes to the activity log; a password never does.
import { json, preflight, guardPost, readBody, clientIp, ipKey, rateLimited, logError, BUSY, cut } from '../../../booking-lib/core.js';
import {
  teamAvailable, normalizeUsername, findUserByUsername, verifyPassword, issueSession, touchLogin, recordActivity, scrubText,
} from '../../../booking-lib/team.js';

export const onRequestOptions = ({ request, env }) => preflight(request, env);

const WRONG = { error: 'Wrong username or password.' };
const TOO_MANY = { error: 'Too many attempts. Try again in a few minutes.' };
const WINDOW_MS = 10 * 60 * 1000, TRIES = 10;
// refused sign-ins are logged at most this often per isolate (a flood must not fill Stripe with logbooks)
const FAILED_LOG_MAX = 30;

export async function onRequestPost(context) {
  const { request, env } = context;
  const send = (d, s = 200) => json(request, d, s, env);
  const bad = guardPost(request, env);
  if (bad) return bad;
  if (!teamAvailable(env)) {
    return send({ error: 'Team sign-in is not set up yet. The main admin can sign in with the admin token (leave the username empty).', code: 'unavailable' }, 503);
  }
  const body = await readBody(request, 4096);
  if (!body) return send({ error: 'Invalid request.' }, 400);
  const username = normalizeUsername(body.username);
  const password = typeof body.password === 'string' ? body.password.trim() : '';
  if (!username || !password) return send({ error: 'Enter your username and password.' }, 400);

  const ip = ipKey(clientIp(request));
  if ((ip && rateLimited('login:ip:' + ip, TRIES, WINDOW_MS)) || rateLimited('login:user:' + cut(username, 64), TRIES, WINDOW_MS)) return send(TOO_MANY, 429);

  let user;
  try { user = await findUserByUsername(env, username); }
  catch (e) { logError('login.find', e); return send(BUSY, 503); }
  const good = await verifyPassword(password, user ? user.pw : ''); // an unknown user costs the same time
  if (!user || !good || user.status !== 'active') {
    if (!rateLimited('login:failed-log', FAILED_LOG_MAX, WINDOW_MS)) {
      const why = !user ? 'unknown username' : !good ? 'wrong password' : 'the user is disabled';
      await recordActivity(context, env, { id: '-', name: cut(scrubText(username), 32), role: '-' },
        { action: 'login_failed', summary: `Sign-in refused (${why})` });
    }
    return send(WRONG, 401);
  }
  let session;
  try { session = await issueSession(env, user); }
  catch (e) { logError('login.session', e); return send(BUSY, 503); }
  // last sign-in: best effort, never holds up the answer
  const touch = touchLogin(env, user).catch(e => logError('login.touch', e));
  if (typeof context.waitUntil === 'function') { try { context.waitUntil(touch); } catch {} } else await touch;
  await recordActivity(context, env, { id: user.id, name: user.name, role: user.role }, { action: 'login', summary: `Signed in as ${user.username}` });
  return send({ ok: true, token: session.token, expires_at: session.expires_at, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
}
