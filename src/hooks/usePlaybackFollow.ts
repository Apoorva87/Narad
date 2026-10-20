import { useCallback,useEffect,useRef } from 'react';
import type { Lesson,Mode } from '../../shared/lesson';
import { splitSpeech } from '../../shared/speech';
import { flattenBlocks } from '../../shared/navigation';
import type { NarrationProgress } from '../lib/narration';
import { passageFraction,playbackScrollTop } from '../lib/playback-follow';

export function usePlaybackFollow(lesson:Lesson,mode:Mode) {
  const context=useRef({lesson,mode});context.current={lesson,mode};
  const latest=useRef<NarrationProgress|undefined>(undefined);
  const frame=useRef(0);
  const observer=useRef<ResizeObserver|undefined>(undefined);
  const blockElement=useRef<HTMLElement|undefined>(undefined);
  const schedule=useCallback(()=>{
    cancelAnimationFrame(frame.current);
    frame.current=requestAnimationFrame(()=>{
      const progress=latest.current,element=blockElement.current;if(!progress||!element)return;
      const block=flattenBlocks(context.current.lesson,context.current.mode).find(item=>item.block.id===progress.blockId)?.block;
      if(!block)return;
      const rect=element.getBoundingClientRect();
      const controls=document.querySelector('.reading-controls')?.getBoundingClientRect();
      const top=playbackScrollTop({top:rect.top+window.scrollY,height:rect.height,viewport:window.innerHeight,controlsHeight:controls?.height??0,fraction:passageFraction(splitSpeech(block.spokenText),progress.chunk,progress.elapsed,progress.duration)});
      if(Math.abs(window.scrollY-top)>2)window.scrollTo({top,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    });
  },[]);
  const follow=useCallback((progress?:NarrationProgress)=>{
    latest.current=progress;
    if(!progress){
      cancelAnimationFrame(frame.current);observer.current?.disconnect();blockElement.current=undefined;
      // Cancel an in-flight smooth scroll immediately when narration pauses or stops.
      window.scrollTo({top:window.scrollY,behavior:'instant'});return;
    }
    const element=document.getElementById('block-'+progress.blockId);
    if(!element)return;
    if(blockElement.current!==element){
      observer.current?.disconnect();blockElement.current=element;
      observer.current=new ResizeObserver(schedule);observer.current.observe(element);
      const controls=document.querySelector('.reading-controls');if(controls)observer.current.observe(controls);
    }
    schedule();
  },[schedule]);
  useEffect(()=>{window.addEventListener('resize',schedule);return()=>{follow();window.removeEventListener('resize',schedule)}},[follow,schedule,lesson.id,mode]);
  return follow;
}
