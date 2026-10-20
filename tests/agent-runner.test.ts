import { expect, it } from 'vitest';
import { claudeUsage, codexUsage, executeProcess, providerArgs } from '../server/agent-runner';
it('passes prompt text through stdin without shell evaluation and captures the result',async()=>{
 const r=await executeProcess({command:process.execPath,args:['-e',"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s))"],cwd:process.cwd(),input:'$(touch unwanted) `hello`',signal:new AbortController().signal,timeoutMs:3000});expect(r.stdout).toBe('$(touch unwanted) `hello`');
});
it('does not pass Narad service bearer tokens to provider processes',async()=>{
 const beforeAgent=process.env.NARAD_AGENT_TOKEN,beforeTts=process.env.NARAD_TTS_TOKEN;
 process.env.NARAD_AGENT_TOKEN='agent-secret';process.env.NARAD_TTS_TOKEN='tts-secret';
 try {
  const r=await executeProcess({command:process.execPath,args:['-e',"process.stdout.write(String(process.env.NARAD_AGENT_TOKEN)+':'+String(process.env.NARAD_TTS_TOKEN))"],cwd:process.cwd(),input:'',signal:new AbortController().signal,timeoutMs:3000});
  expect(r.stdout).toBe('undefined:undefined');
 } finally {
  if(beforeAgent===undefined)delete process.env.NARAD_AGENT_TOKEN;else process.env.NARAD_AGENT_TOKEN=beforeAgent;
  if(beforeTts===undefined)delete process.env.NARAD_TTS_TOKEN;else process.env.NARAD_TTS_TOKEN=beforeTts;
 }
});
it('stops an owned process and rejects late results',async()=>{
 const controller=new AbortController();let pid=0;
 const p=executeProcess({command:process.execPath,args:['-e',"setInterval(()=>{},1000)"],cwd:process.cwd(),input:'',signal:controller.signal,timeoutMs:3000,onSession:n=>{if(n){pid=n;controller.abort()}}});
 await expect(p).rejects.toThrow(/stop|cancel/i);expect(pid).toBeGreaterThan(0);expect(()=>process.kill(pid,0)).toThrow();
});
it('bounds process time and output',async()=>{
 await expect(executeProcess({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:process.cwd(),input:'',signal:new AbortController().signal,timeoutMs:100})).rejects.toThrow(/timed out/i);
 await expect(executeProcess({command:process.execPath,args:['-e',"process.stdout.write('x'.repeat(5000))"],cwd:process.cwd(),input:'',signal:new AbortController().signal,timeoutMs:3000,maxBytes:1000})).rejects.toThrow(/output limit/i);
});
it('uses structured noninteractive modes without permission bypass flags',()=>{
 for(const provider of ['codex','claude'] as const) {const args=providerArgs(provider,{schemaPath:'/tmp/schema',outputPath:'/tmp/result',schema:{type:'object'},images:[],research:false});expect(args.join(' ')).not.toContain('bypass');expect(args.join(' ')).not.toContain('skip-permissions');}
 expect(providerArgs('claude',{schemaPath:'schema',outputPath:'out',schema:{},images:[],research:false})).toContain('--json-schema');
});
it('enables native Codex subagents and low reasoning only for an opted-in request',()=>{
 const coordinated=providerArgs('codex',{schemaPath:'schema',outputPath:'out',schema:{},images:[],research:false,multiAgent:true,reasoningEffort:'low'}).join(' ');
 expect(coordinated).toContain('features.multi_agent=true');
 expect(coordinated).toContain('model_reasoning_effort="low"');
 expect(coordinated).not.toContain('--ephemeral');
 const ordinary=providerArgs('codex',{schemaPath:'schema',outputPath:'out',schema:{},images:[],research:false}).join(' ');
 expect(ordinary).toContain('features.multi_agent=false');
 expect(ordinary).toContain('--ephemeral');
 expect(ordinary).not.toContain('model_reasoning_effort');
});
it('does not finish cancellation until a SIGTERM-resistant child is gone',async()=>{
 let pid=0;
 await expect(executeProcess({command:process.execPath,args:['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],cwd:process.cwd(),input:'',signal:new AbortController().signal,timeoutMs:400,onSession:n=>{if(n)pid=n}})).rejects.toThrow(/timed out/i);
 try{expect(()=>process.kill(pid,0)).toThrow()}finally{try{process.kill(pid,'SIGKILL')}catch{}}
});
it('surfaces a provider authentication error returned on stdout with a failing exit code',async()=>{
 await expect(executeProcess({command:process.execPath,args:['-e',"console.log(JSON.stringify({is_error:true,result:'Failed to authenticate: OAuth session expired'}));process.exitCode=1"],cwd:process.cwd(),input:'',signal:new AbortController().signal,timeoutMs:3000})).rejects.toThrow(/OAuth session expired/);
});
it('surfaces a structured provider error from JSON-lines output',async()=>{
 await expect(executeProcess({command:process.execPath,args:['-e',"console.log(JSON.stringify({type:'error',message:'Invalid schema: missing required label'}));process.exitCode=1"],cwd:process.cwd(),input:'',signal:new AbortController().signal,timeoutMs:3000})).rejects.toThrow(/missing required label/);
});

it('reads usage and cost from a Claude envelope',()=>{
 expect(claudeUsage({usage:{input_tokens:12,output_tokens:5,cache_read_input_tokens:100,cache_creation_input_tokens:20},total_cost_usd:0.42})).toEqual({inputTokens:12,outputTokens:5,cachedTokens:120,costUsd:0.42});
 expect(claudeUsage({usage:{input_tokens:3,output_tokens:1}})).toEqual({inputTokens:3,outputTokens:1});
});
it('tolerates missing or odd usage in a Claude envelope',()=>{
 expect(claudeUsage({})).toBeUndefined();expect(claudeUsage(null)).toBeUndefined();
 expect(claudeUsage({usage:{input_tokens:'x',output_tokens:7},total_cost_usd:'free'})).toEqual({inputTokens:0,outputTokens:7});
});
it('sums turn.completed usage from Codex JSONL and ignores everything else',()=>{
 const out=[JSON.stringify({type:'thread.started'}),JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:60,output_tokens:10}}),'not json',JSON.stringify({type:'turn.completed',usage:{input_tokens:50,output_tokens:5}}),JSON.stringify({type:'turn.completed'})].join('\n');
 expect(codexUsage(out)).toEqual({inputTokens:150,outputTokens:15,cachedTokens:60});
 expect(codexUsage(out,true)).toEqual({inputTokens:150,outputTokens:15,cachedTokens:60,partial:true});
 expect(codexUsage('garbage\n{}')).toBeUndefined();
});
