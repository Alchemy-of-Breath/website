/* Demo bookings for TEST MODE only (admin "Fill with demo bookings" / "Remove demo bookings").
   Each demo booking is priced by quote() and checked by checkAvailability() exactly like a real one,
   then paid server-side with Stripe's test card (pm_card_visa) as a PaymentIntent carrying the usual
   aob_* metadata plus aob_demo='1'. Removing them renames their aob_program / aob_kind, so they drop
   out of every booking search (PaymentIntents can't be deleted). Refused with a live key. */
import {
  quote, checkAvailability, availability, buildOccupancy, programPayments, openBookingSessions,
  bookingMetadata, newRef, stripe, searchAll, clearAvailabilityMemo, liveMode, serviceItems, logError,
} from './core.js';

const FEMALE = ['Anna', 'Sofia', 'Clara', 'Maja', 'Lucia', 'Emma', 'Ingrid', 'Nadia', 'Hannah', 'Chiara', 'Elena', 'Freya', 'Lea', 'Amara', 'Julia', 'Marta', 'Noor', 'Isla', 'Greta', 'Rosa'];
const MALE = ['Luca', 'Jonas', 'Marco', 'Oliver', 'Tomás', 'Erik', 'Daniel', 'Felix', 'Samir', 'Hugo', 'Matteo', 'Liam', 'Kai', 'Pavel', 'Arjun'];
const LAST = ['Rossi', 'Berg', 'Novak', 'Silva', 'Meyer', 'Laurent', 'Kowalski', 'Jensen', 'Costa', 'Fischer', 'Moreau', 'Andersson', 'Kelly', 'Varga', 'Bianchi', 'Hughes', 'Okafor', 'Lindqvist'];
const DIET = ['Vegetarian, no nuts please', 'Gluten-free', 'Lactose intolerant', 'No onion or garlic', 'Coeliac'];
const MAX_BOOKINGS = 14;   // Workers allow ~50 Stripe calls per request: 1 per booking + a few balances + the reads

