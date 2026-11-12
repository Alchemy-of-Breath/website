import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const metaCode=readFileSync(new URL('../../assets/aob-application-meta.js',import.meta.url),'utf8');
const parentCode=readFileSync(new URL('../../assets/aob-application-consent.js',import.meta.url),'utf8');
function child(host='website-5h3.pages.dev') {
 const listeners={},calls=[],scripts=[],requests=[];const parent={postMessage:(...a)=>requests.push(a)};
 const root={parent,location:{hostname:host,search:'?embed_page=https%3A%2F%2Falchemyofbreath.com%2Ffacilitator-application%2F'},navigator:{},
  document:{referrer:'https://alchemyofbreath.com/facilitator-application/',createElement:()=>({}),head:{appendChild:s=>scripts.push(s)}},
  AoBApplication:{productionHost:h=>h==='website-5h3.pages.dev'},addEventListener:(name,fn)=>{listeners[name]=fn;},fbq:(...args)=>calls.push(args)};
 vm.runInNewContext(metaCode,{window:root,URL,URLSearchParams});
 return {root,calls,scripts,requests,consent:(status,origin='https://alchemyofbreath.com',source=parent)=>listeners.message({origin,source,data:{type:'aob:application:consent',status}})};
}
const payload={email:' Synthetic@Example.Invalid ',phone:'+44 7700 900123',first_name:'Synthetic',last_name:'Applicant'};
test('iframe sends no tracking until its actual trusted parent grants consent',()=>{
 const c=child();assert.equal(c.root.AoBMeta.initialize(payload),false);assert.equal(c.calls.length,0);
 c.consent('granted','https://evil.invalid');assert.equal(c.root.AoBMeta.initialize(payload),false);
 c.consent('granted','https://alchemyofbreath.com',{});assert.equal(c.root.AoBMeta.initialize(payload),false);
 c.consent('granted');assert.equal(c.root.AoBMeta.initialize(payload),true);
 const init=c.calls.find(x=>x[0]==='init');assert.equal(init[1],'713374525487066');assert.equal(init[2].em,'synthetic@example.invalid');assert.equal(init[2].ph,'447700900123');
 assert.equal(c.root.AoBMeta.initialize(payload),true);assert.equal(c.calls.filter(x=>x[0]==='init').length,1);
 c.consent('denied');assert.equal(c.root.AoBMeta.initialize(payload),false);assert.ok(c.calls.some(x=>x[0]==='consent'&&x[1]==='revoke'));
});
test('GPC and preview hosts cannot initialize matching even after a valid grant',()=>{
 const c=child();c.consent('granted');c.root.navigator.globalPrivacyControl=true;assert.equal(c.root.AoBMeta.initialize(payload),false);assert.equal(c.root.AoBMeta.consent(),'denied');
 const preview=child('preview.website-5h3.pages.dev');preview.consent('granted');assert.equal(preview.root.AoBMeta.initialize(payload),false);
});
test('the SDK loads only when granted and the init includes manual matching fields',()=>{
 const c=child();delete c.root.fbq;assert.equal(c.root.AoBMeta.initialize(payload),false);assert.equal(c.scripts.length,0);
 c.consent('granted');assert.equal(c.root.AoBMeta.initialize(payload),true);assert.equal(c.scripts.length,1);assert.equal(c.scripts[0].src,'https://connect.facebook.net/en_US/fbevents.js');
 assert.deepEqual(Array.from(c.root.fbq.queue[0]),['set','autoConfig',false,'713374525487066']);
 assert.deepEqual(Array.from(c.root.fbq.queue[1]),['optinMetaEnabledCapi','713374525487066']);
 assert.equal(c.root.fbq.queue[2][0],'init');assert.equal(c.root.fbq.queue[2][2].em,'synthetic@example.invalid');
});
function bridge(preferences,manual=false,gpc=false) {
 const windowEvents={},documentEvents={},sent=[];const child={postMessage:(data,origin)=>sent.push({data,origin})};
 const frame={src:'https://website-5h3.pages.dev/facilitator-application/',contentWindow:child,addEventListener:(name,fn)=>{documentEvents['frame:'+name]=fn;}};
 const root={WPConsent:{lastPreferences:preferences,registerListener:fn=>{root.listener=fn;},shouldUnlockContent:(prefs,service,category)=>manual&&prefs[service]!==undefined?prefs[service]:prefs[category]===true},addEventListener:(name,fn)=>{windowEvents[name]=fn;}};
 const document={readyState:'complete',getElementById:id=>id==='aob-fa-frame'?frame:null,addEventListener:(name,fn)=>{documentEvents[name]=fn;}};
 vm.runInNewContext(parentCode,{window:root,document,location:{origin:'https://alchemyofbreath.com'},navigator:{globalPrivacyControl:gpc},URL});
 return {root,sent,frame,request:(origin,source=child)=>windowEvents.message({origin,source,data:{type:'aob:application:consent-request'}})};
}
test('WordPress bridge respects marketing, per-service refusal, GPC and actual iframe origin',()=>{
 assert.equal(bridge({marketing:true}).sent[0].data.status,'granted');
 assert.equal(bridge({marketing:true,'facebook-pixel':false},true).sent[0].data.status,'denied');
 assert.equal(bridge({marketing:true},false,true).sent[0].data.status,'denied');
 assert.equal(bridge(null).sent[0].data.status,'unknown');
 const c=bridge({marketing:true});const n=c.sent.length;c.request('https://evil.invalid');c.request('https://website-5h3.pages.dev',{});assert.equal(c.sent.length,n);
 c.request('https://website-5h3.pages.dev');assert.equal(c.sent.length,n+1);assert.equal(c.sent.at(-1).origin,'https://website-5h3.pages.dev');
 c.frame.src='https://website-5h3.pages.dev.evil.invalid/';c.request('https://website-5h3.pages.dev');assert.equal(c.sent.length,n+1);
});
