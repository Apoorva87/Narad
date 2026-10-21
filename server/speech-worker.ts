import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { SpeechEngine } from './speech';
import type { SpeechStatus } from '../shared/speech';

export class LocalSpeechWorker implements SpeechEngine {
  readonly model='Qwen3-TTS-1.7B-CustomVoice-8bit@41d3337-mlx0.6.0';
  private child?: ChildProcessWithoutNullStreams;
  private state: Omit<SpeechStatus,'model'>={state:'idle'};
  private pending?: {id:string;resolve:(data:Buffer)=>void;reject:(error:Error)=>void};
  private diagnostics='';
  private python=resolve('speech/.venv/bin/python');
  private modelPath=resolve('data/models/qwen3-tts');
  status() {
    if (!existsSync(this.python) || !existsSync(resolve(this.modelPath,'model.safetensors'))) return {state:'not-installed' as const,message:'Run npm run speech:setup once to install local narration.'};
    return this.state;
  }
  private start() {
    if (this.child) return;
    if (this.status().state==='not-installed') throw new Error('Local speech is not installed. Run npm run speech:setup.');
    this.state={state:'loading'}; this.diagnostics='';
    const child=spawn(this.python,['-u','speech/worker.py','--model',this.modelPath],{cwd:resolve('.'),env:{...process.env,HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'},stdio:['pipe','pipe','pipe']});
    this.child=child;
    child.stderr.on('data',chunk=>{this.diagnostics=(this.diagnostics+String(chunk)).slice(-3000)});
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      try {
        const message=JSON.parse(line);
        if (message.event==='ready') this.state={state:'ready'};
        if (message.event==='generating') this.state={state:'generating'};
        const pending=this.pending;
        if (pending && message.id===pending.id) {
          this.state={state:'ready'};
          if (message.error) pending.reject(new Error(message.error));
          else if (message.audio) pending.resolve(Buffer.from(message.audio,'base64'));
        }
      } catch { /* Third-party diagnostics must not become protocol messages. */ }
    });
    child.stdin.on('error',()=>{});
    const fail=(message:string)=>{if(this.child!==child)return; this.child=undefined;this.state={state:'error',message};this.pending?.reject(new Error(message));lines.close();};
    child.on('error',e=>fail('Could not start local speech: '+e.message));
    child.on('close',()=>fail('Local speech stopped. Press Play to retry. '+this.diagnostics.slice(-500)));
  }
  async synthesize(text:string,voice:string,style:string,signal:AbortSignal):Promise<Buffer> {
    signal.throwIfAborted(); this.start();
    if (this.pending) throw new Error('Speech worker is busy.');
    const id=randomUUID();
    return new Promise<Buffer>((resolvePromise,rejectPromise)=>{
      const abort=()=>{this.child?.stdin.write(JSON.stringify({cancel:id})+'\n')};
      const timer=setTimeout(()=>{
        // Forget the stuck process now, not when its close event arrives: the next queued request must start a fresh one.
        const stuck=this.child;this.child=undefined;this.state={state:'error',message:'Local narration took too long. Press Play to retry.'};stuck?.kill('SIGKILL');
        finish(new Error('Local narration took too long. Press Play to retry.'));
      },180000);
      const finish=(error?:Error,data?:Buffer)=>{
        clearTimeout(timer);signal.removeEventListener('abort',abort);this.pending=undefined;
        if (signal.aborted) rejectPromise(new DOMException('Narration aborted','AbortError'));
        else if(error)rejectPromise(error);else resolvePromise(data!);
      };
      this.pending={id,resolve:data=>finish(undefined,data),reject:error=>finish(error)};
      signal.addEventListener('abort',abort,{once:true});
      this.child!.stdin.write(JSON.stringify({id,text,voice,style})+'\n');
      if (signal.aborted) abort();
    });
  }
  async close() {
    const child=this.child;if(!child)return;
    this.pending?.reject(new Error('Speech server stopped.'));
    await new Promise<void>(resolveClose=>{const timer=setTimeout(()=>child.kill('SIGKILL'),1000);child.once('close',()=>{clearTimeout(timer);resolveClose()});child.stdin.end();});
  }
}
