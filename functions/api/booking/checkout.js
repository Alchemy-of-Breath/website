// POST /api/booking/checkout — validate, price on the server, re-check availability, open Stripe Checkout
// (embedded in the booking page when a publishable key is set and the page asks for it, else Stripe's page).
import {
  json, preflight, guardPost, readBody, clientIp, ipHash, verifyTurnstile, getProgram, isClosed, quote, planInfo,
  checkAvailability, availability, buildOccupancy, programPayments, recentProgramPayments, mergePayments, openBookingSessions,
  newRef, bookingMetadata, bookingCheckoutParams, bookingPageUrl, publicQuote, stripe, safeCreateSession, expireSession, expireOrCheck,
  sessionState, programmeFeePayments, claimedProgrammePayments, matchProgramme, publishableKey, autoRegisterDomain, clearAvailabilityMemo,
  cleanAttempt, remindEnabled, isBusy, logError, BUSY, CS_ID, nowSec,
} from '../../../booking-lib/core.js';

export const onRequestOptions = ({ request, env }) => preflight(request, env);

const MAX_HOLDS_PER_VISITOR = 3; // open checkouts per visitor (IP hash, IPv6 by /64) and week…
// …and at most one booking's worth of places in them, so one visitor can't hold the whole week
const maxPlaces = program => program.max_guests_per_booking || 6;
const guestsOf = s => Math.max(1, parseInt((s.metadata || {}).aob_guests || '1', 10) || 1);
const overCap = (program, held, adding) => held.length + 1 > MAX_HOLDS_PER_VISITOR || held.reduce((n, s) => n + guestsOf(s), 0) + adding > maxPlaces(program);
const TOO_MANY = { error: 'You already have bookings in progress. Please finish or wait a few minutes.', code: 'too_many_holds' };
const alreadyPaid = s => ({ error: 'This booking is already paid. We\'re showing your confirmation.', code: 'already_paid', session_id: s.id, ref: (s.metadata || {}).aob_ref || null });
const num = v => typeof v === 'number' && Number.isFinite(v);
const priceChanged = (exp, q) => (num(exp.due_now_cents) && Math.round(exp.due_now_cents) !== q.due_now_cents)
  || (num(exp.total_cents) && Math.round(exp.total_cents) !== q.total_cents);

