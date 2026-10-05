// /api/booking/admin — bookings dashboard data and actions. Requires Authorization: Bearer <ADMIN_TOKEN>.
// GET ?program=ID   one week: bookings (online ones with sessions, note, room assignment, source, discount and
//                   payments incl. offline ones; manual bookings overlapping the week with source 'manual'), the
//                   week's rooms and sessions (program_detail), the rooming map (blocked rooms, manual guests),
//                   availability (after the team's records), the blocks overlapping the week, the setup panel.
// GET ?overview=1   every week at a glance: totals (manual bookings and offline payments included), places, alerts,
//                   the 15 newest bookings; manual stays outside every week under `stay`.
// GET ?stays=1      the manual bookings outside every week (program 'stay'), with their offline payments.
// GET ?calendar=1&from=YYYY-MM-DD&to=YYYY-MM-DD   the rooming calendar (up to 120 nights): every physical room by
//                   area, every guest's stay (online and manual), the blocks, guests not placed in a room yet.
// GET reads only. POST actions: cancel (also closes any open balance link), restore (refuses to
// overbook unless force), balance_link (asks before charging a booking that has a refund), repair_plans
// (plan-end safety net), register_domains (Apple Pay / Google Pay / Link for embedded checkout),
// note / assign / svc_status (the team's notes, kept on the booking's own PaymentIntent / subscription; an
// ended plan's on its first invoice's PaymentIntent, see saveAdminMeta in core.js),
// create_link (a 24-hour booking link made by the team, optionally with a discount),
// block_create / block_delete (rooms out of use for some nights), manual_create / manual_cancel /
// manual_restore / manual_update (bookings made by hand for any dates; a clash with what is booked → 409
// code 'conflict' with the list, unless force), offline_payment (a bank transfer, cash… recorded on a booking;
// more than the balance → 409 code 'overpay' unless force) / offline_void (undo one).
import {
  json, preflight, guardPost, readBody, adminAuthorized, getProgram, listPrograms, programSummary, programDetail, programPayments, groupBookings,
  openBookingSessions, openSessionsRaw, recentRaw, recentProgramPayments, mergePayments, buildOccupancy, occupancy, availability, checkAvailability, validRef, findBooking, forgetBooking, stripe,
  balanceSession, openBalanceSessions, openAddonSessions, expireSession, expireOrCheck, sessionState, balancePageUrl, bookingPageUrl, roomCapacity, roomingMap, ensurePlanEnds, planEndAt,
  planEndCheck, planEndCheckRecord, keyMode, publishableStatus, turnstileSiteKey, turnstileStatus, remindEnabled, listDomains, ensurePaymentMethodDomain,
  clearAvailabilityMemo, quote, publicQuote, bookingMetadata, bookingCheckoutParams, safeCreateSession, newRef, cleanNote, str, parseAssign,
  assignToString, parseSvc, svcToString, SVC_STATUS, saveAdminMeta, currentBookingMeta, logError, eur, nowSec, PROD_HOSTS,
  liveMode, listRecords, listOffline, calendarRooms, weekConflicts, nameConflicts, manualBooking, blockOut, blockInput, manualInput,
  manualUpdateInput, offlineInput, createOfflinePayment, recordsChanged, rememberWrite, parseRecord, isManualRef, isBlockId, homeProgram,
  overlaps, weekRange, validDay, addDays, nightsBetween, todayIso, rangeLabel, OFFLINE_METHODS, REC_MAX_NIGHTS,
} from '../../../booking-lib/core.js';
import { seedDemo, clearDemo, placeDemo } from '../../../booking-lib/demo.js';

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
/* Totals over bookings (online and manual): the active ones, refunds of all. */
function totalsOf(bookings) {
  const active = bookings.filter(b => b.status !== 'cancelled');
  return {
    bookings: active.length, guests: active.reduce((s, b) => s + b.guests.length, 0),
    paid_cents: active.reduce((s, b) => s + b.paid_cents, 0), balance_cents: active.reduce((s, b) => s + b.balance_cents, 0),
    refunded_cents: bookings.reduce((s, b) => s + (b.refunded_cents || 0), 0),
    sessions_count: active.reduce((s, b) => s + b.sessions_count, 0), sessions_cents: active.reduce((s, b) => s + b.sessions_cents, 0),
  };
}
/* A booking whose balance has to be asked for (not one a running plan collects by itself). */
const balanceDue = b => b.balance_cents > 0 && !b.pending && (!b.plan || b.plan.ended);
const planIssue = b => !!b.plan && b.plan.status !== 'canceled' && (b.plan.status === 'past_due' || b.plan.status === 'unpaid'
  || b.plan.end_check === 'missing' || b.plan.end_check === 'movable' || b.plan.end_check === 'short' || (b.plan.ended && b.balance_cents > 0));
