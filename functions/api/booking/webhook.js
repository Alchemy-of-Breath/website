// POST /api/booking/webhook — Stripe → (verified) → GoHighLevel inbound webhook.
// In Stripe: Developers → Webhooks → https://website-5h3.pages.dev/api/booking/webhook with the events
//   checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed,
//   checkout.session.expired, invoice.paid, invoice.payment_failed, customer.subscription.deleted
// and put its signing secret in STRIPE_WEBHOOK_SECRET.
// Delivery to GHL is awaited (5 s); if GHL fails we answer 500 so Stripe retries. Paid bookings and
// paid wellbeing sessions are forwarded once: after a successful forward the PaymentIntent /
// subscription gets aob_ghl=<event id>.
// A paid booking (a guest's checkout or an admin booking link) is auto-placed first: its guests go into free
// physical rooms of their type (with the Uplisting integration and the auto-place setting on, see autoPlace in
// booking-lib/uplisting.js; idempotent on retries, never failing the webhook), and with the push to Uplisting on
// those rooms are closed there after the answer (waitUntil).
import {
  verifyStripeSignature, parseBooking, parseAddons, sessionLabel, getProgram, ensurePlanEnds, planDates, stripe, paidOnSub, liveMode,
  siteOrigin, findBooking, forgetBooking, currentBookingMeta, str, isBusy, logError, nowSec, openBookingSessions, programPayments,
} from '../../../booking-lib/core.js';
import { autoPlace } from '../../../booking-lib/uplisting.js';

const done = (t = 'ok', status = 200) => new Response(t, { status });
const money = c => (c == null || c === '' || Number.isNaN(+c)) ? '' : ((+c) / 100).toFixed(2);
const day = t => t ? new Date(t * 1000).toISOString().slice(0, 10) : '';
const idOf = v => typeof v === 'string' ? v : (v && v.id) || null;

async function forward(env, body) {
  const r = await fetch(env.GHL_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!r.ok) { const e = new Error(`GHL answered ${r.status}`); e.status = r.status; e.type = 'ghl_error'; throw e; }
}

/* "Muji: Magic Massage (60 min) for Ana Lee", one per session (guests: [{ name }] of the booking) */
const sessionLines = (addons, guests) => addons.map(a => `${sessionLabel(a)} for ${(guests[a.guest] && guests[a.guest].name) || `Guest ${a.guest + 1}`}`);

/* What every booking event carries: who, which week, which rooms, which wellbeing sessions. */
function bookingFields(event, md, program) {
  const b = parseBooking(md, program);
  const [first, ...rest] = String(md.aob_lead_name || '').split(' ');
  const roomName = id => (program && program.rooms.find(r => r.id === id) || { name: id }).name;
  const sessions = sessionLines(b.addons, b.guests);
  return {
    event_id: event.id, ref: md.aob_ref || '', program: md.aob_program,
    program_title: program ? `${program.edition || program.title} · ${program.dates.label}` : '',
    first_name: first || '', last_name: rest.join(' '), email: md.aob_lead_email || '', phone: md.aob_whatsapp || '',
    gender: (b.guests[0] && b.guests[0].gender) || '',
    guests: md.aob_guests || '', rooms: Object.entries(b.rooms).map(([id, n]) => `${roomName(id)} × ${n}`).join(', '),
    guest_list: b.guests.map(g => `${g.name}${g.email ? ` <${g.email}>` : ''}, ${g.gender}, ${roomName(g.room)}`).join('\n'),
    roommate: md.aob_roommate || '', diet: md.aob_diet || '',
    sessions, sessions_text: sessions.join('\n'), sessions_total: md.aob_addons_total ? money(md.aob_addons_total) : '',
    ...b.utm,
  };
}
function moneyFields(s, md, program, paid) {
  return {
    payment: md.aob_payment || '', currency: (s.currency || (program && program.currency) || '').toUpperCase(),
    amount_paid: paid ? money(s.amount_total || 0) : '0.00', amount_due: money(s.amount_total || 0),
    total: md.aob_total ? money(md.aob_total) : '',
    balance: md.aob_kind === 'booking' ? money(md.aob_balance || '0') : '',
    balance_due: (program && program.deposit && program.deposit.balance_due) || '', // '' = before arrival
    balance_url: md.aob_ref ? `${siteOrigin(md.aob_page)}/book/balance/?ref=${encodeURIComponent(md.aob_ref)}` : '',
    programme: md.aob_prog === 'included' ? 'included' : md.aob_prog === 'paid' ? 'paid separately' : '',
    programme_total: md.aob_prog_total ? money(md.aob_prog_total) : '',
    programme_verified: md.aob_prog === 'paid' ? (md.aob_prog_verified || 'unverified') : '',
    ui: md.aob_ui || '', stripe_session: s.id || '',
  };
}

