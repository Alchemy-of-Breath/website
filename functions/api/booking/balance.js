// /api/booking/balance — a guest pays their remaining balance (reference + lead email).
//   GET                                          → { turnstile_site_key } (the page's bot check, when on)
//   POST { action:'lookup', ref, email }         → what's paid and what's left (no Stripe session)
//   POST { action:'pay' (default), ref, email, return_url } → one payable balance session (reused if open)
// Bookings with a refund of their booking or balance payment are settled with the team, not here (a
// refund must never become payable again; a refunded wellbeing session doesn't count, it never touches
// the balance). Plans pay themselves; a plan that has ended short gets a normal balance payment.
import {
  json, preflight, guardPost, readBody, clientIp, ipHash, rateLimited, verifyTurnstile, turnstileSiteKey, validRef, knownRef, findBooking,
  balanceSession, balancePageUrl, isBusy, logError, BUSY,
} from '../../../booking-lib/core.js';
export const onRequestOptions = ({ request, env }) => preflight(request, env);

export function onRequestGet({ request, env }) {
  return json(request, { turnstile_site_key: turnstileSiteKey(env) }, 200, env);
}

const NOT_FOUND = { error: 'We could not find a booking with that reference and email.' };

export async function onRequestPost({ request, env }) {
  const send = (d, s = 200) => json(request, d, s, env);
  const bad = guardPost(request, env);
  if (bad) return bad;
  const body = await readBody(request);
  if (!body) return send({ error: 'Invalid request.' }, 400);
  const action = body.action === 'lookup' ? 'lookup' : 'pay';
  const ref = String(body.ref || '').trim().toUpperCase();
  const email = String(body.email || '').trim().toLowerCase();
  if (!validRef(ref) || !email) return send({ error: 'Enter your booking reference and the email you booked with.' }, 400);
  if (!env.STRIPE_SECRET_KEY) return send({ demo: true, error: 'Payments are not connected yet.' }, 503);
  const ip = clientIp(request), iph = await ipHash(env, ip);
  if (iph && rateLimited('balance:' + iph, 20, 10 * 60 * 1000)) {
    return send({ error: 'Too many tries. Please wait a few minutes and try again.', code: 'too_many' }, 429);
  }
  const human = await verifyTurnstile(env, body.turnstile, ip, { action: 'balance' });
  if (!human.ok) return send({ error: 'Please confirm you\'re not a robot, then try again.', code: 'turnstile' }, 403);
  if (!knownRef(ref)) return send(NOT_FOUND, 404); // not a reference we issue: no Stripe calls
  try {
    const found = await findBooking(env, ref, { cached: action === 'lookup' }); // paying always reads fresh
    if (!found || (found.booking.lead.email || '').toLowerCase() !== email) return send(NOT_FOUND, 404);
    const { program, booking } = found;
    if (booking.status === 'cancelled') return send({ error: 'This booking has been cancelled. Message us on WhatsApp if that looks wrong.' }, 409);
    const info = {
      ref, total_cents: booking.total_cents, paid_cents: booking.paid_cents, balance_cents: booking.balance_cents,
      balance_due: (program.deposit && program.deposit.balance_due) || null, currency: program.currency,
      program: { id: program.id, title: program.title, edition: program.edition, dates: program.dates },
    };
    if (booking.pending) return send({ ...info, error: 'Your first payment is still being processed. Please check back once it has cleared.', code: 'processing' }, 409);
    if (booking.balance_cents <= 0) return send({ paid_in_full: true, ...info });
    if (booking.plan) {
      const p = booking.plan;
      if (!p.ended) return send({ plan: true, ...info, installment_cents: p.installment_cents, paid_count: p.paid_count, installments: p.installments, next_payment: p.next_payment });
      if (!p.paid_known) return send(BUSY, 503); // can't tell what the plan has paid: never guess a balance
      Object.assign(info, { plan_ended: true, paid_count: p.paid_count, installments: p.installments });
    }
    if (booking.refunded_booking_cents > 0) { // a refunded wellbeing session (extras) doesn't stop the balance
      return send({ ...info, code: 'refunded', error: 'Part of this booking has been refunded, so we\'ll settle what\'s left with you directly. Please message us on WhatsApp.' }, 409);
    }
    if (action === 'lookup') return send(info);
    const { session, reused } = await balanceSession(env, program, booking, balancePageUrl(body.return_url, env));
    return send({ url: session.url, ref, balance_cents: booking.balance_cents, expires_at: session.expires_at, reused, plan_ended: !!info.plan_ended });
  } catch (e) {
    logError('balance', e, { ref });
    return isBusy(e) ? send(BUSY, 503) : send({ error: 'We could not start the payment. Please try again in a moment.' }, 502);
  }
}
