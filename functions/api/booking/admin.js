// /api/booking/admin — bookings dashboard data and actions. Requires Authorization: Bearer <ADMIN_TOKEN>.
import {
  json, preflight, adminAuthorized, getProgram, listPrograms, programSummary, programPayments, groupBookings,
  occupancy, availability, validRef, findBooking, stripe, balanceCheckoutParams, safeReturnUrl, roomCapacity, ensurePlanEnds,
} from '../../../booking-lib/core.js';
export const onRequestOptions = ({ request }) => preflight(request);

export async function onRequestGet({ request, env }) {
  if (!adminAuthorized(request, env)) return json(request, { error: 'Not authorised.' }, 401);
  const program = getProgram(new URL(request.url).searchParams.get('program')) || listPrograms()[0];
  const programs = listPrograms().map(programSummary);
  if (!env.STRIPE_SECRET_KEY) return json(request, { demo: true, programs, program: programSummary(program), bookings: [], availability: availability(program) });
  try {
    const pays = await programPayments(env, program, { amounts: true });
    // safety net: every running plan must have its end date set
    for (const p of pays) if (p.sub && !p.cancel_at && (p.status === 'active' || p.status === 'past_due')) { try { const u = await ensurePlanEnds(env, p.id); p.cancel_at = u.cancel_at || null; } catch {} }
    const bookings = groupBookings(program, pays);
    const occ = await occupancy(env, program, pays);
    const active = bookings.filter(b => b.status !== 'cancelled');
    return json(request, {
      live: true, programs, program: programSummary(program), bookings,
      rooms: program.rooms.map(r => ({ id: r.id, name: r.name, capacity: roomCapacity(r), price: r.price, shared: !!r.same_gender })),
      availability: availability(program, occ), holds: occ.holds,
      totals: {
        bookings: active.length, guests: active.reduce((s, b) => s + b.guests.length, 0),
        paid_cents: active.reduce((s, b) => s + b.paid_cents, 0), balance_cents: active.reduce((s, b) => s + b.balance_cents, 0),
      },
    });
  } catch (e) { return json(request, { error: 'Could not load bookings from Stripe: ' + e.message }, 502); }
}

export async function onRequestPost({ request, env }) {
  if (!adminAuthorized(request, env)) return json(request, { error: 'Not authorised.' }, 401);
  if (!env.STRIPE_SECRET_KEY) return json(request, { error: 'Stripe is not connected yet.' }, 503);
  let body; try { body = await request.json(); } catch { return json(request, { error: 'Invalid request.' }, 400); }
  const ref = String(body && body.ref || '').toUpperCase();
  if (!validRef(ref)) return json(request, { error: 'Invalid reference.' }, 400);
  try {
    const found = await findBooking(env, ref);
    if (!found) return json(request, { error: 'Booking not found (new bookings can take a minute to appear).' }, 404);
    const { program, booking } = found;
    if (body.action === 'cancel' || body.action === 'restore') {
      const status = body.action === 'cancel' ? 'cancelled' : 'active';
      if (booking.plan) {
        if (body.action === 'restore' && booking.plan.status === 'canceled') return json(request, { error: 'This plan was stopped in Stripe and can\'t be restored. Make a new booking instead.' }, 409);
        await stripe(env, 'POST', `/subscriptions/${booking.booking_pi}`, { metadata: { aob_status: status } });
        if (body.action === 'cancel') await stripe(env, 'DELETE', `/subscriptions/${booking.booking_pi}`); // stop future monthly payments
      } else {
        await stripe(env, 'POST', `/payment_intents/${booking.booking_pi}`, { metadata: { aob_status: status } });
      }
      return json(request, { ok: true, ref, status });
    }
    if (body.action === 'balance_link') {
      if (booking.plan) return json(request, { error: 'This booking is on the monthly payment plan: the remaining payments are taken automatically.' }, 409);
      if (booking.balance_cents <= 0) return json(request, { error: 'Nothing left to pay on this booking.' }, 409);
      const s = await stripe(env, 'POST', '/checkout/sessions',
        balanceCheckoutParams(program, booking, booking.balance_cents, safeReturnUrl(body.return_url, 'https://website-5h3.pages.dev/book/balance/'), 23.9));
      return json(request, { url: s.url, expires_at: s.expires_at, balance_cents: booking.balance_cents });
    }
    return json(request, { error: 'Unknown action.' }, 400);
  } catch (e) { return json(request, { error: 'Stripe error: ' + e.message }, 502); }
}
