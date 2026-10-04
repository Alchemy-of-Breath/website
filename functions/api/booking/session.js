// GET /api/booking/session?id=cs_… — what the confirmation screen shows after a checkout.
// state: paid | processing | open | expired | unpaid. Only "paid" means the place is confirmed.
// kind: booking | balance | addon (wellbeing sessions added after booking, from /book/extras/).
// The session id travels in return URLs, so the answer carries nothing personal beyond a first name
// and a masked receipt address (sessions name their guest by number, not by name).
import {
  json, preflight, getProgram, stripe, roomsFromString, findBooking, forgetBooking, ensurePlanEnds, planDates, sessionState, clientIp, ipHash, rateLimited,
  parseAddons, maskEmail, isBusy, logError, nowSec, BUSY, CS_ID,
} from '../../../booking-lib/core.js';

const sessionOut = a => ({ id: a.id, guest: a.guest, title: a.title, practitioner: a.practitioner, practitioner_name: a.practitioner_name, minutes: a.minutes, price_cents: a.price_cents });
export const onRequestOptions = ({ request, env }) => preflight(request, env);

export async function onRequestGet({ request, env }) {
  const send = (d, s = 200) => json(request, d, s, env);
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!CS_ID.test(id)) return send({ error: 'Invalid session.' }, 400);
  if (!env.STRIPE_SECRET_KEY) return send({ demo: true });
  const iph = await ipHash(env, clientIp(request));
  if (iph && rateLimited('session:' + iph, 120, 10 * 60 * 1000)) return send({ error: 'Too many requests. Please try again in a few minutes.', code: 'too_many' }, 429);
  try {
    const s = await stripe(env, 'GET', `/checkout/sessions/${id}`);
    const md = s.metadata || {};
    const program = getProgram(md.aob_program);
    if (!program) return send({ error: 'Not found.' }, 404);
    const state = await sessionState(env, s);
    // a payment just went through: this isolate's 30 s booking memo (filled before it) is stale now
    // (the webhook clears it too, but in whichever isolate Stripe's call lands)
    if (state === 'paid' && md.aob_ref) forgetBooking(md.aob_ref);
    const rooms = Object.entries(roomsFromString(md.aob_rooms)).map(([rid, n]) => ({ name: (program.rooms.find(r => r.id === rid) || { name: rid }).name, guests: n }));
    let balance = md.aob_kind === 'booking' ? parseInt(md.aob_balance || '0', 10) : null;
    if (md.aob_kind === 'balance' && state === 'paid') { try { const f = await findBooking(env, md.aob_ref); balance = f ? f.booking.balance_cents : null; } catch {} }
    let plan = null;
    if (s.mode === 'subscription' || md.aob_payment === 'plan') {
      // the plan's shape comes from the metadata; its dates need the subscription (left out if Stripe is busy)
      const n = parseInt(md.aob_plan_n || '3', 10);
      plan = { installments: n, installment_cents: parseInt(md.aob_installment || '0', 10), dates: null, ends_at: null };
      if (s.subscription) {
        try {
          const sub = await ensurePlanEnds(env, typeof s.subscription === 'string' ? s.subscription : s.subscription.id); // safety net if the webhook has not run yet
          plan.dates = planDates(sub.billing_cycle_anchor || sub.start_date || s.created, n);
          plan.ends_at = sub.cancel_at || null;
        } catch (e) { logError('session.plan', e); }
      }
    }
    return send({
      kind: md.aob_kind, ref: md.aob_ref, state, status: s.status, paid: state === 'paid',
      amount_paid_cents: state === 'paid' ? s.amount_total : 0, amount_total_cents: s.amount_total, currency: s.currency, payment: md.aob_payment || null,
      total_cents: parseInt(md.aob_total || '0', 10) || null, balance_cents: plan ? null : balance,
      balance_due: (program.deposit && program.deposit.balance_due) || null,
      guests: parseInt(md.aob_guests || '0', 10) || null, rooms, plan,
      programme: md.aob_prog || 'none', programme_cents: parseInt(md.aob_prog_total || '0', 10),
      addons: parseAddons(md.aob_addons, program).map(sessionOut), addons_cents: parseInt(md.aob_addons_total || '0', 10) || 0,
      services_note: md.aob_addons && program.services ? program.services.note || null : null,
      first_name: (md.aob_lead_name || '').split(' ')[0],
      receipt_email: maskEmail((s.customer_details && s.customer_details.email) || s.customer_email || md.aob_lead_email),
      arrival: (program.arrival && program.arrival.checkin) || null,
      expires_at: state === 'open' ? s.expires_at : null, server_now: nowSec(),
      program: { id: program.id, title: program.title, edition: program.edition, dates: program.dates, venue: program.venue.name },
    });
  } catch (e) {
    if (e.status === 404) return send({ error: 'Not found.' }, 404);
    logError('session', e);
    return isBusy(e) ? send(BUSY, 503) : send({ error: 'Could not load this payment.' }, 502);
  }
}
