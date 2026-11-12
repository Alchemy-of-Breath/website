// Browser dispatch is an attempt receipt, never proof Meta received the event.
export async function onRequestPost({request,env}) {
  const reply=(body,status)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if (request.headers.get('Origin')!==new URL(request.url).origin) return reply({error:'Invalid origin'},403);
  if (!env.APPLICATIONS_DB) return reply({error:'Not configured'},503);
  let p;try{const text=await request.text();if(text.length>2048)return reply({error:'Too large'},413);p=JSON.parse(text);}catch{return reply({error:'Invalid JSON'},400);}
  if (!/^aob-[0-9a-f-]{36}$/.test(p.application_id||'') || !Array.isArray(p.events) || p.events.length>2) return reply({error:'Invalid receipt'},400);
  for(const id of p.events) {
    // Leave CAPI's provider state intact. Browser attempts cannot mark an event accepted.
    await env.APPLICATIONS_DB.prepare('UPDATE facilitator_application_events SET browser_attempted_at=COALESCE(browser_attempted_at,?) WHERE application_id=? AND event_id=?').bind(new Date().toISOString(),p.application_id,String(id)).run();
  }
  return reply({ok:true},200);
}