export async function onRequestPost(context) {
  const { request, env } = context;
  const send = (d, s = 200) => json(request, d, s, env);
  const bad = guardPost(request, env);
  if (bad) return bad;
  const body = await readBody(request);
  if (!body) return send({ error: 'Invalid request.' }, 400);
  const program = getProgram(body.program);
  if (!program) return send({ error: 'Unknown program.' }, 404);
  if (isClosed(program)) return send({ error: 'Booking for this week has closed. Message us on WhatsApp and we will help.', code: 'closed' }, 410);

  const ip = clientIp(request);
  const human = await verifyTurnstile(env, body.turnstile, ip);
  if (!human.ok) return send({ error: 'Please confirm you\'re not a robot, then try again.', code: 'turnstile' }, 403);

  const q = quote(program, body);
  if (!q.ok) return send({ error: 'Please check the highlighted details.', fields: q.errors }, 422);
  if (q.payment === 'plan' && !planInfo(program, env).available) {
    const msg = 'The monthly payment plan isn\'t available for this booking. Please choose the deposit or pay in full.';
    return send({ error: msg, fields: { payment: msg } }, 422);
  }
  if (body.expected && typeof body.expected === 'object' && priceChanged(body.expected, q)) {
    return send({ error: 'Prices were updated. Please check your total.', code: 'price_changed', quote: publicQuote(q) }, 409);
  }
  q.remind = q.remind && remindEnabled(env); // the reminder email only when it can be sent safely

  // Return links: our own booking page on the origin the guest is on (never a path from the request).
  const returnUrl = bookingPageUrl(program, body.return_url, env);
  const page = bookingPageUrl(program, body.page, env);
  const attempt = cleanAttempt(body.attempt);

  /* ---------- demo mode: no Stripe key, nothing is charged ---------- */
  if (!env.STRIPE_SECRET_KEY) {
    const avail = availability(program);
    const full = checkAvailability(program, q, avail);
    if (full) return send({ error: full, code: 'unavailable', availability: avail }, 409);
    const ref = newRef(program);
    const md = bookingMetadata(program, q, ref, { page, utm: body.utm, ui: 'hosted', attempt });
    return send({ demo: true, ref, quote: publicQuote(q), stripe_params: bookingCheckoutParams(program, q, ref, md, returnUrl) });
  }

  /* ---------- live ---------- */
  const embedded = body.ui === 'embedded' && !!publishableKey(env);
  const lead = q.guests[0].email;
  const iph = await ipHash(env, ip);
  const feeLookup = q.programme === 'paid' ? programmeFeePayments(env, program, lead).catch(() => []) : Promise.resolve(null);

  let payments, open;
  try { [payments, open] = await Promise.all([programPayments(env, program), openBookingSessions(env, program)]); }
  catch (e) {
    logError('checkout.read', e);
    return isBusy(e) ? send(BUSY, 503) : send({ error: 'We could not check availability just now. Please try again in a moment.' }, 502);
  }

  // This visitor's own earlier checkouts: the one this browser is replacing, and any other open
  // booking for this week with the same lead email from the same visitor (one hold per person).
  // They are left out of every check below and expired only once the new checkout exists, so a
  // refused request never cancels anything, and nobody can cancel someone else's checkout by typing
  // their email address.
  const mine = new Set();
  if (typeof body.replace === 'string' && CS_ID.test(body.replace)) {
    let s = open.find(x => x.id === body.replace);
    if (!s) { try { s = await stripe(env, 'GET', `/checkout/sessions/${body.replace}`); } catch { s = null; } }
    const md = (s && s.metadata) || {};
    if (s && md.aob_kind === 'booking' && md.aob_program === program.id) {
      if (s.status === 'complete') {
        // the checkout this browser is replacing has been paid (a bank app, another tab, a slow
        // confirmation): never open a second payment for the same booking
        const st = await sessionState(env, s);
        if (st === 'paid' || st === 'processing') return send(alreadyPaid(s), 409);
      } else if (s.status === 'open' && (md.aob_lead_email === lead || (iph && md.aob_iph === iph))) mine.add(s.id);
    }
  }
  if (iph) open.forEach(s => { if ((s.metadata.aob_lead_email || '') === lead && s.metadata.aob_iph === iph) mine.add(s.id); });
  const ids = [...mine];

  // Abuse cap: a few open checkouts, and one booking's worth of places, per visitor and week.
  if (iph && overCap(program, open.filter(s => !mine.has(s.id) && s.metadata.aob_iph === iph), q.guests.length)) return send(TOO_MANY, 429);

  const avail = availability(program, buildOccupancy(program, payments, open, ids));
  const full = checkAvailability(program, q, avail);
  if (full) return send({ error: full, code: 'unavailable', availability: avail }, 409);

  let prog = { status: 'unverified', pis: [] };
  const feePays = await feeLookup;
  if (feePays) prog = matchProgramme(feePays, q.guests.length, claimedProgrammePayments(payments, open, ids));

  const ref = newRef(program);
  const md = bookingMetadata(program, q, ref, { page, utm: body.utm, ui: embedded ? 'embedded' : 'hosted', attempt, iph, progVerified: prog.status, progPis: prog.pis });
  const params = bookingCheckoutParams(program, q, ref, md, returnUrl, { embedded });
  let session;
  try { ({ session } = await safeCreateSession(env, params)); }
  catch (e) {
    logError('checkout.create', e, { ref });
    if (isBusy(e)) return send(BUSY, 503);
    if (e.type === 'invalid_request_error' && e.param === 'customer_email') {
      return send({ error: 'Please check the highlighted details.', fields: { 'guests.0.email': 'Please check this email address.' } }, 422);
    }
    return send({ error: 'We could not start the payment. Please try again, or message us on WhatsApp.' }, 502);
  }
  const drop = async (status, data) => { await expireSession(env, session.id); clearAvailabilityMemo(program.id); return send(data, status); };

  // Race checks against a fresh list: two requests can pass the checks above at the same moment (the
  // last place, or one visitor firing many requests at once). Holds are ordered by creation time;
  // sessions created in the same second count as earlier (Stripe ids don't follow creation order),
  // so in a tie both back off rather than both keep the place.
  try {
    const [fresh, recent] = await Promise.all([openBookingSessions(env, program), recentProgramPayments(env, program)]);
    const created = session.created || nowSec();
    const earlier = fresh.filter(s => s.id !== session.id && !mine.has(s.id) && s.created <= created);
    if (iph && overCap(program, earlier.filter(s => s.metadata.aob_iph === iph), q.guests.length)) return await drop(429, TOO_MANY);
    const pays = mergePayments(payments, recent);
    const clash = checkAvailability(program, q, availability(program, buildOccupancy(program, pays, earlier)));
    if (clash) {
      const now = availability(program, buildOccupancy(program, pays, fresh, [...ids, session.id]));
      return await drop(409, { error: clash, code: 'unavailable', availability: now });
    }
  } catch (e) { logError('checkout.race', e, { ref }); } // the first checks passed: keep the session

  // Only now give up the visitor's earlier checkouts. One may have been paid in the meantime (a bank
  // app, another tab): then this new checkout isn't needed. One released a moment ago is just gone.
  const results = await Promise.all(ids.map(id => expireOrCheck(env, id)));
  for (const r of results) {
    if (r.state !== 'complete' || !r.session) continue;
    const st = await sessionState(env, r.session);
    if (st === 'paid' || st === 'processing') return await drop(409, alreadyPaid(r.session));
  }

  clearAvailabilityMemo(program.id);
  const base = { session_id: session.id, expires_at: session.expires_at, server_now: nowSec(), ref, quote: publicQuote(q) };
  if (embedded) {
    if (!session.client_secret) {
      logError('checkout.embedded', { type: 'no_client_secret' }, { ref });
      return await drop(502, { error: 'We could not start the payment. Please try again, or message us on WhatsApp.' });
    }
    autoRegisterDomain(env, request, p => context.waitUntil(p)); // wallets need the page host registered with Stripe
    return send({ ui: 'embedded', client_secret: session.client_secret, publishable_key: publishableKey(env), ...base });
  }
  return send({ ui: 'hosted', url: session.url, ...base });
}
