import { attribution } from './attribution.js';

const FIELDS = ['source','variant','outcome','outcome_tag','submitted_at','first_name','last_name','email','phone','summary',
  'facilitator_intent','what_pulled_you','twelve_months','current_work','tried_so_far','why_now','time_commitment','investment_readiness','call_commitment',
  'practitioner_type','clients_per_month','work_details','session_price',
  'utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id','gclid','fbclid','msclkid','campaign_id','adset_id','ad_id',
  'meta_campaign_id','meta_adset_id','meta_ad_id','h_ad_id','fbc_id','referrer','page_url','identity_persistence'];
const OUTCOMES = ['booking','not_facilitator','not_ready_to_invest','cannot_commit'];
export class InputError extends Error { constructor(message, status=400) { super(message); this.status=status; } }
export async function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid application');
  if (!/^aob-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.application_id || '')) throw new InputError('Invalid application ID');
  if (!['default','coaches'].includes(input.variant) || !OUTCOMES.includes(input.outcome)) throw new InputError('Invalid application version or outcome');
  const p = { application_id: input.application_id };
  for (const k of FIELDS) {
    if (input[k] != null && typeof input[k] !== 'string') throw new InputError('Invalid field type');
    const value = input[k] || '';
    if (value.length > (k==='summary' ? 20000 : 4000)) throw new InputError('Application field too long');
    p[k] = value;
  }
  p.email = p.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) || !p.first_name.trim() || !p.last_name.trim()) throw new InputError('Missing contact details');
  if (!Number.isFinite(Date.parse(p.submitted_at))) throw new InputError('Invalid submission date');
  p.source = p.variant==='coaches' ? 'facilitator-application-coaches' : 'facilitator-application';
  p.outcome_tag = 'fa-'+p.outcome.replaceAll('_','-');
  Object.assign(p, attribution(p));
  p.meta_event_name = 'SubmitApplication';
  p.meta_event_id = p.application_id+':SubmitApplication';
  p.qualified_lead_event_id = p.outcome==='booking' ? p.application_id+':Lead' : '';
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(p)));
  return { payload:p, hash:Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('') };
}
const now = () => new Date().toISOString();
const stmt = (db,sql,...args) => db.prepare(sql).bind(...args);
export async function receipt(db,id) {
  const row = await stmt(db,'SELECT application_id, received_at, ghl_contact_id, status, crm_state, workflow_state FROM facilitator_applications WHERE application_id = ?',id).first();
  if (!row) return null;
  const events = await stmt(db,'SELECT event_id,event_name,delivery_state FROM facilitator_application_events WHERE application_id = ? ORDER BY event_name',id).all();
  return { ...row, events:events.results };
}

// The database owns uniqueness. Duplicate delivery never repeats workflow enrollment.
// Uncertain workflow delivery fails closed for operator reconciliation; no blind replay.
export async function accept(db,input,adapters) {
  const {payload:p,hash} = await normalize(input); const t=now();
  await stmt(db,`INSERT INTO facilitator_applications
    (application_id,payload_hash,submitted_at,received_at,variant,outcome,application_lead_source,attribution_status,campaign_id,adset_id,ad_id,payload_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(application_id) DO NOTHING`,
    p.application_id,hash,p.submitted_at,t,p.variant,p.outcome,p.application_lead_source,p.attribution_status,p.meta_campaign_id,p.meta_adset_id,p.meta_ad_id,JSON.stringify(p),t).run();
  const row=await stmt(db,'SELECT * FROM facilitator_applications WHERE application_id = ?',p.application_id).first();
  if (row.payload_hash!==hash) throw new InputError('Application ID already belongs to different answers',409);
  // A process crash leaves processing visible; an operator must inspect the saved stages.
  const claim=await stmt(db,"UPDATE facilitator_applications SET status='processing',updated_at=? WHERE application_id=? AND status='received'",now(),p.application_id).run();
  if (!claim.meta.changes) return receipt(db,p.application_id);
  try {
    const contact=await adapters.contact(p);
    if (!contact || typeof contact.id!=='string' || !contact.id) throw new Error('crm_missing_contact');
    await stmt(db,"UPDATE facilitator_applications SET ghl_contact_id=?,crm_state='saved',updated_at=? WHERE application_id=?",contact.id,now(),p.application_id).run();
  } catch (e) {
    // Upsert can be retried safely by the operator after looking up the same email.
    await stmt(db,"UPDATE facilitator_applications SET status='needs_review',crm_state='uncertain',last_error='crm_not_confirmed',updated_at=? WHERE application_id=?",now(),p.application_id).run();
    return receipt(db,p.application_id);
  }
  // Commit the attempt before making a remote effect; retries cannot send it twice.
  await stmt(db,"UPDATE facilitator_applications SET workflow_state='attempting',workflow_attempted_at=?,updated_at=? WHERE application_id=?",now(),now(),p.application_id).run();
  try {
    const saved=await receipt(db,p.application_id);
    await adapters.workflow({...p,ghl_contact_id:saved.ghl_contact_id});
    await db.batch([
      stmt(db,"UPDATE facilitator_applications SET workflow_state='acknowledged',status='accepted',updated_at=? WHERE application_id=?",now(),p.application_id),
      stmt(db,'INSERT INTO facilitator_application_events(event_id,application_id,event_name) VALUES (?,?,?) ON CONFLICT(event_id) DO NOTHING',p.meta_event_id,p.application_id,'SubmitApplication'),
      ...(p.qualified_lead_event_id ? [stmt(db,'INSERT INTO facilitator_application_events(event_id,application_id,event_name) VALUES (?,?,?) ON CONFLICT(event_id) DO NOTHING',p.qualified_lead_event_id,p.application_id,'Lead')] : [])
    ]);
  } catch(e) {
    await stmt(db,"UPDATE facilitator_applications SET workflow_state='uncertain',status='needs_review',last_error='workflow_not_confirmed',updated_at=? WHERE application_id=?",now(),p.application_id).run();
  }
  return receipt(db,p.application_id);
}
