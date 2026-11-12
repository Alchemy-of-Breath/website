import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {accept,normalize,receipt} from '../../application-lib/receiver.js';
import {providers,deliverMeta} from '../../application-lib/providers.js';
import {attribution} from '../../application-lib/attribution.js';
import {onRequestPost} from '../../functions/api/application/submit.js';
function database() {
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../../migrations/0001_applications.sql',import.meta.url),'utf8'));sql.exec(readFileSync(new URL('../../migrations/0002_meta_consent.sql',import.meta.url),'utf8'));
  const prepare=query=>({bind(...args){const st=sql.prepare(query);return {
    first:async()=>st.get(...args)||null,
    all:async()=>({results:st.all(...args)}),
    run:async()=>({meta:{changes:Number(st.run(...args).changes)}})
  };}});
  return {prepare,batch:async statements=>{sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}},sql};
}
const input=(extra={})=>({application_id:'aob-'+crypto.randomUUID(),submitted_at:'2026-11-10T12:00:00Z',variant:'default',meta_consent:'granted',source:'facilitator-application',outcome:'booking',email:'synthetic@example.invalid',first_name:'Synthetic',last_name:'Application',utm_source:'facebook',utm_medium:'ppc',utm_id:'120254405385540483',utm_term:'120254405387700483',...extra});
const adapters=()=>{const counts={contact:0,workflow:0};return {counts,contact:async()=>{counts.contact++;return{id:'ghl-test-contact'};},workflow:async()=>{counts.workflow++;}};};

test('concurrent retries create one durable application, one workflow effect and stable event IDs',async()=>{
 const db=database(),p=input(),api=adapters();await Promise.all(Array.from({length:25},()=>accept(db,p,api)));
 const got=await receipt(db,p.application_id);
 assert.equal(got.status,'accepted');assert.equal(got.ghl_contact_id,'ghl-test-contact');assert.deepEqual(api.counts,{contact:1,workflow:1});
 assert.equal(db.sql.prepare('SELECT count(*) AS n FROM facilitator_applications').get().n,1);
 assert.deepEqual(got.events.map(x=>x.event_id).sort(),[p.application_id+':Lead',p.application_id+':SubmitApplication'].sort());
 await accept(db,p,api);assert.equal(api.counts.workflow,1);
 await assert.rejects(accept(db,{...p,email:'different@example.invalid'},api),e=>e.status===409);
});

test('both variants share application and qualification definitions, rejected applications still count once',async()=>{
 const db=database();for(const variant of ['default','coaches'])for(const outcome of ['booking','not_facilitator','not_ready_to_invest','cannot_commit']) await accept(db,input({variant,outcome}),adapters());
 assert.equal(db.sql.prepare("SELECT count(*) AS n FROM facilitator_applications WHERE status='accepted'").get().n,8);
 assert.equal(db.sql.prepare("SELECT count(*) AS n FROM facilitator_application_events WHERE event_name='SubmitApplication'").get().n,8);
 assert.equal(db.sql.prepare("SELECT count(*) AS n FROM facilitator_application_events WHERE event_name='Lead'").get().n,2);
});

test('ambiguous webhook delivery is visible and never blindly enrolled twice',async()=>{
 const db=database(),p=input(),api=adapters();api.workflow=async()=>{api.counts.workflow++;throw new Error('response lost after remote enrollment');};
 const r=await accept(db,p,api);assert.equal(r.status,'needs_review');assert.equal(r.crm_state,'saved');assert.equal(r.workflow_state,'uncertain');assert.equal(r.events.length,0);
 await accept(db,p,api);assert.equal(api.counts.workflow,1);
});

test('a missing CRM confirmation produces no workflow and no conversion',async()=>{
 const db=database(),p=input(),api=adapters();api.contact=async()=>({});
 const r=await accept(db,p,api);assert.equal(r.status,'needs_review');assert.equal(r.events.length,0);assert.equal(api.counts.workflow,0);
});