/* bookings: the week's online bookings and the manual ones that belong to it (homeProgram). */
function weekSummary(program, bookings, avail) {
  const active = bookings.filter(b => b.status !== 'cancelled');
  const totals = totalsOf(bookings);
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
/* stay: manual bookings outside every week ({ totals }); counted in the overall totals too. */
function overviewOf(weeks, recentBookings, stay = { totals: ZERO_TOTALS() }) {
  const totals = ZERO_TOTALS();
  [...weeks, stay].forEach(w => Object.keys(totals).forEach(k => { totals[k] += w.totals[k]; }));
  const recent = recentBookings.sort((a, b) => b.b.created - a.b.created).slice(0, 15).map(({ p, b }) => ({
    ref: b.ref, program: p ? p.id : 'stay', edition: p ? p.edition || p.title : 'Stay', created: b.created, lead_name: b.lead.name || '', guests: b.guests.length,
    total_cents: b.total_cents, paid_cents: b.paid_cents, status: b.status, source: b.source || 'online',
  }));
  return { overview: true, weeks, stay, recent, totals };
}

export async function onRequestGet({ request, env }) {
  const send = (d, s = 200) => json(request, d, s, env);
  if (!adminAuthorized(request, env)) return send({ error: 'Not authorised.' }, 401);
  const params = new URL(request.url).searchParams;
  const programs = listPrograms().map(programSummary);
  if (params.get('calendar')) {
    try { return await calendar(env, params, send); }
    catch (e) { logError('admin.calendar', e); return send({ error: 'Could not load the calendar from Stripe: ' + e.message }, 502); }
  }

  // the manual bookings outside every week (a one-night stay, a stay between the weeks): the weeks' data leaves them out
  if (params.get('stays')) {
    const program = { id: 'stay', edition: 'Outside the weeks', title: 'Stay', dates: {} };
    if (!env.STRIPE_SECRET_KEY) return send({ stays: true, demo: true, programs, program, bookings: [] });
    try {
      const [recs, offline] = await Promise.all([listRecords(env, { recent: true }), listOffline(env, { recent: true })]);
      const bookings = recs.filter(r => r.type === 'booking').map(r => manualBooking(r, offline)).filter(b => b.program === 'stay').sort((a, b) => b.created - a.created);
      return send({ stays: true, live: true, programs, program, bookings, totals: totalsOf(bookings) });
    } catch (e) { logError('admin.stays', e); return send({ error: 'Could not load bookings from Stripe: ' + e.message }, 502); }
  }

  if (params.get('overview')) {
    const progs = listPrograms();
    if (!env.STRIPE_SECRET_KEY) {
      const weeks = progs.map(p => ({ ...weekSummary(p, [], availability(p)), totals: ZERO_TOTALS() }));
      return send({ ...overviewOf(weeks, []), demo: true, programs });
    }
    try {
      // the real-time lists, the team's records and the offline payments are the same for every week: read them once
      const [recent, rows, recs, offline] = await Promise.all([recentRaw(env), openSessionsRaw(env), listRecords(env, { recent: true }), listOffline(env, { recent: true })]);
      // a manual booking counts in the first week it overlaps (or under `stay`), never twice
      const manual = recs.filter(r => r.type === 'booking').map(r => manualBooking(r, offline));
      const all = await Promise.all(progs.map(async p => {
        const [pays, open] = await Promise.all([programPayments(env, p, { amounts: true, recent, offline }), openBookingSessions(env, p, rows)]);
        return { p, bookings: [...groupBookings(p, pays), ...manual.filter(b => b.program === p.id)], avail: availability(p, buildOccupancy(p, pays, open, [], recs)) };
      }));
      const weeks = all.map(x => weekSummary(x.p, x.bookings, x.avail));
      const stayB = manual.filter(b => b.program === 'stay');
      return send({ ...overviewOf(weeks, [...all.flatMap(x => x.bookings.map(b => ({ p: x.p, b }))), ...stayB.map(b => ({ p: null, b }))], { totals: totalsOf(stayB) }), live: true, programs });
    } catch (e) { logError('admin.overview', e); return send({ error: 'Could not load bookings from Stripe: ' + e.message }, 502); }
  }

  const program = getProgram(params.get('program')) || listPrograms()[0];
  const detail = programDetail(program);
  if (!env.STRIPE_SECRET_KEY) {
    return send({ demo: true, programs, program: programSummary(program), program_detail: detail, bookings: [], rooms: roomsOf(program),
      availability: availability(program), ...roomingMap(program, []), blocks: [], setup: { ...setupBase(env), domains: [] } });
  }
  try {
    const [pays, open, domains, recs, offline] = await Promise.all([
      programPayments(env, program, { amounts: true }),
      openBookingSessions(env, program),
      listDomains(env).catch(e => { logError('admin.domains', e); return null; }),
      listRecords(env, { recent: true }),
      listOffline(env, { recent: true }), // every offline payment (a few): the week's bookings', and the manual bookings'
    ]);
    const online = groupBookings(program, [...pays, ...offline.filter(o => o.md.aob_program === program.id)]);
    const manual = recs.filter(r => r.type === 'booking' && overlaps(r, weekRange(program))).map(r => manualBooking(r, offline));
    const bookings = [...online, ...manual].sort((a, b) => b.created - a.created);
    const occ = buildOccupancy(program, pays, open, [], recs);
    const checks = planRecords(pays).map(p => ({ p, state: planEndCheckRecord(p).state }));
    return send({
      live: true, programs, program: programSummary(program), program_detail: detail, bookings,
      rooms: roomsOf(program),
      availability: availability(program, occ), holds: occ.holds,
      ...roomingMap(program, online, recs),
      blocks: occ.records.filter(r => r.type === 'block').map(blockOut),
      setup: { ...setupBase(env), domains },
      // plans whose end date is missing or wrong (Repair payment plans fixes them) …
      plans_without_end: checks.filter(c => c.state === 'missing' || c.state === 'movable').length,
      // … and plans whose last period was already cut short (invoice the difference by hand)
      plans_short: checks.filter(c => c.state === 'short').map(c => ({ ref: c.p.md.aob_ref, subscription: c.p.id })),
      totals: { ...totalsOf(bookings), paid_after_cancel_cents: bookings.reduce((s, b) => s + (b.paid_after_cancel_cents || 0), 0) },
    });
  } catch (e) { logError('admin.get', e); return send({ error: 'Could not load bookings from Stripe: ' + e.message }, 502); }
}

/* ---------------------------------------------------------------- calendar */
/* from / to (YYYY-MM-DD, `to` = the day after the last night shown). Both given: checked (at most
   REC_MAX_NIGHTS nights). Otherwise from = the earliest week's start − 7 days, to = the latest week's
   end + 7 days, cut to REC_MAX_NIGHTS nights. */
function calendarRange(params, progs) {
  const qf = params.get('from') || '', qt = params.get('to') || '';
  if ((qf && !validDay(qf)) || (qt && !validDay(qt))) return { error: 'Dates must look like 2027-07-18.' };
  if (qf && qt) {
    if (qf >= qt) return { error: 'The end date must be after the start date.' };
    if (nightsBetween(qf, qt) > REC_MAX_NIGHTS) return { error: `The calendar shows at most ${REC_MAX_NIGHTS} nights at a time.` };
    return { from: qf, to: qt };
  }
  const starts = progs.map(p => p.dates.start).sort(), ends = progs.map(p => p.dates.end).sort();
  const dFrom = starts.length ? addDays(starts[0], -7) : todayIso(), dTo = ends.length ? addDays(ends[ends.length - 1], 7) : addDays(dFrom, 28);
  let from = qf || dFrom, to = qt || dTo;
  if (qt && !qf && from >= to) from = addDays(to, -28);
  if (qf && !qt && to <= from) to = addDays(from, 28);
  if (nightsBetween(from, to) > REC_MAX_NIGHTS) { if (qt && !qf) from = addDays(to, -REC_MAX_NIGHTS); else to = addDays(from, REC_MAX_NIGHTS); }
  return { from, to };
}
const payState = b => b.pending ? 'processing' : b.plan ? 'plan' : b.balance_cents > 0 ? 'deposit' : 'paid';
const calendarRoomOut = r => ({ name: r.name, room_id: r.room_id, room_name: r.room_name, area: r.area, capacity: r.capacity, same_gender: r.same_gender, unit: r.unit, sleeps: r.sleeps });
async function calendar(env, params, send) {
  const progs = listPrograms(), range = calendarRange(params, progs);
  if (range.error) return send({ error: range.error }, 400);
  const { rooms, areas } = calendarRooms(progs);
  const base = {
    calendar: true, from: range.from, to: range.to, nights: nightsBetween(range.from, range.to), today: todayIso(),
    rooms: rooms.map(calendarRoomOut), areas,
    programs: progs.map(p => ({ id: p.id, edition: p.edition || p.title, title: p.title, dates: p.dates })),
  };
  if (!env.STRIPE_SECRET_KEY) return send({ ...base, demo: true, stays: [], blocks: [], unplaced: [], manual: [] });
  const weeksIn = progs.filter(p => overlaps(weekRange(p), range));
  const [recs, offline, recent] = await Promise.all([listRecords(env, { recent: true }), listOffline(env, { recent: true }), weeksIn.length ? recentRaw(env) : null]);
  const weeks = await Promise.all(weeksIn.map(async p => ({ p, bookings: groupBookings(p, await programPayments(env, p, { recent, offline })) })));
  const stays = [], unplaced = [];
  for (const { p, bookings } of weeks) {
    const per = {};
    for (const b of bookings) {
      if (b.status === 'cancelled') continue;
      const pay_state = payState(b);
      b.guests.forEach((g, i) => {
        const name = (b.assign || {})[i] || null;
        stays.push({ kind: 'online', ref: b.ref, program: p.id, index: i, name: g.name, gender: g.gender, room_id: g.room, room_name: name,
          from: p.dates.start, to: p.dates.end, demo: !!b.demo, status: b.status, pay_state });
        if (name) return;
        const c = per[g.room] || (per[g.room] = { program: p.id, room_id: g.room, count: 0, female: 0, male: 0,
          placeable: !!((p.rooms.find(x => x.id === g.room) || {}).names || []).length });
        c.count++; if (String(g.gender).toLowerCase() === 'male') c.male++; else c.female++;
      });
    }
    unplaced.push(...Object.values(per));
  }
  const inRange = recs.filter(r => overlaps(r, range));
  const manual = inRange.filter(r => r.type === 'booking').map(r => manualBooking(r, offline, rooms));
  for (const b of manual) {
    if (b.status === 'cancelled') continue;
    b.guests.forEach((g, i) => stays.push({ kind: 'manual', ref: b.ref, program: b.program, index: i, name: g.name, gender: g.gender, room_id: g.room, room_name: g.room_name,
      from: b.manual.from, to: b.manual.to, programme: b.manual.programme, comment: b.manual.comment, status: b.status,
      pay_state: !b.total_cents ? 'none' : !b.balance_cents ? 'paid' : b.paid_cents ? 'deposit' : 'unpaid' }));
  }
  return send({ ...base, live: true, stays, blocks: inRange.filter(r => r.type === 'block' && r.status === 'active').map(blockOut), unplaced, manual });
}

/* ---------------------------------------------- records: conflicts, find, GHL */
/* What a record (a new block or manual booking, or a manual booking being restored) would clash with:
   the rooms on the same nights (other records, online guests placed there), and every week it
   overlaps (its bookings and open checkouts must still fit, programme places included). → [text] */
async function conflictsFor(env, cand) {
  const progs = listPrograms().filter(p => overlaps(cand, weekRange(p)));
  const [recs, recent, rows] = await Promise.all([listRecords(env, { recent: true }), progs.length ? recentRaw(env) : null, progs.length ? openSessionsRaw(env) : []]);
  const others = recs.filter(r => r.customer !== cand.customer && r.status === 'active');
  const weeks = await Promise.all(progs.map(async p => {
    const [pays, open] = await Promise.all([programPayments(env, p, { recent }), openBookingSessions(env, p, rows)]);
    return { program: p, bookings: groupBookings(p, pays), occ: buildOccupancy(p, pays, open, [], others) };
  }));
  return [...nameConflicts(cand, others, weeks), ...weeks.flatMap(w => weekConflicts(w.program, w.occ, cand))];
}
const CONFLICT = conflicts => ({ error: 'This clashes with what is already booked. Check the list, or save it anyway.', code: 'conflict', conflicts });
const fieldsError = (send, errors) => send({ error: 'Please check the highlighted details.', fields: errors }, 422);
/* A record customer read fresh from Stripe (search lags; a write starts from the current metadata). */
async function readRecord(env, customerId) {
  try { return parseRecord(await stripe(env, 'GET', `/customers/${customerId}`)); }
  catch (e) { if (e.status === 404) return null; throw e; }
}
async function findManual(env, ref) {
  const rec = (await listRecords(env, { recent: true })).find(r => r.type === 'booking' && r.ref === ref);
  const fresh = rec ? await readRecord(env, rec.customer) : null;
  return fresh && fresh.type === 'booking' ? fresh : null;
}
/* Fire-and-forget to GHL (never holds up or fails the admin action). */
function notifyGhl(env, context, payload) {
  if (!env.GHL_WEBHOOK_URL) return null;
  const p = fetch(env.GHL_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) })
    .then(r => { if (!r.ok) logError('admin.ghl', { status: r.status, type: 'ghl_error' }); }, () => logError('admin.ghl', { status: 0, type: 'network_error' }));
  if (context && typeof context.waitUntil === 'function') { try { context.waitUntil(p); } catch {} }
  return p;
}
const money = c => ((c || 0) / 100).toFixed(2);

