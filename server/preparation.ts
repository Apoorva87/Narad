import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { type Provider, type PreparationJob, type PreparationState } from '../shared/preparation';
import type { Familiarity } from '../shared/lesson';
import { renderPrompt, type Settings } from '../shared/settings';
import { LessonStore, StoreError } from './store';
import { cliRunner, type AgentRunner, type AgentRequest } from './agent-runner';
import type { Download } from './capture';
import { prepareSources } from './intake';
import { authoredSectionSchema } from './lesson-preparation';
import { agentSectionSchema, buildTeachingPlan, checkTeaching, compilePreparedBundle, researchSchema, reviewSchema, summarySchema, type TeachingOutput } from './generation-content';
const levelKey:Record<Familiarity,'levelFoundational'|'levelSomeBackground'|'levelAdvanced'>={foundational:'levelFoundational','some-background':'levelSomeBackground',advanced:'levelAdvanced'};
/** Fills the shared slots once per job; each step adds its own data slots. */
function promptKit(settings:Settings,level:Familiarity){
  const p=settings.prompts;
  const principles=renderPrompt(p.principles,{level,levelGuidance:p[levelKey[level]]});
  const shared={principles,walkthroughGuidance:p.walkthroughGuidance,dialogueGuidance:p.dialogueGuidance,visualGuidance:p.visualGuidance,maxLinks:String(settings.research.maxLinks)};
  return (key:'research'|'section'|'revision'|'review'|'summary',values:Record<string,string>)=>renderPrompt(p[key],{...shared,...values});
}
export class PreparationService {
  private active?:{job:PreparationJob;controller:AbortController;done:Promise<void>};
  private sessions:PreparationState['sessions']=[];
  private closing=false;
  constructor(private store:LessonStore,private dataDir:string,private runner:AgentRunner=cliRunner,private download?:Download){
    for(const job of store.listJobs()) if(job.status==='running'||job.status==='stopping') this.update(job,{status:'interrupted',stage:'Interrupted when the server stopped',error:'Preparation was interrupted. Saved drafts remain on disk. Start again to retry.'});
  }
  state():PreparationState{return{jobs:this.store.listJobs(),sessions:[...this.sessions],providers:this.runner.available()}}
  start(bundleId:string,provider:Provider,familiarity?:Familiarity):PreparationJob {
    if(this.closing)throw new StoreError('The server is shutting down.',503);
    if(this.active)throw new StoreError('A preparation is already running. Stop it or wait for it to finish.',409);
    if(!this.runner.available().some(p=>p.id===provider&&p.available))throw new StoreError('This agent is not available. Install it and sign in from a terminal, then restart Narad if PATH changed.',400);
    const found=this.store.getBundle(bundleId);if(!found)throw new StoreError('Source collection not found.',404);
    const bundle=familiarity&&familiarity!==found.familiarity?{...found,familiarity}:found;if(bundle!==found)this.store.saveBundle(bundle,[]);
    buildTeachingPlan(bundle);
    const job:PreparationJob={id:randomUUID(),bundleId,title:bundle.title,provider,status:'running',stage:'Starting preparation',completed:0,total:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    this.store.saveJob(job);const controller=new AbortController();
    const active={job,controller,done:Promise.resolve()};this.active=active;
    active.done=this.prepare(job,controller.signal,this.store.getSettings()).catch(error=>{
      this.update(job,{status:controller.signal.aborted?'cancelled':'failed',stage:controller.signal.aborted?'Stopped · saved drafts retained':'Preparation needs attention',error:controller.signal.aborted?undefined:(error instanceof Error?error.message:String(error)).slice(0,3000)});
    }).finally(()=>{this.sessions=[];if(this.active===active)this.active=undefined;});
    return {...job};
  }
  stop(id:string):PreparationJob {
    if(!this.active||this.active.job.id!==id){const existing=this.store.listJobs().find(j=>j.id===id);if(existing)return existing;throw new StoreError('Preparation not found.',404)}
    this.update(this.active.job,{status:'stopping',stage:'Stopping agent…'});this.active.controller.abort();return{...this.active.job};
  }
  /** True while this collection is being prepared, matching old IDs and renamed slugs alike. */
  busy(bundleId:string){const active=this.active?.job.bundleId;if(!active)return false;if(active===bundleId)return true;const slug=this.store.resolveId(bundleId);return !!slug&&this.store.resolveId(active)===slug}
  /** Deletes saved drafts, prompts and source image copies for these jobs. */
  async forget(jobs:PreparationJob[]){await Promise.all(jobs.map(job=>rm(join(this.dataDir,'preparations',job.id),{recursive:true,force:true})))}
  async shutdown(){this.closing=true;if(this.active){this.stop(this.active.job.id);await this.active.done}}
  private update(job:PreparationJob,patch:Partial<PreparationJob>){Object.assign(job,patch,{updatedAt:new Date().toISOString()});this.store.saveJob(job)}
  private async prepare(job:PreparationJob,signal:AbortSignal,settings:Settings){
    const cwd=join(this.dataDir,'preparations',job.id);await mkdir(cwd,{recursive:true});
    // The settings in force when the job started, kept beside its drafts so a lesson's instructions stay inspectable.
    await writeFile(join(cwd,'settings.json'),JSON.stringify(settings,null,2));
    let bundle=this.store.getBundle(job.bundleId)!;const prompt=promptKit(settings,bundle.familiarity??'foundational');
    const limits={chunkChars:settings.preparation.chunkChars,chunkUnits:settings.preparation.chunkUnits};
    const run=async(kind:AgentRequest['kind'],name:string,prompt:string,schema:z.ZodType,images:string[]=[])=>{
      signal.throwIfAborted();const request:AgentRequest={kind,name,prompt,schema:z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string,unknown>,cwd,images,provider:job.provider,model:(job.provider==='codex'?settings.preparation.codexModel:settings.preparation.claudeModel)||undefined,timeoutMs:settings.preparation.timeoutMinutes*60_000};
      const result=await this.runner.run(request,signal,pid=>{this.sessions=pid?[{jobId:job.id,provider:job.provider,pid,startedAt:new Date().toISOString()}]:[]});
      signal.throwIfAborted();await writeFile(join(cwd,name+'.json'),JSON.stringify(result,null,2));return result;
    };
    if(bundle.sources.every(s=>s.kind==='note')){
      this.update(job,{stage:'Finding sources for your topic'});
      const linkSchema=researchSchema.extend({links:researchSchema.shape.links.max(settings.research.maxLinks)});
      const research=linkSchema.parse(await run('research','research',prompt('research',{request:bundle.text}),linkSchema));
      const captured=await prepareSources({title:bundle.title,text:research.links.join('\n')},this.download,settings.capture);signal.throwIfAborted();
      // Saving moves captured images into the folder; continue with the served paths it returns.
      bundle=this.store.saveBundle({...bundle,sources:[...bundle.sources,...captured.bundle.sources.filter(s=>s.kind==='article')],status:captured.bundle.status},captured.blobs);
    }
    await writeFile(join(cwd,'source-snapshot.json'),JSON.stringify(bundle,null,2));
    const tasks=buildTeachingPlan(bundle,limits);this.update(job,{total:tasks.length,stage:'Preparing the first section'});
    const outputs:TeachingOutput[]=[];
    for(const [i,task]of tasks.entries()){
      signal.throwIfAborted();this.update(job,{stage:`Writing ${i+1}/${tasks.length} · ${task.source.title} · ${task.section.title}`});
      const images:string[]=[];
      for(const asset of task.assets){
        // A video without a captured poster has no image to show the agent; its title and caption still go in the context.
        if(asset.kind==='video'&&asset.src==='/assets/video-poster.svg')continue;
        const media=asset.src!.match(/^\/api\/library\/([^/]+)\/media\/([^/]+)$/);const file=media&&this.store.mediaPath(media[1],media[2]);if(!file)throw new Error('Saved source visual is missing: '+asset.id);
        const path=join(cwd,task.id+'-'+asset.id+'.png');await writeFile(path,await sharp(await readFile(file)).png().toBuffer());images.push(path);
      }
      const context=JSON.stringify({learningIntent:bundle.text,source:{id:task.source.id,title:task.source.title,url:task.source.url},section:{...task.section,units:task.section.units.filter(u=>u.kind!=='note')},visualOrder:task.assets.map(a=>({id:a.id,kind:a.kind,caption:a.caption,alt:a.alt,...(a.kind==='video'&&{note:'A video that streams from its source; explain what it shows from its title, caption'+(a.src==='/assets/video-poster.svg'?'.':' and poster image.')})})),allSectionTitles:tasks.filter(t=>t.source.id===task.source.id).map(t=>t.section.title)});
      const instruction=prompt('section',{input:context});
      let teaching:TeachingOutput['teaching']|undefined;let issues:string[]=[];
      for(let attempt=0;attempt<settings.preparation.reviewRounds;attempt++){
        const raw=await run('author',task.id+'-draft-'+attempt,instruction+(issues.length?'\n'+prompt('revision',{issues:issues.join('\n'),draft:JSON.stringify(teaching)}):''),agentSectionSchema,images);
        const structured=agentSectionSchema.parse(raw);teaching=authoredSectionSchema.parse({...structured,units:structured.units.map(u=>({...u,question:u.question??undefined}))});
        issues=checkTeaching(task,teaching);if(issues.length)continue;
        this.update(job,{stage:`Checking ${i+1}/${tasks.length} · ${task.section.title}`});
        const review=reviewSchema.parse(await run('review',task.id+'-review-'+attempt,prompt('review',{source:context,draft:JSON.stringify(teaching)}),reviewSchema,images));
        issues=review.approved&&review.issues.length===0?[]:review.issues.length?review.issues:['Content review did not approve this section.'];
        if(!issues.length)break;
      }
      if(issues.length||!teaching)throw new Error('Section '+task.section.title+' needs review: '+issues.join('; '));
      outputs.push({task,teaching});await writeFile(join(cwd,task.id+'.approved.json'),JSON.stringify(teaching,null,2));this.update(job,{completed:i+1});
    }
    signal.throwIfAborted();this.update(job,{stage:'Preparing the brief summary and synthesis'});
    const summaryContext=tasks.map((task,i)=>({sourceId:task.source.id,sourceTitle:task.source.title,section:task.section.title,introduction:outputs[i].teaching.introduction}));
    const summary=summarySchema.parse(await run('summary','summary',prompt('summary',{sections:JSON.stringify(summaryContext)}),summarySchema));
    const lesson=compilePreparedBundle(bundle,outputs,summary.sections,'lesson-'+job.id,{limits,speakers:{host:settings.lessons.hostName,expert:settings.lessons.expertName}});signal.throwIfAborted();
    await writeFile(join(cwd,'lesson.json'),JSON.stringify(lesson,null,2));signal.throwIfAborted();
    const saved=this.store.insert(lesson,{replace:true});this.update(job,{status:'completed',stage:'Lesson ready · all three modes saved',lessonId:saved.id});
  }
}
