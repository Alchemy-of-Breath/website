// POST /api/booking/lead — a guest who ticked "Email me a link to finish my booking if I get
// interrupted". Forwarded to GHL as booking_started (only with that consent). Nothing is stored here.
// The address isn't verified, so: names with links, emails or numbers are refused; in live mode the
// reminder is only on with the bot check; one booking_started per email address per day (per isolate;
// set the GHL workflow to "allow re-entry: off" for a durable limit); the resume link is always our
// own booking page; and the consent is marked unverified for GHL (double opt-in before any marketing).
import {
  json, preflight, guardPost, readBody, clientIp, ipHash, rateLimited, verifyTurnstile, getProgram, validEmail, nameError,
  normalizePhone, phoneError, pickUtm, bookingPageUrl, cleanAttempt, remindEnabled, str, logError,
} from '../../../booking-lib/core.js';

export const onRequestOptions = ({ request, env }) => preflight(request, env);

const CONSENT_TEXT = 'Email me a link to finish my booking if I get interrupted';
const DAY_MS = 24 * 3600 * 1000;
const sent = new Map(); // email → when booking_started was last forwarded (this isolate)
const sentRecently = email => { const t = sent.get(email); return !!t && Date.now() - t < DAY_MS; };
const markSent = email => { sent.delete(email); sent.set(email, Date.now()); while (sent.size > 5000) sent.delete(sent.keys().next().value); };

export async function onRequestPost({ request, env }) {
  const send = (d, s = 200) => json(request, d, s, env);
  const bad = guardPost(request, env);
  if (bad) return bad;
  const body = await readBody(request);
  if (!body) return send({ error: 'Invalid request.' }, 400);
  const program = getProgram(body.program);
  if (!program) return send({ error: 'Unknown program.' }, 404);

  const ip = clientIp(request), iph = await ipHash(env, ip);
  if (iph && rateLimited('lead:' + iph, 6, 10 * 60 * 1000)) {
    return send({ error: 'Too many requests. Please try again in a few minutes.', code: 'too_many' }, 429);
  }
  const human = await verifyTurnstile(env, body.turnstile, ip);
  if (!human.ok) return send({ error: 'Please confirm you\'re not a robot, then try again.', code: 'turnstile' }, 403);

  const fields = {};
  const email = str(body.email, 120).toLowerCase();
  const first = str(body.first, 60), last = str(body.last, 60);
  if (body.consent !== true) fields.consent = 'Please tick the box so we can email you a link.';
  if (!validEmail(email)) fields.email = 'Please add a valid email address.';
  if (nameError(first)) fields.first = nameError(first);
  if (nameError(last)) fields.last = nameError(last);
  if (Object.keys(fields).length) return send({ error: 'Please check the highlighted details.', fields }, 422);

  const phone = normalizePhone(body.whatsapp);
  const max = program.max_guests_per_booking || 6;
  const guests = Math.min(max, Math.max(1, parseInt(body.guests, 10) || 1));
  const room = program.rooms.find(r => r.id === body.room);

  if (!remindEnabled(env)) return send({ ok: true, forwarded: false }, 202); // no GHL, or live mode without the bot check
  if (sentRecently(email)) return send({ ok: true }, 202);                  // already sent today: don't email them again
  const payload = {
    event: 'booking_started', program: program.id,
    program_title: `${program.edition || program.title} · ${program.dates.label}`,
    first_name: first, last_name: last, email, phone: phoneError(phone) ? '' : phone,
    guests, room: room ? room.id : '', room_name: room ? room.name : '',
    resume_url: bookingPageUrl(program, body.page, env), tag: `${program.id}-started`,
    consent_text: CONSENT_TEXT, consent_at: new Date().toISOString(), consent_verified: 'no', attempt: cleanAttempt(body.attempt),
    ...pickUtm(body.utm),
  };
  try {
    const r = await fetch(env.GHL_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    if (r.ok) markSent(email); else logError('lead.ghl', { status: r.status, type: 'ghl_error' });
  } catch (e) { logError('lead.ghl', { status: 0, type: 'network_error' }); }
  return send({ ok: true }, 202);
}
