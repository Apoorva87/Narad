import type { SpeechRequest, SpeechAudio, SpeechPace } from '../../shared/speech';
export type NarrationItem = SpeechRequest & {pace?:SpeechPace;tutor?:{turnId:string;part:'question'|'answer'}};
export type NarrationState = {status:'idle'|'loading'|'playing'|'paused'|'ended'|'error';blockId?:string;chunk?:number;tutor?:NarrationItem['tutor'];error?:string};
export type NarrationProgress = {blockId:string;chunk:number;elapsed:number;duration:number};
export interface AudioPort {
  src:string;currentTime:number;duration:number;playbackRate:number;preservesPitch:boolean;
  ontimeupdate:((event:Event)=>unknown)|null;
  onended:((event:Event)=>unknown)|null;onerror:((event:Event|string)=>unknown)|null;
  play():Promise<void>;pause():void;load():void;removeAttribute(name:string):void;
}
type Render=(item:NarrationItem,signal:AbortSignal)=>Promise<SpeechAudio>;
type PrefetchedAudio={promise:Promise<SpeechAudio|undefined>;audio?:SpeechAudio};

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
  constructor(private audio:AudioPort,private render:Render,private changed:(state:NarrationState)=>void,private progress:(value?:NarrationProgress)=>void=()=>{}) {audio.preservesPitch=true;}
  private update(status:NarrationState['status'],error?:string) {
    if(this.disposed)return;
    this.state={status,blockId:this.items[this.index]?.blockId,chunk:this.items[this.index]?.chunk,tutor:this.items[this.index]?.tutor,error};this.changed(this.state);
    if(status!=='playing')this.progress();
  }
  private invalidate(clearAudio:boolean) {
    this.generation++;this.abort.abort();this.abort=new AbortController();
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
    const current=this.items[this.index];const key=(item:NarrationItem)=>[item.lessonId,item.mode,item.blockId,item.chunk,item.tutor?.turnId??'',item.tutor?.part??''].join('|');
    const index=items.findIndex(item=>key(item)===key(current));if(index<0)return false;
    for(const entry of this.prefetched.values()) {if(entry.audio)entry.audio.release();else void entry.promise.then(audio=>audio?.release())}this.prefetched.clear();
    this.items=items;this.index=index;return true;
  }
  private effectiveRate(){const pace=this.items[this.index]?.pace??'normal';const factor=pace==='focus'?0.9:pace==='brisk'?1.06:1;return Math.max(0.5,Math.min(2,this.rate*factor));}
  setRate(rate:number){this.rate=Math.max(0.5,Math.min(2,rate));this.audio.playbackRate=this.effectiveRate();}
  pause(){if(!['playing','loading'].includes(this.state.status))return;this.invalidate(false);this.update('paused');}
  resume(){if(this.disposed)return;if(this.state.status==='ended')this.index=0;const generation=this.generation;if(this.loaded)void this.play(generation);else void this.load(generation);}
  stop(){this.invalidate(true);this.update('idle');}
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
      void this.load(generation);
    };
    this.audio.onerror=()=>{if(generation===this.generation){this.invalidate(true);this.update('error','Could not play this audio. Press Play to retry.')}};
    try {
      await this.audio.play();if(generation!==this.generation||this.disposed)return;
      this.update('playing');
      report();
      for(let next=this.index+1;next<=this.index+3;next++){
        if(!this.items[next]||this.prefetched.has(next))continue;
        const entry:PrefetchedAudio={promise:Promise.resolve(undefined)};
        entry.promise=this.render(this.items[next],this.abort.signal).then(audio=>{
          if(generation!==this.generation||this.disposed){audio.release();return undefined;}
          entry.audio=audio;return audio;
        }).catch(()=>undefined);
        this.prefetched.set(next,entry);
      }
    } catch {if(generation===this.generation&&!this.disposed)this.update('error','Playback was blocked. Press Play to continue.');}
  }
}
