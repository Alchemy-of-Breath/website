// /api/booking/admin — bookings dashboard data and actions. Requires Authorization: Bearer <ADMIN_TOKEN>.
// GET reads only. POST actions: cancel (also closes any open balance link), restore (refuses to
// overbook unless force), balance_link (asks before charging a booking that has a refund), repair_plans
// (plan-end safety net), register_domains (Apple Pay / Google Pay / Link for embedded checkout).
import {
  json, preflight, guardPost, readBody, adminAuthorized, getProgram, listPrograms, programSummary, programPayments, groupBookings,
  openBookingSessions, buildOccupancy, occupancy, availability, checkAvailability, validRef, findBooking, forgetBooking, stripe, balanceSession,
  openBalanceSessions, expireSession, balancePageUrl, roomCapacity, ensurePlanEnds, planEndAt, planEndCheck, planEndCheckRecord, keyMode,
  publishableStatus, turnstileSiteKey, turnstileStatus, remindEnabled, listDomains, ensurePaymentMethodDomain, clearAvailabilityMemo, logError,
  eur, nowSec, PROD_HOSTS,
} from '../../../booking-lib/core.js';

export const onRequestOptions = ({ request, env }) => preflight(request, env);

const setupBase = env => ({
  stripe: keyMode(env), publishable: publishableStatus(env), webhook: !!env.STRIPE_WEBHOOK_SECRET,
  turnstile: !!turnstileSiteKey(env), turnstile_status: turnstileStatus(env), ghl: !!env.GHL_WEBHOOK_URL, remind: remindEnabled(env),
});
const planRecords = pays => pays.filter(p => p.sub && p.status !== 'canceled');

export async function onRequestGet({ request, env }) {
  const send = (d, s = 200) => json(request, d, s, env);
  if (!adminAuthorized(request, env)) return send({ error: 'Not authorised.' }, 401);
  const program = getProgram(new URL(request.url).searchParams.get('program')) || listPrograms()[0];
  const programs = listPrograms().map(programSummary);
  const rooms = program.rooms.map(r => ({ id: r.id, name: r.name, capacity: roomCapacity(r), price: r.price, shared: !!r.same_gender, unit: r.unit }));
  if (!env.STRIPE_SECRET_KEY) {
    return send({ demo: true, programs, program: programSummary(program), bookings: [], rooms, availability: availability(program), setup: { ...setupBase(env), domains: [] } });
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
      live: true, programs, program: programSummary(program), bookings,
      rooms,
      availability: availability(program, occ), holds: occ.holds,
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
      },
    });
  } catch (e) { logError('admin.get', e); return send({ error: 'Could not load bookings from Stripe: ' + e.message }, 502); }
}

export async function onRequestPost({ request, env }) {
  const send = (d, s = 200) => json(request, d, s, env);
  const bad = guardPost(request, env);
  if (bad) return bad;
  if (!adminAuthorized(request, env)) return send({ error: 'Not authorised.' }, 401);
  if (!env.STRIPE_SECRET_KEY) return send({ error: 'Stripe is not connected yet.' }, 503);
  const body = await readBody(request);
  if (!body) return send({ error: 'Invalid request.' }, 400);

  try {
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
      const metadata = { aob_status: status, aob_status_at: status === 'cancelled' ? String(nowSec()) : '' };
      if (booking.plan) {
        await stripe(env, 'POST', `/subscriptions/${booking.booking_pi}`, { metadata });
        if (body.action === 'cancel' && booking.plan.status !== 'canceled') await stripe(env, 'DELETE', `/subscriptions/${booking.booking_pi}`); // stop future monthly payments
      } else {
        await stripe(env, 'POST', `/payment_intents/${booking.booking_pi}`, { metadata });
      }
      let closed = 0;
      if (body.action === 'cancel') {
        // a balance link already sent must not stay payable for a cancelled booking
        try {
          const links = await openBalanceSessions(env, ref);
          const done = await Promise.all(links.map(s => expireSession(env, s.id)));
          closed = done.filter(Boolean).length;
          if (closed < links.length) logError('admin.cancel_links', { type: 'expire_failed' }, { ref });
        } catch (e) { logError('admin.cancel_links', e, { ref }); }
      }
      forgetBooking(ref);
      clearAvailabilityMemo(program.id);
      return send({ ok: true, ref, status, balance_links_closed: closed });
    }
    if (body.action === 'balance_link') {
      const p = booking.plan;
      if (p && !p.ended) return send({ error: 'This booking is on the monthly payment plan: the remaining payments are taken automatically.' }, 409);
      if (p && !p.paid_known) return send({ error: 'Stripe didn\'t say what this plan has paid so far. Please try again in a moment.' }, 503);
      if (booking.status === 'cancelled') return send({ error: 'This booking is cancelled. Restore it first if the guest should pay.' }, 409);
      if (booking.pending) return send({ error: 'The first payment for this booking is still processing.' }, 409);
      if (booking.balance_cents <= 0) return send({ error: 'Nothing left to pay on this booking.' }, 409);
      if (booking.refunded_cents > 0 && body.force !== true) {
        return send({ error: `${eur(booking.refunded_cents)} of booking ${ref} has been refunded. A balance link would ask the guest for ${eur(booking.balance_cents)}.`, code: 'refunded',
          refunded_cents: booking.refunded_cents, balance_cents: booking.balance_cents }, 409);
      }
      // one payable balance session per booking: reuse a long-lived open one, else replace it
      const { session, reused } = await balanceSession(env, program, booking, balancePageUrl(body.return_url, env), { hours: 23.9, minLeftSec: 12 * 3600 });
      forgetBooking(ref);
      return send({ url: session.url, expires_at: session.expires_at, balance_cents: booking.balance_cents, reused, plan_ended: !!p });
    }
    return send({ error: 'Unknown action.' }, 400);
  } catch (e) { logError('admin.post', e, { action: String(body.action || '').slice(0, 30) }); return send({ error: 'Stripe error: ' + e.message }, 502); }
}
