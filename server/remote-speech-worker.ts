import type { SpeechEngine } from './speech';
import type { SpeechEngineId, SpeechStatus } from '../shared/speech';

async function errorMessage(response:Response){try{const value=await response.json() as {error?:unknown};if(typeof value.error==='string')return value.error}catch{/* plain response */}return `Speech host returned HTTP ${response.status}.`}

/** SpeechEngine client for the MLX service that stays on the macOS host. */
export class RemoteSpeechWorker implements SpeechEngine {
  private state:Omit<SpeechStatus,'model'>={state:'loading',message:'Checking the macOS voice host.'};private timer:ReturnType<typeof setInterval>;private probing=false;private closed=false;private requests=new Set<AbortController>();private preferred?:SpeechEngineId;
  /** `model` starts as a placeholder and becomes whatever the host reports it is using. */
  constructor(private url:string,private token:string,public model:string,probeMs=5_000){this.url=url.replace(/\/$/,'');void this.probe();this.timer=setInterval(()=>void this.probe(),probeMs);this.timer.unref()}
  status(preferred?:SpeechEngineId){if(preferred)this.preferred=preferred;void this.probe();return this.state}
  private request(external?:AbortSignal,timeoutMs?:number){
    if(this.closed)throw new Error('The speech host client is closed.');
    const controller=new AbortController(),abort=()=>controller.abort(external?.reason),timer=timeoutMs?setTimeout(()=>controller.abort(new DOMException('Speech host request timed out.','TimeoutError')),timeoutMs):undefined;
    external?.addEventListener('abort',abort,{once:true});if(external?.aborted)abort();this.requests.add(controller);
    return{signal:controller.signal,finish:()=>{if(timer)clearTimeout(timer);external?.removeEventListener('abort',abort);this.requests.delete(controller)}};
  }
  private async probe(){
    if(this.probing||this.closed)return;this.probing=true;let operation:ReturnType<RemoteSpeechWorker['request']>|undefined;
    try{operation=this.request(undefined,5_000);const response=await fetch(this.url+'/health'+(this.preferred?'?engine='+this.preferred:''),{headers:{Authorization:'Bearer '+this.token},signal:operation.signal});if(!response.ok)throw new Error(await errorMessage(response));const value=await response.json() as SpeechStatus;this.state={state:value.state,message:value.message};if(typeof value.model==='string'&&value.model)this.model=value.model}
    catch(error){if(!this.closed)this.state={state:'error',message:error instanceof Error?error.message:'Cannot reach the macOS voice host.'}}
    finally{operation?.finish();this.probing=false}
  }
  async synthesize(text:string,voice:string,style:string,signal:AbortSignal,preferred?:SpeechEngineId){
    if(preferred)this.preferred=preferred;
    const operation=this.request(signal);this.state={state:'generating'};
    try{const response=await fetch(this.url+'/synthesize',{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify({text,voice,style,...(this.preferred&&{engine:this.preferred})}),signal:operation.signal});if(!response.ok)throw new Error(await errorMessage(response));const bytes=Buffer.from(await response.arrayBuffer());if(!this.closed)this.state={state:'ready'};return bytes}
    catch(error){if(!this.closed)this.state={state:'error',message:error instanceof Error?error.message:'Voice generation failed.'};throw error}
    finally{operation.finish()}
  }
  async close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);for(const request of this.requests)request.abort(new DOMException('Speech host client stopped.','AbortError'));this.state={state:'error',message:'Speech host client stopped.'}}
}
