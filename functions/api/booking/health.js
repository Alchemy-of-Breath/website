// GET /api/booking/health — which pieces are configured (never reveals the values).
import { json, preflight, listPrograms } from '../../../booking-lib/core.js';
export const onRequestOptions = ({ request }) => preflight(request);
export function onRequestGet({ request, env }) {
  const key = env.STRIPE_SECRET_KEY || '';
  return json(request, {
    ok: true,
    stripe: key ? (key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : 'test') : 'not connected (demo mode)',
    webhook: !!env.STRIPE_WEBHOOK_SECRET, admin: !!(env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16), ghl: !!env.GHL_WEBHOOK_URL,
    programs: listPrograms().map(p => p.id),
  });
}
