// GET /api/booking/health — which pieces are configured (never reveals the values).
import { json, preflight, listPrograms, keyMode, publishableStatus, turnstileSiteKey, turnstileStatus, remindEnabled } from '../../../booking-lib/core.js';
import { uplistingStatus } from '../../../booking-lib/uplisting.js';
export const onRequestOptions = ({ request, env }) => preflight(request, env);
export function onRequestGet({ request, env }) {
  const mode = keyMode(env);
  return json(request, {
    ok: true,
    stripe: mode === 'none' ? 'not connected (demo mode)' : mode,
    publishable: publishableStatus(env), // test | live | missing | mismatch (wrong mode for the secret key)
    webhook: !!env.STRIPE_WEBHOOK_SECRET, admin: !!(env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16), ghl: !!env.GHL_WEBHOOK_URL,
    turnstile: !!turnstileSiteKey(env),
    turnstile_status: turnstileStatus(env), // on | off | misconfigured (only one of TURNSTILE_SITE_KEY / TURNSTILE_SECRET set)
    remind: remindEnabled(env),
    uplisting: uplistingStatus(env), // off | on | no_webhook_secret (UPLISTING_API_KEY set, UPLISTING_WEBHOOK_SECRET missing or under 16 characters)
    programs: listPrograms().map(p => p.id),
  }, 200, env);
}
