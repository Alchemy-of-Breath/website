// Private operational export. Contact IDs and attribution metadata only, no answers.
export async function onRequestGet({request,env}) {
 const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
 if(!env.APPLICATION_REPORT_TOKEN || env.APPLICATION_REPORT_TOKEN.length<32 || !env.APPLICATIONS_DB)return json({error:'Report not configured'},503);
 const given=request.headers.get('Authorization')||'';
 const hash=async x=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)));
 const a=await hash(given),b=await hash('Bearer '+env.APPLICATION_REPORT_TOKEN);let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];
 if(mismatch)return json({error:'Unauthorized'},401);
 const u=new URL(request.url);const from=u.searchParams.get('from'),to=u.searchParams.get('to');
 if(!from||!to||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(from)>=Date.parse(to)||Date.parse(to)>Date.now())return json({error:'Use an inclusive from and exclusive to ISO timestamp'},400);
 const after=u.searchParams.get('after')||'';
 const rows=await env.APPLICATIONS_DB.prepare(`SELECT application_id,submitted_at,received_at,variant,outcome,application_lead_source,attribution_status,campaign_id,adset_id,ad_id,ghl_contact_id,status,crm_state,workflow_state,meta_consent FROM facilitator_applications WHERE received_at >= ? AND received_at < ? AND application_id > ? ORDER BY application_id LIMIT 201`).bind(new Date(from).toISOString(),new Date(to).toISOString(),after).all();
 const page=rows.results.slice(0,200);
 const eventRows=await env.APPLICATIONS_DB.prepare(`SELECT event_id,event_name,delivery_state,accepted_at,browser_attempted_at,provider_receipt,application_id FROM facilitator_application_events WHERE application_id IN (SELECT application_id FROM facilitator_applications WHERE received_at >= ? AND received_at < ? AND application_id > ? ORDER BY application_id LIMIT 200)`).bind(new Date(from).toISOString(),new Date(to).toISOString(),after).all();
 const events=eventRows.results;
 return json({from:new Date(from).toISOString(),to_exclusive:new Date(to).toISOString(),basis:'server_received_at',applications:page,events,next:rows.results.length>200?page.at(-1).application_id:null});
}