/* Wellbeing sessions bought after booking (aob_kind addon), once paid: addon_paid for the team to
   arrange the times (addon_paid_after_cancel when the booking was cancelled meanwhile: refund or
   follow up). Forwarded once per payment, like booking_paid. Guest names come from the booking. */
async function onAddonPaid(env, event, s, md, program, paid) {
  if (!env.GHL_WEBHOOK_URL) return done();
  if (!paid) return done('addon pending'); // a delayed method: async_payment_succeeded forwards it
  let pi = null;
  if (s.payment_intent) pi = typeof s.payment_intent === 'object' ? s.payment_intent : await stripe(env, 'GET', `/payment_intents/${s.payment_intent}`);
  if (pi && (pi.metadata || {}).aob_ghl) return done('already forwarded');
  const f = md.aob_ref ? await findBooking(env, md.aob_ref) : null; // a Stripe error throws: 500, Stripe retries
  let afterCancel = false;
  if (f) afterCancel = (await currentBookingMeta(env, f.booking)).aob_status === 'cancelled'; // read fresh (an ended plan: its overlay)
  const guests = f ? f.booking.guests : [], lead = f ? f.booking.lead : {};
  const sessions = sessionLines(parseAddons(md.aob_addons, program), guests);
  const [first, ...rest] = String(md.aob_lead_name || '').split(' ');
  await forward(env, {
    event: afterCancel ? 'addon_paid_after_cancel' : 'addon_paid', event_id: event.id, ref: md.aob_ref || '', program: md.aob_program,
    program_title: program ? `${program.edition || program.title} · ${program.dates.label}` : '',
    first_name: first || '', last_name: rest.join(' '), email: md.aob_lead_email || '', phone: lead.whatsapp || '',
    sessions, sessions_text: sessions.join('\n'), sessions_total: money(md.aob_addons_total || s.amount_total || 0),
    amount_paid: money(s.amount_total || 0), currency: String(s.currency || (program && program.currency) || '').toUpperCase(),
    ui: md.aob_ui || '', stripe_session: s.id || '',
    tag: afterCancel ? `${md.aob_program}-addon-after-cancel` : `${md.aob_program}-addon-paid`,
  });
  if (pi) { try { await stripe(env, 'POST', `/payment_intents/${pi.id}`, { metadata: { aob_ghl: event.id } }); } catch (e) { logError('webhook.mark', e); } }
  if (md.aob_ref) forgetBooking(md.aob_ref);
  return done();
}

/* aob_terms_at (when the guest accepted, ISO) and aob_terms (the terms page) on the booking's
   PaymentIntent / subscription. Idempotent: nothing is written once aob_terms_at is there. Returns the
   updated subscription (plans), else null. */
