/* Demo bookings for TEST MODE only (admin "Fill with demo bookings" / "Remove demo bookings").
   Each demo booking is priced by quote() and checked by checkAvailability() exactly like a real one,
   then paid server-side with Stripe's test card (pm_card_visa) as a PaymentIntent carrying the usual
   aob_* metadata plus aob_demo='1'. Removing them renames their aob_program / aob_kind, so they drop
   out of every booking search (PaymentIntents can't be deleted). Refused with a live key. */
import {
  quote, checkAvailability, availability, buildOccupancy, programPayments, openBookingSessions,
  bookingMetadata, newRef, stripe, searchAll, clearAvailabilityMemo, liveMode, serviceItems, logError,
  parseAssign, assignToString, nameCapacity,
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

/* ---- random room placement (same rules as the Rooming board: one gender per shared room, never more
   guests than a room sleeps, the cottage for two only for the guests of one booking) ---- */
const gk = g => (String(g || '').toLowerCase() === 'male' ? 'male' : 'female');
const guestsOf = md => { const out = []; for (let i = 1; i <= 12; i++) { const v = md[`aob_g${i}`]; if (!v) continue; const p = v.split(' | '); out.push({ i: i - 1, gender: p[2], room: p[3] }); } return out; };
// physical rooms of the week and what is already in them, from every active booking's aob_assign
function physicalRooms(program, mds) {
  const phys = {};
  for (const r of program.rooms) for (const name of r.names || []) phys[name] = { room: r.id, cap: nameCapacity(r), shared: !!r.same_gender, unit: r.unit !== 'person', used: 0, gender: null, refs: new Set() };
  for (const md of mds) {
    if (md.aob_kind !== 'booking' || md.aob_status === 'cancelled' || md.aob_program !== program.id) continue;
    const a = parseAssign(md.aob_assign), gs = guestsOf(md);
    for (const g of gs) { const slot = phys[a[g.i]]; if (!slot) continue; slot.used++; slot.gender = slot.gender || gk(g.gender); slot.refs.add(md.aob_ref); }
  }
  return phys;
}
// a random valid room for each guest of one booking; guests of the same gender and room type stay together where they fit
export function placeGuests(program, phys, guests, rnd, ref = '') {
  const assign = {}, shuffle = a => { for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); const t = a[k]; a[k] = a[j]; a[j] = t; } return a; };
  const groups = {};
  for (const g of guests) { const r = program.rooms.find(x => x.id === g.room); if (!r || !(r.names || []).length) continue; const key = g.room + (r.same_gender ? ':' + gk(g.gender) : ''); (groups[key] = groups[key] || []).push(g); }
  for (const list of Object.values(groups)) {
    const room = list[0].room, gender = gk(list[0].gender);
    let left = list.slice();
    while (left.length) {
      const free = shuffle(Object.keys(phys).filter(n => {
        const p = phys[n];
        if (p.room !== room || p.used >= p.cap) return false;
        if (p.unit && p.used && !p.refs.has(ref)) return false;         // a whole cottage belongs to one booking
        if (p.shared && p.used && p.gender !== gender) return false;      // shared rooms stay single-gender
        return true;
      }));
      if (!free.length) break;                                           // no physical room left: stays unplaced
      // prefer the room where the most of this group fit at once, so friends share
      // …and, like the availability count, fill a half-used room of this gender before opening an empty one
      free.sort((a, b) => (Math.min(phys[b].cap - phys[b].used, left.length) - Math.min(phys[a].cap - phys[a].used, left.length)) ||
        ((phys[b].used > 0) - (phys[a].used > 0)));
      const name = free[0], p = phys[name], take = Math.min(p.cap - p.used, left.length);
      for (const g of left.splice(0, take)) { assign[g.i] = name; p.used++; p.gender = p.gender || gk(g.gender); p.refs.add(ref); }
    }
  }
  return assign;
}

export async function seedDemo(env, program, { percent = 40, now = new Date() } = {}) {
  if (liveMode(env)) { const e = new Error('Demo bookings can only be added in Stripe test mode.'); e.status = 403; throw e; }
  const rnd = rng(program.id + ':' + now.getTime());
  const [pays, sessions] = await Promise.all([programPayments(env, program), openBookingSessions(env, program)]);
  const records = pays.slice();
  let avail = availability(program, buildOccupancy(program, records, sessions));
  const phys = physicalRooms(program, records.map(p => p.md || {}));
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
    const placed = placeGuests(program, phys, q.guests.map((g, i) => ({ i, gender: g.gender, room: g.room })), rnd, ref);
    if (Object.keys(placed).length) md.aob_assign = assignToString(placed);
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

/* Place demo guests who have no room yet (bookings made before placement existed). One Stripe update
   per booking; real bookings are never changed, only counted. */
export async function placeDemo(env, program, { now = new Date() } = {}) {
  if (liveMode(env)) { const e = new Error('Demo bookings only exist in Stripe test mode.'); e.status = 403; throw e; }
  const rnd = rng(program.id + ':place:' + now.getTime());
  const pays = await programPayments(env, program);
  const mds = pays.map(p => p.md || {});
  const phys = physicalRooms(program, mds);
  let placed = 0, guests = 0, unplaced = 0;
  for (const p of pays) {
    const md = p.md || {};
    if (md.aob_demo !== '1' || md.aob_kind !== 'booking' || md.aob_status === 'cancelled' || p.sub || placed >= 40) continue;
    const hasNames = id => { const r = program.rooms.find(x => x.id === id); return !!(r && (r.names || []).length); };
    const have = parseAssign(md.aob_assign), gs = guestsOf(md).filter(g => !have[g.i] && hasNames(g.room));   // tent pitches have no names
    if (!gs.length) continue;
    const add = placeGuests(program, phys, gs, rnd, md.aob_ref);
    const n = Object.keys(add).length; unplaced += gs.length - n;
    if (!n) continue;
    try {
      await stripe(env, 'POST', `/payment_intents/${p.id}`, { metadata: { aob_assign: assignToString({ ...have, ...add }) } });
      placed++; guests += n;
    } catch (e) { logError('demo.place', e, { ref: md.aob_ref }); }
  }
  return { program: program.id, bookings: placed, guests, unplaced };
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