test('today\'s Meta parameters, future sources and unknown attribution are kept distinct',async()=>{
 for(const [source,medium] of [['facebook','ppc'],['facebook','paid'],['meta','paid_social'],['meta-ads','paid_social']]) {
  const {payload}=await normalize(input({utm_source:source,utm_medium:medium}));assert.equal(payload.application_lead_source,'Meta Ads');assert.equal(payload.meta_campaign_id,'120254405385540483');assert.equal(payload.meta_adset_id,'120254405387700483');
 }
 for(const source of ['newsletter','google','partner'])assert.equal(attribution({utm_source:source,utm_medium:'email'}).application_lead_source,source);
 const unknown=attribution({fbclid:'a-click-id',utm_id:'120254405385540483'});assert.equal(unknown.application_lead_source,'Unknown');assert.equal(unknown.meta_campaign_id,'');
 assert.equal(attribution({utm_source:'facebook',utm_medium:'organic'}).application_lead_source,'Social Direct');
});

test('receiver derives event IDs and source itself, refusing malformed identity or structure',async()=>{
 const {payload}=await normalize(input({application_lead_source:'Meta Ads',utm_source:'newsletter',utm_medium:'email',meta_event_id:'spoofed'}));
 assert.equal(payload.application_lead_source,'newsletter');assert.equal(payload.meta_event_id,payload.application_id+':SubmitApplication');
 for(const patch of [{application_id:'not-a-uuid'},{variant:'other'},{outcome:'other'},{email:{}},{summary:'x'.repeat(20001)}]) await assert.rejects(normalize(input(patch)));
});

test('provider uses returned GHL ID, preserves existing acquisition sources, and verifies email match',async()=>{
 const writes=[];const fetcher=async(url,opts)=>{
  writes.push([String(url),opts]);
  if(String(url).endsWith('/upsert'))return Response.json({contact:{id:'real-provider-contact'}});
  return Response.json({contact:{id:'real-provider-contact',email:'synthetic@example.invalid',source:'Existing referral',customFields:[{id:'AUBprKjRLgm29DPO3nU6',value:'Referral'}]}});
 };
 const result=await providers({APPLICATION_GHL_TOKEN:'fake',APPLICATION_GHL_LOCATION_ID:'loc'},fetcher).contact((await normalize(input())).payload);
 assert.equal(result.id,'real-provider-contact');assert.equal(writes.length,2);assert.equal(JSON.parse(writes[0][1].body).source,undefined);assert.equal(JSON.parse(writes[0][1].body).phone,undefined);
});

test('blank acquisition source captures paid Meta; unknown attribution leaves it blank',async()=>{
 for(const unknown of [false,true]){
  const writes=[];const fetcher=async(url,opts)=>{writes.push([String(url),opts]);if(String(url).endsWith('/upsert'))return Response.json({contact:{id:'contact'}});return Response.json({contact:{id:'contact',email:'synthetic@example.invalid',customFields:[]}});};
  await providers({APPLICATION_GHL_TOKEN:'fake',APPLICATION_GHL_LOCATION_ID:'loc'},fetcher).contact((await normalize(input(unknown?{utm_source:'',utm_medium:''}:{}))).payload);
  assert.equal(writes.length,unknown?2:3);if(!unknown){const body=JSON.parse(writes[2][1].body);assert.equal(body.source,'Meta Ads');assert.equal(body.customFields[0].field_value,'Meta Ads');}
 }
});

test('CAPI and browser use identical event IDs; provider acceptance is recorded and duplicate delivery is suppressed',async()=>{
 const db=database(),p=input(),api=adapters();await accept(db,p,api);const {payload}=await normalize(p);const sent=[];
 const env={APPLICATION_META_CAPI_ENABLED:'true',APPLICATION_META_TOKEN:'synthetic-token',APPLICATION_META_PIXEL_ID:'713374525487066',APPLICATION_META_API_VERSION:'v26.0',APPLICATION_META_TEST_EVENT_CODE:'TEST_SYNTHETIC'};
 const fetcher=async(url,opts)=>{sent.push(JSON.parse(opts.body));return Response.json({events_received:1,fbtrace_id:'test-receipt'});};
 await Promise.all([deliverMeta(db,payload,env,fetcher),deliverMeta(db,payload,env,fetcher)]);
 assert.equal(sent.length,2);assert.equal(sent.filter(x=>x.data[0].event_name==='SubmitApplication').length,1);
 assert.deepEqual(sent.map(x=>x.data[0].event_id).sort(),[payload.meta_event_id,payload.qualified_lead_event_id].sort());
 for(const x of sent){assert.equal(x.test_event_code,'TEST_SYNTHETIC');assert.match(x.data[0].user_data.em[0],/^[0-9a-f]{64}$/);}
 assert.equal((await receipt(db,p.application_id)).events.filter(x=>x.delivery_state==='accepted').length,2);
});