const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
function rng(seed) { // small deterministic PRNG, seeded per request
  let h = 2166136261 >>> 0;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

export async function seedDemo(env, program, { percent = 40, now = new Date() } = {}) {
  if (liveMode(env)) { const e = new Error('Demo bookings can only be added in Stripe test mode.'); e.status = 403; throw e; }
  const rnd = rng(program.id + ':' + now.getTime());
  const [pays, sessions] = await Promise.all([programPayments(env, program), openBookingSessions(env, program)]);
  const records = pays.slice();
  let avail = availability(program, buildOccupancy(program, records, sessions));
  const usedBefore = program.program_spaces - avail.program_left;
  const target = Math.round(program.program_spaces * Math.min(90, Math.max(5, percent)) / 100);
  let need = target - usedBefore;
  const created = [];
  const svc = serviceItems(program).map(s => s.id);
  const people = (n) => Array.from({ length: n }, () => (rnd() < 0.65 ? 'Female' : 'Male'));
  let tries = 0;
  while (need > 0 && created.length < MAX_BOOKINGS && tries++ < 80) {
    const size = Math.min(need, rnd() < 0.5 ? 1 : rnd() < 0.7 ? 2 : 3);
    const gs = people(size), f = gs.filter(g => g === 'Female').length, m = size - f;
    const options = program.rooms.filter(r => {
      if (r.unit !== 'person' && !(size === 2 && r.sleeps === 2)) return false;   // the cottage for two: couples only
      const a = avail.rooms[r.id];
      return a && !a.sold_out && checkAvailability(program, { guests: gs.map(g => ({ gender: g, room: r.id })) }, avail) === null;
    });
    if (!options.length) continue;
    const room = pick(rnd, options).id;
    const last = pick(rnd, LAST);
    const guests = gs.map((g, i) => {
      const first = pick(rnd, g === 'Female' ? FEMALE : MALE), ln = i && rnd() < 0.5 ? pick(rnd, LAST) : last;
      return { first, last: ln, email: i && rnd() < 0.4 ? '' : `${first}.${ln}`.toLowerCase().normalize('NFD').replace(/[^a-z.]/g, '') + '.demo@example.com', gender: g, room };
    });
    const addons = [];
    if (svc.length && rnd() < 0.4) {
      const n = rnd() < 0.7 ? 1 : 2;
      for (let k = 0; k < n; k++) addons.push({ id: pick(rnd, svc), guest: Math.floor(rnd() * size) });
    }
    const input = {
      payment: rnd() < 0.55 ? 'deposit' : 'full', programme: rnd() < 0.9 ? 'included' : 'paid', guests,
      whatsapp: '+447700900' + String(100 + Math.floor(rnd() * 899)), roommate: '', diet: rnd() < 0.22 ? pick(rnd, DIET) : '',
      terms: true, addons,
    };
    const q = quote(program, input, { now });
    if (!q.ok || checkAvailability(program, q, avail)) continue;
    const ref = newRef(program);
    const md = { ...bookingMetadata(program, q, ref, { now, ui: 'hosted' }), aob_demo: '1' };
    if (md.aob_prog === 'paid') md.aob_prog_verified = 'unverified';
    try {
      const pi = await stripe(env, 'POST', '/payment_intents', {
        amount: q.due_now_cents, currency: program.currency.toLowerCase(), payment_method: 'pm_card_visa',
        payment_method_types: ['card'], confirm: true, description: `DEMO · ${program.edition || program.title} · ${ref}`, metadata: md,
      });
      records.push({ id: pi.id, md, amount: pi.amount_received || q.due_now_cents, created: pi.created });
      created.push({ ref, guests: size, room, payment: q.payment, due_now_cents: q.due_now_cents, balance_cents: q.balance_cents, lead: guests[0] });
      need -= size;
      avail = availability(program, buildOccupancy(program, records, sessions));
    } catch (e) { logError('demo.seed', e, { ref }); break; }
  }
  // a few deposit bookings have already paid their balance
  let balances = 0;
  for (const b of created) {
    if (balances >= 3 || b.payment !== 'deposit' || !b.balance_cents || rnd() > 0.35) continue;
    try {
      await stripe(env, 'POST', '/payment_intents', {
        amount: b.balance_cents, currency: program.currency.toLowerCase(), payment_method: 'pm_card_visa', payment_method_types: ['card'], confirm: true,
        description: `DEMO · balance · ${b.ref}`,
        metadata: { aob_kind: 'balance', aob_program: program.id, aob_ref: b.ref, aob_lead_name: `${b.lead.first} ${b.lead.last}`, aob_lead_email: b.lead.email, aob_demo: '1' },
      });
      balances++;
    } catch (e) { logError('demo.balance', e, { ref: b.ref }); }
  }
  clearAvailabilityMemo(program.id);
  return {
    program: program.id, target, used_before: usedBefore, created: created.length, balances,
    guests: created.reduce((s, b) => s + b.guests, 0), places_left: avail.program_left, refs: created.map(b => b.ref),
  };
}

export async function clearDemo(env, program) {
  if (liveMode(env)) { const e = new Error('Demo bookings only exist in Stripe test mode.'); e.status = 403; throw e; }
  const rows = await searchAll(env, `metadata['aob_demo']:'1' AND metadata['aob_program']:'${program.id}'`, 45);
  let removed = 0;
  for (const pi of rows.slice(0, 40)) {
    try {
      await stripe(env, 'POST', `/payment_intents/${pi.id}`, { metadata: {
        aob_program: 'demo-removed', aob_kind: 'demo_removed', aob_demo_program: program.id } });
      removed++;
    } catch (e) { logError('demo.clear', e, { pi: pi.id }); }
  }
  clearAvailabilityMemo(program.id);
  return { program: program.id, removed, more: rows.length > 40 };
}
