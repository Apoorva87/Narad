import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Mode } from '../../shared/lesson';
import type { TutorAsk, TutorState, TutorTurn } from '../../shared/tutor';
import { api } from '../lib/api';

const empty: TutorState = { providers: [], threads: [] };
export function useTutor(lessonId:string,mode:Mode) {
  const [state,setState]=useState<TutorState>(empty);const [error,setError]=useState('');const [expanded,setExpanded]=useState<Set<string>>(new Set());
  const current=useRef('');current.current=lessonId+'|'+mode;
  // Polling usually returns what is already shown: keep the same object then, so the reader and narration queue do not rebuild every few seconds.
  // A response for a lesson or mode the reader has since left is dropped.
  const refresh=useCallback(async()=>{const asked=lessonId+'|'+mode;try{const next=await api.tutorState(lessonId,mode);if(current.current!==asked)return;setState(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);setError('')}catch(error){if(current.current===asked)setError(error instanceof Error?error.message:'Tutor is unavailable.')}},[lessonId,mode]);
  useEffect(()=>{let active=true;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{if(active)await refresh();if(active)timer=setTimeout(poll,state.activeTurnId?900:4000)};void poll();return()=>{active=false;clearTimeout(timer)}},[refresh,state.activeTurnId]);
  useEffect(()=>{setExpanded(new Set())},[mode]);
  const threadFor=useCallback((blockId:string)=>state.threads.find(thread=>thread.blockId===blockId),[state.threads]);
  async function ask(input:TutorAsk){const turn=await api.askTutor(lessonId,input);setExpanded(previous=>new Set(previous).add(input.blockId));await refresh();return turn}
  async function stop(id:string){await api.stopTutor(id);await refresh()}
  async function remove(id:string){await api.deleteTutorTurn(id);await refresh()}
  const playback=useMemo(()=>Object.fromEntries(state.threads.filter(thread=>expanded.has(thread.blockId)).map(thread=>[thread.blockId,thread.turns.filter(turn=>turn.status==='ready')])),[state.threads,expanded]);
  return {state,error,expanded,threadFor,playback,refresh,ask,stop,remove,toggle:(blockId:string)=>setExpanded(previous=>{const next=new Set(previous);if(next.has(blockId))next.delete(blockId);else next.add(blockId);return next})};
}
