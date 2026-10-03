// POST /api/booking/balance — a guest pays their remaining balance (reference + lead email).
import { json, preflight, validRef, findBooking, balanceCheckoutParams, safeReturnUrl, stripe } from '../../../booking-lib/core.js';
export const onRequestOptions = ({ request }) => preflight(request);
export async function onRequestPost({ request, env }) {
  let body; try { body = await request.json(); } catch { return json(request, { error: 'Invalid request.' }, 400); }
  const ref = String(body && body.ref || '').trim().toUpperCase();
  const email = String(body && body.email || '').trim().toLowerCase();
  if (!validRef(ref) || !email) return json(request, { error: 'Enter your booking reference and the email you booked with.' }, 400);
  if (!env.STRIPE_SECRET_KEY) return json(request, { demo: true, error: 'Payments are not connected yet.' }, 503);
  try {
    const found = await findBooking(env, ref);
    if (!found || (found.booking.lead.email || '').toLowerCase() !== email) {
      return json(request, { error: 'We could not find a booking with that reference and email.' }, 404);
    }
    const { program, booking } = found;
    if (booking.status === 'cancelled') return json(request, { error: 'This booking has been cancelled. Message us on WhatsApp if that looks wrong.' }, 409);
    if (booking.balance_cents <= 0) return json(request, { paid_in_full: true, ref, total_cents: booking.total_cents });
    if (booking.plan) return json(request, { plan: true, ref, balance_cents: booking.balance_cents, installment_cents: booking.plan.installment_cents,
      paid_count: booking.plan.paid_count, installments: booking.plan.installments, next_payment: booking.plan.next_payment });
    const session = await stripe(env, 'POST', '/checkout/sessions',
      balanceCheckoutParams(program, booking, booking.balance_cents, safeReturnUrl(body.return_url, 'https://website-5h3.pages.dev/book/balance/')));
    return json(request, { url: session.url, ref, balance_cents: booking.balance_cents });
  } catch { return json(request, { error: 'We could not start the payment. Please try again in a moment.' }, 502); }
}
