// /api/booking/admin — bookings dashboard data and actions. Requires Authorization: Bearer <ADMIN_TOKEN>.
// GET ?program=ID   one week: bookings (with sessions, note, room assignment, source, discount), the week's
//                   rooms and sessions (program_detail), the rooming map, availability and the setup panel.
// GET ?overview=1   every week at a glance: totals, places, alerts, the 15 newest bookings.
// GET reads only. POST actions: cancel (also closes any open balance link), restore (refuses to
// overbook unless force), balance_link (asks before charging a booking that has a refund), repair_plans
// (plan-end safety net), register_domains (Apple Pay / Google Pay / Link for embedded checkout),
// note / assign / svc_status (the team's notes, kept on the booking's own PaymentIntent / subscription; an
// ended plan's on its first invoice's PaymentIntent, see saveAdminMeta in core.js),
// create_link (a 24-hour booking link made by the team, optionally with a discount).
import {
  json, preflight, guardPost, readBody, adminAuthorized, getProgram, listPrograms, programSummary, programDetail, programPayments, groupBookings,
  openBookingSessions, openSessionsRaw, recentRaw, recentProgramPayments, mergePayments, buildOccupancy, occupancy, availability, checkAvailability, validRef, findBooking, forgetBooking, stripe,
  balanceSession, openBalanceSessions, openAddonSessions, expireSession, expireOrCheck, sessionState, balancePageUrl, bookingPageUrl, roomCapacity, roomingMap, ensurePlanEnds, planEndAt,
  planEndCheck, planEndCheckRecord, keyMode, publishableStatus, turnstileSiteKey, turnstileStatus, remindEnabled, listDomains, ensurePaymentMethodDomain,
  clearAvailabilityMemo, quote, publicQuote, bookingMetadata, bookingCheckoutParams, safeCreateSession, newRef, cleanNote, str, parseAssign,
  assignToString, parseSvc, svcToString, SVC_STATUS, saveAdminMeta, currentBookingMeta, logError, eur, nowSec, PROD_HOSTS,
  liveMode,
} from '../../../booking-lib/core.js';
import { seedDemo, clearDemo } from '../../../booking-lib/demo.js';

export const onRequestOptions = ({ request, env }) => preflight(request, env);

const setupBase = env => ({
  stripe: keyMode(env), publishable: publishableStatus(env), webhook: !!env.STRIPE_WEBHOOK_SECRET,
  turnstile: !!turnstileSiteKey(env), turnstile_status: turnstileStatus(env), ghl: !!env.GHL_WEBHOOK_URL, remind: remindEnabled(env),
});
const planRecords = pays => pays.filter(p => p.sub && p.status !== 'canceled');
const roomsOf = program => program.rooms.map(r => ({ id: r.id, name: r.name, capacity: roomCapacity(r), price: r.price, shared: !!r.same_gender, unit: r.unit }));
const META_MAX = 490;

/* ------------------------------------------------------------------ overview */
const ZERO_TOTALS = () => ({ bookings: 0, guests: 0, paid_cents: 0, balance_cents: 0, refunded_cents: 0, sessions_count: 0, sessions_cents: 0 });
/* A booking whose balance has to be asked for (not one a running plan collects by itself). */
const balanceDue = b => b.balance_cents > 0 && !b.pending && (!b.plan || b.plan.ended);
const planIssue = b => !!b.plan && b.plan.status !== 'canceled' && (b.plan.status === 'past_due' || b.plan.status === 'unpaid'
  || b.plan.end_check === 'missing' || b.plan.end_check === 'movable' || b.plan.end_check === 'short' || (b.plan.ended && b.balance_cents > 0));
