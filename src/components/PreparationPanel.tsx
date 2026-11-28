import { useState } from 'react';
import { Check, Circle, Clock, Copy, FolderOpen, LoaderCircle, RotateCcw, Sparkles, Square, TriangleAlert, X } from 'lucide-react';
import type { AgentUsage, PreparationJob, PreparationSection, PreparationState, Provider } from '../../shared/preparation';
import { api } from '../lib/api';
import { useSettings } from '../lib/settings';
import { ResearchOutline, waitHint } from './ResearchOutline';
import { familiarities, familiarityLabels, type Familiarity } from '../../shared/lesson';

const sectionStates: Record<string, string> = { waiting: 'Waiting', writing: 'Writing', reviewing: 'Reviewing', done: 'Done', failed: 'Failed' };
function duration(ms?: number) { if (ms === undefined) return ''; const total = Math.round(ms / 1000); return total < 60 ? total + 's' : Math.floor(total / 60) + 'm ' + (total % 60) + 's'; }
function tokens(n: number) { return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n); }
/** "Queued · position N of M" while waiting, "Waiting for your picks" at the topic outline, otherwise the server's stage text. */
export function stageLine(job: PreparationJob) { return job.status === 'awaiting-input' ? (job.steering?.status === 'choosing' ? 'Waiting for your picks' : 'Ready to resume') : job.status === 'queued' && job.queuePosition ? 'Queued · position ' + job.queuePosition + ' of ' + (job.queueLength ?? job.queuePosition) : job.stage; }
/** Lessons preparing now (running or stopping), waiting in the queue, and waiting for the learner's topic picks (which hold no slot). */
export function runCounts(state: PreparationState | null) { const jobs = state?.jobs ?? []; return { running: jobs.filter(j => j.status === 'running' || j.status === 'stopping').length, queued: jobs.filter(j => j.status === 'queued').length, waiting: jobs.filter(j => j.status === 'awaiting-input').length }; }
/** Screen-reader and tooltip label for the sidebar's agent button. */
export function agentsLabel(runs: ReturnType<typeof runCounts>) { return 'Agents: ' + runs.running + ' running, ' + runs.queued + ' queued' + (runs.waiting ? ', ' + runs.waiting + ' waiting for you' : ''); }
export function usageLine(u: AgentUsage) { return 'Tokens: ' + tokens(u.inputTokens) + ' in · ' + tokens(u.outputTokens) + ' out' + (u.cachedTokens ? ' (cached ' + tokens(u.cachedTokens) + ')' : '') + (u.costUsd !== undefined ? ' · $' + u.costUsd.toFixed(2) : '') + (u.partial ? ' · coordinator only; subagent tokens not reported' : ''); }
function SectionRow({ section }: { section: PreparationSection }) {
  const active = section.state === 'writing' || section.state === 'reviewing';
  return <li className={'section-row state-' + section.state}>
    <span className="section-icon" aria-hidden="true">{section.state === 'done' ? <Check size={14} /> : section.state === 'failed' ? <TriangleAlert size={14} /> : active ? <LoaderCircle size={14} className="spin" /> : <Circle size={12} />}</span>
    <span className="section-title">{section.title}</span>
    <span className="section-state">{sectionStates[section.state] ?? section.state}{section.durationMs !== undefined && ' · ' + duration(section.durationMs)}</span>
    {section.error && <span className="section-error">{section.error}</span>}
  </li>;
}
const steerKey='narad.steer';
/** The learner's last "Steer the research" choice, kept in this browser. Storage can be blocked, so both directions are best-effort. */
function rememberedSteer(){try{return localStorage.getItem(steerKey)==='1'}catch{return false}}
function rememberSteer(on:boolean){try{localStorage.setItem(steerKey,on?'1':'0')}catch{/* not remembered */}}
export function PreparationPanel({bundleId,ready,state,onChanged,onOpenLesson,topicOnly=false,familiarity:initialLevel='foundational'}:{bundleId:string;ready:boolean;topicOnly?:boolean;familiarity?:Familiarity;state:PreparationState|null;onChanged:()=>Promise<void>;onOpenLesson:(id:string)=>void}){
 const {defaultProvider,lessonsAtOnce}=useSettings().preparation;const [picked,setProvider]=useState<Provider>();const provider=picked??defaultProvider;const [pending,setPending]=useState(false);const [level,setLevel]=useState<Familiarity>(initialLevel);const [error,setError]=useState('');
 const [confirm,setConfirm]=useState<'restart'|'level'|null>(null);const [copied,setCopied]=useState(false);const [steer,setSteer]=useState(rememberedSteer);
 const job=state?.jobs.find(j=>j.bundleId===bundleId);const busy=job?.status==='running'||job?.status==='stopping';const queued=job?.status==='queued';const awaiting=job?.status==='awaiting-input';
 // A paused job whose plan is not open for picking (a confirm interrupted before it started, or an unreadable plan file) cannot be edited; Continue resumes it.
 const stalled=awaiting&&job?.steering?.status!=='choosing';
 const outline=!!job?.steering&&((awaiting&&!stalled)||(job.steering.status==='choosing'&&(busy||queued)));
 // Every slot taken by other lessons: a start now joins the queue instead.
 const willQueue=!busy&&!queued&&runCounts(state).running>=lessonsAtOnce;
 const resumable=!!job&&['interrupted','stopped','failed','cancelled'].includes(job.status);
 const available=state?.providers.filter(p=>p.available)??[];const chosen=available.some(p=>p.id===provider)?provider:available[0]?.id;
  // A steered lesson stays steered when it is continued or started over; the checkbox only decides for a topic-only lesson's first run.
 const steered=(topicOnly&&steer)||!!job?.steer;
 async function act(stop=false,action:'continue'|'restart'='continue'){setPending(true);setError('');setConfirm(null);try{if(stop&&job)await api.stopPreparation(job.id);else if(chosen)await api.prepare(bundleId,chosen,level,action,steered);await onChanged()}catch(e){setError(e instanceof Error?e.message:'Could not start preparation.')}finally{setPending(false)}}
 async function reveal(){setError('');try{if(job)await api.reveal(job.slug)}catch(e){setError(e instanceof Error?e.message:'Could not open the folder.')}}
 async function copyPath(){try{await navigator.clipboard.writeText(job!.folder);setCopied(true);setTimeout(()=>setCopied(false),1500)}catch{setError('Could not copy. Select the path and copy it instead.')}}
 // Continue keeps finished sections only for the level the run started with; another level starts over, so ask first.
 const levelChanged=level!==initialLevel;
 const disabled=pending||!ready||!chosen;
 return <section className="preparation-panel" aria-label="Lesson preparation"><div className="preparation-heading"><Sparkles size={20}/><div><h2>Turn these sources into a lesson</h2><p>A brief summary, a faithful walkthrough, and a tutor conversation—with the original visuals.</p></div></div>
 {job&&<div className="preparation-status">{!(outline&&!awaiting)&&<strong role="status">{stageLine(job)}</strong>}{busy&&!outline&&waitHint(job.stage)&&<small className="wait-hint">{waitHint(job.stage)}</small>}{busy&&job.total>0&&<><progress value={job.completed} max={job.total}/><small>{job.completed} of {job.total} sections checked</small></>}{job.error&&<p className="preparation-error" role="alert">{job.error}</p>}{stalled&&<p className="stage-note">This lesson was interrupted before it could start. Your picks are saved; press Continue to resume.</p>}{job.lessonId&&<button className="primary-button" onClick={()=>onOpenLesson(job.lessonId!)}>Open prepared lesson</button>}</div>}
 {outline&&job?<ResearchOutline job={job} onChanged={onChanged}/>:job&&(job.sections?.length??0)>0&&<ol className="section-list" aria-label="Sections">{job.sections.map(section=><SectionRow key={section.task} section={section}/>)}</ol>}
 {job?.usage&&<p className="stage-note usage-line">{usageLine(job.usage)}</p>}
 {job?.folder&&<div className="folder-row"><code className="folder-path">{job.folder}</code><button className="icon-button" onClick={()=>void copyPath()} aria-label="Copy folder path" title={copied?'Copied':'Copy folder path'}>{copied?<Check size={15}/>:<Copy size={15}/>}</button><button className="secondary-button" onClick={()=>void reveal()}><FolderOpen size={15}/>Open folder</button></div>}
 {topicOnly&&!busy&&!queued&&!awaiting&&<label className="steer-option"><input type="checkbox" checked={steered} disabled={pending||!!job?.steer} onChange={e=>{setSteer(e.target.checked);rememberSteer(e.target.checked)}}/><span><strong>Steer the research</strong><small>{job?.steer?'This lesson is steered: starting over draws a new outline for you to pick from':'Pick the topics before the lesson is written'}</small></span></label>}
 <div className="preparation-actions">{queued?<button className="secondary-button" disabled={pending} onClick={()=>void act(true)}><X size={14}/>Remove from queue</button>:busy?<button className="secondary-button" disabled={pending||job.status==='stopping'} onClick={()=>void act(true)}><Square size={14}/>{job.status==='stopping'?'Stopping…':'Stop preparation'}</button>:awaiting?<>{stalled&&<button className="primary-button" disabled={disabled} onClick={()=>void act(false,'continue')}>{pending?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>} Continue</button>}<button className="secondary-button" disabled={pending} onClick={()=>void act(true)}><Square size={14}/>Stop preparation</button><button className="secondary-button" disabled={disabled} onClick={()=>setConfirm('restart')}><RotateCcw size={15}/> Start over</button></>:<><label>Level<select aria-label="Learner level" value={level} onChange={e=>{setLevel(e.target.value as Familiarity);setConfirm(null)}} disabled={pending}>{familiarities.map(l=><option key={l} value={l}>{familiarityLabels[l]}</option>)}</select></label><label>Prepare with<select aria-label="Preparation agent" value={chosen??provider} onChange={e=>setProvider(e.target.value as Provider)} disabled={pending||!available.length}>{state?.providers.map(p=><option key={p.id} value={p.id} disabled={!p.available}>{p.id==='codex'?'Codex':'Claude'}{!p.available?' · unavailable':''}</option>)}</select></label>
  {resumable&&<button className="primary-button" disabled={disabled} onClick={()=>levelChanged?setConfirm('level'):void act(false,'continue')}>{pending?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>} Continue</button>}
  {job&&<button className={resumable?'secondary-button':'primary-button'} disabled={disabled} onClick={()=>setConfirm('restart')}>{pending&&!resumable?<LoaderCircle className="spin" size={16}/>:<RotateCcw size={15}/>} {job.status==='completed'?'Prepare a new version':'Start over'}</button>}
  {!job&&<button className="primary-button" disabled={disabled} onClick={()=>void act()}>{pending?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>} Prepare lesson</button>}</>}</div>
 {confirm&&!busy&&!queued&&<div className="confirm-inline" role="group" aria-label="Confirm"><p>{confirm==='level'?'Changing the level starts over. Finished sections are kept in the preparation folder’s runs/ archive.':'Start over? Finished sections move to the runs/ archive.'+(job?.steering?' Your topic picks are discarded.':'')}</p><button className="primary-button" disabled={pending} onClick={()=>void act(false,confirm==='level'?'continue':'restart')}>Confirm</button><button className="secondary-button" onClick={()=>setConfirm(null)}>Cancel</button></div>}
 {!ready&&<p className="stage-note">Resolve the source capture issues above before preparing.</p>}
 {state&&!available.length&&<p className="stage-note">Install Codex or Claude and sign in from a terminal. Restart Narad if the command was just added to PATH.</p>}
 {willQueue&&ready&&!!chosen&&<p className="stage-note"><Clock size={13} aria-hidden="true"/> Another lesson is preparing; this one will start when a slot frees up.</p>}
 <p className="stage-note">Uses your selected agent’s account. You can leave this page while it works. Stopping keeps the saved sources and completed drafts.</p>{error&&<p role="alert" className="preparation-error">{error}</p>}
 </section>;
}
export function PreparationHistory({state,onChanged,onOpenLesson,onOpenBundle}:{state:PreparationState|null;onChanged:()=>Promise<void>;onOpenLesson:(id:string)=>void;onOpenBundle?:(id:string)=>void}){
 const [error,setError]=useState('');
 async function stop(id:string){try{await api.stopPreparation(id);await onChanged()}catch(e){setError(String(e))}}
 return <div className="preparation-history"><p className="modal-description">{runCounts(state).running} preparing · {runCounts(state).queued} queued · {runCounts(state).waiting>0&&runCounts(state).waiting+' waiting for you · '}{state?.sessions.length??0} live agent sessions launched by Narad. Each session closes after its task. Other Codex and Claude windows are not included.</p>{!state?.jobs.length&&<p>No preparations yet. Open a saved source collection to begin.</p>}{state?.jobs.slice(0,12).map(job=><article key={job.id}><div><strong>{job.title}</strong><span>{job.provider==='codex'?'Codex':'Claude'} · {job.status==='queued'&&job.queuePosition?'queued #'+job.queuePosition:job.status==='awaiting-input'?'waiting for your picks':job.status}</span><p>{stageLine(job)}</p>{job.error&&<p className="preparation-error">{job.error}</p>}</div>{job.status==='queued'?<button className="secondary-button" onClick={()=>void stop(job.id)}>Remove from queue</button>:(job.status==='running'||job.status==='stopping')?<button className="secondary-button" disabled={job.status==='stopping'} onClick={()=>void stop(job.id)}>Stop preparation</button>:job.status==='awaiting-input'&&onOpenBundle?<button className="text-link" onClick={()=>onOpenBundle(job.bundleId)}>Choose topics</button>:job.lessonId?<button className="text-link" onClick={()=>onOpenLesson(job.lessonId!)}>Open lesson</button>:null}</article>)}{error&&<p role="alert">{error}</p>}</div>;
}
