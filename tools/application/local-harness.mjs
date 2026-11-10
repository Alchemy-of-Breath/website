// Local integration fixture. Runs the production receiver with persistent SQLite
// and explicit fake GHL/Meta providers. NEVER use this as a production server.
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {onRequestPost as submit} from '../../functions/api/application/submit.js';
import {onRequestPost as events} from '../../functions/api/application/events.js';
const root=resolve(new URL('../..',import.meta.url).pathname);
const filename=process.env.APPLICATION_TEST_DB;
if(!filename)throw new Error('APPLICATION_TEST_DB must name a private test database');
const sql=new DatabaseSync(filename);
sql.exec('CREATE TABLE IF NOT EXISTS fixture_migrations (name TEXT PRIMARY KEY)');
for(const name of readdirSync(resolve(root,'migrations')).filter(n=>n.endsWith('.sql')).sort()) {
 if(!sql.prepare('SELECT name FROM fixture_migrations WHERE name=?').get(name)) {
  sql.exec('BEGIN');try{sql.exec(readFileSync(resolve(root,'migrations',name),'utf8'));sql.prepare('INSERT INTO fixture_migrations VALUES (?)').run(name);sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}
 }
}
sql.exec('CREATE TABLE IF NOT EXISTS fixture_requests (kind TEXT, body TEXT); CREATE TABLE IF NOT EXISTS fixture_contacts (id TEXT PRIMARY KEY, email TEXT UNIQUE, source TEXT, fields TEXT)');
const db={prepare(query){return{bind(...args){const s=sql.prepare(query);return{first:async()=>s.get(...args)||null,all:async()=>({results:s.all(...args)}),run:async()=>({meta:{changes:Number(s.run(...args).changes)}})};}};},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
const env={APPLICATIONS_DB:db,APPLICATION_GHL_TOKEN:'LOCAL-FAKE-TOKEN',APPLICATION_GHL_LOCATION_ID:'local-test-location',APPLICATION_GHL_WEBHOOK_URL:'https://services.leadconnectorhq.com/hooks/local-test-location/webhook-trigger/local-test',APPLICATION_META_CAPI_ENABLED:'true',APPLICATION_META_TOKEN:'LOCAL-FAKE-META',APPLICATION_META_PIXEL_ID:'713374525487066',APPLICATION_META_API_VERSION:'v26.0',APPLICATION_META_TEST_EVENT_CODE:'LOCAL_TEST_ONLY'};
globalThis.fetch=async(url,opts={})=>{
 const u=new URL(url);const body=opts.body?JSON.parse(opts.body):null;
 if(u.origin==='https://services.leadconnectorhq.com'){
  if(u.pathname==='/contacts/upsert'){
   sql.prepare('INSERT INTO fixture_requests VALUES (?,?)').run('crm_upsert',JSON.stringify(body));
   let c=sql.prepare('SELECT * FROM fixture_contacts WHERE email=?').get(body.email);
   if(!c){c={id:'local-contact-'+crypto.randomUUID(),email:body.email,source:'',fields:'[]'};sql.prepare('INSERT INTO fixture_contacts VALUES (?,?,?,?)').run(c.id,c.email,c.source,c.fields);}
   return Response.json({contact:{id:c.id}});
  }
  if(u.pathname.startsWith('/contacts/')){
   const id=u.pathname.split('/').at(-1);const c=sql.prepare('SELECT * FROM fixture_contacts WHERE id=?').get(id);
   if(opts.method==='PUT')sql.prepare('UPDATE fixture_contacts SET source=?,fields=? WHERE id=?').run(body.source||c.source,body.customFields?JSON.stringify(body.customFields.map(f=>({id:f.id,value:f.field_value}))):c.fields,id);
   const updated=sql.prepare('SELECT * FROM fixture_contacts WHERE id=?').get(id);
   return Response.json({contact:{id,email:updated.email,source:updated.source,customFields:JSON.parse(updated.fields)}});
  }
  if(u.pathname.startsWith('/hooks/')){sql.prepare('INSERT INTO fixture_requests VALUES (?,?)').run('workflow',JSON.stringify(body));return Response.json({ok:true});}
 }
 if(u.origin==='https://graph.facebook.com'){
  sql.prepare('INSERT INTO fixture_requests VALUES (?,?)').run('meta',JSON.stringify(body));return Response.json({events_received:1,fbtrace_id:'LOCAL-FAKE-RECEIPT'});
 }
 throw new Error('Fixture refused unexpected external network request');
};
http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://127.0.0.1:8797');
  if(req.method==='POST' && ['/api/application/submit','/api/application/events'].includes(u.pathname)){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const request=new Request(u,{method:'POST',headers:req.headers,body:Buffer.concat(chunks)});
   const response=await(u.pathname.endsWith('/submit')?submit:events)({request,env});
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  if(u.pathname==='/__fixture/summary'){
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({applications:sql.prepare('SELECT application_id,variant,outcome,application_lead_source,attribution_status,ghl_contact_id,status FROM facilitator_applications').all(),events:sql.prepare('SELECT * FROM facilitator_application_events').all(),requests:sql.prepare('SELECT kind,count(*) AS count FROM fixture_requests GROUP BY kind').all()}));return;
  }
  const path=resolve(root,'.'+decodeURIComponent(u.pathname)+(u.pathname.endsWith('/')?'index.html':''));
  if(!path.startsWith(root+'/') || !existsSync(path)){res.writeHead(404);res.end('Not found');return;}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(path)]||'application/octet-stream');res.end(readFileSync(path));
 }catch(e){console.error('Fixture error',e.message);res.writeHead(500);res.end('Local fixture error');}
}).listen(8797,'127.0.0.1',()=>console.log('Local fixture http://127.0.0.1:8797; fake external providers; SQLite '+filename));