function weekSummary(program, bookings, avail) {
  const active = bookings.filter(b => b.status !== 'cancelled');
  const totals = {
    bookings: active.length, guests: active.reduce((s, b) => s + b.guests.length, 0),
    paid_cents: active.reduce((s, b) => s + b.paid_cents, 0), balance_cents: active.reduce((s, b) => s + b.balance_cents, 0),
    refunded_cents: bookings.reduce((s, b) => s + (b.refunded_cents || 0), 0),
    sessions_count: active.reduce((s, b) => s + b.sessions_count, 0), sessions_cents: active.reduce((s, b) => s + b.sessions_cents, 0),
  };
  return {
    program: programSummary(program), totals,
    places: { left: avail.program_left, spaces: program.program_spaces },
    alerts: {
      balance_due: active.filter(balanceDue).length, plan_issues: active.filter(planIssue).length,
      unverified_room_only: active.filter(b => b.programme === 'paid' && b.programme_verified === 'unverified').length,
      pending: active.filter(b => b.pending).length,
    },
  };
}
function overviewOf(weeks, recentBookings) {
  const totals = ZERO_TOTALS();
  weeks.forEach(w => Object.keys(totals).forEach(k => { totals[k] += w.totals[k]; }));
  const recent = recentBookings.sort((a, b) => b.b.created - a.b.created).slice(0, 15).map(({ p, b }) => ({
    ref: b.ref, program: p.id, edition: p.edition || p.title, created: b.created, lead_name: b.lead.name || '', guests: b.guests.length,
    total_cents: b.total_cents, paid_cents: b.paid_cents, status: b.status,
  }));
  return { overview: true, weeks, recent, totals };
}

export async function onRequestGet({ request, env }) {
  const send = (d, s = 200) => json(request, d, s, env);
  if (!adminAuthorized(request, env)) return send({ error: 'Not authorised.' }, 401);
  const params = new URL(request.url).searchParams;
  const programs = listPrograms().map(programSummary);

  if (params.get('overview')) {
    const progs = listPrograms();
    if (!env.STRIPE_SECRET_KEY) {
      const weeks = progs.map(p => ({ ...weekSummary(p, [], availability(p)), totals: ZERO_TOTALS() }));
      return send({ ...overviewOf(weeks, []), demo: true, programs });
    }
    try {
      // the real-time lists are the same for every week: read them once
      const [recent, rows] = await Promise.all([recentRaw(env), openSessionsRaw(env)]);
      const all = await Promise.all(progs.map(async p => {
        const [pays, open] = await Promise.all([programPayments(env, p, { amounts: true, recent }), openBookingSessions(env, p, rows)]);
        return { p, bookings: groupBookings(p, pays), avail: availability(p, buildOccupancy(p, pays, open)) };
      }));
      const weeks = all.map(x => weekSummary(x.p, x.bookings, x.avail));
      return send({ ...overviewOf(weeks, all.flatMap(x => x.bookings.map(b => ({ p: x.p, b })))), live: true, programs });
    } catch (e) { logError('admin.overview', e); return send({ error: 'Could not load bookings from Stripe: ' + e.message }, 502); }
  }

  const program = getProgram(params.get('program')) || listPrograms()[0];
  const detail = programDetail(program);
  if (!env.STRIPE_SECRET_KEY) {
    return send({ demo: true, programs, program: programSummary(program), program_detail: detail, bookings: [], rooms: roomsOf(program),
      availability: availability(program), ...roomingMap(program, []), setup: { ...setupBase(env), domains: [] } });
  }
  try {
    const [pays, open, domains] = await Promise.all([
      programPayments(env, program, { amounts: true }),
      openBookingSessions(env, program),
      listDomains(env).catch(e => { logError('admin.domains', e); return null; }),
    ]);
    const bookings = groupBookings(program, pays);
    const occ = buildOccupancy(program, pays, open);
    const active = bookings.filter(b => b.status !== 'cancelled');
    const checks = planRecords(pays).map(p => ({ p, state: planEndCheckRecord(p).state }));
    return send({
      live: true, programs, program: programSummary(program), program_detail: detail, bookings,
      rooms: roomsOf(program),
      availability: availability(program, occ), holds: occ.holds,
      ...roomingMap(program, bookings),
      setup: { ...setupBase(env), domains },
      // plans whose end date is missing or wrong (Repair payment plans fixes them) …
      plans_without_end: checks.filter(c => c.state === 'missing' || c.state === 'movable').length,
      // … and plans whose last period was already cut short (invoice the difference by hand)
      plans_short: checks.filter(c => c.state === 'short').map(c => ({ ref: c.p.md.aob_ref, subscription: c.p.id })),
      totals: {
        bookings: active.length, guests: active.reduce((s, b) => s + b.guests.length, 0),
        paid_cents: active.reduce((s, b) => s + b.paid_cents, 0), balance_cents: active.reduce((s, b) => s + b.balance_cents, 0),
        refunded_cents: bookings.reduce((s, b) => s + (b.refunded_cents || 0), 0),
        paid_after_cancel_cents: bookings.reduce((s, b) => s + (b.paid_after_cancel_cents || 0), 0),
        sessions_count: active.reduce((s, b) => s + b.sessions_count, 0), sessions_cents: active.reduce((s, b) => s + b.sessions_cents, 0),
      },
    });
  } catch (e) { logError('admin.get', e); return send({ error: 'Could not load bookings from Stripe: ' + e.message }, 502); }
}

