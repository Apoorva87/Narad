import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { SpeechEngine } from './speech';
import { speechEngines, type SpeechEngineId, type SpeechStatus } from '../shared/speech';

/** Installed voice models: the label shown in the app, the folder `speech/setup.py` fills, and the weight files that must all be present. */
const engines: Record<SpeechEngineId, { label: string; name: string; folder: string; weights: string[] }> = {
  breeze: { label: 'Breeze-TTS-2-bf16@3c8829f-mlx0.6.0', name: 'Breeze TTS 2', folder: 'data/models/breeze-tts-2', weights: ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors', 'audio_tokenizer/model.safetensors'] },
  qwen: { label: 'Qwen3-TTS-1.7B-CustomVoice-8bit@41d3337-mlx0.6.0', name: 'Qwen3-TTS', folder: 'data/models/qwen3-tts', weights: ['model.safetensors'] },
};

export class LocalSpeechWorker implements SpeechEngine {
  private preferred: SpeechEngineId='breeze';
  private running?: SpeechEngineId;
  get model() { return engines[this.active()??this.preferred].label; }
  private child?: ChildProcessWithoutNullStreams;
  private state: Omit<SpeechStatus,'model'>={state:'idle'};
  private pending?: {id:string;resolve:(data:Buffer)=>void;reject:(error:Error)=>void};
  private diagnostics='';
  private python=resolve('speech/.venv/bin/python');
  private installed(engine:SpeechEngineId) { return engines[engine].weights.every(file=>existsSync(resolve(engines[engine].folder,file))); }
  /** The model that will speak: the preferred one when installed, otherwise another installed one. */
  private active():SpeechEngineId|undefined { return this.installed(this.preferred)?this.preferred:speechEngines.find(engine=>this.installed(engine)); }
  status(preferred?:SpeechEngineId) {
    if (preferred) this.preferred=preferred;
    const active=this.active();
    if (!existsSync(this.python) || !active) return {state:'not-installed' as const,message:'Run npm run speech:setup once to install local narration.'};
    // A model other than the loaded one starts when narration is next requested.
    const state=this.child&&this.running!==active?{state:'idle' as const}:this.state;
    return active===this.preferred||state.message?state:{...state,message:`${engines[this.preferred].name} is not installed, so narration uses ${engines[active].name}. Run npm run speech:setup to install it.`};
  }
  private async start(engine:SpeechEngineId) {
    if (this.child&&this.running!==engine) await this.close();
    if (this.child) return;
    this.state={state:'loading'}; this.diagnostics=''; this.running=engine;
    const child=spawn(this.python,['-u','speech/worker.py','--engine',engine,'--model',resolve(engines[engine].folder)],{cwd:resolve('.'),env:{...process.env,HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'},stdio:['pipe','pipe','pipe']});
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
  async synthesize(text:string,voice:string,style:string,signal:AbortSignal,preferred?:SpeechEngineId):Promise<Buffer> {
    signal.throwIfAborted();
    if (this.pending) throw new Error('Speech worker is busy.');
    if (preferred) this.preferred=preferred;
    const engine=this.active();
    if (!existsSync(this.python) || !engine) throw new Error('Local speech is not installed. Run npm run speech:setup.');
    await this.start(engine); signal.throwIfAborted();
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
    this.child=undefined;this.state={state:'idle'};
    this.pending?.reject(new Error('Speech server stopped.'));
    await new Promise<void>(resolveClose=>{const timer=setTimeout(()=>child.kill('SIGKILL'),1000);child.once('close',()=>{clearTimeout(timer);resolveClose()});child.stdin.end();});
  }
}
