// POST /api/booking/release { id: 'cs_…', email } — the guest gives back their own open checkout
// ("Change booking details", coming back from Stripe cancelled, a payment that didn't go through),
// so the places are free again at once instead of after 31 minutes. Accepts JSON or text/plain JSON
// (sendBeacon / keepalive). A checkout whose payment is already under way is never released.
import {
  json, preflight, guardPost, readBody, clientIp, ipHash, rateLimited, stripe, expireSession, clearAvailabilityMemo, validEmail, str,
  isBusy, logError, BUSY, CS_ID,
} from '../../../booking-lib/core.js';

export const onRequestOptions = ({ request, env }) => preflight(request, env);

const IN_PROGRESS = new Set(['processing', 'requires_capture', 'succeeded']);

export async function onRequestPost({ request, env }) {
  const send = (d, s = 200) => json(request, d, s, env);
  const bad = guardPost(request, env, { text: true });
  if (bad) return bad;
  const body = await readBody(request);
  const id = body && typeof body.id === 'string' ? body.id : '';
  const email = str(body && body.email, 120).toLowerCase();
  if (!CS_ID.test(id) || !validEmail(email)) return send({ error: 'Invalid request.' }, 400);
  if (!env.STRIPE_SECRET_KEY) return send({ ok: true, released: false, demo: true });
  const iph = await ipHash(env, clientIp(request));
  if (iph && rateLimited('release:' + iph, 30, 10 * 60 * 1000)) return send({ error: 'Too many requests. Please try again in a few minutes.', code: 'too_many' }, 429);
  try {
    const s = await stripe(env, 'GET', `/checkout/sessions/${id}`);
    const md = s.metadata || {};
    // only the guest's own open booking checkout: same lead email
    if (s.status !== 'open' || md.aob_kind !== 'booking' || String(md.aob_lead_email || '').toLowerCase() !== email) {
      return send({ ok: true, released: false });
    }
    // a payment already submitted (bank debit processing, card confirming) must be allowed to finish
    if (s.payment_intent) {
      const pi = typeof s.payment_intent === 'object' ? s.payment_intent : await stripe(env, 'GET', `/payment_intents/${s.payment_intent}`);
      if (IN_PROGRESS.has(pi.status)) return send({ ok: true, released: false, in_progress: true });
    }
    const released = await expireSession(env, id);
    if (released) clearAvailabilityMemo(md.aob_program);
    return send({ ok: true, released });
  } catch (e) {
    if (e.status === 404) return send({ ok: true, released: false });
    logError('release', e);
    return isBusy(e) ? send(BUSY, 503) : send({ error: 'We could not release this checkout.' }, 502);
  }
}
