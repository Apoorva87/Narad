import { fork } from 'node:child_process';
import { accessSync, constants, openSync, appendFileSync, closeSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provider, PreparationState, AgentUsage } from '../shared/preparation';
import { hasFixedPromptPolicy } from './prompt-security';
export type { AgentUsage };
export type AgentRequest = { provider:Provider; kind:'author'|'review'|'summary'|'research'|'tutor'; prompt:string; schema:Record<string,unknown>; cwd:string; name:string; images:string[]; model?:string; timeoutMs?:number; research?:boolean; multiAgent?:boolean; reasoningEffort?:'low'|'medium' };
export type AgentRunner = {run:(request:AgentRequest,signal:AbortSignal,onSession?:(pid:number|null)=>void,onUsage?:(usage:AgentUsage)=>void)=>Promise<unknown>; available:()=>PreparationState['providers']};
const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
/** Usage from a Claude `--output-format json` envelope; undefined when it carries none. Never throws. */
export function claudeUsage(envelope:unknown):AgentUsage|undefined {
  const e=envelope as {usage?:Record<string,unknown>;total_cost_usd?:unknown}|null;
  const u=e&&typeof e==='object'?e.usage:undefined;if(!u||typeof u!=='object')return undefined;
  const cached=count(u.cache_read_input_tokens)+count(u.cache_creation_input_tokens);
  const cost=typeof e!.total_cost_usd==='number'&&Number.isFinite(e!.total_cost_usd)?e!.total_cost_usd:undefined;
  return {inputTokens:count(u.input_tokens),outputTokens:count(u.output_tokens),...(cached>0&&{cachedTokens:cached}),...(cost!==undefined&&{costUsd:cost})};
}
/** Summed `turn.completed` usage from Codex `--json` JSONL output; undefined when no event carries usage. Never throws. */
export function codexUsage(stdout:string,partial=false):AgentUsage|undefined {
  let total:AgentUsage|undefined;
  for(const line of stdout.split(/\r?\n/))try{
    const event=JSON.parse(line) as {type?:string;usage?:Record<string,unknown>};
    if(event?.type!=='turn.completed'||!event.usage||typeof event.usage!=='object')continue;
    const cached=count(event.usage.cached_input_tokens);
    total={inputTokens:(total?.inputTokens??0)+count(event.usage.input_tokens),outputTokens:(total?.outputTokens??0)+count(event.usage.output_tokens),...((total?.cachedTokens||cached)&&{cachedTokens:(total?.cachedTokens??0)+cached})};
  } catch { /* not a JSON event line */ }
  return total&&partial?{...total,partial:true}:total;
}
export function executeProcess(options:{command:string;args:string[];cwd:string;input:string;signal:AbortSignal;timeoutMs:number;maxBytes?:number;onSession?:(pid:number|null)=>void;onOutput?:(text:string)=>void}):Promise<{stdout:string;stderr:string}> {
  return new Promise((resolve,reject)=>{
    if(options.signal.aborted) {reject(new Error('Preparation cancelled.'));return;}
    const environment={...process.env};delete environment.NARAD_AGENT_TOKEN;delete environment.NARAD_TTS_TOKEN;
    const host=fork(fileURLToPath(new URL('./cli-host.mjs',import.meta.url)),[],{cwd:options.cwd,detached:true,silent:true,execArgv:[],env:environment});
    let stdout='';let stderr='';let bytes=0;let failure:Error|undefined;let exitCode:number|undefined;let escalation:ReturnType<typeof setTimeout>|undefined;
    const kill=(signal:NodeJS.Signals)=>{if(host.pid)try{process.kill(-host.pid,signal)}catch{/* already closed */}};
    const stop=(reason:string)=>{if(failure)return;failure=new Error(reason);kill('SIGTERM');escalation=setTimeout(()=>kill('SIGKILL'),1500);escalation.unref();};
    const abort=()=>stop('Preparation cancelled.');options.signal.addEventListener('abort',abort,{once:true});
    const timeout=setTimeout(()=>stop('Agent timed out. The partial preparation was saved; retry or choose another agent.'),options.timeoutMs);timeout.unref();
    const consume=(data:Buffer,channel:'stdout'|'stderr')=>{bytes+=data.length;if(bytes>(options.maxBytes??12_000_000)){stop('Agent exceeded the output limit.');return;}options.onOutput?.(data.toString());if(channel==='stdout')stdout+=data;else stderr+=data;};
    host.stdout!.on('data',d=>consume(d,'stdout'));host.stderr!.on('data',d=>consume(d,'stderr'));
    host.on('message',(value:unknown)=>{const message=value as {type:string;pid?:number;code?:number};if(message.type==='started' && message.pid) options.onSession?.(message.pid);if(message.type==='finished')exitCode=message.code??1;});
    host.once('error',error=>{failure=error;});
    host.once('close',()=>{
      // Close can race with termination of descendants: finish the owned group first.
      kill('SIGKILL');
      clearTimeout(timeout);if(escalation)clearTimeout(escalation);options.signal.removeEventListener('abort',abort);options.onSession?.(null);
      // The helper exits by killing its own group after the CLI has closed.
      let diagnostic=stderr.slice(-1800);
      if (!diagnostic.trim()) {
        for (const line of [stdout, ...stdout.trim().split(/\r?\n/).reverse()]) try {
          const result=JSON.parse(line) as {is_error?:boolean;result?:unknown;message?:unknown;error?:{message?:unknown}};
          const detail=result.is_error?result.result:result.error?.message??result.message;
          if(typeof detail==='string'&&detail.trim()){diagnostic=detail.slice(0,1800);break}
        } catch { /* keep looking through provider JSON-lines output */ }
      }
      if (/authenticate|OAuth session expired/i.test(diagnostic)) diagnostic+=' Sign in again with the selected CLI from a terminal, then retry.';
      if(failure)reject(failure);else if(exitCode!==0)reject(new Error('Agent failed. '+(diagnostic||'No diagnostic was returned. See the saved output log.')));else resolve({stdout,stderr});
    });
    host.send({type:'start',command:options.command,args:options.args,cwd:options.cwd,input:options.input});
  });
}
export function providerArgs(provider:Provider,options:{schemaPath:string;outputPath:string;schema:Record<string,unknown>;images:string[];research:boolean;model?:string;multiAgent?:boolean;reasoningEffort?:'low'|'medium'}):string[] {
  const model=options.model?(provider==='codex'?['-m',options.model]:['--model',options.model]):[];
  if(provider==='codex')return ['exec','--ignore-user-config','--ignore-rules',...(options.multiAgent?[]:['--ephemeral']),'--skip-git-repo-check','--sandbox','read-only','--json','--color','never','-c','features.shell_tool=false','-c','features.js_repl=false','-c','features.multi_agent='+(options.multiAgent?'true':'false'),...(options.reasoningEffort?['-c','model_reasoning_effort="'+options.reasoningEffort+'"']:[]),'-c','web_search="'+(options.research?'live':'disabled')+'"','--output-schema',options.schemaPath,'--output-last-message',options.outputPath,...model,...options.images.flatMap(path=>['--image',path]),'-'];
  const allowed=options.research?'WebSearch':'Read';
  return ['--print','--safe-mode','--restricted','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--permission-mode','dontAsk','--tools',allowed,'--allowedTools',allowed,'--no-session-persistence','--output-format','json','--json-schema',JSON.stringify(options.schema),...model];
}
function executable(provider:Provider):string|undefined {
  const configured=process.env[provider==='codex'?'NARAD_CODEX_BIN':'NARAD_CLAUDE_BIN'];
  for(const path of configured?[configured]:(process.env.PATH??'').split(delimiter).map(dir=>join(dir,provider)))try{accessSync(path,constants.X_OK);return path}catch{/* next */}
}
export const cliRunner:AgentRunner={
  available:()=>['codex','claude'].map(id=>({id:id as Provider,available:!!executable(id as Provider)})),
  async run(request,signal,onSession,onUsage){
    const command=executable(request.provider);if(!command)throw new Error(request.provider+' is not installed or is not on the server PATH. Install it and sign in from a terminal first.');
    if(!hasFixedPromptPolicy(request.prompt))throw new Error('Agent request is missing Narad fixed prompt policy.');
    const schemaPath=join(request.cwd,request.name+'.schema.json');const outputPath=join(request.cwd,request.name+'.result.json');
    await writeFile(schemaPath,JSON.stringify(request.schema));await writeFile(join(request.cwd,request.name+'.prompt.txt'),request.prompt);
    const log=openSync(join(request.cwd,request.name+'.events.log'),'w');
    let result:{stdout:string;stderr:string};
    try { result=await executeProcess({command,args:providerArgs(request.provider,{schemaPath,outputPath,schema:request.schema,images:request.images,research:request.research??request.kind==='research',model:request.model,multiAgent:request.multiAgent,reasoningEffort:request.reasoningEffort}),cwd:request.cwd,input:request.prompt,signal,timeoutMs:request.timeoutMs??12*60_000,onSession,onOutput:text=>appendFileSync(log,text)}); } finally { closeSync(log); }
    signal.throwIfAborted();
    let value:unknown;
    if(request.provider==='codex') {try{const usage=codexUsage(result.stdout,request.multiAgent);if(usage)onUsage?.(usage)}catch{/* usage is best effort */}value=JSON.parse(await readFile(outputPath,'utf8'));}
    else {const envelope=JSON.parse(result.stdout);try{const usage=claudeUsage(envelope);if(usage)onUsage?.(usage)}catch{/* usage is best effort */}if(envelope.is_error)throw new Error('Claude could not complete preparation: '+String(envelope.result??envelope.subtype));value=envelope.structured_output;if(!value && typeof envelope.result==='string')value=JSON.parse(envelope.result);}
    if(!value)throw new Error('Agent returned no structured teaching content.');
    await writeFile(outputPath,JSON.stringify(value,null,2));return value;
  },
};
