import { expect, it } from 'vitest';
import { NarrationController, type AudioPort, type NarrationItem } from '../src/lib/narration';
const items:NarrationItem[]=[{lessonId:'lesson',mode:'walkthrough',blockId:'one',chunk:0,voice:'Ryan'},{lessonId:'lesson',mode:'walkthrough',blockId:'one',chunk:1,voice:'Ryan'},{lessonId:'lesson',mode:'walkthrough',blockId:'two',chunk:0,voice:'Aiden'}];
class TestAudio implements AudioPort {
 duration=1;ontimeupdate:(()=>void)|null=null;
 src='';currentTime=0;playbackRate=1;preservesPitch=true;paused=true;onended:(()=>void)|null=null;onerror:(()=>void)|null=null;played:string[]=[];
 async play(){this.paused=false;this.played.push(this.src)} pause(){this.paused=true} load(){} removeAttribute(){this.src=''}
}
const tick=()=>new Promise(r=>setTimeout(r,0));
it('buffers six following segments in memory after playback begins',async()=>{
 const audio=new TestAudio();const requested:number[]=[];
 const buffered:NarrationItem[]=Array.from({length:9},(_,chunk)=>({...items[0],chunk}));
 const controller=new NarrationController(audio,async item=>{requested.push(item.chunk);return {url:`/${item.chunk}.wav`,release:()=>{}}},()=>{});
 controller.start(buffered,0,1);await tick();
 expect(requested).toEqual([0,1,2,3,4,5,6]);controller.dispose();
});
it('never plays a late response after navigating to a different passage',async()=>{
 const audio=new TestAudio();let release!:(v:any)=>void;const controller=new NarrationController(audio,(item)=>item.blockId==='one'?new Promise(r=>release=r):Promise.resolve({url:'/two.wav',release:()=>{}}),()=>{});
 controller.start(items,0,1);controller.start(items,2,1);await tick();release({url:'/old.wav',release:()=>{}});await tick();
 expect(audio.played).toEqual(['/two.wav']);controller.dispose();
});
it('pause is immediate, resumes the same audio offset, and rate changes do not regenerate',async()=>{
 const audio=new TestAudio();const controller=new NarrationController(audio,async()=>({url:'/one.wav',release:()=>{}}),()=>{});
 controller.start(items,0,1);await tick();audio.currentTime=0.4;controller.pause();expect(audio.paused).toBe(true);
 controller.setRate(1.5);controller.resume();await tick();expect(audio.currentTime).toBe(0.4);expect(audio.playbackRate).toBe(1.5);expect(audio.preservesPitch).toBe(true);controller.dispose();
});
it('adjusts each segment around the learner selected baseline speed',async()=>{
 const paced:NarrationItem[]=[
  {...items[0],pace:'focus'},
  {...items[1],pace:'brisk'},
 ];
 const audio=new TestAudio();const rates:number[]=[];
 audio.play=async()=>{audio.paused=false;rates.push(audio.playbackRate)};
 const controller=new NarrationController(audio,async()=>({url:'/segment.wav',release:()=>{}}),()=>{});
 controller.start(paced,0,1.5);await tick();
 expect(rates).toEqual([1.35]);
 controller.setRate(2);expect(audio.playbackRate).toBe(1.8);
 audio.onended!();await tick();
 expect(rates).toEqual([1.35,2]);
 controller.dispose();
});
it('advances through chunks before moving the passage and ends without looping',async()=>{
 const audio=new TestAudio();const active:string[]=[];const controller=new NarrationController(audio,async item=>({url:`/${item.blockId}-${item.chunk}.wav`,release:()=>{}}),s=>{if(s.status==='playing')active.push(s.blockId!)});
 controller.start(items,0,1);await tick();audio.onended!();await tick();audio.onended!();await tick();audio.onended!();await tick();
 expect(audio.played).toEqual(['/one-0.wav','/one-1.wav','/two-0.wav']);expect(active).toEqual(['one','one','two']);expect(controller.state.status).toBe('ended');controller.dispose();
});
it('pause during loading and disposal both invalidate pending playback',async()=>{
 const audio=new TestAudio();let release!:(v:any)=>void;const controller=new NarrationController(audio,()=>new Promise(r=>release=r),()=>{});
 controller.start(items,0,1);controller.pause();release({url:'/late.wav',release:()=>{}});await tick();expect(audio.played).toEqual([]);
 controller.resume();controller.dispose();release({url:'/later.wav',release:()=>{}});await tick();expect(audio.played).toEqual([]);
});
it('reports autoplay rejection and can retry without losing the passage',async()=>{
 const audio=new TestAudio();let first=true;audio.play=async()=>{if(first){first=false;throw new Error('NotAllowedError')}audio.paused=false};
 const controller=new NarrationController(audio,async()=>({url:'/one.wav',release:()=>{}}),()=>{});controller.start(items,0,1);await tick();
 expect(controller.state.status).toBe('error');expect(controller.state.blockId).toBe('one');controller.resume();await tick();expect(controller.state.status).toBe('playing');controller.dispose();
});