async function blockCreate(env, body, send) {
  const v = blockInput(body);
  if (Object.keys(v.errors).length) return fieldsError(send, v.errors);
  if (body.force !== true) {
    const conflicts = await conflictsFor(env, v.rec);
    if (conflicts.length) return send(CONFLICT(conflicts), 409);
  }
  const c = await stripe(env, 'POST', '/customers', { name: v.name, description: v.description, metadata: v.metadata });
  recordsChanged(c);
  return send({ ok: true, block: blockOut(parseRecord(c)), forced: body.force === true });
}
async function blockDelete(env, body, send) {
  const id = str(body.id, 80);
  let rec = null;
  if (/^cus_[A-Za-z0-9]{6,}$/.test(id)) rec = await readRecord(env, id);
  else if (isBlockId(id)) {
    const found = (await listRecords(env, { recent: true })).find(r => r.type === 'block' && r.id === id);
    rec = found ? await readRecord(env, found.customer) : null;
  }
  if (!rec || rec.type !== 'block') return send({ error: 'Block not found (it may have been removed already).' }, 404);
  await stripe(env, 'DELETE', `/customers/${rec.customer}`);
  recordsChanged({ id: rec.customer }, true);
  return send({ ok: true, id: rec.id, customer: rec.customer });
}
async function manualCreate(env, body, send) {
  const v = manualInput(body);
  if (Object.keys(v.errors).length) return fieldsError(send, v.errors);
  if (body.force !== true) {
    const conflicts = await conflictsFor(env, v.rec);
    if (conflicts.length) return send(CONFLICT(conflicts), 409);
  }
  const c = await stripe(env, 'POST', '/customers', { name: v.name, description: v.description, metadata: v.metadata });
  recordsChanged(c);
  return send({ ok: true, booking: manualBooking(parseRecord(c), []), forced: body.force === true });
}
/* manual_cancel / manual_restore / manual_update (and note, as the comment) / offline_payment on a manual booking */
async function manualAction(context, env, body, ref, send) {
  const rec = await findManual(env, ref);
  if (!rec) return send({ error: 'Manual booking not found (a new one can take a minute to appear).' }, 404);
  if (body.action === 'offline_payment') return offlinePayment(context, env, body, { manual: rec }, send);
  let fields;
  if (body.action === 'manual_cancel') {
    if (rec.status === 'cancelled') return send({ ok: true, ref, status: 'cancelled', booking: manualBooking(rec, await listOffline(env, { ref, recent: true })) });
    fields = { aob_status: 'cancelled', aob_status_at: String(nowSec()) };
  } else if (body.action === 'manual_restore') {
    if (rec.status === 'active') return send({ ok: true, ref, status: 'active', booking: manualBooking(rec, await listOffline(env, { ref, recent: true })) });
    if (body.force !== true) {
      const conflicts = await conflictsFor(env, { ...rec, status: 'active' });
      if (conflicts.length) return send({ ...CONFLICT(conflicts), error: `Restoring ${ref} clashes with what has been booked since. Check the list, or restore it anyway.` }, 409);
    }
    fields = { aob_status: 'active', aob_status_at: '' };
  } else if (body.action === 'manual_update' || body.action === 'note') {
    const v = manualUpdateInput(body.action === 'note' ? { comment: body.note } : body);
    if (Object.keys(v.errors).length) return fieldsError(send, v.errors);
    fields = v.fields;
  } else return send({ error: 'This is a manual booking: it can be cancelled, restored, edited (comment, price) or paid offline.' }, 400);
  const [c, offline] = await Promise.all([stripe(env, 'POST', `/customers/${rec.customer}`, { metadata: fields }), listOffline(env, { ref, recent: true })]);
  recordsChanged(c);
  const booking = manualBooking(parseRecord(c), offline);
  return send({ ok: true, ref, status: booking.status, booking });
}

