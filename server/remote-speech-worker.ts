import type { SpeechEngine } from './speech';
import type { SpeechStatus } from '../shared/speech';

async function errorMessage(response:Response){try{const value=await response.json() as {error?:unknown};if(typeof value.error==='string')return value.error}catch{/* plain response */}return `Speech host returned HTTP ${response.status}.`}

/** SpeechEngine client for the MLX service that stays on the macOS host. */
export class RemoteSpeechWorker implements SpeechEngine {
  private state:Omit<SpeechStatus,'model'>={state:'loading',message:'Checking the macOS voice host.'};private timer:ReturnType<typeof setInterval>;private probing=false;private closed=false;
  constructor(private url:string,private token:string,readonly model:string,probeMs=5_000){this.url=url.replace(/\/$/,'');void this.probe();this.timer=setInterval(()=>void this.probe(),probeMs);this.timer.unref()}
  status(){void this.probe();return this.state}
  private async probe(){if(this.probing||this.closed)return;this.probing=true;try{const response=await fetch(this.url+'/health',{headers:{Authorization:'Bearer '+this.token}});if(!response.ok)throw new Error(await errorMessage(response));const value=await response.json() as SpeechStatus;this.state={state:value.state,message:value.message}}catch(error){this.state={state:'error',message:error instanceof Error?error.message:'Cannot reach the macOS voice host.'}}finally{this.probing=false}}
  async synthesize(text:string,voice:string,style:string,signal:AbortSignal){
    this.state={state:'generating'};
    try{const response=await fetch(this.url+'/synthesize',{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify({text,voice,style}),signal});if(!response.ok)throw new Error(await errorMessage(response));const bytes=Buffer.from(await response.arrayBuffer());this.state={state:'ready'};return bytes}
    catch(error){this.state={state:'error',message:error instanceof Error?error.message:'Voice generation failed.'};throw error}
  }
  async close(){this.closed=true;clearInterval(this.timer)}
}
