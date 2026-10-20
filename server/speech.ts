import { speechRequestSchema, splitSpeech, speechStyle, type SpeechRequest, type SpeechStatus } from '../shared/speech';
import { type LessonStore, StoreError } from './store';

export interface SpeechEngine {
  model: string;
  status(): Omit<SpeechStatus,'model'>;
  synthesize(text: string, voice: string, style: string, signal: AbortSignal): Promise<Buffer>;
  close(): Promise<void>;
}
export function wavDuration(bytes: Buffer) {
  if (bytes.length<=44 || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,16)!=='WAVEfmt ' || bytes.readUInt16LE(20)!==1 || bytes.toString('ascii',36,40)!=='data' || bytes.readUInt32LE(40)!==bytes.length-44) throw new Error('The speech model returned invalid audio. Try again.');
  const rate=bytes.readUInt32LE(28); if (!rate) throw new Error('Invalid audio sample rate.');
  return (bytes.length-44)/rate;
}
export class SpeechService {
  private queue: Promise<unknown> = Promise.resolve();
  private pending=0;
  private closed=false;
  constructor(private store: LessonStore, private engine: SpeechEngine) {}
  status(): SpeechStatus { return {...this.engine.status(),model:this.engine.model}; }
  async render(input: SpeechRequest, signal: AbortSignal): Promise<Buffer> {
    const request=speechRequestSchema.parse(input);
    const lesson=this.store.get(request.lessonId);
    const block=lesson?.modes[request.mode]?.sections.flatMap(s=>s.blocks).find(b=>b.id===request.blockId);
    if (!block) throw new StoreError('This lesson passage was not found.',404);
    const text=splitSpeech(block.spokenText)[request.chunk];
    if (!text) throw new StoreError('This narration chunk was not found.',400);
    return this.renderText(text,request.voice,speechStyle(block,this.store.getSettings().prompts),signal);
  }
  async renderText(text: string, voice: string, style: string, signal: AbortSignal): Promise<Buffer> {
    if (this.closed) throw new StoreError('Speech is shutting down.',503);
    if (this.pending>=8) throw new StoreError('Speech is busy. Try again in a moment.',429);
    const checkActive=()=>{signal.throwIfAborted();if(this.closed)throw new StoreError('Speech is shutting down.',503)};
    this.pending++;
    const work=this.queue.then(async()=>{
      checkActive();
      const bytes=await this.engine.synthesize(text,voice,style,signal);
      checkActive(); wavDuration(bytes);
      return bytes;
    }).finally(()=>{this.pending--});
    this.queue=work.then(()=>undefined,()=>undefined);
    return work;
  }
  async close() { this.closed=true; await this.engine.close(); await this.queue; }
}
