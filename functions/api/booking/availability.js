// GET /api/booking/availability?program=<id> — places left per room right now.
import { json, preflight, getProgram, isClosed, occupancy, availability, planInfo } from '../../../booking-lib/core.js';
export const onRequestOptions = ({ request }) => preflight(request);
export async function onRequestGet({ request, env }) {
  const program = getProgram(new URL(request.url).searchParams.get('program'));
  if (!program) return json(request, { error: 'Unknown program.' }, 404);
  const live = !!env.STRIPE_SECRET_KEY;
  try {
    const avail = availability(program, live ? await occupancy(env, program) : undefined);
    return json(request, { program: program.id, live, closed: isClosed(program), payment_plan: planInfo(program, env), ...avail });
  } catch (e) {
    // Stripe unreachable: show the program's own capacity; checkout re-checks before charging.
    return json(request, { program: program.id, live, degraded: true, closed: isClosed(program), payment_plan: planInfo(program, env), ...availability(program) });
  }
}
