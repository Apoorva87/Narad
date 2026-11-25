import type { SpeechRequest, SpeechAudio, SpeechPace } from '../../shared/speech';
/** `gate` marks the first chunk of a check question's explanation: narration waits there until the learner answers or presses Play. */
export type NarrationItem = SpeechRequest & {pace?:SpeechPace;tutor?:{turnId:string;part:'question'|'answer'};gate?:boolean};
export type NarrationState = {status:'idle'|'loading'|'playing'|'paused'|'ended'|'error';blockId?:string;chunk?:number;tutor?:NarrationItem['tutor'];part?:NarrationItem['part'];/** Paused at a check question, waiting for an answer. */waiting?:boolean;error?:string};
export type NarrationProgress = {blockId:string;chunk:number;elapsed:number;duration:number};
export interface AudioPort {
  src:string;currentTime:number;duration:number;playbackRate:number;preservesPitch:boolean;
  ontimeupdate:((event:Event)=>unknown)|null;
  onended:((event:Event)=>unknown)|null;onerror:((event:Event|string)=>unknown)|null;
  play():Promise<void>;pause():void;load():void;removeAttribute(name:string):void;
}
type Render=(item:NarrationItem,signal:AbortSignal)=>Promise<SpeechAudio>;
type PrefetchedAudio={promise:Promise<SpeechAudio|undefined>;audio?:SpeechAudio};
/** Chunks rendered ahead of playback (about a minute of speech): the local model runs ~4× real time, so this stays full even while a tutor answer renders. */
const prefetchAhead=6;