it('releases completed audio and buffered look-ahead on stop while keeping paused audio resumable',async()=>{
 const audio=new TestAudio();const released:string[]=[];
 const controller=new NarrationController(audio,async item=>({url:`/${item.blockId}-${item.chunk}`,release:()=>released.push(`${item.blockId}-${item.chunk}`)}),()=>{});
 controller.start(items,0,1);await tick();controller.pause();
 expect(released).toEqual(['one-1','two-0']);controller.resume();await tick();audio.onended!();await tick();
 expect(released).toContain('one-0');controller.stop();await tick();
 expect(released.sort()).toEqual(['one-0','one-1','one-1','two-0','two-0']);expect(audio.src).toBe('');controller.dispose();
});
it('releases late current and prefetch responses after cancellation',async()=>{
 const audio=new TestAudio();const released:string[]=[];let resolveCurrent!:(v:any)=>void;
 const controller=new NarrationController(audio,()=>new Promise(r=>resolveCurrent=r),()=>{});
 controller.start(items,0,1);controller.stop();resolveCurrent({url:'blob:late',release:()=>released.push('current')});await tick();
 controller.start(items,0,1);resolveCurrent({url:'blob:now',release:()=>released.push('playing')});await tick();
 controller.pause();resolveCurrent({url:'blob:prefetch',release:()=>released.push('prefetch')});await tick();
 expect(released).toEqual(['current','prefetch']);controller.dispose();expect(released).toEqual(['current','prefetch','playing']);
});
it('can insert expanded replies after the current passage without restarting its audio',async()=>{
 const audio=new TestAudio();const controller=new NarrationController(audio,async item=>({url:`/${item.blockId}-${item.chunk}-${item.tutor?.part??'lesson'}`,release:()=>{}}),()=>{});
 controller.start(items,0,1);await tick();audio.currentTime=.35;
 const withReply=[items[0],{...items[0],tutor:{turnId:'turn-1',part:'question' as const}},{...items[0],tutor:{turnId:'turn-1',part:'answer' as const}},...items.slice(1)];
 expect(controller.replaceItems(withReply)).toBe(true);expect(audio.currentTime).toBe(.35);expect(audio.paused).toBe(false);
 audio.onended!();await tick();expect(audio.played[1]).toContain('question');controller.dispose();
});
it('keeps prefetched audio when polling rebuilds the same items, so no chunk is rendered twice',async()=>{
 const audio=new TestAudio();const rendered:string[]=[];const released:string[]=[];
 const controller=new NarrationController(audio,async item=>{const id=`${item.blockId}-${item.chunk}`;rendered.push(id);return {url:'/'+id,release:()=>released.push(id)}},()=>{});
 controller.start(items,0,1);await tick();
 for(let poll=0;poll<3;poll++)expect(controller.replaceItems(structuredClone(items))).toBe(true);
 expect(released).toEqual([]);audio.onended!();await tick();
 expect(rendered.filter(id=>id===rendered[1])).toHaveLength(1);controller.dispose();
});
it('prefetches one chunk at a time so narration holds at most one server request',async()=>{
 const audio=new TestAudio();let open=0,peak=0;const requested:number[]=[];
 const buffered:NarrationItem[]=Array.from({length:9},(_,chunk)=>({...items[0],chunk}));
 const controller=new NarrationController(audio,async item=>{open++;peak=Math.max(peak,open);requested.push(item.chunk);await new Promise(r=>setTimeout(r,2));open--;return {url:`/${item.chunk}.wav`,release:()=>{}}},()=>{});
 controller.start(buffered,0,1);await expect.poll(()=>requested.length).toBe(7);
 expect(peak).toBeLessThanOrEqual(1);expect(requested).toEqual([0,1,2,3,4,5,6]);controller.dispose();
});
