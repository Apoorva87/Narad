import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LoaderCircle, MessageCircleQuestion, Mic, Pause, Play, Search, Send, Square, Trash2 } from 'lucide-react';
import type { Lesson, Mode } from '../../shared/lesson';
import type { Provider } from '../../shared/preparation';
import type { TutorAsk, TutorThread, TutorTurn } from '../../shared/tutor';
import { TutorAnswer } from './TutorAnswer';

type Recognition = {continuous:boolean;interimResults:boolean;lang:string;start():void;stop():void;onresult:((event:any)=>void)|null;onerror:((event:any)=>void)|null;onend:(()=>void)|null};
function recognition():Recognition|undefined {const Constructor=(window as any).SpeechRecognition||(window as any).webkitSpeechRecognition;return Constructor?new Constructor():undefined}

export function ReplyThread({lesson,mode,sectionId,blockId,thread,providers,expanded,busy,playback,onToggle,onBegin,onAsk,onStop,onRemove,onPlay,onContinue}:{
  lesson:Lesson;mode:Mode;sectionId:string;blockId:string;thread?:TutorThread;providers:{id:Provider;available:boolean}[];expanded:boolean;busy:boolean;playback:{status:string;turnId?:string;error?:string};
  onToggle:()=>void;onBegin:()=>boolean;onAsk:(input:TutorAsk)=>Promise<TutorTurn>;onStop:(id:string)=>Promise<void>;onRemove:(id:string)=>Promise<void>;onPlay:(turn:TutorTurn,part?:'question'|'answer')=>void;onContinue:()=>void;
}) {
  const [composing,setComposing]=useState(false),[question,setQuestion]=useState(''),[scope,setScope]=useState<'lesson'|'research'>('lesson'),[provider,setProvider]=useState<Provider>('codex'),[error,setError]=useState(''),[listening,setListening]=useState(false);const pending=useRef<{id:string;auto:boolean}|undefined>(undefined);const heard=useRef(new Set<string>());const rec=useRef<Recognition|undefined>(undefined);
  const turns=thread?.turns??[];const running=turns.find(turn=>['queued','reading','answering'].includes(turn.status));
  useEffect(()=>{const first=providers.find(item=>item.available);if(first)setProvider(first.id)},[providers]);
  useEffect(()=>{const value=pending.current;if(!value||heard.current.has(value.id))return;const turn=turns.find(item=>item.id===value.id&&item.status==='ready');if(turn){heard.current.add(turn.id);if(value.auto)onPlay(turn);pending.current=undefined}},[turns,onPlay]);
  useEffect(()=>()=>rec.current?.stop(),[]);
  function dictate(){if(listening){rec.current?.stop();return}const speech=recognition();if(!speech){setError('Voice transcription is not available in this browser. Use the keyboard microphone or type your question.');return}speech.continuous=false;speech.interimResults=true;speech.lang='en-US';speech.onresult=event=>{let text='';for(let i=event.resultIndex;i<event.results.length;i++)text+=event.results[i][0].transcript;setQuestion(previous=>(previous&&event.resultIndex===0?previous+' ':'')+text)};speech.onerror=()=>setError('I could not transcribe that. You can edit the text or try again.');speech.onend=()=>setListening(false);rec.current=speech;setListening(true);speech.start()}
  async function submit(){setError('');const auto=onBegin();try{const turn=await onAsk({mode,sectionId,blockId,question,provider,scope});pending.current={id:turn.id,auto};setQuestion('');setComposing(false)}catch(error){setError(error instanceof Error?error.message:'Could not ask the tutor.')}}
  return <div className={'reply-thread'+(expanded?' expanded':'')}>
    <div className="reply-actions"><button className="reply-toggle" onClick={onToggle} aria-expanded={expanded}><MessageCircleQuestion size={16}/>{turns.length?`Replies ${turns.length}`:'Ask tutor'}<ChevronDown size={14}/></button>{turns.length>0&&<button onClick={()=>setComposing(true)}>Ask a follow-up</button>}</div>
    {expanded&&<div className="reply-board">
      {turns.map(turn=><article className="reply-turn" key={turn.id}>
        <div className="learner-message"><div className="message-author">You</div><p>{turn.question}</p></div>
        <div className="tutor-message"><div className="message-author">Narad tutor <span>{turn.scope==='research'?'Researched answer':'From this lesson'}</span></div>
          {turn.answer? <>{turn.answer.blocks.map((block,index)=><TutorAnswer key={index} block={block} lesson={lesson}/>)}
            {turn.answer.citations.length>0&&<div className="tutor-citations"><strong>References</strong>{turn.answer.citations.map((citation,index)=>citation.url?<a key={index} href={citation.url} target="_blank" rel="noreferrer">{citation.title}</a>:<span key={index}>{citation.title}{citation.locator?' · '+citation.locator:''}</span>)}</div>}
            <div className="reply-controls"><button onClick={()=>onPlay(turn)}>{playback.turnId===turn.id&&playback.status==='playing'?<Pause size={14}/>:<Play size={14}/>}Listen</button><button onClick={()=>{setQuestion(turn.answer!.suggestedFollowUps[0]??'');setComposing(true)}}>Follow up</button>{playback.turnId===turn.id&&['ended','error'].includes(playback.status)&&<button className="continue-lesson" onClick={onContinue}>Continue lesson</button>}<button aria-label="Remove reply" title="Remove reply" onClick={()=>void onRemove(turn.id)}><Trash2 size={14}/></button></div>
          </>:<div className={'reply-progress '+turn.status} role="status">{['queued','reading','answering'].includes(turn.status)&&<LoaderCircle className="spin" size={16}/>}<span>{turn.stage}</span>{turn.error&&<small>{turn.error}</small>}{['queued','reading','answering'].includes(turn.status)&&<button onClick={()=>void onStop(turn.id)}><Square size={12}/>Stop</button>}</div>}
        </div>
      </article>)}
      {(composing||turns.length===0)&&<div className="tutor-composer"><textarea value={question} onChange={event=>setQuestion(event.target.value)} placeholder="What would you like explained?" aria-label="Question for the tutor" rows={3}/><div className="composer-options"><button className={listening?'recording':''} onClick={dictate} type="button"><Mic size={15}/>{listening?'Listening…':'Dictate'}</button><select value={scope} onChange={event=>setScope(event.target.value as 'lesson'|'research')} aria-label="Answer scope"><option value="lesson">Explain this lesson</option><option value="research">Research further</option></select><select value={provider} onChange={event=>setProvider(event.target.value as Provider)} aria-label="Tutor agent">{providers.map(item=><option key={item.id} value={item.id} disabled={!item.available}>{item.id==='codex'?'Codex':'Claude'}{item.available?'':' · unavailable'}</option>)}</select><button className="send-question" disabled={!question.trim()||busy||!providers.some(item=>item.id===provider&&item.available)} onClick={()=>void submit()}><Send size={15}/>Ask</button></div><p className="transcript-note">Voice is transcribed here first so you can edit it before sending.</p>{scope==='research'&&<p className="research-note"><Search size={13}/>The agent may search the web and will show citations.</p>}{error&&<p role="alert" className="reply-error">{error}</p>}</div>}
    </div>}
  </div>;
}
