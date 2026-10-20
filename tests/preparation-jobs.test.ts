import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonStore } from '../server/store';
import { PreparationService } from '../server/preparation';
import type { AgentRequest } from '../server/agent-runner';
import sharp from 'sharp';
const dirs:string[]=[];const stores:LessonStore[]=[];const services:PreparationService[]=[];
afterEach(async()=>{for(const s of services.splice(0)) await s.shutdown();for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true})});
async function setup(run:(r:AgentRequest,s:AbortSignal)=>Promise<unknown>){const dir=await mkdtemp(join(tmpdir(),'narad-job-'));dirs.push(dir);const store=new LessonStore(join(dir,'db'));stores.push(store);store.saveBundle({id:'source',title:'Time',text:'Explain',createdAt:new Date().toISOString(),status:'captured',sources:[{id:'a',title:'Time',kind:'article',markdown:'# Time\n\nA delay of 42 ms.',assets:[],warnings:[],inventory:{images:0,inlineSvg:0,tables:0,savedVisuals:0}}]},[]);const service=new PreparationService(store,dir,{run,available:()=>[{id:'codex',available:true},{id:'claude',available:true}]});services.push(service);return {dir,store,service}}
const answer=async(r:AgentRequest)=>{if(r.kind==='review')return{approved:true,issues:[]};if(r.kind==='summary')return{sections:[{title:'In brief',markdown:'A delay is measured in milliseconds.',spokenText:'A delay is measured in milliseconds.',sourceIds:['a']},{title:'Takeaway',markdown:'Measure the delay between events.',spokenText:'Measure the delay between events.',sourceIds:['a']}]} ;return{id:'s00',introduction:'Learn delay.',hostQuestion:'What is delay?',units:[{id:'s00-u00',walkthrough:'The 42 ms delay is elapsed time between two events.',walkthroughSpoken:'Forty two milliseconds is elapsed time between events.',dialogue:'Imagine timing two events with a stopwatch: the delay is 42 ms.',dialogueSpoken:'Imagine timing two events with a stopwatch.',question:null}],visuals:[]}};
async function finished(service:PreparationService){await expect.poll(()=>service.state().jobs[0].status,{timeout:3000}).not.toBe('running');return service.state().jobs[0]}
it('prepares, reviews and saves three distinct modes with a persisted job',async()=>{const {service,store}=await setup(answer);service.start('source','codex');const job=await finished(service);expect(job.status).toBe('completed');const lesson=store.get(job.lessonId!)!;expect(Object.keys(lesson.modes)).toEqual(['summary','walkthrough','dialogue']);expect(store.getBundle('source')!.lessonId).toBe(lesson.id);expect(store.listJobs()[0].status).toBe('completed')});
it('allows one job at a time and never publishes after cancellation even if a provider returns late',async()=>{let release!:(v:unknown)=>void;const {service,store}=await setup(()=>new Promise(r=>release=r));const job=service.start('source','codex');expect(()=>service.start('source','claude')).toThrow(/already|running/i);await expect.poll(()=>!!release).toBe(true);service.stop(job.id);release(await answer({kind:'author'} as AgentRequest));await expect.poll(()=>service.state().jobs[0].status).toBe('cancelled');expect(store.list()).toEqual([])});
it('does not publish when independent content review rejects the lesson',async()=>{const {service,store}=await setup(async r=>r.kind==='review'?{approved:false,issues:['Unsupported interpretation of the units.']}:answer(r));service.start('source','codex');const job=await finished(service);expect(job.status).toBe('failed');expect(job.error).toContain('Unsupported');expect(store.list()).toEqual([])});
it('marks persisted running records interrupted on restart without killing saved PIDs',async()=>{const {service,store,dir}=await setup(answer);store.saveJob({id:'old',bundleId:'source',title:'Old',provider:'codex',status:'running',stage:'Writing',completed:0,total:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});const restarted=new PreparationService(store,dir,{run:answer,available:()=>[]});services.push(restarted);expect(restarted.state().jobs.find(j=>j.id==='old')!.status).toBe('interrupted');expect(restarted.state().sessions).toEqual([])});
it('prepares for the chosen level and deletes its drafts when forgotten',async()=>{const prompts:string[]=[];const {service,store,dir}=await setup(async r=>{prompts.push(r.prompt);return answer(r)});service.start('source','codex','advanced');const job=await finished(service);expect(job.status).toBe('completed');expect(prompts.every(p=>p.includes('Learner familiarity is advanced')&&p.includes('expert reader'))).toBe(true);expect(store.get(job.lessonId!)!.familiarity).toBe('advanced');expect(store.getBundle('source')!.familiarity).toBe('advanced');const {existsSync}=await import('node:fs');expect(existsSync(join(dir,'preparations',job.id))).toBe(true);await service.forget(store.deleteBundle('source'));expect(existsSync(join(dir,'preparations',job.id))).toBe(false);expect(service.state().jobs).toEqual([])});
it('prepares with the settings in force when the job starts and keeps a snapshot',async()=>{const requests:AgentRequest[]=[];const {service,store,dir}=await setup(async r=>{requests.push(r);return answer(r)});const settings=store.getSettings();settings.prompts.walkthroughGuidance='CUSTOM WALKTHROUGH RULE';settings.prompts.summary='Summarise briefly. {{sections}}';settings.lessons.expertName='Dr Rao';settings.preparation.codexModel='gpt-test';settings.preparation.timeoutMinutes=5;store.saveSettings(settings);service.start('source','codex');settings.prompts.summary='CHANGED AFTER START {{sections}}';store.saveSettings(settings);const job=await finished(service);expect(job.status).toBe('completed');const author=requests.find(r=>r.kind==='author')!;expect(author.prompt).toContain('CUSTOM WALKTHROUGH RULE');expect(author.prompt).not.toMatch(/\{\{/);expect(author.model).toBe('gpt-test');expect(author.timeoutMs).toBe(300_000);expect(requests.find(r=>r.kind==='summary')!.prompt).toMatch(/^Summarise briefly\./);const lesson=store.get(job.lessonId!)!;expect(lesson.modes.dialogue!.sections.flatMap(s=>s.blocks).some(b=>b.kind==='dialogue'&&b.speaker==='Dr Rao')).toBe(true);const {readFileSync}=await import('node:fs');expect(JSON.parse(readFileSync(join(dir,'preparations',job.id,'settings.json'),'utf8')).prompts.summary).toBe('Summarise briefly. {{sections}}')});
it('stops after the configured number of review rounds',async()=>{let reviews=0;const {service,store}=await setup(async r=>{if(r.kind==='review'){reviews++;return{approved:false,issues:['Not yet.']}}return answer(r)});const settings=store.getSettings();settings.preparation.reviewRounds=3;store.saveSettings(settings);service.start('source','codex');const job=await finished(service);expect(job.status).toBe('failed');expect(reviews).toBe(3)});
it('captures researched articles with images into the folder and teaches from their saved visuals',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'narad-job-'));dirs.push(dir);const store=new LessonStore(join(dir,'db'));stores.push(store);
 store.saveBundle({id:'notes',title:'Latency',text:'Explain latency',createdAt:new Date().toISOString(),status:'captured',sources:[{id:'n',title:'Your notes',kind:'note',markdown:'Explain latency',assets:[],warnings:[],inventory:{images:0,inlineSvg:0,tables:0,savedVisuals:0}}]},[]);
 const png=await sharp({create:{width:4,height:4,channels:3,background:'red'}}).png().toBuffer();
 const html='<article><h1>Latency</h1><p>A delay of 42 ms.</p><figure><img src="fig.png" alt="Delay chart"><figcaption>Delay chart</figcaption></figure></article>';
 const download=async(url:string)=>({url,bytes:url.endsWith('.png')?png:Buffer.from(html),type:url.endsWith('.png')?'image/png':'text/html'});
 const images:string[][]=[];
 const run=async(r:AgentRequest)=>{
  if(r.kind==='research')return{links:['https://example.com/latency'],rationale:'Primary source.'};
  if(r.kind==='summary'){const sourceIds=[r.prompt.match(/"sourceId":"([^"]+)"/)![1]];return{sections:[{title:'In brief',markdown:'Latency is delay.',spokenText:'Latency is delay.',sourceIds},{title:'Takeaway',markdown:'Measure delay.',spokenText:'Measure delay.',sourceIds}]}}
  if(r.kind==='author'){images.push(r.images);const base=await answer(r) as any;const ids=[...new Set([...r.prompt.matchAll(/"id":"(s\d+-u\d+)","markdown":"(?:[^"\\]|\\.)*","kind":"(?:text|table)"/g)].map(m=>m[1]))];return{...base,units:ids.map(id=>({...base.units[0],id})),visuals:[{id:'source-asset-0',caption:'Delay chart',explanation:'The chart shows a 42 ms delay.',spokenText:'The chart shows a forty two millisecond delay.',dialogueTurns:[{role:'host',markdown:'What does it show?',spokenText:'What does it show?'},{role:'expert',markdown:'A 42 ms delay.',spokenText:'A forty two millisecond delay.'}]}]}}
  return answer(r);
 };
 const service=new PreparationService(store,dir,{run,available:()=>[{id:'codex',available:true}]},download);services.push(service);
 service.start('notes','codex');const job=await finished(service);
 expect(job.error).toBeUndefined();expect(job.status).toBe('completed');
 expect(images.flat().length).toBeGreaterThan(0);
 const bundle=store.getBundle('notes')!;const src=bundle.sources[1].assets[0].src!;
 expect(src).toMatch(/^\/api\/library\/latency\/media\//);
 const lesson=store.get(job.lessonId!)!;
 expect(lesson.assets.every(a=>!a.src.startsWith('/api/source-assets/'))).toBe(true);
 expect(lesson.assets.some(a=>a.src===src)).toBe(true);
});
it('publishes a new preparation over the collection\'s previous lesson',async()=>{
 const {service,store}=await setup(answer);
 service.start('source','codex');const first=await finished(service);expect(first.status).toBe('completed');
 service.start('source','codex');await expect.poll(()=>service.state().jobs.filter(j=>j.status==='completed').length,{timeout:3000}).toBe(2);
 expect(store.list()).toHaveLength(1);
});
it('reports a running job as busy for both its original ID and the folder slug',async()=>{
 let release!:(v:unknown)=>void;const {service,store}=await setup(()=>new Promise(r=>release=r));
 const job=service.start('source','codex');
 expect(service.busy('source')).toBe(true);expect(service.busy(store.resolveId('source')!)).toBe(true);expect(service.busy('elsewhere')).toBe(false);
 await expect.poll(()=>!!release).toBe(true);service.stop(job.id);release(await answer({kind:'author'} as AgentRequest));await finished(service);
});