async function recordTerms(env, event, s, md, program, sub) {
  let path, cur;
  if (sub) { path = `/subscriptions/${sub.id}`; cur = sub.metadata || {}; }
  else if (s.payment_intent) {
    const pi = typeof s.payment_intent === 'object' ? s.payment_intent : await stripe(env, 'GET', `/payment_intents/${s.payment_intent}`);
    path = `/payment_intents/${pi.id}`; cur = pi.metadata || {};
  } else return null;
  if (cur.aob_terms_at) return null;
  const at = new Date(((event.created || nowSec()) * 1000)).toISOString();
  const terms = (program && program.terms_url) ? str(program.terms_url, 300) : (md.aob_terms || '');
  const updated = await stripe(env, 'POST', path, { metadata: { aob_terms_at: at, ...(terms ? { aob_terms: terms } : {}) } });
  if (md.aob_ref) forgetBooking(md.aob_ref);
  return sub ? updated : null;
}

/* A paid booking's guests into free rooms (never failing the webhook); the push to Uplisting after the answer. */
async function placeBooking(context, env, md, program) {
  try {
    const r = await autoPlace(env, program, md, { host: hostOf(context && context.request) });
    if (r && r.push) {
      if (context && typeof context.waitUntil === 'function') { try { context.waitUntil(r.push); return; } catch {} }
      await r.push;
    }
  } catch (e) { logError('webhook.autoplace', e, { ref: md.aob_ref || null }); }
}
const hostOf = request => { try { return new URL(request.url).host; } catch { return ''; } };

/* checkout.session.completed / async_payment_succeeded */
async function onCompleted(env, event, s, asyncSucceeded, context = null) {
  const md = s.metadata || {};
  if (!md.aob_program || !['booking', 'balance', 'addon'].includes(md.aob_kind)) return done('not a booking');
  const program = getProgram(md.aob_program);
  if (md.aob_kind === 'addon') return onAddonPaid(env, event, s, md, program, asyncSucceeded || s.payment_status === 'paid' || s.payment_status === 'no_payment_required');
  let sub = null, planEnd = null, planPayDates = [];
  if (s.mode === 'subscription' && s.subscription) {
    // a payment plan: make sure it stops after its last monthly payment
    try {
      sub = await ensurePlanEnds(env, idOf(s.subscription));
      planEnd = sub.cancel_at || null;
      planPayDates = planDates(sub.billing_cycle_anchor || sub.start_date || s.created, parseInt(md.aob_plan_n || '3', 10));
    } catch (e) { logError('webhook.plan_end', e); return done('could not set plan end', 500); } // Stripe retries
  }
  // An admin booking link: the guest accepted the terms on Stripe's page; record it on the booking
  // (a guest's own checkout records aob_terms_at when it starts). Once, whatever GHL is set to.
  if (md.aob_kind === 'booking' && md.aob_source === 'admin' && s.consent && s.consent.terms_of_service === 'accepted') {
    try { sub = await recordTerms(env, event, s, md, program, sub) || sub; }
    catch (e) {
      logError('webhook.terms', e);
      if (isBusy(e)) return done('could not record the terms acceptance', 500); // Stripe retries
    }
  }
  const paid = asyncSucceeded || s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
  if (paid && md.aob_kind === 'booking' && program) await placeBooking(context, env, md, program);
  if (!env.GHL_WEBHOOK_URL) return done();
  const kind = md.aob_kind === 'balance' ? 'booking_balance' : 'booking';
  // forward a paid booking once: the PaymentIntent / subscription remembers the event that did it
  let mark = null;
  if (paid) {
    if (sub) mark = { path: `/subscriptions/${sub.id}`, md: sub.metadata || {} };
    else if (s.payment_intent) {
      const pi = typeof s.payment_intent === 'object' ? s.payment_intent : await stripe(env, 'GET', `/payment_intents/${s.payment_intent}`);
      mark = { path: `/payment_intents/${pi.id}`, md: pi.metadata || {} };
    }
    if (mark && mark.md.aob_ghl) return done('already forwarded');
  }
  // A balance link sent before the booking was cancelled can still be paid: tell the team instead
  // of thanking the guest (refund or follow up). The booking's status is read fresh, not from search.
  let afterCancel = false;
  if (paid && md.aob_kind === 'balance' && md.aob_ref) {
    const f = await findBooking(env, md.aob_ref); // a Stripe error throws: 500, Stripe retries
    if (f) afterCancel = (await currentBookingMeta(env, f.booking)).aob_status === 'cancelled'; // read fresh (an ended plan: its overlay)
  }
  const tag = !paid ? `${md.aob_program}-pending` : kind === 'booking' ? `${md.aob_program}-booked`
    : afterCancel ? `${md.aob_program}-balance-after-cancel` : `${md.aob_program}-balance-paid`;
  await forward(env, {
    event: afterCancel ? 'booking_balance_paid_after_cancel' : `${kind}_${paid ? 'paid' : 'pending'}`,
    ...bookingFields(event, md, program), ...moneyFields(s, md, program, paid), tag,
    plan_installments: md.aob_plan_n || '', plan_installment: md.aob_installment ? money(md.aob_installment) : '',
    plan_payment_dates: planPayDates.map(day).join(', '), plan_ends_at: day(planEnd),
  });
  if (mark) { try { await stripe(env, 'POST', mark.path, { metadata: { aob_ghl: event.id } }); } catch (e) { logError('webhook.mark', e); } }
  return done();
}

