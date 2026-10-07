// POST /api/booking/uplisting?key=<UPLISTING_WEBHOOK_SECRET>… — Uplisting (and the scheduled sync) → booking system
// (see booking-lib/uplisting.js). The key in the URL is the only thing that tells these posts apart from anyone
// else's (Uplisting doesn't sign them). The integration off (no UPLISTING_API_KEY, no UPLISTING_WEBHOOK_SECRET of 16+
// characters, or no Stripe) → 503 { error }. A missing or wrong key → 401 { error: 'Not authorised.' } (compared in
// constant time).
//
// &event=booking_created|booking_updated|booking_removed (the webhooks, registered from the admin: Setup → Uplisting →
//   Connect webhooks) → 200 { ok: true } at once (Uplisting wants a 2xx within 5 seconds and disables an endpoint after
//   5 failures in a row); the work runs after the answer (waitUntil): the booking is read again from Uplisting's API and
//   our record created, changed or cancelled from that copy. A failure there is only logged (no personal data): the
//   next webhook of that booking, or the next sync, brings it in line.
//
// &action=sync[&cursor=…] (the scheduled sync: .github/workflows/uplisting-sync.yml, twice a day) → ONE slice of the full
//   sync (bookings, nights closed in Uplisting, then — with the push on — the push reconcile), the same as the admin's
//   uplisting_sync: 200 { ok, done, cursor | null, progress, stats, closures, push?, warnings?, paused?, retry_after? }.
//   Call again with the cursor until done (the cursor may also come as JSON { "cursor": "…" }: it can be long). Errors:
//   409 no_mapping, 400 bad_cursor, 502 uplisting_auth, 503 too_big / busy. Logged by the 'Automatic sync' actor (one
//   uplisting_sync entry when it is done; uplisting_closed / uplisting_push_close / uplisting_push_reopen as they happen).
//
// &notify=1&listing=<id> (Uplisting's answer to a calendar change the push made) → its Authorization header must be
//   base64(UPLISTING_API_KEY) ('Basic …' or bare) → 200 { ok: true }, else 401. A change Uplisting could not apply, and
//   a wrong header, go to the activity log (uplisting_push_error).
import { json, readBody, logError, isBusy, BUSY } from '../../../booking-lib/core.js';
import { uplistingStatus, webhookKeyOk, handleWebhook, handleNotify, syncSlice, syncSummary, HOOK_EVENTS } from '../../../booking-lib/uplisting.js';
import { logActivity, SCHEDULE_ACTOR } from '../../../booking-lib/team.js';

const later = (context, p) => {
  if (typeof context.waitUntil === 'function') { try { context.waitUntil(p); return null; } catch {} }
  return p;
};

async function scheduledSync(context, url) {
  const { request, env } = context;
  const body = await readBody(request, 65536);
  const cursor = (body && typeof body.cursor === 'string' && body.cursor) || url.searchParams.get('cursor') || null;
  let r;
  try { r = await syncSlice(env, { cursor, mode: 'sync', host: url.host, actor: SCHEDULE_ACTOR }); }
  catch (e) {
    logError('uplisting.scheduled', e);
    return json(request, isBusy(e) ? BUSY : { error: 'The sync failed (Stripe). It is tried again at the next run.', code: 'stripe' }, isBusy(e) ? 503 : 502, env);
  }
  if (r.status === 200) {
    const entries = [...(r.activity || []), ...(r.data.done ? [{ action: 'uplisting_sync', summary: syncSummary(r.data.stats) }] : [])];
    if (entries.length) {
      const p = (async () => { for (const e of entries) await logActivity(env, SCHEDULE_ACTOR, e); })();
      const wait = later(context, p);
      if (wait) await wait;
    }
  }
  return json(request, r.data, r.status, env);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (uplistingStatus(env) !== 'on' || !env.STRIPE_SECRET_KEY) return json(request, { error: 'The Uplisting connection is off.' }, 503, env);
  const url = new URL(request.url);
  if (!(await webhookKeyOk(env, url.searchParams.get('key')))) return json(request, { error: 'Not authorised.' }, 401, env);
  if (url.searchParams.get('action') === 'sync') return scheduledSync(context, url);
  if (url.searchParams.get('notify') === '1') {
    const body = await readBody(request, 262144);
    const r = await handleNotify(env, { authorization: request.headers.get('Authorization') || '', listing: url.searchParams.get('listing') || '', body })
      .catch(e => { logError('uplisting.notify', e); return { status: 200 }; });
    return json(request, r.status === 401 ? { error: 'Not authorised.' } : { ok: true }, r.status, env);
  }
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
