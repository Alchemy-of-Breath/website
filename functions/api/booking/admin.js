// /api/booking/admin — bookings dashboard data and actions.
// Who: Authorization: Bearer <ADMIN_TOKEN> (the main admin, role 'owner'), or Bearer <session token> from
// POST /api/booking/login (a team member, role 'team' or 'viewer'; see booking-lib/team.js). 401
// { error: 'Not authorised.' }; a session that expired or was ended (user disabled, role / status / password
// changed) → 401 { error, code: 'session_ended' }. Stripe unreachable while checking a session → 503 busy.
// Every GET answer carries me: { id, name, role: 'owner'|'team'|'viewer', username (team members) }.
// GET ?program=ID   one week: bookings (online ones with sessions, note, room assignment, source, discount and
//                   payments incl. offline ones; manual bookings overlapping the week with source 'manual'), the
//                   week's rooms and sessions (program_detail), the rooming map (blocked rooms, manual guests),
//                   availability (after the team's records), the blocks overlapping the week, the setup panel.
//                   Programs whose nights overlap share the rooms: overlaps [{ id, title, edition, dates }] lists them;
//                   availability counts their paid guests and open checkouts in the rooms (rooms[id].taken includes
//                   them, rooms[id].taken_other is their part, held includes their holds; program_left stays this
//                   week's own), holds_other is their open checkouts per room, and their guests placed in this
//                   week's rooms are in rooming[name].guests as read-only occupants { ref, index, name, gender,
//                   program, edition, from, to (their nights within this week), other: true }.
// GET ?overview=1   every week at a glance: totals (manual bookings and offline payments included), places, alerts,
//                   the 15 newest bookings; manual stays outside every week under `stay`.
// GET ?stays=1      the manual bookings outside every week (program 'stay'), with their offline payments.
// GET ?calendar=1&from=YYYY-MM-DD&to=YYYY-MM-DD   the rooming calendar (up to 120 nights): every physical room by
//                   area, every guest's stay (online and manual), the blocks, guests not placed in a room yet.
// GET ?users=1      (owner) { users: [{ id, username, name, role, status, test, created_at, last_login_at }] oldest
//                   first, live (Stripe live keys), password_min (5 with test keys, 10 with live keys) }.
// GET ?activity=1[&limit=200][&user=<actor id>][&before=<unix ms>]   (owner) the activity log, newest first:
//                   { entries: [{ id, t (unix ms), at (ISO), actor: { id: 'owner'|customer id|'-', name, role },
//                   action, ref, program, summary }], has_more } (limit 1 to 1000, default 200; before = the
//                   oldest t shown, for "Load older").
// GET ?uplisting=1[&refresh=1]   (every role; refresh: Uplisting's listings, account and webhooks read again
//                   instead of this isolate's 5-minute copy) the Setup → Uplisting panel: { uplisting: true, status:
//                   'off'|'on'|'no_webhook_secret', configured: { api_key, webhook_secret }, account: { name } | null,
//                   properties: [{ id, name, nickname, units: [{ id, name }] }] (by id), mapping: { '<pid>': [room names],
//                   '<pid>_<unit id>': [...] }, rooms: [calendar room names], room_groups: [{ area, rooms }], hooks:
//                   { booking_created, booking_updated, booking_removed } (true: registered for this host with the
//                   current secret) | null, hooks_other_hosts: [hosts], webhook_url_hint (no key), last_sync: { at,
//                   result: { created, updated, cancelled, unchanged, unmapped, clashes, errors } } | null, imported:
//                   { active, upcoming, closed, closed_upcoming, closed_nights } (bookings; ranges and nights closed in
//                   Uplisting), max_keys (47 minus the settings flags set), push: 'on'|'off', autoplace: 'on'|'off',
//                   last_sync.by: 'scheduled' | { id, name } | null, last_scheduled_sync: { at, result } | null, last_push:
//                   { at, result: { closed, reopened, skipped_closed, refused, listings, errors }, by } | null, push_warnings:
//                   [text] (the last push run's), pushed: { listings, nights } (what we hold closed in Uplisting now),
//                   sync_url_hint (no key), error? (Uplisting unreachable / refused: still 200) }. No API key: no Uplisting
//                   call (account null, properties [], hooks null). Stripe unreadable → 502.
// Others than the owner: GET ?users / ?activity and the owner-only actions → 403 { error: 'Only the main admin
// can do this.', code: 'owner_only' }; any POST by a viewer → 403 { error: 'View-only access: you can look but
// not change anything.', code: 'read_only' }.
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
// Owner only: seed_demo / place_demo / clear_demo, register_domains, repair_plans and the team's users:
//   user_create { username, name, role: 'team'|'viewer', password? } → { ok, user, password } (password: the
//     one given, else a generated one like 'lotus-amber-river-42'; shown only in this answer). 422 { error,
//     fields } for a bad username / name / role / password; 409 { error, fields: { username: 'Already taken.' } }.
//   user_update { id, name?, role?, status?: 'active'|'disabled', reset_password?: true, password? } → { ok, user,
//     password? } (nothing different: { ok, user, unchanged: true }); a new role, status or password signs the
//     user out. 404 unknown id. There is no delete: disable instead.
//   test_users_create {} (Stripe test keys only, else 403) → { ok, users: [{ user, password }] }: test1, test2
//     (team) and test3 (view only) with fresh passwords; existing ones are reactivated, their passwords reset.
// Uplisting (see booking-lib/uplisting.js; 503 { code: 'uplisting_off' } without UPLISTING_API_KEY):
//   uplisting_map { mapping } (owner) → { ok, mapping }; 422 { error, fields: { 'mapping.<key>' | mapping: text } }.
//   uplisting_hooks {} (owner) → { ok, hooks, created, removed }; 409 code no_webhook_secret | bad_host.
//   uplisting_sync { cursor? } (owner, team) → { ok, done, cursor | null, progress: { listings_done, listings_total, phase:
//     'bookings'|'closures'|'push'|'done', closures_done, closures_total, push_done?, push_total? }, stats: { created, updated,
//     cancelled, unchanged, unmapped, clashes, errors } (bookings), closures: { created, updated, cancelled, unchanged, listings,
//     errors } (closed nights), push?: { closed, reopened, skipped_closed, refused, listings, errors } (nights; with the push on),
//     warnings?, paused?: 'rate_limited' | 'busy', retry_after? (seconds to wait before calling again) }; 409 no_mapping,
//     400 bad_cursor, 503 too_big.
//   uplisting_push { mode: 'on'|'off' } (owner) → { ok, push } (unchanged: true when it already was); 409 settings_full.
//   uplisting_push_run { cursor? } (owner, team) → { ok, done, cursor | null, progress: { listings_done, listings_total, phase },
//     stats: { closed, reopened, skipped_closed, refused, listings, errors } (nights; refused: listings whose ledger is full),
//     warnings?, paused?: 'rate_limited' | 'busy', retry_after? }; 409 push_off, 400 bad_cursor.
//   uplisting_autoplace { mode: 'on'|'off' } (owner; works without UPLISTING_API_KEY, but auto-place only runs with it)
//     → { ok, autoplace }.
//   Uplisting refusing or unreachable → 502 / 503 { error, code: 'uplisting_auth' | 'uplisting' | 'uplisting_busy', retry_after? }.
//   block_delete of an Uplisting booking or of nights closed there → 409 { error, code: 'external' }.
// GET ?uplisting_push_preview=1 (owner, team) → { push: 'on'|'off', close: [{ listing_id, nickname, from, to, nights, because:
//   [refs], unchecked? }], reopen: [{ listing_id, nickname, from, to, nights }], skipped_closed: [{ listing_id, nickname, from, to,
//   nights, because }], warnings: [text], listings, checked } — nothing written. 503 uplisting_off without the API key.
// With the push on, assign, cancel, restore, manual_create / manual_update / manual_cancel / manual_restore and block_create /
// block_delete reconcile the listings of the rooms they touch after answering (waitUntil; never failing the action).
// Every action that answers 2xx is written to the activity log with who did it (never failing the action); an
// unfinished sync slice is not (one uplisting_sync entry when it is done).
import {
  json, preflight, guardPost, readBody, getProgram, listPrograms, programSummary, programDetail, programPayments, groupBookings,
  openBookingSessions, openSessionsRaw, recentRaw, recentProgramPayments, mergePayments, buildOccupancy, occupancy, availability, checkAvailability, validRef, findBooking, forgetBooking, stripe,
  balanceSession, openBalanceSessions, openAddonSessions, expireSession, expireOrCheck, sessionState, balancePageUrl, bookingPageUrl, roomCapacity, roomingMap, ensurePlanEnds, planEndAt,
  planEndCheck, planEndCheckRecord, keyMode, publishableStatus, turnstileSiteKey, turnstileStatus, remindEnabled, listDomains, ensurePaymentMethodDomain,
  clearAvailabilityMemo, quote, publicQuote, bookingMetadata, bookingCheckoutParams, safeCreateSession, newRef, cleanNote, str, parseAssign,
  assignToString, parseSvc, svcToString, SVC_STATUS, saveAdminMeta, currentBookingMeta, logError, eur, nowSec, PROD_HOSTS,
  liveMode, isBusy, listRecords, listOffline, calendarRooms, weekConflicts, nameConflicts, manualBooking, blockOut, blockInput, manualInput,
  manualUpdateInput, offlineInput, createOfflinePayment, recordsChanged, rememberWrite, parseRecord, isManualRef, isBlockId, homeProgram,
  overlaps, weekRange, validDay, addDays, nightsBetween, todayIso, rangeLabel, OFFLINE_METHODS, REC_MAX_NIGHTS, BUSY, cut,
  isExternal, externalText, isClosure, groupPayments, groupSessions, programsPayments, paysOf, overlappingPrograms, occupancyGroup, overlapOut,
} from '../../../booking-lib/core.js';
import { uplistingPanel, saveMapping, connectHooks, syncSlice, pushPreview, saveFlag, pushAfter, syncSummary, pushRunSummary } from '../../../booking-lib/uplisting.js';
import { seedDemo, clearDemo, placeDemo } from '../../../booking-lib/demo.js';
import {
  resolveAdmin, meOut, listUsers, readUser, userInput, userOut, createUser, updateUser, generatePassword, passwordMin,
  listActivity, recordActivity, scrubText,
} from '../../../booking-lib/team.js';

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

