import { accept, normalize, receipt, InputError } from '../../../application-lib/receiver.js';
import { providers, deliverMeta } from '../../../application-lib/providers.js';
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export async function onRequestPost({request,env}) {
  const url=new URL(request.url);
  // This endpoint is same-origin only; preview environments need their own bindings.
  if (request.headers.get('Origin')!==url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) return reply({error:'Invalid request origin or content type'},403);
  if (!env.APPLICATIONS_DB || !env.APPLICATION_GHL_TOKEN || !env.APPLICATION_GHL_LOCATION_ID || !env.APPLICATION_GHL_WEBHOOK_URL) return reply({error:'Application receiver is not configured'},503);
  try {
    const raw=await request.text();
    if (new TextEncoder().encode(raw).length>65536) return reply({error:'Application too large'},413);
    let input;try{input=JSON.parse(raw);}catch{throw new InputError('Invalid JSON');}
    const {payload}=await normalize(input);
    const result=await accept(env.APPLICATIONS_DB,input,providers(env));
    if (result.status==='accepted') {
      // The application stays accepted when Meta is down. The outbox shows the gap.
      try{await deliverMeta(env.APPLICATIONS_DB,payload,env);}catch{}
      return reply(await receipt(env.APPLICATIONS_DB,payload.application_id));
    }
    return reply(result,202);
  } catch(e) {
    if(e instanceof InputError) return reply({error:e.message},e.status);
    return reply({error:'Application could not be confirmed; retry with the same application ID'},503);
  }
}
