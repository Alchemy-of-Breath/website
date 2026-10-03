// POST /api/booking/checkout — validate, price on the server, re-check availability, open Stripe Checkout.
import {
  json, preflight, getProgram, isClosed, quote, checkAvailability, occupancy, availability,
  newRef, bookingMetadata, bookingCheckoutParams, safeReturnUrl, publicQuote, stripe,
} from '../../../booking-lib/core.js';
export const onRequestOptions = ({ request }) => preflight(request);
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json(request, { error: 'Invalid request.' }, 400); }
  const program = getProgram(body && body.program);
  if (!program) return json(request, { error: 'Unknown program.' }, 404);
  if (isClosed(program)) return json(request, { error: 'Booking for this week has closed. Message us on WhatsApp and we will help.' }, 410);

  const q = quote(program, body);
  if (!q.ok) return json(request, { error: 'Please check the highlighted details.', fields: q.errors }, 422);

  const live = !!env.STRIPE_SECRET_KEY;
  let avail;
  try { avail = availability(program, live ? await occupancy(env, program) : undefined); }
  catch { return json(request, { error: 'We could not check availability just now. Please try again in a moment.' }, 502); }
  const full = checkAvailability(program, q, avail);
  if (full) return json(request, { error: full, availability: avail }, 409);

  const ref = newRef(program);
  const md = bookingMetadata(program, q, ref, { page: body.page, utm: body.utm });
  const params = bookingCheckoutParams(program, q, ref, md, safeReturnUrl(body.return_url, `https://website-5h3.pages.dev/book/${program.id}/`));
  if (!live) return json(request, { demo: true, ref, quote: publicQuote(q), stripe_params: params });
  try {
    const session = await stripe(env, 'POST', '/checkout/sessions', params);
    return json(request, { url: session.url, ref, quote: publicQuote(q) });
  } catch (e) {
    return json(request, { error: 'We could not start the payment. Please try again, or message us on WhatsApp.' }, 502);
  }
}