/* -------------------------------------------------------------- team notes */
/* The team's keys live on the booking's own PaymentIntent (or the plan's subscription; once a plan has
   ended, on its first invoice's PaymentIntent). They are read from Stripe directly before a change
   (search can lag a minute behind an update, and two quick edits must not undo each other), then
   written back. '' removes a key. */
const currentMeta = currentBookingMeta;
const saveOnBooking = saveAdminMeta;

/* Warnings for the rooms this booking's guests are in, after its new assignment. */
function assignWarnings(program, bookings, booking) {
  const { rooming } = roomingMap(program, bookings);
  const mine = new Set(Object.values(booking.assign || {}));
  const out = [];
  for (const name of mine) {
    const slot = rooming[name];
    if (!slot) continue;
    if (slot.conflict === 'mixed') out.push(`${name}: women and men are in the same room.`);
    else if (slot.conflict === 'over') out.push(`${name}: ${slot.guests.length} guests for ${slot.capacity} ${slot.capacity === 1 ? 'place' : 'beds'}.`);
  }
  return out;
}

/* -------------------------------------------------------------- admin link */
/* A booking link the team sends (WhatsApp, email): Stripe's own page, open for 23.9 hours, holding its
   places meanwhile. The same checks as a guest's checkout (prices, rooms, availability) plus an
   optional discount; the guest ticks the terms on Stripe's page (the webhook records the acceptance
   on the booking). terms: 'collected' | 'not_collected' (Stripe refused the terms tick, or the week
   has no terms page), with a warning for the team in the second case. */
const TERMS_WARNING = 'Stripe isn\'t set up to ask for terms acceptance on this link. Add a terms URL in Stripe → Settings → Public details, or send the terms with the link.';
const NO_TERMS_PAGE = 'This week has no terms page, so the link doesn\'t ask for terms acceptance. Send the terms with the link.';
const termsInfo = (program, params, dropped = []) => {
  const asked = !!params.consent_collection && !dropped.some(d => /consent_collection|terms_of_service/.test(d));
  return asked ? { terms: 'collected' } : { terms: 'not_collected', warning: program.terms_url ? TERMS_WARNING : NO_TERMS_PAGE };
};
async function createLink(env, body, send) {
  const program = getProgram(body.program);
  if (!program) return send({ error: 'Unknown week.' }, 404);
  if (new Date().toISOString().slice(0, 10) > program.dates.end) return send({ error: `${program.edition || program.title} has ended.` }, 410);
  if (body.payment !== 'deposit' && body.payment !== 'full') {
    const msg = 'Choose the deposit or payment in full.';
    return send({ error: msg, fields: { payment: msg } }, 422);
  }
  const q = quote(program, body, { admin: true });
  if (!q.ok) return send({ error: 'Please check the highlighted details.', fields: q.errors }, 422);
  if (q.due_now_cents < 50) { // Stripe's smallest card payment
    const msg = 'That leaves less than €0.50 to pay today, which Stripe can\'t take. Lower the discount, or record this booking by hand.';
    return send({ error: msg, fields: { [q.discount ? 'discount.value' : 'payment']: msg } }, 422);
  }
  const note = cleanNote(body.note);
  const returnUrl = bookingPageUrl(program, body.return_url, env);
  const ref = newRef(program);
  const md = bookingMetadata(program, q, ref, { page: returnUrl, ui: 'hosted', source: 'admin', note, progVerified: 'admin' });
  const params = bookingCheckoutParams(program, q, ref, md, returnUrl, { hours: 23.9, consent: true });
  if (!env.STRIPE_SECRET_KEY) return send({ ok: true, demo: true, url: null, ref, expires_at: params.expires_at, quote: publicQuote(q), ...termsInfo(program, params), stripe_params: params });

  const [payments, open] = await Promise.all([programPayments(env, program), openBookingSessions(env, program)]);
  // an earlier link for the same guest is replaced (one hold per person): left out of the check,
  // given up only once the new link exists (and only if it can be: see below)
  const lead = q.guests[0].email;
  const mineS = open.filter(s => s.metadata.aob_source === 'admin' && s.metadata.aob_lead_email === lead);
  const mine = mineS.map(s => s.id), mineRefs = new Set(mineS.map(s => s.metadata.aob_ref).filter(Boolean));
  const avail = availability(program, buildOccupancy(program, payments, open, mine));
  const full = checkAvailability(program, q, avail);
  if (full) return send({ error: full, code: 'unavailable', availability: avail }, 409);
  const { session, dropped } = await safeCreateSession(env, params);
  const drop = async (status, data) => { await expireSession(env, session.id); clearAvailabilityMemo(program.id); return send(data, status); };
  // the same race check as a guest's checkout: an earlier hold for the last places wins, and a hold
  // paid meanwhile counts as booked (except the link being replaced: a payment of it is answered below)
  try {
    const [fresh, recent] = await Promise.all([openBookingSessions(env, program), recentProgramPayments(env, program)]);
    const created = session.created || nowSec();
    const earlier = fresh.filter(s => s.id !== session.id && !mine.includes(s.id) && s.created <= created);
    const pays = mergePayments(payments, recent).filter(p => !mineRefs.has(p.md.aob_ref));
    const clash = checkAvailability(program, q, availability(program, buildOccupancy(program, pays, earlier)));
    if (clash) return await drop(409, { error: clash, code: 'unavailable' });
  } catch (e) { logError('admin.link_race', e, { ref }); }
  // Only now give up the earlier link(s). One that was paid (or is paying) meanwhile is the booking:
  // the new link isn't needed. One Stripe couldn't close stays payable: never leave two payable links.
  const results = await Promise.all(mine.map(id => expireOrCheck(env, id)));
  for (const r of results) {
    if (r.state !== 'complete' || !r.session) continue;
    const st = await sessionState(env, r.session);
    if (st === 'paid' || st === 'processing') {
      const old = (r.session.metadata || {}).aob_ref || null;
      return await drop(409, { error: `The earlier link for this guest${old ? ` (${old})` : ''} has just been paid${st === 'processing' ? ' (the payment is still clearing)' : ''}, so no new link was made.`,
        code: 'already_paid', ref: old, session_id: r.session.id });
    }
  }
  if (results.some(r => r.state === 'open' || r.state === 'unknown')) {
    logError('admin.link_replace', { type: 'expire_failed' }, { ref });
    return await drop(503, { error: 'The earlier link for this guest couldn\'t be closed just now, so no new link was made. Please try again in a moment.', code: 'busy', retry_after: 5 });
  }
  clearAvailabilityMemo(program.id);
  return send({ ok: true, url: session.url, session_id: session.id, ref, expires_at: session.expires_at,
    replaced: results.filter(r => r.state === 'expired').length, ...termsInfo(program, params, dropped), quote: publicQuote(q) });
}