test('Meta failure does not erase an application or pretend parity',async()=>{
 const db=database(),p=input();await accept(db,p,adapters());const {payload}=await normalize(p);
 await deliverMeta(db,payload,{APPLICATION_META_CAPI_ENABLED:'true',APPLICATION_META_TOKEN:'fake',APPLICATION_META_PIXEL_ID:'123',APPLICATION_META_API_VERSION:'v26.0'},async()=>{throw new Error('timeout');});
 const r=await receipt(db,p.application_id);assert.equal(r.status,'accepted');assert.ok(r.events.every(x=>x.delivery_state==='uncertain'));
});

test('public endpoint rejects cross-origin posts and fails closed without deployment bindings',async()=>{
 const env={};assert.equal((await onRequestPost({request:new Request('https://example.invalid/api/application/submit',{method:'POST',headers:{Origin:'https://other.invalid','Content-Type':'application/json'},body:'{}'}),env})).status,403);
 assert.equal((await onRequestPost({request:new Request('https://example.invalid/api/application/submit',{method:'POST',headers:{Origin:'https://example.invalid','Content-Type':'application/json'},body:'{}'}),env})).status,503);
});

test('private report enforces authorization, excludes answers and paginates every application',async()=>{
 const {onRequestGet}=await import('../../functions/api/application/report.js');
 const db=database();const env={APPLICATIONS_DB:db,APPLICATION_REPORT_TOKEN:'local-report-secret-'.repeat(3)};
 for(let i=0;i<201;i++)await accept(db,input(),adapters());
 db.sql.exec("UPDATE facilitator_applications SET received_at='2020-01-01T12:00:00.000Z'");
 const url='https://example.invalid/api/application/report?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z';
 assert.equal((await onRequestGet({request:new Request(url),env})).status,401);
 const read=async suffix=>(await onRequestGet({request:new Request(url+suffix,{headers:{Authorization:'Bearer '+env.APPLICATION_REPORT_TOKEN}}),env})).json();
 const first=await read('');assert.equal(first.applications.length,200);assert.ok(first.next);assert.equal(first.events.length,400);
 const second=await read('&after='+encodeURIComponent(first.next));assert.equal(second.applications.length,1);assert.equal(second.next,null);
 assert.equal(new Set([...first.applications,...second.applications].map(x=>x.application_id)).size,201);
 assert.ok(!JSON.stringify(first).includes('synthetic@example.invalid'));assert.ok(!JSON.stringify(first).includes('payload_json'));
});

test('a newly created contact captures paid Meta even if GHL supplies an API default source',async()=>{
 const writes=[];const fetcher=async(url,opts)=>{writes.push([String(url),opts]);if(String(url).endsWith('/upsert'))return Response.json({new:true,contact:{id:'new-contact'}});return Response.json({contact:{id:'new-contact',email:'synthetic@example.invalid',source:'API',customFields:[]}});};
 await providers({APPLICATION_GHL_TOKEN:'fake',APPLICATION_GHL_LOCATION_ID:'loc'},fetcher).contact((await normalize(input())).payload);
 assert.equal(JSON.parse(writes.at(-1)[1].body).source,'Meta Ads');
});

test('consent changes keep the application ID and workflow effect but stop CAPI delivery',async()=>{
 const db=database(),p=input({meta_consent:'unknown'}),api=adapters();await accept(db,p,api);
 let sent=0;const fetcher=async()=>{sent++;return Response.json({events_received:1});};
 const env={APPLICATION_META_CAPI_ENABLED:'true',APPLICATION_META_TOKEN:'fake',APPLICATION_META_PIXEL_ID:'123',APPLICATION_META_API_VERSION:'v26.0'};
 await deliverMeta(db,(await normalize(p)).payload,env,fetcher);assert.equal(sent,0);
 await accept(db,{...p,meta_consent:'denied'},api);assert.equal(api.counts.workflow,1);assert.equal((await receipt(db,p.application_id)).meta_consent,'denied');
 await deliverMeta(db,(await normalize(p)).payload,env,fetcher);assert.equal(sent,0);
 await accept(db,{...p,meta_consent:'granted'},api);assert.equal(api.counts.workflow,1);
 await deliverMeta(db,(await normalize(p)).payload,env,fetcher);assert.equal(sent,2);
});
