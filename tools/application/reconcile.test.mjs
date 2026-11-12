import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const app=(id,consent='granted',outcome='booking')=>({application_id:id,meta_consent:consent,outcome,status:'accepted',crm_state:'saved',workflow_state:'acknowledged',ghl_contact_id:'contact-'+id});
const event=(id,name,state='accepted')=>({application_id:id,event_id:id+':'+name,event_name:name,delivery_state:state,provider_receipt:JSON.stringify({test:true,events_received:1})});
function reconcile(report,observation){const dir=mkdtempSync(join(tmpdir(),'aob-reconcile-'));try{const file=join(dir,'report.json');writeFileSync(file,JSON.stringify({next:null,...report}));const args=[new URL('./reconcile.mjs',import.meta.url).pathname,file];if(observation){const meta=join(dir,'meta.json');writeFileSync(meta,JSON.stringify(observation));args.push('--meta-observations',meta);}const r=spawnSync(process.execPath,args,{encoding:'utf8'});return{code:r.status,result:r.stdout?JSON.parse(r.stdout):null,stderr:r.stderr};}finally{rmSync(dir,{recursive:true,force:true});}}
test('reconciliation proves both application and qualification parity and labels test receipts',()=>{
 const r=reconcile({applications:[app('one'),app('two','granted','not_facilitator')],events:[event('one','SubmitApplication'),event('one','Lead'),event('two','SubmitApplication')]});assert.equal(r.code,0);assert.equal(r.result.parity,true);assert.equal(r.result.receipt_mode,'test');assert.equal(r.result.meta_confirmed_application_events,2);assert.equal(r.result.meta_confirmed_qualified_events,1);
});
test('unconfirmed delivery and consent violations fail reconciliation',()=>{
 for(const report of [
  {applications:[app('one')],events:[event('one','SubmitApplication','pending'),event('one','Lead')]},
  {applications:[app('one','denied')],events:[event('one','SubmitApplication'),event('one','Lead')]},
  {applications:[app('one','unknown')],events:[]},
  {applications:[app('one','granted','not_facilitator')],events:[event('one','SubmitApplication'),event('one','Lead')]}
 ]){const r=reconcile(report);assert.equal(r.code,1);assert.equal(r.result.parity,false);}
});
test('consent exclusions stay visible and incomplete exports cannot claim parity',()=>{
 const r=reconcile({applications:[app('one'),app('two','denied','not_facilitator')],events:[event('one','SubmitApplication'),event('one','Lead')]});assert.equal(r.result.ghl_confirmed_applications,2);assert.equal(r.result.meta_eligible_ghl_applications,1);assert.equal(r.result.excluded_from_meta_by_consent,1);
 const partial=reconcile({next:'another-page',applications:[app('one')],events:[]});assert.notEqual(partial.code,0);assert.match(partial.stderr,/Incomplete pagination/);
});
const observations=(events,patch={})=>({source:'meta_test_events',dataset_id:'713374525487066',captured_at:'2026-11-12T12:00:00Z',evidence_reference:'fixture:synthetic-meta-ui-observation',cohort_application_ids:['one'],events:events.map(([id,name])=>({event_id:id+':'+name,event_name:name,status:'processed'})),...patch});
test('independent managed-CAPI observations can reconcile without inventing direct sender receipts',()=>{
 const report={applications:[app('one')],events:[event('one','SubmitApplication','pending'),event('one','Lead','pending')]};
 const r=reconcile(report,observations([['one','SubmitApplication'],['one','Lead']]));
 assert.equal(r.code,0);assert.equal(r.result.parity,true);assert.equal(r.result.evidence_mode,'independent_meta_test_events');assert.equal(r.result.receipt_mode,'test');assert.equal(r.result.parity_scope,'test_event_ids_in_declared_application_cohort');
 assert.equal(r.result.meta_confirmed_application_events,1);assert.match(r.result.meta_evidence.observation_sha256,/^[a-f0-9]{64}$/);assert.match(r.result.basis,/NOT production/);assert.equal(report.events[0].delivery_state,'pending');
});
test('independent observations still expose missing qualification and consent violations',()=>{
 const report={applications:[app('one')],events:[]};
 const missing=reconcile(report,observations([['one','SubmitApplication']]));assert.equal(missing.code,1);assert.ok(missing.result.gaps.some(g=>g.reason==='qualification_event_mismatch'));
 const denied=reconcile({applications:[app('one','denied')],events:[]},observations([['one','SubmitApplication'],['one','Lead']]));assert.equal(denied.code,1);assert.equal(denied.result.parity,false);
});
test('unscoped, browser-attempt, unprocessed, duplicate and inconsistent observations are rejected',()=>{
 const report={applications:[app('one')],events:[]};
 const valid=observations([['one','SubmitApplication'],['one','Lead']]);
 for(const invalid of [
  {...valid,dataset_id:'another-dataset'}, {...valid,captured_at:'invalid'}, {...valid,evidence_reference:''},
  {...valid,source:'browser_attempt'}, {...valid,cohort_application_ids:[]},
  {...valid,events:[{...valid.events[0],status:'queued'}]},
  {...valid,events:[valid.events[0],valid.events[0]]},
  {...valid,events:[{...valid.events[0],event_id:'other:SubmitApplication'}]},
  {...valid,events:[{...valid.events[0],event_id:'one:Lead'}]}
 ]){const r=reconcile(report,invalid);assert.notEqual(r.code,0);assert.equal(r.result,null);}
});
