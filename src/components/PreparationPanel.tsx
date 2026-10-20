import { useState } from 'react';
import { Check, Circle, Copy, FolderOpen, LoaderCircle, RotateCcw, Sparkles, Square, TriangleAlert } from 'lucide-react';
import type { PreparationSection, PreparationState, Provider } from '../../shared/preparation';
import { api } from '../lib/api';
import { useSettings } from '../lib/settings';
import { familiarities, familiarityLabels, type Familiarity } from '../../shared/lesson';

const sectionStates: Record<string, string> = { waiting: 'Waiting', writing: 'Writing', reviewing: 'Reviewing', done: 'Done', failed: 'Failed' };
function duration(ms?: number) { if (ms === undefined) return ''; const total = Math.round(ms / 1000); return total < 60 ? total + 's' : Math.floor(total / 60) + 'm ' + (total % 60) + 's'; }
function SectionRow({ section }: { section: PreparationSection }) {
  const active = section.state === 'writing' || section.state === 'reviewing';
  return <li className={'section-row state-' + section.state}>
    <span className="section-icon" aria-hidden="true">{section.state === 'done' ? <Check size={14} /> : section.state === 'failed' ? <TriangleAlert size={14} /> : active ? <LoaderCircle size={14} className="spin" /> : <Circle size={12} />}</span>
    <span className="section-title">{section.title}</span>
    <span className="section-state">{sectionStates[section.state] ?? section.state}{section.durationMs !== undefined && ' · ' + duration(section.durationMs)}</span>
    {section.error && <span className="section-error">{section.error}</span>}
  </li>;
}
export function PreparationPanel({bundleId,ready,state,onChanged,onOpenLesson,familiarity:initialLevel='foundational'}:{bundleId:string;ready:boolean;familiarity?:Familiarity;state:PreparationState|null;onChanged:()=>Promise<void>;onOpenLesson:(id:string)=>void}){
 const defaultProvider=useSettings().preparation.defaultProvider;const [picked,setProvider]=useState<Provider>();const provider=picked??defaultProvider;const [pending,setPending]=useState(false);const [level,setLevel]=useState<Familiarity>(initialLevel);const [error,setError]=useState('');
 const [confirm,setConfirm]=useState<'restart'|'level'|null>(null);const [copied,setCopied]=useState(false);
 const job=state?.jobs.find(j=>j.bundleId===bundleId);const busy=job?.status==='running'||job?.status==='stopping';const anyBusy=state?.jobs.some(j=>j.status==='running'||j.status==='stopping');
 const resumable=!!job&&['interrupted','stopped','failed','cancelled'].includes(job.status);
 const available=state?.providers.filter(p=>p.available)??[];const chosen=available.some(p=>p.id===provider)?provider:available[0]?.id;
 async function act(stop=false,action:'continue'|'restart'='continue'){setPending(true);setError('');setConfirm(null);try{if(stop&&job)await api.stopPreparation(job.id);else if(chosen)await api.prepare(bundleId,chosen,level,action);await onChanged()}catch(e){setError(e instanceof Error?e.message:'Could not start preparation.')}finally{setPending(false)}}
 async function reveal(){setError('');try{if(job)await api.reveal(job.slug)}catch(e){setError(e instanceof Error?e.message:'Could not open the folder.')}}
 async function copyPath(){try{await navigator.clipboard.writeText(job!.folder);setCopied(true);setTimeout(()=>setCopied(false),1500)}catch{setError('Could not copy. Select the path and copy it instead.')}}
 // Continue keeps finished sections only for the level the run started with; another level starts over, so ask first.
 const levelChanged=level!==initialLevel;
 const disabled=pending||anyBusy||!ready||!chosen;
 return <section className="preparation-panel" aria-label="Lesson preparation"><div className="preparation-heading"><Sparkles size={20}/><div><h2>Turn these sources into a lesson</h2><p>A brief summary, a faithful walkthrough, and a tutor conversation—with the original visuals.</p></div></div>
 {job&&<div className="preparation-status"><strong role="status">{job.stage}</strong>{busy&&job.total>0&&<><progress value={job.completed} max={job.total}/><small>{job.completed} of {job.total} sections checked</small></>}{job.error&&<p className="preparation-error" role="alert">{job.error}</p>}{job.lessonId&&<button className="primary-button" onClick={()=>onOpenLesson(job.lessonId!)}>Open prepared lesson</button>}</div>}
 {job&&(job.sections?.length??0)>0&&<ol className="section-list" aria-label="Sections">{job.sections.map(section=><SectionRow key={section.task} section={section}/>)}</ol>}
 {job?.folder&&<div className="folder-row"><code className="folder-path">{job.folder}</code><button className="icon-button" onClick={()=>void copyPath()} aria-label="Copy folder path" title={copied?'Copied':'Copy folder path'}>{copied?<Check size={15}/>:<Copy size={15}/>}</button><button className="secondary-button" onClick={()=>void reveal()}><FolderOpen size={15}/>Open folder</button></div>}
 <div className="preparation-actions">{busy?<button className="secondary-button" disabled={pending||job.status==='stopping'} onClick={()=>void act(true)}><Square size={14}/>{job.status==='stopping'?'Stopping…':'Stop preparation'}</button>:<><label>Level<select aria-label="Learner level" value={level} onChange={e=>{setLevel(e.target.value as Familiarity);setConfirm(null)}} disabled={pending||anyBusy}>{familiarities.map(l=><option key={l} value={l}>{familiarityLabels[l]}</option>)}</select></label><label>Prepare with<select aria-label="Preparation agent" value={chosen??provider} onChange={e=>setProvider(e.target.value as Provider)} disabled={pending||anyBusy||!available.length}>{state?.providers.map(p=><option key={p.id} value={p.id} disabled={!p.available}>{p.id==='codex'?'Codex':'Claude'}{!p.available?' · unavailable':''}</option>)}</select></label>
  {resumable&&<button className="primary-button" disabled={disabled} onClick={()=>levelChanged?setConfirm('level'):void act(false,'continue')}>{pending?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>} Continue</button>}
  {job&&<button className={resumable?'secondary-button':'primary-button'} disabled={disabled} onClick={()=>setConfirm('restart')}>{pending&&!resumable?<LoaderCircle className="spin" size={16}/>:<RotateCcw size={15}/>} {job.status==='completed'?'Prepare a new version':'Start over'}</button>}
  {!job&&<button className="primary-button" disabled={disabled} onClick={()=>void act()}>{pending?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>} Prepare lesson</button>}</>}</div>
 {confirm&&!busy&&<div className="confirm-inline" role="group" aria-label="Confirm"><p>{confirm==='level'?'Changing the level starts over. Finished sections are kept in the preparation folder’s runs/ archive.':'Start over? Finished sections move to the runs/ archive.'}</p><button className="primary-button" disabled={pending} onClick={()=>void act(false,confirm==='level'?'continue':'restart')}>Confirm</button><button className="secondary-button" onClick={()=>setConfirm(null)}>Cancel</button></div>}
 {!ready&&<p className="stage-note">Resolve the source capture issues above before preparing.</p>}
 {state&&!available.length&&<p className="stage-note">Install Codex or Claude and sign in from a terminal. Restart Narad if the command was just added to PATH.</p>}
 {anyBusy&&!busy&&<p className="stage-note">Another lesson is being prepared. You can keep reading while it finishes.</p>}
 <p className="stage-note">Uses your selected agent’s account. You can leave this page while it works. Stopping keeps the saved sources and completed drafts.</p>{error&&<p role="alert" className="preparation-error">{error}</p>}
 </section>;
}
export function PreparationHistory({state,onChanged,onOpenLesson}:{state:PreparationState|null;onChanged:()=>Promise<void>;onOpenLesson:(id:string)=>void}){
 const [error,setError]=useState('');
 async function stop(id:string){try{await api.stopPreparation(id);await onChanged()}catch(e){setError(String(e))}}
 return <div className="preparation-history"><p className="modal-description">{state?.sessions.length??0} live agent sessions launched by Narad. Each session closes after its task. Other Codex and Claude windows are not included.</p>{!state?.jobs.length&&<p>No preparations yet. Open a saved source collection to begin.</p>}{state?.jobs.slice(0,12).map(job=><article key={job.id}><div><strong>{job.title}</strong><span>{job.provider==='codex'?'Codex':'Claude'} · {job.status}</span><p>{job.stage}</p>{job.error&&<p className="preparation-error">{job.error}</p>}</div>{(job.status==='running'||job.status==='stopping')?<button className="secondary-button" disabled={job.status==='stopping'} onClick={()=>void stop(job.id)}>Stop preparation</button>:job.lessonId?<button className="text-link" onClick={()=>onOpenLesson(job.lessonId!)}>Open lesson</button>:null}</article>)}{error&&<p role="alert">{error}</p>}</div>;
}