/* A payment received outside Stripe Checkout (bank transfer, cash, other), recorded as an invoice paid
   out of band (see createOfflinePayment). target: { program, booking } (online) | { manual: record }. */
async function offlinePayment(context, env, body, target, send) {
  const v = offlineInput(body);
  if (Object.keys(v.errors).length) return fieldsError(send, v.errors);
  const pay = v.payment;
  let ref, programId, label, customer, lead, total, paid, refunded, guard, currency = 'eur';
  if (target.manual) {
    const rec = target.manual, b = manualBooking(rec, await listOffline(env, { ref: rec.ref, recent: true })), home = homeProgram(rec);
    ref = rec.ref; programId = b.program; label = home ? home.edition || home.title : 'Stay'; customer = rec.customer; lead = b.lead;
    total = b.total_cents; paid = b.paid_cents; refunded = 0; guard = total > 0; // no agreed price yet: nothing to overpay
    if (home) currency = home.currency.toLowerCase();
  } else {
    const { program, booking } = target;
    ref = booking.ref; programId = program.id; label = program.edition || program.title; lead = booking.lead; currency = program.currency.toLowerCase();
    customer = booking.customer || ((booking.payments || []).find(x => x.kind === 'offline' && x.customer) || {}).customer || null;
    total = booking.total_cents; paid = booking.paid_cents; refunded = booking.refunded_cents || 0; guard = true;
  }
  const balance = Math.max(0, total - paid - refunded);
  if (guard && pay.amount_cents > balance && body.force !== true) {
    return send({ error: `${eur(pay.amount_cents)} is more than the ${eur(balance)} still to pay on ${ref}. Record it anyway?`, code: 'overpay', balance_cents: balance, amount_cents: pay.amount_cents }, 409);
  }
  const inv = await createOfflinePayment(env, { customer, name: lead.name, ref, program: programId, label, currency, payment: pay });
  rememberWrite(inv);
  forgetBooking(ref);
  const paidNow = paid + pay.amount_cents, balanceNow = Math.max(0, total - paidNow - refunded);
  // a balance link already sent asks for the old amount: close it (a new one asks for what is left)
  let closed = 0;
  if (!target.manual) {
    try { const links = await openBalanceSessions(env, ref); closed = (await Promise.all(links.map(s => expireSession(env, s.id)))).filter(Boolean).length; }
    catch (e) { logError('admin.offline_links', e, { ref }); }
  }
  const [first, ...rest] = String(lead.name || '').split(' ');
  notifyGhl(env, context, {
    event: 'offline_payment_recorded', ref, program: programId, program_title: label, source: target.manual ? 'manual' : 'online',
    first_name: first || '', last_name: rest.join(' '), email: lead.email || '', phone: lead.whatsapp || '',
    amount: money(pay.amount_cents), amount_cents: pay.amount_cents, currency: currency.toUpperCase(), method: pay.method, method_label: OFFLINE_METHODS[pay.method],
    received: pay.received, comment: pay.comment, invoice_id: inv.id, paid_total: money(paidNow), balance: money(balanceNow), tag: `${programId}-offline-paid`,
  });
  return send({ ok: true, ref, payment: { invoice_id: inv.id, amount_cents: pay.amount_cents, method: pay.method, received: pay.received, comment: pay.comment },
    booking: { total_cents: total, paid_cents: paidNow, balance_cents: balanceNow }, balance_links_closed: closed, forced: body.force === true && pay.amount_cents > balance });
}
async function offlineVoid(env, body, send) {
  const id = str(body.invoice_id, 80);
  if (!/^in_[A-Za-z0-9]{6,}$/.test(id)) return send({ error: 'Invalid invoice.' }, 400);
  const reason = cleanNote(body.reason, 200);
  if (!reason) return fieldsError(send, { reason: 'Add a short reason.' });
  let inv;
  try { inv = await stripe(env, 'GET', `/invoices/${id}`); }
  catch (e) { if (e.status === 404) return send({ error: 'Payment not found.' }, 404); throw e; }
  const md = inv.metadata || {};
  if (md.aob_kind === 'offline_void') return send({ ok: true, invoice_id: id, ref: md.aob_ref || null, already: true });
  if (md.aob_kind !== 'offline') return send({ error: 'That invoice is not an offline payment recorded here.' }, 409);
  const u = await stripe(env, 'POST', `/invoices/${id}`, { metadata: { aob_kind: 'offline_void', aob_void_reason: reason, aob_void_at: new Date().toISOString() } });
  rememberWrite(u);
  if (md.aob_ref) forgetBooking(md.aob_ref);
  return send({ ok: true, invoice_id: id, ref: md.aob_ref || null, amount_cents: inv.amount_paid || inv.total || 0,
    message: 'Undone: it no longer counts as paid. If your books must show the reversal, add a credit note to this invoice in Stripe.' });
}