/* checkout.session.async_payment_failed: the bank debit didn't go through; the places are free again. */
async function onAsyncFailed(env, event, s) {
  const md = s.metadata || {};
  if (!md.aob_program || !md.aob_kind) return done('not a booking');
  if (!env.GHL_WEBHOOK_URL) return done();
  const program = getProgram(md.aob_program);
  const name = md.aob_kind === 'balance' ? 'booking_balance_payment_failed' : md.aob_kind === 'addon' ? 'addon_payment_failed' : 'booking_payment_failed';
  await forward(env, { event: name, ...bookingFields(event, md, program), ...moneyFields(s, md, program, false), tag: `${md.aob_program}-payment-failed` });
  return done();
}

/* checkout.session.expired: only for guests who asked for a reminder, only when the checkout timed
   out (not when the guest gave it back or replaced it: they are still on the page), and only when
   they haven't since started another checkout or booked. Links back to our own page (fresh prices
   and places), never to a path from the request. */
async function onExpired(env, event, s) {
  const md = s.metadata || {};
  if (md.aob_kind !== 'booking' || md.aob_remind !== '1' || !md.aob_program) return done('ignored');
  if ((event.created || nowSec()) < (s.expires_at || 0) - 120) return done('released, not abandoned');
  if (!env.GHL_WEBHOOK_URL) return done();
  const program = getProgram(md.aob_program);
  if (!program) return done('unknown program');
  const email = md.aob_lead_email || '';
  try {
    const [open, pays] = await Promise.all([openBookingSessions(env, program), programPayments(env, program)]);
    if (open.some(x => x.id !== s.id && x.metadata.aob_lead_email === email)) return done('still booking');
    if (pays.some(p => p.md.aob_kind === 'booking' && p.md.aob_lead_email === email && p.md.aob_status !== 'cancelled')) return done('already booked');
  } catch (e) { logError('webhook.expired_check', e); throw e; }
  await forward(env, {
    event: 'booking_abandoned', ...bookingFields(event, md, program), ...moneyFields(s, md, program, false),
    resume_url: `${siteOrigin(md.aob_page)}/book/${program.id}/`, tag: `${md.aob_program}-abandoned`,
  });
  return done();
}

