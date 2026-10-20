import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Provider } from '../shared/preparation';
import type { AgentRequest, AgentRunner, AgentUsage } from './agent-runner';

type AgentEvent={type:'session';pid:number|null}|{type:'usage';usage:AgentUsage}|{type:'result';value:unknown}|{type:'error';error:string};

async function readText(response:IncomingMessage){let body='';response.setEncoding('utf8');for await(const chunk of response)body+=chunk;return body}
function responseError(status:number,body:string){try{const value=JSON.parse(body) as {error?:unknown};if(typeof value.error==='string')return value.error}catch{/* plain response */}return `Agent service returned HTTP ${status}.`}

/** AgentRunner client for the isolated container service. Accepts an HTTP URL or an absolute Unix socket path. */
export class RemoteAgentRunner implements AgentRunner {
  private providers:Provider[];
  constructor(private endpoint:string,private token:string,providers:Provider[]){this.endpoint=endpoint.replace(/\/$/,'');this.providers=providers}
  available(){return(['codex','claude'] as const).map(id=>({id,available:this.providers.includes(id)}))}
  private post(request:AgentRequest,signal:AbortSignal){
    const body=JSON.stringify(request),headers={Authorization:'Bearer '+this.token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)};
    return new Promise<IncomingMessage>((resolve,reject)=>{
      const options={method:'POST',headers,signal};
      const outgoing=this.endpoint.startsWith('/')
        ?httpRequest({...options,socketPath:this.endpoint,path:'/run'},resolve)
        :(new URL(this.endpoint).protocol==='https:'?httpsRequest:httpRequest)(new URL('/run',this.endpoint+'/'),options,resolve);
      outgoing.once('error',reject);outgoing.end(body);
    });
  }
  async run(request:AgentRequest,signal:AbortSignal,onSession?:(pid:number|null)=>void,onUsage?:(usage:AgentUsage)=>void) {
    const response=await this.post(request,signal),status=response.statusCode??500;
    if(status<200||status>=300)throw new Error(responseError(status,await readText(response)));
    response.setEncoding('utf8');let buffer='',result:unknown,complete=false,active=false;
    const consume=(line:string)=>{
      if(!line.trim())return;const event=JSON.parse(line) as AgentEvent;
      if(event.type==='session'){active=event.pid!==null;onSession?.(event.pid)}
      else if(event.type==='usage'){try{onUsage?.(event.usage)}catch{/* usage is best effort */}}
      else if(event.type==='error')throw new Error(event.error);
      else if(event.type==='result'){result=event.value;complete=true}
    };
    try {
      for await(const chunk of response){buffer+=chunk;let newline:number;while((newline=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,newline));buffer=buffer.slice(newline+1)}}
      consume(buffer);if(!complete)throw new Error('Agent service ended without a result.');return result;
    } finally {if(active)onSession?.(null)}
  }
}

export function remoteAgentRunnerFromEnv():AgentRunner|undefined {
  const endpoint=process.env.NARAD_AGENT_SOCKET??process.env.NARAD_AGENT_URL;if(!endpoint)return undefined;
  const token=process.env.NARAD_AGENT_TOKEN;if(!token)throw new Error('NARAD_AGENT_TOKEN is required with the remote agent service.');
  const providers=(process.env.NARAD_AGENT_PROVIDERS??'codex,claude').split(',').map(value=>value.trim()).filter((value):value is Provider=>value==='codex'||value==='claude');
  return new RemoteAgentRunner(endpoint,token,providers);
}
