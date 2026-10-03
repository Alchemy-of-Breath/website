// POST /api/booking/webhook — Stripe → (verified) → GoHighLevel inbound webhook.
// In Stripe: Developers → Webhooks → add https://website-5h3.pages.dev/api/booking/webhook,
// event checkout.session.completed, then put its signing secret in STRIPE_WEBHOOK_SECRET.
import { verifyStripeSignature, parseBooking, getProgram } from '../../../booking-lib/core.js';
export async function onRequestPost({ request, env }) {
  const payload = await request.text();
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response('webhook secret not configured', { status: 503 });
  if (!(await verifyStripeSignature(payload, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return new Response('invalid signature', { status: 400 });
  }
  let event; try { event = JSON.parse(payload); } catch { return new Response('bad json', { status: 400 }); }
  if (event.type !== 'checkout.session.completed') return new Response('ignored', { status: 200 });
  const s = event.data && event.data.object || {};
  const md = s.metadata || {};
  if (!md.aob_program) return new Response('not a booking', { status: 200 });
  if (env.GHL_WEBHOOK_URL) {
    const b = parseBooking(md), program = getProgram(md.aob_program);
    const [first, ...rest] = String(md.aob_lead_name || '').split(' ');
    const roomName = id => (program && program.rooms.find(r => r.id === id) || { name: id }).name;
    const body = {
      event: md.aob_kind === 'balance' ? 'booking_balance_paid' : 'booking_paid',
      ref: md.aob_ref, program: md.aob_program,
      program_title: program ? `${program.edition || program.title} · ${program.dates.label}` : '',
      first_name: first || '', last_name: rest.join(' '),
      email: md.aob_lead_email || (s.customer_details && s.customer_details.email) || '',
      phone: md.aob_whatsapp || '', gender: (b.guests[0] && b.guests[0].gender) || '',
      payment: md.aob_payment || '', currency: (s.currency || '').toUpperCase(),
      amount_paid: ((s.amount_total || 0) / 100).toFixed(2),
      total: md.aob_total ? (parseInt(md.aob_total, 10) / 100).toFixed(2) : '',
      balance: md.aob_kind === 'booking' ? (parseInt(md.aob_balance || '0', 10) / 100).toFixed(2) : '',
      guests: md.aob_guests || '', rooms: Object.entries(b.rooms).map(([id, n]) => `${roomName(id)} × ${n}`).join(', '),
      guest_list: b.guests.map(g => `${g.name} <${g.email}>, ${g.gender}, ${roomName(g.room)}`).join('\n'),
      roommate: md.aob_roommate || '',
      tag: md.aob_kind === 'balance' ? `${md.aob_program}-balance-paid` : `${md.aob_program}-booked`,
      stripe_session: s.id, ...b.utm,
    };
    try { await fetch(env.GHL_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch {}
  }
  return new Response('ok', { status: 200 });
}
