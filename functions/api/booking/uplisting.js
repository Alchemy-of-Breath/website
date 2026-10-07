// POST /api/booking/uplisting?key=<UPLISTING_WEBHOOK_SECRET>[&event=booking_created|booking_updated|booking_removed]
// Uplisting → booking system (see booking-lib/uplisting.js). Registered from the admin (Setup → Uplisting →
// Connect webhooks), never by hand: the key in the URL is the only thing that tells Uplisting's posts apart
// (they are not signed).
// - The integration off (no UPLISTING_API_KEY, no UPLISTING_WEBHOOK_SECRET of 16+ characters, or no Stripe)
//   → 503 { error }. A missing or wrong key → 401 { error: 'Not authorised.' } (compared in constant time).
// - Otherwise → 200 { ok: true } at once (Uplisting wants a 2xx within 5 seconds and disables an endpoint after
//   5 failures in a row); the work runs after the answer (waitUntil): the booking is read again from Uplisting's
//   API and our record created, changed or cancelled from that copy. A failure there is only logged (no
//   personal data): the next webhook of that booking, or the next sync, brings it in line.
import { json, readBody, logError } from '../../../booking-lib/core.js';
import { uplistingStatus, webhookKeyOk, handleWebhook, HOOK_EVENTS } from '../../../booking-lib/uplisting.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (uplistingStatus(env) !== 'on' || !env.STRIPE_SECRET_KEY) return json(request, { error: 'The Uplisting connection is off.' }, 503, env);
  const url = new URL(request.url);
  if (!(await webhookKeyOk(env, url.searchParams.get('key')))) return json(request, { error: 'Not authorised.' }, 401, env);
  const body = await readBody(request, 65536);
  const ev = url.searchParams.get('event');
  const event = HOOK_EVENTS.includes(ev) ? ev : null;
  const work = handleWebhook(env, body, event).catch(e => {
    const p = body && typeof body === 'object' ? (body.data && typeof body.data === 'object' ? body.data : body) : {};
    logError('uplisting.webhook', e, { booking: /^[A-Za-z0-9-]{1,24}$/.test(String(p.id)) ? String(p.id) : null, event });
    return null;
  });
  if (typeof context.waitUntil === 'function') { try { context.waitUntil(work); } catch { await work; } }
  else await work;
  return json(request, { ok: true }, 200, env);
}
