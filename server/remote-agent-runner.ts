import type { Provider } from '../shared/preparation';
import type { AgentRequest, AgentRunner } from './agent-runner';

type AgentEvent={type:'session';pid:number|null}|{type:'result';value:unknown}|{type:'error';error:string};

async function responseError(response:Response) {
  try {const value=await response.json() as {error?:unknown};if(typeof value.error==='string')return value.error}catch{/* plain response */}
  return `Agent service returned HTTP ${response.status}.`;
}

/** AgentRunner client for the isolated container service. */
export class RemoteAgentRunner implements AgentRunner {
  private providers:Provider[];
  constructor(private url:string,private token:string,providers:Provider[]){this.url=url.replace(/\/$/,'');this.providers=providers}
  available(){return(['codex','claude'] as const).map(id=>({id,available:this.providers.includes(id)}))}
  async run(request:AgentRequest,signal:AbortSignal,onSession?:(pid:number|null)=>void) {
    const response=await fetch(this.url+'/run',{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify(request),signal});
    if(!response.ok)throw new Error(await responseError(response));
    if(!response.body)throw new Error('Agent service returned no event stream.');
    const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';let result:unknown;let complete=false;let active=false;
    const consume=(line:string)=>{
      if(!line.trim())return;const event=JSON.parse(line) as AgentEvent;
      if(event.type==='session'){active=event.pid!==null;onSession?.(event.pid)}
      else if(event.type==='error')throw new Error(event.error);
      else if(event.type==='result'){result=event.value;complete=true}
    };
    try {
      while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done});let newline:number;
        while((newline=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,newline));buffer=buffer.slice(newline+1)}
        if(done)break;
      }
      consume(buffer);
      if(!complete)throw new Error('Agent service ended without a result.');
      return result;
    } finally {if(active)onSession?.(null);reader.releaseLock()}
  }
}

export function remoteAgentRunnerFromEnv():AgentRunner|undefined {
  const url=process.env.NARAD_AGENT_URL;if(!url)return undefined;
  const token=process.env.NARAD_AGENT_TOKEN;if(!token)throw new Error('NARAD_AGENT_TOKEN is required with NARAD_AGENT_URL.');
  const providers=(process.env.NARAD_AGENT_PROVIDERS??'codex,claude').split(',').map(value=>value.trim()).filter((value):value is Provider=>value==='codex'||value==='claude');
  return new RemoteAgentRunner(url,token,providers);
}