/* invoice.paid (monthly plan instalments) / invoice.payment_failed */
async function onInvoice(env, event, inv, ok) {
  const subId = idOf(inv.subscription) || idOf(inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription);
  if (!subId) return done('not a subscription');
  if (ok && inv.billing_reason !== 'subscription_cycle') return done('ignored'); // the first payment is checkout.session.completed
  if (!ok && inv.billing_reason === 'subscription_create') return done('ignored'); // still inside Checkout
  let md = (inv.subscription_details && inv.subscription_details.metadata) || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.metadata) || null;
  let sub = null;
  if (!md || !md.aob_program) { sub = await stripe(env, 'GET', `/subscriptions/${subId}`); md = sub.metadata || {}; }
  if (md.aob_kind !== 'booking' || !md.aob_program) return done('not a booking');
  if (ok) sub = await ensurePlanEnds(env, subId); // safety net: the plan must stop after its last payment (also corrects a wrong end date while that's still safe)
  if (!env.GHL_WEBHOOK_URL) return done();
  const program = getProgram(md.aob_program);
  let counts = null; try { counts = await paidOnSub(env, subId); } catch {}
  await forward(env, {
    event: ok ? 'plan_payment_paid' : 'plan_payment_failed', ...bookingFields(event, md, program),
    currency: String(inv.currency || '').toUpperCase(), amount_paid: money(inv.amount_paid || 0), amount_due: money(inv.amount_due || 0),
    total: md.aob_total ? money(md.aob_total) : '', paid_count: counts ? counts.count : '', installments: md.aob_plan_n || '',
    plan_installment: md.aob_installment ? money(md.aob_installment) : '', plan_ends_at: day(sub && sub.cancel_at),
    hosted_invoice_url: inv.hosted_invoice_url || '', attempt_count: inv.attempt_count || '', next_payment_attempt: day(inv.next_payment_attempt),
    subscription: subId, tag: ok ? `${md.aob_program}-plan-paid` : `${md.aob_program}-plan-failed`,
  });
  return done();
}

/* customer.subscription.deleted: a plan ended (after its last payment, or stopped early). */
async function onSubDeleted(env, event, sub) {
  const md = sub.metadata || {};
  if (md.aob_kind !== 'booking' || !md.aob_program) return done('not a booking');
  if (!env.GHL_WEBHOOK_URL) return done();
  const program = getProgram(md.aob_program);
  let counts = null; try { counts = await paidOnSub(env, sub.id); } catch {}
  const n = parseInt(md.aob_plan_n || '3', 10);
  await forward(env, {
    event: 'plan_ended', ...bookingFields(event, md, program),
    paid_count: counts ? counts.count : '', installments: n, completed: counts ? (counts.count >= n ? 'yes' : 'no') : '',
    cancelled_by_team: md.aob_status === 'cancelled' ? 'yes' : 'no', subscription: sub.id, tag: `${md.aob_program}-plan-ended`,
  });
  return done();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await request.text();
  if (!env.STRIPE_WEBHOOK_SECRET) return done('webhook secret not configured', 503);
  if (!(await verifyStripeSignature(payload, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) return done('invalid signature', 400);
  let event; try { event = JSON.parse(payload); } catch { return done('bad json', 400); }
  // an endpoint wired to the other mode (test events with live keys, or the reverse) is ignored
  if (typeof event.livemode === 'boolean' && event.livemode !== liveMode(env)) return done('ignored: other mode');
  const obj = (event.data && event.data.object) || {};
  try {
    switch (event.type) {
      case 'checkout.session.completed': return await onCompleted(env, event, obj, false, context);
      case 'checkout.session.async_payment_succeeded': return await onCompleted(env, event, obj, true, context);
      case 'checkout.session.async_payment_failed': return await onAsyncFailed(env, event, obj);
      case 'checkout.session.expired': return await onExpired(env, event, obj);
      case 'invoice.paid': return await onInvoice(env, event, obj, true);
      case 'invoice.payment_failed': return await onInvoice(env, event, obj, false);
      case 'customer.subscription.deleted': return await onSubDeleted(env, event, obj);
      default: return done('ignored');
    }
  } catch (e) {
    logError('webhook', e, { event: event.type });
    return done('error', 500); // Stripe retries for up to 3 days
  }
}
