// Input is a merged, fully paginated /api/application/report JSON export.
// These are provider receipt counts, not Ads Manager attribution counts.
import {readFileSync} from 'node:fs';
import {readMetaObservations} from './meta-observations.mjs';
const file=process.argv[2];if(!file || (process.argv.length>3 && (process.argv.length!==5 || process.argv[3]!=='--meta-observations')))throw new Error('Usage: node tools/application/reconcile.mjs report.json [--meta-observations observed-test-events.json]');
const report=JSON.parse(readFileSync(file,'utf8'));
if(report.next)throw new Error('Incomplete pagination: export all report pages first');
const apps=report.applications||[],outboxEvents=report.events||[];
const observed=process.argv[4]?readMetaObservations(process.argv[4],apps):null;
const events=observed?observed.events:outboxEvents;
if(new Set(apps.map(x=>x.application_id)).size!==apps.length)throw new Error('Duplicate application rows');
if(new Set(events.map(x=>x.event_id)).size!==events.length)throw new Error('Duplicate event rows');
const accepted=apps.filter(x=>x.status==='accepted'&&x.ghl_contact_id&&x.crm_state==='saved'&&x.workflow_state==='acknowledged');
const eligible=accepted.filter(x=>x.meta_consent==='granted');
const applications=events.filter(x=>x.event_name==='SubmitApplication');
const gaps=[];
for(const app of eligible){const e=applications.filter(x=>x.application_id===app.application_id);if(e.length!==1||e[0].delivery_state!=='accepted')gaps.push({application_id:app.application_id,reason:e.length!==1?'missing_or_duplicate_application_event':'meta_not_confirmed'});}
for(const app of eligible){const leads=events.filter(x=>x.application_id===app.application_id&&x.event_name==='Lead');if(app.outcome==='booking'?(leads.length!==1||leads[0].delivery_state!=='accepted'):leads.length!==0)gaps.push({application_id:app.application_id,reason:'qualification_event_mismatch'});}
for(const event of applications)if(event.delivery_state==='accepted'&&!eligible.some(x=>x.application_id===event.application_id))gaps.push({event_id:event.event_id,reason:'event_without_confirmed_application'});
for(const app of apps)if(!accepted.some(x=>x.application_id===app.application_id))gaps.push({application_id:app.application_id,reason:'crm_or_workflow_not_confirmed'});
for(const event of events)if(event.event_name==='Lead'&&event.delivery_state==='accepted'&&!eligible.some(x=>x.application_id===event.application_id&&x.outcome==='booking'))gaps.push({event_id:event.event_id,reason:'lead_without_eligible_qualified_application'});
const receiptModes=new Set(events.filter(x=>x.delivery_state==='accepted').map(x=>{try{return JSON.parse(x.provider_receipt).test===true?'test':JSON.parse(x.provider_receipt).test===false?'live':'unknown';}catch{return 'unknown';}}));
const receiptMode=receiptModes.size===1?[...receiptModes][0]:receiptModes.size?'mixed':'none';
const result={receipt_mode:receiptMode,evidence_mode:observed?'independent_meta_test_events':'direct_capi_receipts',
 parity_scope:observed?'test_event_ids_in_declared_application_cohort':'provider_receipts_in_application_cohort',
 basis:observed?'independently observed processed Meta Test Events IDs; NOT production or Ads Manager attributed results':'application IDs and CAPI provider acceptance receipts; NOT Ads Manager attributed results',
 ...(observed?{meta_evidence:observed.evidence}:{}),
 ghl_confirmed_applications:accepted.length,meta_eligible_ghl_applications:eligible.length,excluded_from_meta_by_consent:accepted.length-eligible.length,distinct_ghl_contacts:new Set(accepted.map(x=>x.ghl_contact_id)).size,meta_confirmed_application_events:applications.filter(x=>x.delivery_state==='accepted').length,qualified_applications:eligible.filter(x=>x.outcome==='booking').length,meta_confirmed_qualified_events:events.filter(x=>x.event_name==='Lead'&&x.delivery_state==='accepted').length,unconfirmed_applications:apps.length-accepted.length,parity:gaps.length===0&&eligible.length>0&&accepted.length===apps.length,gaps};
console.log(JSON.stringify(result,null,2));if(!result.parity)process.exitCode=1;
