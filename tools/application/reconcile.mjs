// Input is a merged, fully paginated /api/application/report JSON export.
// These are provider receipt counts, not Ads Manager attribution counts.
import {readFileSync} from 'node:fs';
const file=process.argv[2];if(!file)throw new Error('Usage: node tools/application/reconcile.mjs report.json');
const report=JSON.parse(readFileSync(file,'utf8'));
if(report.next)throw new Error('Incomplete pagination: export all report pages first');
const apps=report.applications||[],events=report.events||[];
if(new Set(apps.map(x=>x.application_id)).size!==apps.length)throw new Error('Duplicate application rows');
if(new Set(events.map(x=>x.event_id)).size!==events.length)throw new Error('Duplicate event rows');
const accepted=apps.filter(x=>x.status==='accepted'&&x.ghl_contact_id&&x.crm_state==='saved'&&x.workflow_state==='acknowledged');
const applications=events.filter(x=>x.event_name==='SubmitApplication');
const gaps=[];
for(const app of accepted){const e=applications.filter(x=>x.application_id===app.application_id);if(e.length!==1||e[0].delivery_state!=='accepted')gaps.push({application_id:app.application_id,reason:e.length!==1?'missing_or_duplicate_application_event':'meta_not_confirmed'});}
for(const app of accepted){const leads=events.filter(x=>x.application_id===app.application_id&&x.event_name==='Lead');if(app.outcome==='booking'?(leads.length!==1||leads[0].delivery_state!=='accepted'):leads.length!==0)gaps.push({application_id:app.application_id,reason:'qualification_event_mismatch'});}
for(const event of applications)if(!accepted.some(x=>x.application_id===event.application_id))gaps.push({event_id:event.event_id,reason:'event_without_confirmed_application'});
const result={basis:'application IDs and CAPI provider acceptance receipts; NOT Ads Manager attributed results',ghl_confirmed_applications:accepted.length,distinct_ghl_contacts:new Set(accepted.map(x=>x.ghl_contact_id)).size,meta_confirmed_application_events:applications.filter(x=>x.delivery_state==='accepted').length,qualified_applications:accepted.filter(x=>x.outcome==='booking').length,meta_confirmed_qualified_events:events.filter(x=>x.event_name==='Lead'&&x.delivery_state==='accepted').length,unconfirmed_applications:apps.length-accepted.length,parity:gaps.length===0&&accepted.length>0&&accepted.length===apps.length,gaps};
console.log(JSON.stringify(result,null,2));if(!result.parity)process.exitCode=1;