/* ------------------------------------------------------------------ who */
const READ_ONLY = { error: 'View-only access: you can look but not change anything.', code: 'read_only' };
/* Actions after which the push to Uplisting (when on) reconciles the rooms they touched */
const PUSH_ACTIONS = new Set(['assign', 'cancel', 'restore', 'manual_create', 'manual_update', 'manual_cancel', 'manual_restore', 'block_create', 'block_delete']);
const hostOf = request => { try { return new URL(request.url).host; } catch { return ''; } };
const OWNER_ONLY = { error: 'Only the main admin can do this.', code: 'owner_only' };
const OWNER_ACTIONS = new Set(['user_create', 'user_update', 'test_users_create', 'seed_demo', 'place_demo', 'clear_demo', 'register_domains', 'repair_plans',
  'uplisting_map', 'uplisting_hooks', 'uplisting_push', 'uplisting_autoplace']);
/* → { me } or { res: the 401 / 503 answer } */
async function whoIs(request, env) {
  let who;
  try { who = await resolveAdmin(request, env); }
  catch (e) { logError('admin.auth', e); return { res: json(request, BUSY, 503, env) }; }
  if (!who.me) return { res: json(request, { error: 'Not authorised.', ...(who.code ? { code: who.code } : {}) }, 401, env) };
  return { me: who.me };
}