export async function onRequestPost({ request, env }) {
  const send = (d, s = 200) => json(request, d, s, env);
  const bad = guardPost(request, env);
  if (bad) return bad;
  if (!adminAuthorized(request, env)) return send({ error: 'Not authorised.' }, 401);
  const body = await readBody(request);
  if (!body) return send({ error: 'Invalid request.' }, 400);
  // a booking link can be tried without Stripe (demo: the quote and the Checkout Session it would open)
  if (body.action === 'create_link' && !env.STRIPE_SECRET_KEY) return createLink(env, body, send);
  if (!env.STRIPE_SECRET_KEY) return send({ error: 'Stripe is not connected yet.' }, 503);

  try {
    if (body.action === 'create_link') return await createLink(env, body, send);
    if (body.action === 'seed_demo' || body.action === 'clear_demo') {
      // test mode only: fill a week with demo bookings (about `percent` % of its places), or remove them
      if (liveMode(env)) return send({ error: 'Demo bookings are only available in Stripe test mode.' }, 403);
      const program = getProgram(body.program);
      if (!program) return send({ error: 'Unknown week.' }, 404);
      const r = body.action === 'seed_demo'
        ? await seedDemo(env, program, { percent: Math.round(Number(body.percent) || 40) })
        : await clearDemo(env, program);
      return send({ ok: true, ...r });
    }
    if (body.action === 'register_domains') {
      const domains = await Promise.all(PROD_HOSTS.map(h => ensurePaymentMethodDomain(env, h).catch(e => {
        logError('admin.register_domains', e);
        return { domain: h, registered: false, error: e.message };
      })));
      return send({ ok: domains.every(d => d.registered), domains });
    }
    if (body.action === 'repair_plans') {
      // Sets a missing end date, and moves a wrong one when that can't change any payment. A plan
      // whose current period was already cut short is only reported: invoice the difference by hand
      // (or send a balance link once the plan has ended).
      const progs = body.program ? [getProgram(body.program)].filter(Boolean) : listPrograms();
      const repaired = [], failed = [], short = [];
      for (const program of progs) {
        const pays = await programPayments(env, program);
        for (const p of planRecords(pays)) {
          const state = planEndCheckRecord(p).state, ref = p.md.aob_ref;
          if (state === 'short') { short.push({ subscription: p.id, ref, cancel_at: p.cancel_at, should_end_at: planEndAt({ ...p, billing_cycle_anchor: p.anchor, metadata: p.md }) }); continue; }
          if (state !== 'missing' && state !== 'movable') continue;
          try {
            const u = await ensurePlanEnds(env, p.id);
            if (u.cancel_at && u.cancel_at === planEndAt(u)) repaired.push({ subscription: p.id, ref, ends_at: u.cancel_at, moved: state === 'movable' });
            else if (planEndCheck(u).state === 'short') short.push({ subscription: p.id, ref, cancel_at: u.cancel_at, should_end_at: planEndAt(u) });
          } catch (e) { logError('admin.repair_plans', e); failed.push({ subscription: p.id, ref, error: e.message }); }
        }
      }
      return send({ ok: failed.length === 0, repaired, failed, short });
    }

    const ref = String(body.ref || '').toUpperCase();
    if (!validRef(ref)) return send({ error: 'Invalid reference.' }, 400);
    const found = await findBooking(env, ref);
    if (!found) return send({ error: 'Booking not found (new bookings can take a minute to appear).' }, 404);
    const { program, booking } = found;

    if (body.action === 'note') {
      const note = cleanNote(body.note);
      await saveOnBooking(env, booking, { aob_note: note });
      forgetBooking(ref);
      return send({ ok: true, ref, note });
    }
    if (body.action === 'assign') {
      if (!body.assign || typeof body.assign !== 'object' || Array.isArray(body.assign)) return send({ error: 'Nothing to assign.' }, 400);
      const next = parseAssign((await currentMeta(env, booking)).aob_assign), fields = {};
      for (const [k, v] of Object.entries(body.assign)) {
        const i = /^\d{1,2}$/.test(k) ? parseInt(k, 10) : -1, g = booking.guests[i];
        if (!g) { fields[`assign.${k}`] = 'There is no such guest on this booking.'; continue; }
        const name = str(v, 120);
        if (!name) { delete next[i]; continue; }
        const r = program.rooms.find(x => x.id === g.room);
        if (!r || !Array.isArray(r.names) || !r.names.includes(name)) { fields[`assign.${i}`] = `${name} is not one of the ${r ? r.name : 'booked'} rooms.`; continue; }
        if (/[|=]/.test(name)) { fields[`assign.${i}`] = 'This room name can\'t be stored (it contains | or =). Rename it in the program file.'; continue; }
        next[i] = name;
      }
      if (Object.keys(fields).length) return send({ error: 'Please check the rooms.', fields }, 422);
      const s = assignToString(next);
      if (s.length > META_MAX) return send({ error: 'Too many room names to store on one booking.' }, 422);
      await saveOnBooking(env, booking, { aob_assign: s });
      forgetBooking(ref);
      const assign = parseAssign(s);
      // warnings over the whole week (other bookings' guests may share the room)
      let warnings = [];
      try {
        const others = groupBookings(program, await programPayments(env, program)).filter(b => b.ref !== ref);
        warnings = assignWarnings(program, [...others, { ...booking, assign }], { assign });
      } catch (e) { logError('admin.assign_warnings', e, { ref }); warnings = assignWarnings(program, [{ ...booking, assign }], { assign }); }
      return send({ ok: true, ref, assign, warnings });
    }
    if (body.action === 'svc_status') {
      const key = String(body.key || '');
      if (!booking.addons.some(a => a.key === key)) return send({ error: 'That session is not on this booking.' }, 404);
      if (!SVC_STATUS.includes(body.status)) return send({ error: 'Choose a status.', fields: { status: `One of ${SVC_STATUS.join(', ')}.` } }, 422);
      const when = str(body.when, 40).replace(/;/g, ',');
      const map = parseSvc((await currentMeta(env, booking)).aob_svc);
      map[key] = { status: body.status, when };
      const s = svcToString(map);
      if (s.length > META_MAX) return send({ error: 'There is no room for more session times on this booking. Shorten the times, or clear those of sessions that are done.', code: 'too_long' }, 422);
      await saveOnBooking(env, booking, { aob_svc: s });
      forgetBooking(ref);
      return send({ ok: true, ref, key, status: body.status, when });
    }

    if (body.action === 'cancel' || body.action === 'restore') {
      const status = body.action === 'cancel' ? 'cancelled' : 'active';
      if (booking.plan && body.action === 'restore' && booking.plan.status === 'canceled') {
        return send({ error: 'This plan was stopped in Stripe and can\'t be restored. Make a new booking instead.' }, 409);
      }
      if (body.action === 'restore' && booking.status === 'cancelled' && body.force !== true) {
        // its places may have been sold since: check against today's bookings and open checkouts
        const avail = availability(program, await occupancy(env, program));
        const guests = booking.guests.length ? booking.guests.map(g => ({ gender: g.gender, room: g.room }))
          : Object.entries(booking.rooms).flatMap(([room, n]) => Array.from({ length: n }, () => ({ gender: '', room })));
        const clash = checkAvailability(program, { guests }, avail);
        if (clash) return send({ error: `Restoring ${ref} would overbook: ${clash}`, code: 'conflict', availability: avail }, 409);
      }
      // aob_status_at: when it was cancelled, so payments that still come in afterwards stand out
      // (an ended plan's subscription may refuse it: then on the plan's overlay, see saveAdminMeta)
      const metadata = { aob_status: status, aob_status_at: status === 'cancelled' ? String(nowSec()) : '' };
      await saveOnBooking(env, booking, metadata);
      if (booking.plan && body.action === 'cancel' && booking.plan.status !== 'canceled') await stripe(env, 'DELETE', `/subscriptions/${booking.booking_pi}`); // stop future monthly payments
      let closed = 0, closedExtras = 0;
      if (body.action === 'cancel') {
        // a balance link already sent, or a wellbeing-session checkout, must not stay payable for a cancelled booking
        try {
          const [links, extras] = await Promise.all([openBalanceSessions(env, ref), openAddonSessions(env, ref)]);
          const done = await Promise.all([...links, ...extras].map(s => expireSession(env, s.id)));
          closed = done.slice(0, links.length).filter(Boolean).length;
          closedExtras = done.slice(links.length).filter(Boolean).length;
          if (closed + closedExtras < done.length) logError('admin.cancel_links', { type: 'expire_failed' }, { ref });
        } catch (e) { logError('admin.cancel_links', e, { ref }); }
      }
      forgetBooking(ref);
      clearAvailabilityMemo(program.id);
      return send({ ok: true, ref, status, balance_links_closed: closed, addon_checkouts_closed: closedExtras });
    }
    if (body.action === 'balance_link') {
      const p = booking.plan;
      if (p && !p.ended) return send({ error: 'This booking is on the monthly payment plan: the remaining payments are taken automatically.' }, 409);
      if (p && !p.paid_known) return send({ error: 'Stripe didn\'t say what this plan has paid so far. Please try again in a moment.' }, 503);
      if (booking.status === 'cancelled') return send({ error: 'This booking is cancelled. Restore it first if the guest should pay.' }, 409);
      if (booking.pending) return send({ error: 'The first payment for this booking is still processing.' }, 409);
      if (booking.balance_cents <= 0) return send({ error: 'Nothing left to pay on this booking.' }, 409);
      // a refund of the booking's own payments (not of a wellbeing session bought on the extras page)
      if (booking.refunded_booking_cents > 0 && body.force !== true) {
        return send({ error: `${eur(booking.refunded_booking_cents)} of booking ${ref} has been refunded. A balance link would ask the guest for ${eur(booking.balance_cents)}.`, code: 'refunded',
          refunded_cents: booking.refunded_booking_cents, balance_cents: booking.balance_cents }, 409);
      }
      // one payable balance session per booking: reuse a long-lived open one, else replace it
      const { session, reused } = await balanceSession(env, program, booking, balancePageUrl(body.return_url, env), { hours: 23.9, minLeftSec: 12 * 3600 });
      forgetBooking(ref);
      return send({ url: session.url, expires_at: session.expires_at, balance_cents: booking.balance_cents, reused, plan_ended: !!p });
    }
    return send({ error: 'Unknown action.' }, 400);
  } catch (e) { logError('admin.post', e, { action: String(body.action || '').slice(0, 30) }); return send({ error: 'Stripe error: ' + e.message }, 502); }
}
