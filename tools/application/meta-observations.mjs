import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Operator observations from Meta Test Events are independent of our sender.
// Never infer acceptance from fbq calls, browser requests, or Ads Manager totals.
export function readMetaObservations(file, applications) {
  const raw=readFileSync(file,'utf8'), observation=JSON.parse(raw);
  if(observation.source!=='meta_test_events' || observation.dataset_id!=='713374525487066' ||
     !Number.isFinite(Date.parse(observation.captured_at)) ||
     typeof observation.evidence_reference!=='string' || !observation.evidence_reference.trim()) {
    throw new Error('Meta observations require the expected dataset, capture time and independent Test Events evidence reference');
  }
  const cohort=observation.cohort_application_ids;
  if(!Array.isArray(cohort) || new Set(cohort).size!==cohort.length ||
     cohort.length!==applications.length || applications.some(a=>!cohort.includes(a.application_id))) {
    throw new Error('Meta observation cohort must match every application in the complete CRM export');
  }
  if(!Array.isArray(observation.events))throw new Error('Meta observations require an events array');
  const seen=new Set();
  const events=observation.events.map(e=>{
    if(!['SubmitApplication','Lead'].includes(e.event_name) ||
       typeof e.event_id!=='string' || e.status!=='processed') {
      throw new Error('Only independently observed processed application/qualification events are accepted');
    }
    const suffix=':'+e.event_name, id=e.event_id.endsWith(suffix)?e.event_id.slice(0,-suffix.length):'';
    if(!cohort.includes(id) || seen.has(e.event_id))throw new Error('Unknown, inconsistent or duplicate observed Meta event ID');
    seen.add(e.event_id);
    return {application_id:id,event_id:e.event_id,event_name:e.event_name,delivery_state:'accepted',
      provider_receipt:JSON.stringify({test:true,source:observation.source})};
  });
  return {events, evidence:{source:observation.source,dataset_id:observation.dataset_id,
    captured_at:observation.captured_at,evidence_reference:observation.evidence_reference,
    observation_sha256:createHash('sha256').update(raw).digest('hex'),
    trust_basis:'operator-recorded independent Meta Test Events observation; evidence reference requires human review'}};
}
