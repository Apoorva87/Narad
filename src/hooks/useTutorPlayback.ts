import { useEffect, useRef, useState } from 'react';
import { planSpeech, type SpeechPreferences } from '../../shared/speech';
import type { TutorTurn } from '../../shared/tutor';
import { api } from '../lib/api';

export function useTutorPlayback() {
  const [state,setState]=useState<{status:'idle'|'loading'|'playing'|'ended'|'error';turnId?:string;error?:string}>({status:'idle'});
  const active=useRef<{audio:HTMLAudioElement;controller:AbortController;release?:()=>void;cancelWait?:()=>void}|undefined>(undefined);
  function cancel(){const current=active.current;if(current){current.controller.abort();current.cancelWait?.();current.audio.pause();current.release?.();active.current=undefined}}
  function stop(){cancel();setState({status:'idle'})}
  useEffect(()=>()=>cancel(),[]);
  async function play(turn:TutorTurn,prefs:SpeechPreferences,part?:'question'|'answer') {
    stop();if(!turn.answer&&part!=='question')return;const audio=new Audio();audio.preload='auto';audio.preservesPitch=true;audio.playbackRate=prefs.rate;const controller=new AbortController();active.current={audio,controller};
    const parts=(part?[part]:['question','answer'] as const).filter(value=>value==='question'||!!turn.answer);
    try {
      for(const value of parts){const text=value==='question'?turn.question:turn.answer!.blocks.map(block=>block.spokenText).join(' ');const voice=value==='question'?prefs.host:prefs.expert;
        for(let chunk=0;chunk<planSpeech(text).length;chunk++){
          setState({status:'loading',turnId:turn.id});const rendered=await api.renderTutorSpeech({turnId:turn.id,part:value,chunk,voice},controller.signal);controller.signal.throwIfAborted();active.current!.release=rendered.release;audio.src=rendered.url;audio.currentTime=0;
          await new Promise<void>((resolve,reject)=>{active.current!.cancelWait=()=>reject(new DOMException('Playback stopped.','AbortError'));audio.onended=()=>resolve();audio.onerror=()=>reject(new Error('Could not play this tutor reply.'));setState({status:'playing',turnId:turn.id});audio.play().catch(reject)});rendered.release();if(active.current){active.current.release=undefined;active.current.cancelWait=undefined}
        }
      }
      if(active.current?.controller===controller){active.current=undefined;setState({status:'ended',turnId:turn.id})}
    } catch(error) {if(!controller.signal.aborted)setState({status:'error',turnId:turn.id,error:error instanceof Error?error.message:'Could not play this tutor reply.'})}
  }
  return {state,play,stop};
}
