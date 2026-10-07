// /api/booking/addons — wellbeing sessions added to an existing booking (the /book/extras/ page).
//   GET                                          → { turnstile_site_key, stripe: { embedded, publishable_key } }
//   POST { action:'lookup', ref, email, fresh? } → the booking (week, guests' first names), its sessions, the
//        catalogue and how many more can be added (open: false once cancelled or after the week's last day)
//   POST { action:'pay', ref, email, addons:[{ id, guest }], ui:'embedded'|'hosted', replace?, return_url?, expected? }
//        → a Checkout Session for the new sessions: the same answers as /api/booking/checkout
//          (embedded: client_secret + publishable_key; hosted: url; no Stripe key: demo)
// Same guards as the balance page: JSON only, our origins, a rate limit and the optional bot check.
// Prices only ever come from the program's catalogue, and sessions never hold places. Existing and new
// sessions together stay within the limits; one add-on checkout per booking is payable at a time.
import {
  json, preflight, guardPost, readBody, clientIp, ipHash, rateLimited, verifyTurnstile, turnstileSiteKey, publishableKey, validRef, knownRef,
  programsForRef, findBooking, forgetBooking, extrasOpen, activeAddons, addonLimitsLeft, serviceLimits, checkAddons, publicServices,
  addonMetadata, addonCheckoutParams, addonsToString, extrasPageUrl, openAddonSessions, expireOrCheck, expireSession, sessionState, safeCreateSession, stripe,
  autoRegisterDomain, isBusy, logError, nowSec, BUSY, CS_ID, SITE,
} from '../../../booking-lib/core.js';

export const onRequestOptions = ({ request, env }) => preflight(request, env);

const NOT_FOUND = { error: 'We could not find a booking with that reference and email.' };
const TS_ACTIONS = ['extras', 'balance', 'booking']; // the widget action the extras page may use
const stripeInfo = env => { const pk = env.STRIPE_SECRET_KEY ? publishableKey(env) : null; return { embedded: !!pk, publishable_key: pk }; };

export function onRequestGet({ request, env }) {
  return json(request, { live: !!env.STRIPE_SECRET_KEY, turnstile_site_key: turnstileSiteKey(env), stripe: stripeInfo(env) }, 200, env);
}

/* Service photos from this deployment (pages.dev, a preview or wrangler): the same files the pages use. */
const imgBase = request => { try { return new URL(request.url).origin + '/assets/booking/services/'; } catch { return SITE + '/assets/booking/services/'; } };
const firstName = (g, i) => g.first || String(g.name || '').trim().split(/\s+/)[0] || `Guest ${i + 1}`;
const addonOut = a => ({ key: a.key, id: a.id, guest: a.guest, title: a.title, practitioner: a.practitioner, practitioner_name: a.practitioner_name,
  minutes: a.minutes, price_cents: a.price_cents, source: a.source, status: a.status, when: a.when || '', pending: !!a.pending });
const quoteOf = list => {
  const t = list.reduce((s, a) => s + a.price_cents, 0);
  return { addons: list.map(a => ({ id: a.id, guest: a.guest, title: a.title, practitioner: a.practitioner, practitioner_name: a.practitioner_name, minutes: a.minutes, price_cents: a.price_cents })),
    addons_cents: t, due_now_cents: t, total_cents: t, count: list.length };
};
const num = v => typeof v === 'number' && Number.isFinite(v);
const priceChanged = (exp, q) => (num(exp.due_now_cents) && Math.round(exp.due_now_cents) !== q.due_now_cents)
  || (num(exp.total_cents) && Math.round(exp.total_cents) !== q.total_cents);
const fieldError = (send, msg) => send({ error: msg, fields: { addons: msg } }, 422);
const alreadyPaid = (sessionId, ref) => ({ error: 'These sessions are already paid. We\'re showing your confirmation.', code: 'already_paid', session_id: sessionId, ref });
/* aob_addons → is it the same sessions (in any order)? */
const sortedAddons = v => String(v || '').split(',').filter(Boolean).sort().join(',');
const sameSessions = want => { const w = sortedAddons(want); return v => !!w && sortedAddons(v) === w; };

function lookupInfo(request, env, program, booking) {
  const st = extrasOpen(program, booking);
  return {
    ref: booking.ref,
    program: { id: program.id, title: program.title, edition: program.edition, dates: program.dates, currency: program.currency, terms_url: program.terms_url || null },
    guests: booking.guests.map((g, i) => ({ index: i, first_name: firstName(g, i) })),
    addons: booking.addons.map(addonOut),
    services: publicServices(program, imgBase(request)),
    limits: serviceLimits(program), limits_left: addonLimitsLeft(program, activeAddons(booking)),
    open: st.open, reason: st.reason, message: st.message,
    stripe: stripeInfo(env),
  };
}