/* -------------------------------------------------------------- team notes */
/* The team's keys live on the booking's own PaymentIntent (or the plan's subscription; once a plan has
   ended, on its first invoice's PaymentIntent). They are read from Stripe directly before a change
   (search can lag a minute behind an update, and two quick edits must not undo each other), then
   written back. '' removes a key. */
const currentMeta = currentBookingMeta;
const saveOnBooking = saveAdminMeta;

/* Warnings for the rooms this booking's guests are in, after its new assignment (records: the team's
   blocks and manual bookings, which count too). */
function assignWarnings(program, bookings, booking, records = []) {
  const { rooming } = roomingMap(program, bookings, records);
  const mine = new Set(Object.values(booking.assign || {}));
  const out = [];
  for (const name of mine) {
    const slot = rooming[name];
    if (!slot) continue;
    if (slot.conflict === 'blocked') out.push(`${name} is blocked ${rangeLabel(slot.blocked.from, slot.blocked.to)} (${slot.blocked.reason}).`);
    else if (slot.conflict === 'mixed') out.push(`${name}: women and men are in the same room.`);
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

  const [payments, open, records] = await Promise.all([programPayments(env, program), openBookingSessions(env, program), listRecords(env, { recent: true })]);
  // an earlier link for the same guest is replaced (one hold per person): left out of the check,
  // given up only once the new link exists (and only if it can be: see below)
  const lead = q.guests[0].email;
  const mineS = open.filter(s => s.metadata.aob_source === 'admin' && s.metadata.aob_lead_email === lead);
  const mine = mineS.map(s => s.id), mineRefs = new Set(mineS.map(s => s.metadata.aob_ref).filter(Boolean));
  const avail = availability(program, buildOccupancy(program, payments, open, mine, records));
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
    const clash = checkAvailability(program, q, availability(program, buildOccupancy(program, pays, earlier, [], records)));
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

export async function onRequestPost(context) {
  const { request, env } = context;
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
    if (body.action === 'seed_demo' || body.action === 'clear_demo' || body.action === 'place_demo') {
      // test mode only: fill a week with demo bookings (about `percent` % of its places), or remove them
      if (liveMode(env)) return send({ error: 'Demo bookings are only available in Stripe test mode.' }, 403);
      const program = getProgram(body.program);
      if (!program) return send({ error: 'Unknown week.' }, 404);
      const r = body.action === 'seed_demo' ? await seedDemo(env, program, { percent: Math.round(Number(body.percent) || 40) })
        : body.action === 'place_demo' ? await placeDemo(env, program)
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
    // the team's records: room blocks and manual bookings; offline payments
    if (body.action === 'block_create') return await blockCreate(env, body, send);
    if (body.action === 'block_delete') return await blockDelete(env, body, send);
    if (body.action === 'manual_create') return await manualCreate(env, body, send);
    if (body.action === 'offline_void') return await offlineVoid(env, body, send);

    const ref = String(body.ref || '').trim().toUpperCase();
    if (!validRef(ref)) return send({ error: 'Invalid reference.' }, 400);
    if (isManualRef(ref)) return await manualAction(context, env, body, ref, send);
    if (/^manual_/.test(String(body.action || ''))) return send({ error: 'That is not a manual booking.' }, 400);
    const found = await findBooking(env, ref);
    if (!found) return send({ error: 'Booking not found (new bookings can take a minute to appear).' }, 404);
    const { program, booking } = found;
    if (body.action === 'offline_payment') return await offlinePayment(context, env, body, found, send);

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
        const [pays, recs] = await Promise.all([programPayments(env, program), listRecords(env, { recent: true })]);
        const others = groupBookings(program, pays).filter(b => b.ref !== ref);
        warnings = assignWarnings(program, [...others, { ...booking, assign }], { assign }, recs);
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
