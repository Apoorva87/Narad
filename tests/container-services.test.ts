import { afterEach, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createAgentService } from '../server/agent-service';
import { RemoteAgentRunner } from '../server/remote-agent-runner';
import { createTtsHost } from '../server/tts-host';
import { RemoteSpeechWorker } from '../server/remote-speech-worker';
import { createRuntimeServices } from '../server/runtime-services';
import type { AgentRequest, AgentRunner } from '../server/agent-runner';
import type { SpeechEngine } from '../server/speech';

const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0))await new Promise<void>(resolve=>server.close(()=>resolve()))});
async function listen(app:ReturnType<typeof createAgentService>|ReturnType<typeof createTtsHost>){
 const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise<void>(resolve=>server.once('listening',resolve));
 return 'http://127.0.0.1:'+(server.address() as {port:number}).port;
}
const request:AgentRequest={provider:'codex',kind:'author',prompt:'NARAD_FIXED_POLICY_V1\nTeach this.',schema:{type:'object'},cwd:'/data/preparations/job-1',name:'draft',images:['/data/preparations/job-1/figure.png'],research:false};

it('forwards an authenticated agent job and reports its container session',async()=>{
 let received:AgentRequest|undefined;
 const local:AgentRunner={available:()=>[{id:'codex',available:true},{id:'claude',available:true}],run:async(value,_signal,onSession)=>{received=value;onSession?.(74);onSession?.(null);return{lesson:'ready'}}};
 const url=await listen(createAgentService(local,'agent-secret',['/data/preparations','/data/tutor']));
 const remote=new RemoteAgentRunner(url,'agent-secret',['codex','claude']);const sessions:(number|null)[]=[];
 await expect(remote.run(request,new AbortController().signal,pid=>sessions.push(pid))).resolves.toEqual({lesson:'ready'});
 expect(received).toEqual(request);expect(sessions).toEqual([74,null]);expect(remote.available()).toEqual([{id:'codex',available:true},{id:'claude',available:true}]);
});

it('rejects unauthorized agent calls and paths outside the job mounts',async()=>{
 let calls=0;const local:AgentRunner={available:()=>[],run:async()=>{calls++;return{}}};
 const url=await listen(createAgentService(local,'agent-secret',['/data/preparations','/data/tutor']));
 await expect(new RemoteAgentRunner(url,'wrong',['codex']).run(request,new AbortController().signal)).rejects.toThrow(/authoriz/i);
 await expect(new RemoteAgentRunner(url,'agent-secret',['codex']).run({...request,cwd:'/data/narad.sqlite'},new AbortController().signal)).rejects.toThrow(/job directory/i);
 expect(calls).toBe(0);
});

it('forwards cancellation to the running agent container job',async()=>{
 let aborted=false;let started!:()=>void;const running=new Promise<void>(resolve=>started=resolve);
 const local:AgentRunner={available:()=>[],run:async(_request,signal)=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'))},{once:true}))}};
 const url=await listen(createAgentService(local,'agent-secret',['/data/preparations']));const controller=new AbortController();
 const pending=new RemoteAgentRunner(url,'agent-secret',['codex']).run(request,controller.signal);await running;controller.abort();
 await expect(pending).rejects.toThrow(/abort|cancel/i);await expect.poll(()=>aborted).toBe(true);
});

it('proxies authenticated ephemeral speech without writing audio',async()=>{
 const wav=Buffer.from('RIFF temporary wav');let received:{text:string;voice:string;style:string}|undefined;
 const engine:SpeechEngine={model:'test-voice',status:()=>({state:'ready'}),synthesize:async(text,voice,style)=>{received={text,voice,style};return wav},close:async()=>{}};
 const url=await listen(createTtsHost(engine,'tts-secret'));
 const remote=new RemoteSpeechWorker(url,'tts-secret','test-voice',60_000);
 await expect(remote.synthesize('A careful explanation.','Ryan','Warm and precise.',new AbortController().signal)).resolves.toEqual(wav);
 expect(received).toEqual({text:'A careful explanation.',voice:'Ryan',style:'Warm and precise.'});
 await expect.poll(()=>remote.status().state).toBe('ready');await remote.close();
});

it('does not expose the host speech engine without its token',async()=>{
 let calls=0;const engine:SpeechEngine={model:'test-voice',status:()=>({state:'ready'}),synthesize:async()=>{calls++;return Buffer.alloc(44)},close:async()=>{}};
 const url=await listen(createTtsHost(engine,'tts-secret'));
 await expect(new RemoteSpeechWorker(url,'wrong','test-voice',60_000).synthesize('Hello','Ryan','Calm',new AbortController().signal)).rejects.toThrow(/authoriz/i);
 expect(calls).toBe(0);
});

it('selects isolated remote services and a container bind address from environment',async()=>{
 const runtime=createRuntimeServices({NARAD_AGENT_URL:'http://agent:4320',NARAD_AGENT_TOKEN:'agent-secret',NARAD_AGENT_PROVIDERS:'codex',NARAD_TTS_URL:'http://host.docker.internal:4321',NARAD_TTS_TOKEN:'tts-secret',NARAD_BIND_HOST:'0.0.0.0'});
 expect(runtime.agent).toBeInstanceOf(RemoteAgentRunner);expect(runtime.agent.available()).toEqual([{id:'codex',available:true},{id:'claude',available:false}]);
 expect(runtime.speech).toBeInstanceOf(RemoteSpeechWorker);expect(runtime.bindHost).toBe('0.0.0.0');await runtime.speech.close();
 expect(()=>createRuntimeServices({NARAD_AGENT_URL:'http://agent:4320'})).toThrow(/agent_token/i);
 expect(()=>createRuntimeServices({NARAD_TTS_URL:'http://host.docker.internal:4321'})).toThrow(/tts_token/i);
});
