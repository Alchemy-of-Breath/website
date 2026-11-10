import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const app=(id,consent='granted',outcome='booking')=>({application_id:id,meta_consent:consent,outcome,status:'accepted',crm_state:'saved',workflow_state:'acknowledged',ghl_contact_id:'contact-'+id});
const event=(id,name,state='accepted')=>({application_id:id,event_id:id+':'+name,event_name:name,delivery_state:state,provider_receipt:JSON.stringify({test:true,events_received:1})});
function reconcile(report){const dir=mkdtempSync(join(tmpdir(),'aob-reconcile-'));try{const file=join(dir,'report.json');writeFileSync(file,JSON.stringify({next:null,...report}));const r=spawnSync(process.execPath,[new URL('./reconcile.mjs',import.meta.url).pathname,file],{encoding:'utf8'});return{code:r.status,result:r.stdout?JSON.parse(r.stdout):null,stderr:r.stderr};}finally{rmSync(dir,{recursive:true,force:true});}}
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