/** One owner for audio and async generations. Old results never regain playback ownership. */
export class NarrationController {
  state:NarrationState={status:'idle'};
  private items:NarrationItem[]=[];
  private index=0;
  private generation=0;
  private abort=new AbortController();
  private rate=1;
  private loaded=false;
  private currentAudio?:SpeechAudio;
  private disposed=false;
  private prefetched=new Map<number,PrefetchedAudio>();
  private waiting=false;
  private answered=new Set<string>();
  constructor(private audio:AudioPort,private render:Render,private changed:(state:NarrationState)=>void,private progress:(value?:NarrationProgress)=>void=()=>{}) {audio.preservesPitch=true;}
  private update(status:NarrationState['status'],error?:string) {
    if(this.disposed)return;
    this.state={status,blockId:this.items[this.index]?.blockId,chunk:this.items[this.index]?.chunk,tutor:this.items[this.index]?.tutor,part:this.items[this.index]?.part,...(this.waiting&&{waiting:true}),error};this.changed(this.state);
    if(status!=='playing')this.progress();
  }
  private invalidate(clearAudio:boolean) {
    this.generation++;this.abort.abort();this.abort=new AbortController();this.waiting=false;
    for(const entry of this.prefetched.values())entry.audio?.release();this.prefetched.clear();
    this.audio.pause();this.audio.onended=null;this.audio.onerror=null;this.audio.ontimeupdate=null;
    if(clearAudio)this.releaseCurrent();
  }
  private releaseCurrent(){this.loaded=false;this.audio.removeAttribute('src');this.audio.load();this.currentAudio?.release();this.currentAudio=undefined;}
  start(items:NarrationItem[],index:number,rate:number) {
    if(this.disposed)return;
    this.invalidate(true);this.items=items;this.index=index;this.setRate(rate);void this.load(this.generation);
  }
  replaceItems(items:NarrationItem[]) {
    if(!this.items.length||!['loading','playing','paused'].includes(this.state.status)){this.items=items;return true}
    const current=this.items[this.index];const key=(item:NarrationItem)=>[item.lessonId,item.mode,item.blockId,item.chunk,item.part??'',item.tutor?.turnId??'',item.tutor?.part??''].join('|');
    const index=items.findIndex(item=>key(item)===key(current));if(index<0)return false;
    // Tutor polling rebuilds identical items every few seconds: keep audio already prefetched for an unchanged item
    // (same text position and voice) at its new index, so the single speech worker never renders the same chunk twice.
    const same=(a:NarrationItem,b:NarrationItem)=>JSON.stringify(a)===JSON.stringify(b);
    const kept=new Map<number,PrefetchedAudio>();
    for(const [at,entry] of this.prefetched) {
      const item=this.items[at];const moved=item?items.findIndex((candidate,i)=>i>index&&same(candidate,item)):-1;
      if(moved>=0&&!kept.has(moved))kept.set(moved,entry);
      else if(entry.audio)entry.audio.release();else void entry.promise.then(audio=>audio?.release());
    }
    this.prefetched=kept;this.items=items;this.index=index;return true;
  }
  private effectiveRate(){const pace=this.items[this.index]?.pace??'normal';const factor=pace==='focus'?0.9:pace==='brisk'?1.06:1;return Math.max(0.5,Math.min(2,this.rate*factor));}
  setRate(rate:number){this.rate=Math.max(0.5,Math.min(2,rate));this.audio.playbackRate=this.effectiveRate();}
  pause(){if(!['playing','loading'].includes(this.state.status))return;this.invalidate(false);this.update('paused');}
  resume(){if(this.disposed)return;this.waiting=false;if(this.state.status==='ended')this.index=0;const generation=this.generation;if(this.loaded)void this.play(generation);else void this.load(generation);}
  stop(){this.invalidate(true);this.update('idle');}
  /** The learner answered this check question: narration no longer waits for it, and continues if it was waiting. */
  answer(blockId:string){this.answered.add(blockId);if(this.waiting&&this.items[this.index]?.blockId===blockId)this.resume();}
  dispose(){this.stop();this.disposed=true;}
  private async load(generation:number) {
    const item=this.items[this.index];if(!item){this.update('ended');return;}
    this.update('loading');
    try {
      const prefetched=this.prefetched.get(this.index)?.promise;this.prefetched.delete(this.index);
      const audio=await (prefetched??this.render(item,this.abort.signal));
      if(generation!==this.generation||this.disposed){audio?.release();return;}
      const result=audio??await this.render(item,this.abort.signal);
      if(generation!==this.generation||this.disposed){result.release();return;}
      this.currentAudio=result;this.audio.src=result.url;this.audio.currentTime=0;this.loaded=true;await this.play(generation);
    } catch(error) {if(generation===this.generation&&!this.disposed)this.update('error',error instanceof Error?error.message:'Could not prepare narration.');}
  }
  private async play(generation:number) {
    this.audio.playbackRate=this.effectiveRate();
    const report=()=>{
      const item=this.items[this.index];
      if(item&&generation===this.generation&&this.state.status==='playing')this.progress({blockId:item.blockId,chunk:item.chunk,elapsed:this.audio.currentTime,duration:this.audio.duration});
    };
    this.audio.ontimeupdate=report;
    this.audio.onended=()=>{
      if(generation!==this.generation||this.state.status!=='playing')return;
      this.releaseCurrent();this.index++;
      if(this.index>=this.items.length){this.index=Math.max(0,this.items.length-1);this.update('ended');return;}
      const next=this.items[this.index];
      if(next.gate&&!this.answered.has(next.blockId)){this.waiting=true;this.update('paused');return;}
      void this.load(generation);
    };
    this.audio.onerror=()=>{if(generation===this.generation){this.invalidate(true);this.update('error','Could not play this audio. Press Play to retry.')}};
    try {
      await this.audio.play();if(generation!==this.generation||this.disposed)return;
      this.update('playing');
      report();
      // One request at a time: the speech server renders sequentially anyway, and parallel requests would hold
      // the browser's few connections to this server, stalling tutor and library requests behind narration.
      let previous:Promise<unknown>=Promise.resolve();const signal=this.abort.signal;
      for(let next=this.index+1;next<=this.index+prefetchAhead;next++){
        const item=this.items[next];if(!item)break;
        const existing=this.prefetched.get(next);if(existing){previous=existing.promise;continue}
        const entry:PrefetchedAudio={promise:Promise.resolve(undefined)};
        entry.promise=previous.then(()=>{
          if(generation!==this.generation||this.disposed||signal.aborted)return undefined;
          return this.render(item,signal).then(audio=>{
            if(generation!==this.generation||this.disposed){audio.release();return undefined;}
            entry.audio=audio;return audio;
          });
        }).catch(()=>undefined);
        previous=entry.promise;this.prefetched.set(next,entry);
      }
    } catch {if(generation===this.generation&&!this.disposed)this.update('error','Playback was blocked. Press Play to continue.');}
  }
}
