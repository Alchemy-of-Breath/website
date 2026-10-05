// GET /api/booking/availability?program=<id>[&exclude=cs_…,cs_…] — places left per room right now, plus
// what the page needs to set up payment (embedded Stripe key, Turnstile key, deposit and plan options,
// whether the reminder email is on). exclude: the asking visitor's own open checkouts (at most two),
// so their own hold doesn't show as "in checkout" to them; checkout re-checks everything anyway.
// The team's room blocks and manual bookings count too (one memoised records search for every week).
import {
  json, preflight, getProgram, isClosed, availability, buildOccupancy, planInfo, depositInfo, publishableKey, turnstileSiteKey,
  remindEnabled, liveAvailability, lastSnapshot, logError, CS_ID,
} from '../../../booking-lib/core.js';

export const onRequestOptions = ({ request, env }) => preflight(request, env);

export async function onRequestGet({ request, env }) {
  const send = (d, s = 200) => json(request, d, s, env);
  const params = new URL(request.url).searchParams;
  const program = getProgram(params.get('program'));
  if (!program) return send({ error: 'Unknown program.' }, 404);
  const exclude = String(params.get('exclude') || '').split(',').filter(id => CS_ID.test(id)).slice(0, 2);
  const live = !!env.STRIPE_SECRET_KEY;
  const pk = live ? publishableKey(env) : null;
  const info = {
    program: program.id, live, closed: isClosed(program), payment_plan: planInfo(program, env), deposit: depositInfo(program),
    stripe: { embedded: !!pk, publishable_key: pk }, turnstile_site_key: turnstileSiteKey(env), remind: remindEnabled(env),
  };
  if (!live) return send({ ...info, ...availability(program) }); // demo: the program's own capacity (live:false)
  try {
    const { avail } = await liveAvailability(env, program, exclude); // 15 s memo + single flight per isolate
    return send({ ...info, ...avail });
  } catch (e) {
    logError('availability', e);
    // Stripe unreachable: the last good answer from this isolate, marked stale. Never static capacity.
    const snap = lastSnapshot(program.id);
    if (snap) {
      const avail = availability(program, buildOccupancy(program, snap.pays, snap.open, exclude, snap.records));
      return send({ ...info, ...avail, degraded: true, stale_seconds: Math.max(0, Math.round((Date.now() - snap.at) / 1000)) });
    }
    return send({ error: 'Live availability is busy for a moment. Please try again.', code: 'busy', retry_after: 5 }, 503);
  }
}
