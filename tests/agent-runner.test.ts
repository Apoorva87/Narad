import { expect, it } from 'vitest';
import { executeProcess, providerArgs } from '../server/agent-runner';
it('passes prompt text through stdin without shell evaluation and captures the result',async()=>{
 const r=await executeProcess({command:process.execPath,args:['-e',"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s))"],cwd:process.cwd(),input:'$(touch unwanted) `hello`',signal:new AbortController().signal,timeoutMs:3000});expect(r.stdout).toBe('$(touch unwanted) `hello`');
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
