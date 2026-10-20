import { useEffect, useRef, useState } from 'react';
import type { Lesson, Mode } from '../../shared/lesson';
import { type SpeechPreferences, type SpeechStatus } from '../../shared/speech';
import { NarrationController, type NarrationState,type NarrationProgress } from '../lib/narration';
import { api } from '../lib/api';
import { updateSettings, useSettings } from '../lib/settings';
import type { TutorTurn } from '../../shared/tutor';
import { buildNarrationItems } from '../lib/narration-items';

export function useNarration(lesson:Lesson,mode:Mode,activeId:string,onActive:(blockId:string)=>void,onProgress:(progress?:NarrationProgress)=>void,replies:Record<string,TutorTurn[]>={}) {
  const [state,setState]=useState<NarrationState>({status:'idle'});
  // Voices and speed are app settings, so the reader and the Settings page stay in step.
  const preferences:SpeechPreferences=useSettings().voice;
  const [server,setServer]=useState<SpeechStatus>();
  const controller=useRef<NarrationController|null>(null);
  const activeCallback=useRef(onActive);activeCallback.current=onActive;
  const progressCallback=useRef(onProgress);progressCallback.current=onProgress;
  const selectedId=useRef(activeId);selectedId.current=activeId;
  useEffect(()=>{
    const audio=new Audio();audio.preload='auto';
    const player=new NarrationController(audio,({pace:_,tutor,...request},signal)=>tutor?api.renderTutorSpeech({turnId:tutor.turnId,part:tutor.part,chunk:request.chunk,voice:request.voice},signal):api.renderSpeech(request,signal),next=>{
      setState(next);
      if((next.status==='playing'||next.status==='loading')&&next.blockId&&next.blockId!==selectedId.current)activeCallback.current(next.blockId);
    },progress=>progressCallback.current(progress));
    controller.current=player;
    return()=>{player.dispose();controller.current=null};
  },[lesson.id]);
  useEffect(()=>{
    let alive=true;
    const refresh=()=>api.speechStatus().then(value=>{if(alive)setServer(value)}).catch(()=>{if(alive)setServer({state:'error',model:'Local speech',message:'Cannot reach the local speech server.'})});
    void refresh();const timer=setInterval(refresh,3000);
    return()=>{alive=false;clearInterval(timer)};
  },[]);
  const items=(prefs=preferences)=>buildNarrationItems(lesson,mode,prefs,replies);
  useEffect(()=>{controller.current?.replaceItems(items())},[mode,replies,preferences.narrator,preferences.host,preferences.expert]);
  function start(blockId:string,prefs=preferences) {const all=items(prefs);controller.current?.start(all,Math.max(0,all.findIndex(i=>i.blockId===blockId)),prefs.rate);}
  function toggle() {
    const player=controller.current;if(!player)return;
    if(['playing','loading'].includes(player.state.status))player.pause();
    else if(['paused','error'].includes(player.state.status))player.resume();
    else start(activeId);
  }
  function navigate(blockId:string) {
    if(['playing','loading'].includes(controller.current?.state.status||''))start(blockId);
    else controller.current?.stop();
  }
  function updatePreferences(next:SpeechPreferences) {
    void updateSettings({voice:next}).catch(()=>{/* The previous voice is restored; reading continues. */});
    const voiceChanged=next.narrator!==preferences.narrator||next.host!==preferences.host||next.expert!==preferences.expert;
    if(voiceChanged) {
      if(['playing','loading'].includes(controller.current?.state.status||''))start(activeId,next);
      else controller.current?.stop();
    } else controller.current?.setRate(next.rate);
  }
  return {state,preferences,server,toggle,navigate,updatePreferences,stop:()=>controller.current?.stop(),pause:()=>controller.current?.pause(),resume:()=>controller.current?.resume()};
}