/* No Stripe key: a stand-in booking (two guests, no sessions yet) so the page can be tried locally. */
function demoFind(ref, programId) {
  const progs = programsForRef(ref);
  const program = progs.find(p => p.id === programId) || progs[0];
  if (!program) return null;
  const room = (program.rooms[0] || {}).id;
  return { program, booking: { ref, status: 'active', pending: false, addons: [], lead: { name: 'Demo Guest', email: '' },
    guests: [{ name: 'Demo Guest', first: 'You', gender: 'Female', room }, { name: 'Guest 2', first: 'Guest 2', gender: 'Female', room }] } };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const send = (d, s = 200) => json(request, d, s, env);
  const bad = guardPost(request, env);
  if (bad) return bad;
  const body = await readBody(request);
  if (!body) return send({ error: 'Invalid request.' }, 400);
  const action = body.action === 'lookup' || body.action === 'pay' ? body.action : null;
  if (!action) return send({ error: 'Unknown action.' }, 400);
  const ref = String(body.ref || '').trim().toUpperCase();
  const email = String(body.email || '').trim().toLowerCase();
  if (!validRef(ref) || !email) return send({ error: 'Enter your booking reference and the email you booked with.' }, 400);
  const ip = clientIp(request), iph = await ipHash(env, ip);
  if (iph && rateLimited('addons:' + iph, 30, 10 * 60 * 1000)) {
    return send({ error: 'Too many tries. Please wait a few minutes and try again.', code: 'too_many' }, 429);
  }
  const human = await verifyTurnstile(env, body.turnstile, ip, { action: TS_ACTIONS });
  if (!human.ok) return send({ error: 'Please confirm you\'re not a robot, then try again.', code: 'turnstile' }, 403);
  if (!knownRef(ref)) return send(NOT_FOUND, 404); // not a reference we issue: no Stripe calls
  const returnUrl = extrasPageUrl(body.return_url, env); // our own extras page, on the origin the guest is on

  /* ---------- demo mode: no Stripe key, nothing is charged ---------- */
  if (!env.STRIPE_SECRET_KEY) {
    const f = demoFind(ref, body.program);
    if (!f) return send(NOT_FOUND, 404);
    if (action === 'lookup') return send({ demo: true, ...lookupInfo(request, env, f.program, f.booking) });
    const st = extrasOpen(f.program, f.booking);
    if (!st.open) return send({ error: st.message, code: st.reason }, 409);
    const chk = checkAddons(f.program, body.addons, f.booking.guests.length, []);
    if (chk.error) return fieldError(send, chk.error);
    if (!chk.list.length) return fieldError(send, 'Choose at least one session.');
    const md = addonMetadata(f.program, f.booking, chk.list, 'hosted');
    return send({ demo: true, ref, quote: quoteOf(chk.list), stripe_params: addonCheckoutParams(f.program, f.booking, chk.list, md, returnUrl) });
  }

  /* ---------- live ---------- */
  try {
    // paying always reads fresh; a lookup may use the 30 s memo unless the page asks for fresh data
    // (fresh: true, e.g. right after a payment)
    let found = await findBooking(env, ref, { cached: action === 'lookup' && body.fresh !== true });
    if (!found || (found.booking.lead.email || '').toLowerCase() !== email) return send(NOT_FOUND, 404);
    const { program } = found;
    if (action === 'lookup') return send(lookupInfo(request, env, program, found.booking));

    const st = extrasOpen(program, found.booking);
    if (!st.open) return send({ error: st.message, code: st.reason }, 409);
    let chk = checkAddons(program, body.addons, found.booking.guests.length, activeAddons(found.booking));
    if (chk.error) return fieldError(send, chk.error);
    if (!chk.list.length) return fieldError(send, 'Choose at least one session.');
    let q = quoteOf(chk.list);
    if (body.expected && typeof body.expected === 'object' && priceChanged(body.expected, q)) {
      return send({ error: 'Prices were updated. Please check your total.', code: 'price_changed', quote: q }, 409);
    }

    // The checkout this browser is replacing has been paid (a bank app, another tab): never a second
    // payment for the same sessions. (After a confirmed payment the page starts without `replace`.)
    let replacing = null; // the replaced checkout, still open a moment ago: checked again below
    if (typeof body.replace === 'string' && CS_ID.test(body.replace)) {
      let s = null;
      try { s = await stripe(env, 'GET', `/checkout/sessions/${body.replace}`); } catch { s = null; }
      const md = (s && s.metadata) || {};
      if (s && md.aob_kind === 'addon' && md.aob_ref === ref) {
        if (s.status === 'complete') {
          const was = await sessionState(env, s);
          if (was === 'paid' || was === 'processing') return send(alreadyPaid(s.id, ref), 409);
        } else if (s.status === 'open') replacing = s.id;
      }
    }
    // One payable add-on checkout per booking, so two can't both be paid past the limits: give up the
    // open ones first (and the replaced one, even if it has left the open list meanwhile).
    const open = await openAddonSessions(env, ref);
    const ids = [...new Set([...open.map(s => s.id), ...(replacing ? [replacing] : [])])];
    const results = await Promise.all(ids.map(id => expireOrCheck(env, id)));
    // One paid in that moment: the one being replaced, or one for the very same sessions, is this
    // payment (never open a second one for it); any other counts towards the limits (checked again).
    const want = sameSessions(addonsToString(chk.list));
    for (const r of results) {
      if (r.state !== 'complete' || !r.session) continue;
      const st = await sessionState(env, r.session);
      if ((st === 'paid' || st === 'processing') && (r.session.id === body.replace || want(((r.session.metadata || {}).aob_addons)))) {
        return send(alreadyPaid(r.session.id, ref), 409);
      }
    }
    // one Stripe couldn't close stays payable: don't open a second one beside it
    if (results.some(r => r.state === 'open' || r.state === 'unknown')) {
      logError('addons.replace', { type: 'expire_failed' }, { ref });
      return send({ error: 'An earlier payment for sessions couldn\'t be closed just now. Please try again in a moment.', code: 'busy', retry_after: 5 }, 503);
    }
    if (results.some(r => r.state === 'complete')) {
      forgetBooking(ref);
      found = await findBooking(env, ref);
      if (!found) return send(NOT_FOUND, 404);
      chk = checkAddons(program, body.addons, found.booking.guests.length, activeAddons(found.booking));
      if (chk.error) return send({ error: chk.error, fields: { addons: chk.error }, code: 'changed' }, 409);
      q = quoteOf(chk.list);
    }

    const embedded = body.ui === 'embedded' && !!publishableKey(env);
    const md = addonMetadata(program, found.booking, chk.list, embedded ? 'embedded' : 'hosted');
    let session;
    try { ({ session } = await safeCreateSession(env, addonCheckoutParams(program, found.booking, chk.list, md, returnUrl, { embedded }))); }
    catch (e) {
      logError('addons.create', e, { ref });
      return isBusy(e) ? send(BUSY, 503) : send({ error: 'We could not start the payment. Please try again, or message us on WhatsApp.' }, 502);
    }
    // Race check against a fresh list: two requests at the same moment (a double click, two tabs) both
    // passed the step above before either had created its checkout. Checkouts are ordered by creation
    // time; one created in the same second counts as earlier (Stripe ids don't follow creation order),
    // so in a tie both back off rather than both stay payable.
    try {
      const fresh = await openAddonSessions(env, ref), created = session.created || nowSec();
      if (fresh.some(s => s.id !== session.id && s.created <= created)) {
        await expireSession(env, session.id);
        return send({ error: 'Another payment for sessions is in progress. Please try again in a moment.', code: 'busy' }, 409);
      }
    } catch (e) { logError('addons.race', e, { ref }); } // the checks above passed: keep the checkout
    const base = { session_id: session.id, expires_at: session.expires_at, server_now: nowSec(), ref, quote: q };
    if (embedded) {
      if (!session.client_secret) {
        logError('addons.embedded', { type: 'no_client_secret' }, { ref });
        await expireOrCheck(env, session.id);
        return send({ error: 'We could not start the payment. Please try again, or message us on WhatsApp.' }, 502);
      }
      autoRegisterDomain(env, request, p => context.waitUntil(p)); // wallets need the page host registered with Stripe
      return send({ ui: 'embedded', client_secret: session.client_secret, publishable_key: publishableKey(env), ...base });
    }
    return send({ ui: 'hosted', url: session.url, ...base });
  } catch (e) {
    logError('addons', e, { ref, action });
    return isBusy(e) ? send(BUSY, 503) : send({ error: 'We could not load this booking just now. Please try again in a moment.' }, 502);
  }
}
