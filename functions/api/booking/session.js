// GET /api/booking/session?id=cs_… — what the confirmation screen shows after Stripe returns.
import { json, preflight, getProgram, stripe, roomsFromString, findBooking } from '../../../booking-lib/core.js';
export const onRequestOptions = ({ request }) => preflight(request);
export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return json(request, { error: 'Invalid session.' }, 400);
  if (!env.STRIPE_SECRET_KEY) return json(request, { demo: true }, 200);
  try {
    const s = await stripe(env, 'GET', `/checkout/sessions/${id}`);
    const md = s.metadata || {};
    const program = getProgram(md.aob_program);
    if (!program) return json(request, { error: 'Not found.' }, 404);
    const rooms = Object.entries(roomsFromString(md.aob_rooms)).map(([rid, n]) => ({ name: (program.rooms.find(r => r.id === rid) || { name: rid }).name, guests: n }));
    let balance = md.aob_kind === 'booking' ? parseInt(md.aob_balance || '0', 10) : null;
    if (md.aob_kind === 'balance') { try { const f = await findBooking(env, md.aob_ref); balance = f ? f.booking.balance_cents : null; } catch {} }
    return json(request, {
      kind: md.aob_kind, ref: md.aob_ref, status: s.status, paid: s.payment_status === 'paid',
      amount_paid_cents: s.amount_total, currency: s.currency, payment: md.aob_payment || null,
      total_cents: parseInt(md.aob_total || '0', 10) || null, balance_cents: balance,
      guests: parseInt(md.aob_guests || '0', 10) || null, rooms,
      first_name: (md.aob_lead_name || '').split(' ')[0],
      program: { id: program.id, title: program.title, edition: program.edition, dates: program.dates, venue: program.venue.name },
    });
  } catch { return json(request, { error: 'Could not load this payment.' }, 502); }
}