export async function onRequestGet({ request, env }) {
  const who = await whoIs(request, env);
  if (who.res) return who.res;
  const me = meOut(who.me);
  const send = (d, s = 200) => json(request, { ...d, me }, s, env);
  const params = new URL(request.url).searchParams;
  const programs = listPrograms().map(programSummary);
  if (params.get('users') || params.get('activity')) {
    if (me.role !== 'owner') return send(OWNER_ONLY, 403);
    return params.get('users') ? usersGet(env, send) : activityGet(env, params, send);
  }
  if (params.get('uplisting_push_preview')) {
    if (me.role === 'viewer') return send(READ_ONLY, 403);
    try { const r = await pushPreview(env); return send(r.data, r.status); }
    catch (e) {
      logError('admin.push_preview', e);
      return e.type === 'uplisting_error' ? send({ error: e.message, code: 'uplisting' }, 502) : send({ error: 'Could not work out the preview: ' + e.message }, 502);
    }
  }
  if (params.get('uplisting')) {
    try { return send(await uplistingPanel(env, request, { refresh: params.get('refresh') === '1' && me.role !== 'viewer' })); }
    catch (e) { logError('admin.uplisting', e); return send({ error: 'Could not load the Uplisting settings from Stripe: ' + e.message }, 502); }
  }
  if (params.get('calendar')) {
    try { return await calendar(env, params, send); }
    catch (e) { logError('admin.calendar', e); return send({ error: 'Could not load the calendar from Stripe: ' + e.message }, 502); }
  }

  // the manual bookings outside every week (a one-night stay, a stay between the weeks): the weeks' data leaves them out
  if (params.get('stays')) {
    const program = { id: 'stay', edition: 'Outside the programmes', title: 'Stay', dates: {} };
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
      // every week's payments in one search (10 weeks per search); a week's availability counts the weeks overlapping it
      const every = await programsPayments(env, progs, { amounts: true, recent, offline });
      const all = progs.map(p => {
        const pays = paysOf(every, p.id);
        return { p, bookings: [...groupBookings(p, pays), ...manual.filter(b => b.program === p.id)], avail: availability(p, buildOccupancy(p, every, rows, [], recs)) };
      });
      const weeks = all.map(x => weekSummary(x.p, x.bookings, x.avail));
      const stayB = manual.filter(b => b.program === 'stay');
      return send({ ...overviewOf(weeks, [...all.flatMap(x => x.bookings.map(b => ({ p: x.p, b }))), ...stayB.map(b => ({ p: null, b }))], { totals: totalsOf(stayB) }), live: true, programs });
    } catch (e) { logError('admin.overview', e); return send({ error: 'Could not load bookings from Stripe: ' + e.message }, 502); }
  }

  const program = getProgram(params.get('program')) || listPrograms()[0];
  const detail = programDetail(program);
  if (!env.STRIPE_SECRET_KEY) {
    return send({ demo: true, programs, program: programSummary(program), program_detail: detail, bookings: [], rooms: roomsOf(program),
      overlaps: overlappingPrograms(program).map(overlapOut),
      availability: availability(program), ...roomingMap(program, []), blocks: [], setup: { ...setupBase(env), domains: [] } });
  }
  try {
    // the programs overlapping this week share its rooms: their payments come with the same searches (only this
    // week's plans are totalled), their open checkouts from the same list
    const [all, rows, domains, recs, offline] = await Promise.all([
      groupPayments(env, program, { amounts: true }),
      openSessionsRaw(env),
      listDomains(env).catch(e => { logError('admin.domains', e); return null; }),
      listRecords(env, { recent: true }),
      listOffline(env, { recent: true }), // every offline payment (a few): the week's bookings', and the manual bookings'
    ]);
    const pays = paysOf(all, program.id), near = overlappingPrograms(program);
    const online = groupBookings(program, [...pays, ...offline.filter(o => o.md.aob_program === program.id)]);
    const manual = recs.filter(r => r.type === 'booking' && overlaps(r, weekRange(program))).map(r => manualBooking(r, offline));
    const bookings = [...online, ...manual].sort((a, b) => b.created - a.created);
    const occ = buildOccupancy(program, all, await groupSessions(env, program, rows), [], recs);
    const others = near.map(q => ({ program: q, bookings: groupBookings(q, paysOf(all, q.id)) }));
    const checks = planRecords(pays).map(p => ({ p, state: planEndCheckRecord(p).state }));
    return send({
      live: true, programs, program: programSummary(program), program_detail: detail, bookings,
      rooms: roomsOf(program),
      // overlaps: the programs sharing some of these nights; their guests and holds take rooms here (availability
      // counts them, never against this week's programme places), and the ones placed in a room are in the rooming
      // map as read-only occupants (other: true)
      overlaps: near.map(overlapOut),
      availability: availability(program, occ), holds: occ.holds, holds_other: occ.other.holds,
      ...roomingMap(program, online, recs, others),
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
  const every = weeksIn.length ? await programsPayments(env, weeksIn, { recent, offline }) : [];
  const weeks = weeksIn.map(p => ({ p, bookings: groupBookings(p, paysOf(every, p.id)) }));
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
  // every week the candidate overlaps, in one search; a week's occupancy counts the other weeks of that set that
  // overlap it (they share its rooms on the candidate's nights; a week the candidate doesn't touch can't clash)
  const ids = new Set(progs.map(p => p.id)), holds = rows.filter(s => ids.has((s.metadata || {}).aob_program));
  const every = progs.length ? await programsPayments(env, progs, { recent }) : [];
  const weeks = progs.map(p => ({ program: p, bookings: groupBookings(p, paysOf(every, p.id)), occ: buildOccupancy(p, every, holds, [], others) }));
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

async function blockCreate(env, body, send, hint = null) {
  const v = blockInput(body);
  if (Object.keys(v.errors).length) return fieldsError(send, v.errors);
  if (body.force !== true) {
    const conflicts = await conflictsFor(env, v.rec);
    if (conflicts.length) return send(CONFLICT(conflicts), 409);
  }
  const c = await stripe(env, 'POST', '/customers', { name: v.name, description: v.description, metadata: v.metadata });
  recordsChanged(c);
  const block = blockOut(parseRecord(c));
  if (hint) hint.push = { rooms: block.rooms.slice(), from: block.from, to: block.to, ref: block.id };
  return send({ ok: true, block, forced: body.force === true });
}
async function blockDelete(env, body, send, hint = null) {
  const id = str(body.id, 80);
  let rec = null;
  if (/^cus_[A-Za-z0-9]{6,}$/.test(id)) rec = await readRecord(env, id);
  else if (isBlockId(id)) {
    const found = (await listRecords(env, { recent: true })).find(r => r.type === 'block' && r.id === id);
    rec = found ? await readRecord(env, found.customer) : null;
  }
  else if (/^U[PC]-[A-Za-z0-9-]{1,40}$/.test(id)) rec = (await listRecords(env, { recent: true })).find(r => r.type === 'block' && r.id === id) || null;
  if (!rec || rec.type !== 'block') return send({ error: 'Block not found (it may have been removed already).' }, 404);
  // a booking imported from Uplisting (or nights closed there) only changes there (the sync would bring it back anyway)
  if (isClosure(rec)) return send({ error: 'These nights are closed in Uplisting: open them there and they will update here.', code: 'external' }, 409);
  if (isExternal(rec)) return send({ error: 'This booking comes from Uplisting: change or cancel it there and it will update here.', code: 'external' }, 409);
  await stripe(env, 'DELETE', `/customers/${rec.customer}`);
  recordsChanged({ id: rec.customer }, true);
  if (hint) hint.push = { rooms: rec.rooms.slice(), from: rec.from, to: rec.to, ref: rec.id };
  return send({ ok: true, id: rec.id, customer: rec.customer });
}
async function manualCreate(env, body, send, hint = null) {
  const v = manualInput(body);
  if (Object.keys(v.errors).length) return fieldsError(send, v.errors);
  if (body.force !== true) {
    const conflicts = await conflictsFor(env, v.rec);
    if (conflicts.length) return send(CONFLICT(conflicts), 409);
  }
  const c = await stripe(env, 'POST', '/customers', { name: v.name, description: v.description, metadata: v.metadata });
  recordsChanged(c);
  const rec = parseRecord(c);
  if (hint) hint.push = { rooms: [...new Set(rec.guests.map(g => g.room_name))], from: rec.from, to: rec.to, ref: rec.ref };
  return send({ ok: true, booking: manualBooking(rec, []), forced: body.force === true });
}
/* manual_cancel / manual_restore / manual_update (and note, as the comment) / offline_payment on a manual booking */
async function manualAction(context, env, body, ref, send, hint = {}) {
  const rec = await findManual(env, ref);
  if (!rec) return send({ error: 'Manual booking not found (a new one can take a minute to appear).' }, 404);
  hint.program = (homeProgram(rec) || { id: 'stay' }).id;
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
  if (body.action !== 'note') hint.push = { rooms: [...new Set(rec.guests.map(g => g.room_name))], from: rec.from, to: rec.to, ref };
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
function assignWarnings(program, bookings, booking, records = [], others = []) {
  const { rooming } = roomingMap(program, bookings, records, others);
  const mine = new Set(Object.values(booking.assign || {}));
  const out = [];
  for (const name of mine) {
    const slot = rooming[name];
    if (!slot) continue;
    // guests of an overlapping program in the room: say who (" (with Live Residential: Ana K., 20–26 Jun 2027)")
    const theirs = slot.guests.filter(g => g.other);
    const withOthers = theirs.length ? ` (with ${[...new Set(theirs.map(g => `${g.edition}: ${g.name}, ${rangeLabel(g.from, g.to)}`))].join('; ')})` : '';
    if (slot.conflict === 'blocked') out.push(slot.blocked.ext ? externalText(name, slot.blocked)
      : `${name} is blocked ${rangeLabel(slot.blocked.from, slot.blocked.to)} (${slot.blocked.reason}).`);
    else if (slot.conflict === 'mixed') out.push(`${name}: women and men are in the same room${withOthers}.`);
    else if (slot.conflict === 'over') out.push(`${name}: ${slot.guests.length} guests for ${slot.capacity} ${slot.capacity === 1 ? 'place' : 'beds'}${withOthers}.`);
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

  // the overlapping programs' bookings and holds take rooms too (same searches, same list)
  const [payments, open, records] = await Promise.all([groupPayments(env, program), groupSessions(env, program), listRecords(env, { recent: true })]);
  // an earlier link for the same guest is replaced (one hold per person): left out of the check,
  // given up only once the new link exists (and only if it can be: see below)
  const lead = q.guests[0].email;
  const mineS = open.filter(s => s.metadata.aob_program === program.id && s.metadata.aob_source === 'admin' && s.metadata.aob_lead_email === lead);
  const mine = mineS.map(s => s.id), mineRefs = new Set(mineS.map(s => s.metadata.aob_ref).filter(Boolean));
  const avail = availability(program, buildOccupancy(program, payments, open, mine, records));
  const full = checkAvailability(program, q, avail);
  if (full) return send({ error: full, code: 'unavailable', availability: avail }, 409);
  const { session, dropped } = await safeCreateSession(env, params);
  const drop = async (status, data) => { await expireSession(env, session.id); clearAvailabilityMemo(program.id); return send(data, status); };
  // the same race check as a guest's checkout: an earlier hold for the last places wins, and a hold
  // paid meanwhile counts as booked (except the link being replaced: a payment of it is answered below)
  try {
    const [fresh, recent] = await Promise.all([groupSessions(env, program), recentProgramPayments(env, program, occupancyGroup(program))]);
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

/* ------------------------------------------------------------ team users */
async function usersGet(env, send) {
  if (!env.STRIPE_SECRET_KEY) return send({ users: [], live: false, password_min: passwordMin(env), demo: true });
  try {
    const users = await listUsers(env);
    return send({ users: users.map(userOut), live: liveMode(env), password_min: passwordMin(env) });
  } catch (e) { logError('admin.users', e); return send({ error: 'Could not load the users from Stripe: ' + e.message }, 502); }
}
async function activityGet(env, params, send) {
  const n = parseInt(params.get('limit') || '', 10);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 200;
  const user = params.get('user') ? str(params.get('user'), 80) : null;
  const b = params.get('before') || '';
  const before = /^\d{1,16}$/.test(b) ? parseInt(b, 10) : null;
  if (!env.STRIPE_SECRET_KEY) return send({ entries: [], has_more: false, demo: true });
  try { return send(await listActivity(env, { limit, user, before })); }
  catch (e) { logError('admin.activity', e); return send({ error: 'Could not load the activity log from Stripe: ' + e.message }, 502); }
}
async function userCreate(env, body, send, hint) {
  const v = userInput(body, env, { create: true });
  if (Object.keys(v.errors).length) return fieldsError(send, v.errors);
  // read fresh (not the 30 s memo): two people must never get the same username
  if ((await listUsers(env, { fresh: true })).some(u => u.username === v.values.username)) {
    return send({ error: 'That username is already taken. Choose another.', fields: { username: 'Already taken.' } }, 409);
  }
  const password = v.values.password || generatePassword();
  const user = await createUser(env, { ...v.values, password });
  hint.user = user;
  return send({ ok: true, user: userOut(user), password });
}
async function userUpdate(env, body, send, hint) {
  const id = str(body.id, 80);
  const cur = /^cus_[A-Za-z0-9]{1,250}$/.test(id) ? await readUser(env, id) : null;
  if (!cur) return send({ error: 'User not found.' }, 404);
  const v = userInput(body, env);
  if (Object.keys(v.errors).length) return fieldsError(send, v.errors);
  const { name, role, status } = v.values;
  const password = v.values.password || (body.reset_password === true ? generatePassword() : null);
  const changes = [];
  if (name !== undefined && name !== cur.name) changes.push('name');
  if (role !== undefined && role !== cur.role) changes.push('role');
  if (status !== undefined && status !== cur.status) changes.push('status');
  if (password) changes.push('password');
  if (!changes.length) return send({ ok: true, user: userOut(cur), unchanged: true });
  const user = await updateUser(env, cur, { name, role, status, password });
  Object.assign(hint, { user, before: cur, changes, typed: !!v.values.password });
  return send({ ok: true, user: userOut(user), ...(password ? { password } : {}) });
}
const TEST_USERS = [['test1', 'Test User 1', 'team'], ['test2', 'Test User 2', 'team'], ['test3', 'Test User 3', 'viewer']];
async function testUsersCreate(env, send, hint) {
  if (liveMode(env)) return send({ error: 'Test users can only be made while Stripe uses test keys.', code: 'live_mode' }, 403);
  const have = await listUsers(env, { fresh: true });
  const users = [];
  let created = 0;
  for (const [username, name, role] of TEST_USERS) {
    const password = generatePassword(), old = have.find(u => u.username === username);
    const cur = old ? await readUser(env, old.id) : null;
    const user = cur ? await updateUser(env, cur, { name, role, status: 'active', password, test: true })
      : await createUser(env, { username, name, role, password, test: true });
    if (!cur) created++;
    users.push({ user: userOut(user), password });
  }
  Object.assign(hint, { created, reset: users.length - created });
  return send({ ok: true, users });
}

/* ------------------------------------------------------------ activity log */
/* The log entry of an action that answered 2xx: { action, ref, program, summary }. d: the answer;
   hint: what the action noted on the way (program, session title, user changes). No emails or phone
   numbers: free text (comments, reasons) goes through scrubText. */
const eur2 = c => '€' + ((c || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const ROLE_TEXT = { team: 'team', viewer: 'view only' };
const quoted = (s, max = 80) => { const t = scrubText(s); return t ? ` · "${t.length > max ? cut(t, max - 1) + '…' : t}"` : ''; };
const roomsText = names => names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} + ${names.length - 2} more`;
const editionOf = id => { const p = getProgram(id); return p ? p.edition || p.title : String(id || ''); };
function userChangeText(h) {
  const u = h.before.username, one = h.changes.length === 1;
  const part = {
    name: one ? `Renamed ${u} to "${h.user.name}"` : `renamed to "${h.user.name}"`,
    role: one ? `Changed role of ${u} to ${ROLE_TEXT[h.user.role]}` : `role ${ROLE_TEXT[h.user.role]}`,
    status: one ? `${h.user.status === 'disabled' ? 'Disabled' : 'Enabled'} ${u}` : h.user.status,
    password: one ? (h.typed ? `Set a new password for ${u}` : `Reset password of ${u}`) : (h.typed ? 'new password' : 'password reset'),
  };
  return one ? part[h.changes[0]] : `Updated ${u}: ${h.changes.map(c => part[c]).join(', ')}`;
}
function activityOf(body, d, hint) {
  const action = String(body.action || '');
  const ref = hint.ref || (typeof d.ref === 'string' ? d.ref : null);
  const entry = (summary, extra = {}) => ({ action, ref, program: hint.program || null, summary, ...extra });
  const manual = d.booking && d.booking.source === 'manual' ? d.booking : null;
  switch (action) {
    case 'create_link': {
      const q = d.quote || {};
      return entry(`Booking link · ${editionOf(body.program)} · ${count(q.guests || 0, 'guest')} · ${eur2(q.total_cents)}${q.discount ? ` · discount ${eur(q.discount.cents)}` : ''}`,
        { ref: d.ref || null, program: getProgram(body.program) ? body.program : null });
    }
    case 'note': return entry(`Note on ${ref}`);
    case 'assign': {
      const names = Object.keys(d.assign || {}).sort((a, b) => a - b).map(k => String(d.assign[k]).split(' · ')[0]).filter((n, i, a) => a.indexOf(n) === i);
      return entry(`Rooms on ${ref}: ${names.length ? names.join(', ') : 'none'}`);
    }
    case 'svc_status': return entry(`Session "${hint.session || d.key}" on ${ref} → ${d.status}`);
    case 'cancel': return entry(`Cancelled ${ref}`);
    case 'restore': return entry(`Restored ${ref}`);
    case 'balance_link': return entry(`Balance link for ${ref} · ${eur2(d.balance_cents)}`);
    case 'block_create': {
      const b = d.block;
      return entry(`Blocked ${roomsText(b.rooms)} · ${rangeLabel(b.from, b.to)} (${count(b.nights, 'night')}) · ${b.reason}${d.forced ? ' · saved over a clash' : ''}`, { ref: b.id });
    }
    case 'block_delete': return entry(`Removed block ${d.id}`, { ref: d.id });
    case 'manual_create': {
      const b = d.booking;
      return entry(`Manual booking ${b.ref} · ${count(b.guests.length, 'guest')} · ${rangeLabel(b.manual.from, b.manual.to)}${d.forced ? ' · saved over a clash' : ''}`, { ref: b.ref, program: b.program });
    }
    case 'manual_cancel': return entry(`Cancelled manual booking ${ref}`);
    case 'manual_restore': return entry(`Restored manual booking ${ref}`);
    case 'manual_update': {
      const what = [];
      if (body.comment !== undefined) what.push('comment');
      if (body.total_cents !== undefined) what.push(`price ${eur2(manual ? manual.total_cents : 0)}`);
      return entry(`Edited manual booking ${ref}${what.length ? ` (${what.join(', ')})` : ''}`);
    }
    case 'offline_payment': {
      const p = d.payment || {};
      return entry(`${eur2(p.amount_cents)} ${String(OFFLINE_METHODS[p.method] || 'payment').toLowerCase()} recorded on ${ref}${quoted(p.comment)}${d.forced ? ' · more than the balance' : ''}`);
    }
    case 'offline_void':
      return d.already ? entry(`Undo of a payment on ${d.ref || d.invoice_id}: it was already undone`, { ref: d.ref || null })
        : entry(`Undid ${eur2(d.amount_cents)} payment on ${d.ref || d.invoice_id}${quoted(body.reason)}`, { ref: d.ref || null });
    case 'user_create': return entry(`Added user ${hint.user.username} (${ROLE_TEXT[hint.user.role]})`);
    case 'user_update': return entry(userChangeText(hint));
    case 'test_users_create':
      return entry(!hint.reset ? `Created ${count(hint.created, 'test user')}` : !hint.created ? `Reset ${count(hint.reset, 'test user')} (new passwords)`
        : `Created ${count(hint.created, 'test user')}, reset ${hint.reset}`);
    case 'seed_demo': return entry(`Added demo bookings · ${editionOf(body.program)}`, { program: body.program });
    case 'place_demo': return entry(`Placed demo guests in rooms · ${editionOf(body.program)}`, { program: body.program });
    case 'clear_demo': return entry(`Removed demo bookings · ${editionOf(body.program)}`, { program: body.program });
    case 'register_domains': return entry(d.ok ? 'Registered the payment domains' : 'Tried to register the payment domains (some failed)');
    case 'uplisting_map': { const n = Object.keys(d.mapping || {}).length; return entry(`Uplisting mapping: ${count(n, 'listing')} mapped`); }
    case 'uplisting_hooks': {
      const on = Object.values(d.hooks || {}).filter(Boolean).length;
      return entry(`Uplisting webhooks: ${on} of 3 connected (${d.created || 0} added, ${d.removed || 0} removed)`);
    }
    case 'uplisting_sync': return d.done ? entry(syncSummary(d.stats || {})) : null; // one entry per sync, when it is done
    case 'uplisting_push_run': return d.done ? entry(pushRunSummary(d.stats || {})) : null;
    case 'uplisting_push': return entry(`Push to Uplisting turned ${d.push}`);
    case 'uplisting_autoplace': return entry(`Auto-place of new bookings turned ${d.autoplace}`);
    case 'repair_plans': return entry(`Repaired payment plans${(d.repaired || []).length || (d.failed || []).length ? ` · ${count((d.repaired || []).length, 'plan')} fixed${(d.failed || []).length ? `, ${(d.failed || []).length} failed` : ''}` : ''}`);
    default: return entry(cut(`${action} ${ref || ''}`.trim(), 120) || 'action');
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const bad = guardPost(request, env);
  if (bad) return bad;
  const who = await whoIs(request, env);
  if (who.res) return who.res;
  const me = who.me;
  const body = await readBody(request);
  if (!body) return json(request, { error: 'Invalid request.' }, 400, env);
  if (me.role === 'viewer') return json(request, READ_ONLY, 403, env);
  if (me.role !== 'owner' && OWNER_ACTIONS.has(body.action)) return json(request, OWNER_ONLY, 403, env);
  let sent = null;
  const send = (d, s = 200) => { sent = { d, s }; return json(request, d, s, env); };
  const hint = { me };
  const res = await runAction(context, env, body, send, hint);
  const ok = res.status >= 200 && res.status < 300 && sent && sent.s === res.status && env.STRIPE_SECRET_KEY;
  // the activity log: every action that answered 2xx (not a no-op), with who did it; never fails the action
  if (ok && hint.activity) for (const info of hint.activity) await recordActivity(context, env, me, info);
  if (ok && !(sent.d && sent.d.unchanged)) {
    let info = null;
    try { info = activityOf(body, sent.d || {}, hint); } catch (e) { logError('admin.activity_entry', e, { action: String(body.action || '').slice(0, 30) }); }
    if (info) await recordActivity(context, env, me, info);
  }
  // the push to Uplisting (when it is on) after a change of rooms: after the answer, never failing the action
  if (ok && hint.push && hint.push.rooms && hint.push.rooms.length && PUSH_ACTIONS.has(body.action)) {
    const p = pushAfter(env, { actor: me, host: hostOf(request), ...hint.push });
    if (typeof context.waitUntil === 'function') { try { context.waitUntil(p); } catch { await p; } } else await p;
  }
  return res;
}

async function runAction(context, env, body, send, hint) {
  // a booking link can be tried without Stripe (demo: the quote and the Checkout Session it would open)
  if (body.action === 'create_link' && !env.STRIPE_SECRET_KEY) return createLink(env, body, send);
  if (!env.STRIPE_SECRET_KEY) return send({ error: 'Stripe is not connected yet.' }, 503);

  try {
    if (body.action === 'create_link') return await createLink(env, body, send);
    if (body.action === 'user_create') return await userCreate(env, body, send, hint);
    if (body.action === 'user_update') return await userUpdate(env, body, send, hint);
    if (body.action === 'test_users_create') return await testUsersCreate(env, send, hint);
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
    // auto-place of paid online bookings (a setting of its own: it doesn't need the API key to be changed)
    if (body.action === 'uplisting_autoplace') { const r = await saveFlag(env, 'autoplace', body.mode); return send(r.data, r.status); }
    // Uplisting: which rooms each listing is, its webhooks, a full sync in slices, the push (setting, a run in slices)
    if (['uplisting_map', 'uplisting_hooks', 'uplisting_sync', 'uplisting_push', 'uplisting_push_run'].includes(body.action)) {
      if (!env.UPLISTING_API_KEY || !String(env.UPLISTING_API_KEY).trim()) return send({ error: 'Uplisting is not connected: set UPLISTING_API_KEY in Cloudflare first.', code: 'uplisting_off' }, 503);
      const cursor = typeof body.cursor === 'string' ? body.cursor : null, host = hostOf(context.request);
      let r;
      try {
        r = body.action === 'uplisting_map' ? await saveMapping(env, body)
          : body.action === 'uplisting_hooks' ? await connectHooks(env, context.request)
          : body.action === 'uplisting_push' ? await saveFlag(env, 'push', body.mode)
          : await syncSlice(env, { cursor, mode: body.action === 'uplisting_push_run' ? 'push' : 'sync', host, actor: hint.me });
      } catch (e) {
        if (!isBusy(e) || (body.action !== 'uplisting_sync' && body.action !== 'uplisting_push_run')) throw e;
        logError('admin.uplisting_slice', e);
        return send({ error: 'Stripe is busy for a moment. Call again (the sync goes on from where it was).', code: 'uplisting_busy', retry_after: 5 }, 503);
      }
      if (r.activity && r.activity.length) hint.activity = r.activity;
      return send(r.data, r.status);
    }
    // the team's records: room blocks and manual bookings; offline payments
    if (body.action === 'block_create') return await blockCreate(env, body, send, hint);
    if (body.action === 'block_delete') return await blockDelete(env, body, send, hint);
    if (body.action === 'manual_create') return await manualCreate(env, body, send, hint);
    if (body.action === 'offline_void') return await offlineVoid(env, body, send);

    const ref = String(body.ref || '').trim().toUpperCase();
    if (!validRef(ref)) return send({ error: 'Invalid reference.' }, 400);
    if (isManualRef(ref)) { hint.ref = ref; return await manualAction(context, env, body, ref, send, hint); }
    if (/^manual_/.test(String(body.action || ''))) return send({ error: 'That is not a manual booking.' }, 400);
    const found = await findBooking(env, ref);
    if (!found) return send({ error: 'Booking not found (new bookings can take a minute to appear).' }, 404);
    const { program, booking } = found;
    hint.ref = ref; hint.program = program.id;
    if (body.action === 'offline_payment') return await offlinePayment(context, env, body, found, send);

    if (body.action === 'note') {
      const note = cleanNote(body.note);
      await saveOnBooking(env, booking, { aob_note: note });
      forgetBooking(ref);
      return send({ ok: true, ref, note });
    }
    if (body.action === 'assign') {
      if (!body.assign || typeof body.assign !== 'object' || Array.isArray(body.assign)) return send({ error: 'Nothing to assign.' }, 400);
      const next = parseAssign((await currentMeta(env, booking)).aob_assign), fields = {}, before = Object.values(next);
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
      hint.push = { rooms: [...new Set([...before, ...Object.values(assign)])], from: program.dates.start, to: program.dates.end, override: { ref, assign }, ref };
      // warnings over the whole week (other bookings' guests may share the room)
      let warnings = [];
      try {
        // the guests of the programs overlapping this week who are placed in its rooms count too
        const [all, recs] = await Promise.all([groupPayments(env, program), listRecords(env, { recent: true })]);
        const others = groupBookings(program, paysOf(all, program.id)).filter(b => b.ref !== ref);
        const near = overlappingPrograms(program).map(q => ({ program: q, bookings: groupBookings(q, paysOf(all, q.id)) }));
        warnings = assignWarnings(program, [...others, { ...booking, assign }], { assign }, recs, near);
      } catch (e) { logError('admin.assign_warnings', e, { ref }); warnings = assignWarnings(program, [{ ...booking, assign }], { assign }); }
      return send({ ok: true, ref, assign, warnings });
    }
    if (body.action === 'svc_status') {
      const key = String(body.key || '');
      const addon = booking.addons.find(a => a.key === key);
      if (!addon) return send({ error: 'That session is not on this booking.' }, 404);
      hint.session = addon.minutes ? `${addon.title} ${addon.minutes} min` : addon.title;
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
      hint.push = { rooms: [...new Set(Object.values(booking.assign || {}))], from: program.dates.start, to: program.dates.end, override: { ref, status }, ref };
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
