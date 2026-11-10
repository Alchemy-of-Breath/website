const GHL = 'https://services.leadconnectorhq.com';
const LEAD_SOURCE_FIELD = 'AUBprKjRLgm29DPO3nU6';
const iso = () => new Date().toISOString();
const deadline = () => AbortSignal.timeout(8000);
async function sha(value) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export function providers(env,fetcher=fetch) {
  async function ghl(path,method='GET',body) {
    const response=await fetcher(GHL+path,{method,headers:{Authorization:'Bearer '+env.APPLICATION_GHL_TOKEN,Version:'v3','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:deadline()});
    if (!response.ok) throw new Error('ghl_'+response.status);
    return response.json();
  }
  return {
    async contact(p) {
      // Resolve by email, not a possibly shared phone number. Then verify the returned identity.
      const result=await ghl('/contacts/upsert','POST',{locationId:env.APPLICATION_GHL_LOCATION_ID,email:p.email,firstName:p.first_name,lastName:p.last_name});
      const id=result.contact?.id;
      if (!id) throw new Error('ghl_missing_id');
      const {contact}=await ghl('/contacts/'+encodeURIComponent(id));
      if (!contact || contact.email?.trim().toLowerCase()!==p.email) throw new Error('ghl_identity_mismatch');
      // Preserve original acquisition source. Application source is kept in the ledger.
      const changes={};
      if (p.attribution_status!=='unknown') {
        if (result.new === true || !contact.source) changes.source=p.application_lead_source;
        const original=(contact.customFields || []).find(f=>f.id===LEAD_SOURCE_FIELD)?.value;
        if (!original) changes.customFields=[{id:LEAD_SOURCE_FIELD,field_value:['Meta Ads','Social Direct','Website Organic'].includes(p.application_lead_source)?p.application_lead_source:'Other'}];
      }
      if (Object.keys(changes).length) await ghl('/contacts/'+encodeURIComponent(id),'PUT',changes);
      return {id};
    },
    async workflow(p) {
      // The fixed recipient is configured on the server; never accept a URL from the browser.
      const u=new URL(env.APPLICATION_GHL_WEBHOOK_URL);
      if (u.origin!==GHL || !u.pathname.startsWith('/hooks/'+env.APPLICATION_GHL_LOCATION_ID+'/webhook-trigger/')) throw new Error('invalid_workflow_recipient');
      const r=await fetcher(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p),signal:deadline()});
      if (!r.ok) throw new Error('workflow_'+r.status);
    }
  };
}

// Each event ID is also the browser eventID. Provider acceptance is recorded separately
// from attempted browser dispatch and from Ads Manager's attributed totals.
export async function deliverMeta(db,p,env,fetcher=fetch) {
  if (env.APPLICATION_META_CAPI_ENABLED!=='true') return;
  if (!env.APPLICATION_META_TOKEN || !/^\d+$/.test(env.APPLICATION_META_PIXEL_ID||'') || !/^v\d+\.0$/.test(env.APPLICATION_META_API_VERSION||'')) throw new Error('meta_not_configured');
  const r=await db.prepare('SELECT received_at,ghl_contact_id FROM facilitator_applications WHERE application_id=?').bind(p.application_id).first();
  const rows=await db.prepare("SELECT * FROM facilitator_application_events WHERE application_id=? AND delivery_state='pending'").bind(p.application_id).all();
  for (const event of rows.results) {
    const claimed=await db.prepare("UPDATE facilitator_application_events SET delivery_state='sending' WHERE event_id=? AND delivery_state='pending'").bind(event.event_id).run();
    if (!claimed.meta.changes) continue;
    try {
      let sourceUrl='https://alchemyofbreath.com/facilitator-application/';
      try {const u=new URL(p.page_url);if (['alchemyofbreath.com','www.alchemyofbreath.com','website-5h3.pages.dev'].includes(u.hostname)) sourceUrl=u.origin+u.pathname;}catch{}
      const data={event_name:event.event_name,event_id:event.event_id,event_time:Math.floor(Date.parse(r.received_at)/1000),action_source:'website',event_source_url:sourceUrl,
        user_data:{em:[await sha(p.email)],external_id:[await sha(r.ghl_contact_id)]},
        custom_data:{application_id:p.application_id,variant:p.variant,qualified:p.outcome==='booking'}};
      if (p.phone) data.user_data.ph=[await sha(p.phone.replace(/\D/g,''))];
      if (p.fbclid) data.user_data.fbc='fb.1.'+Date.parse(r.received_at)+'.'+p.fbclid;
      const response=await fetcher('https://graph.facebook.com/'+env.APPLICATION_META_API_VERSION+'/'+env.APPLICATION_META_PIXEL_ID+'/events',{
        method:'POST',headers:{Authorization:'Bearer '+env.APPLICATION_META_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({data:[data],...(env.APPLICATION_META_TEST_EVENT_CODE?{test_event_code:env.APPLICATION_META_TEST_EVENT_CODE}:{})}),signal:deadline()});
      const result=await response.json();
      if (!response.ok || result.events_received!==1) throw new Error('meta_not_accepted');
      await db.prepare("UPDATE facilitator_application_events SET delivery_state='accepted',accepted_at=?,provider_receipt=? WHERE event_id=?").bind(iso(),JSON.stringify({events_received:result.events_received,fbtrace_id:result.fbtrace_id||null,test:!!env.APPLICATION_META_TEST_EVENT_CODE}),event.event_id).run();
    } catch(e) {
      await db.prepare("UPDATE facilitator_application_events SET delivery_state='uncertain' WHERE event_id=?").bind(event.event_id).run();
    }
  }
}
