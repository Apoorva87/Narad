import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
async function finished(service:PreparationService){await expect.poll(()=>['running','stopping'].includes(service.state().jobs[0]?.status??'running'),{timeout:3000}).toBe(false);return service.state().jobs[0]}
it('prepares, reviews and saves three distinct modes with a persisted job',async()=>{const {service,store}=await setup(answer);service.start('source','codex');const job=await finished(service);expect(job.status).toBe('completed');const lesson=store.get(job.lessonId!)!;expect(Object.keys(lesson.modes)).toEqual(['summary','walkthrough','dialogue']);expect(store.getBundle('source')!.lessonId).toBe(lesson.id);expect(service.state().jobs[0].status).toBe('completed')});
it('allows one job at a time and never publishes after cancellation even if a provider returns late',async()=>{let release!:(v:unknown)=>void;const {service,store}=await setup(()=>new Promise(r=>release=r));const job=service.start('source','codex');expect(()=>service.start('source','claude')).toThrow(/already|running/i);await expect.poll(()=>!!release).toBe(true);service.stop(job.id);release(await answer({kind:'author'} as AgentRequest));await expect.poll(()=>service.state().jobs[0].status).toBe('stopped');expect(store.list()).toEqual([])});
it('does not publish when independent content review rejects the lesson',async()=>{const {service,store}=await setup(async r=>r.kind==='review'?{approved:false,issues:['Unsupported interpretation of the units.']}:answer(r));service.start('source','codex');const job=await finished(service);expect(job.status).toBe('failed');expect(job.error).toContain('Unsupported');expect(store.list()).toEqual([])});
it('prepares for the chosen level and keeps its progress in the item folder',async()=>{const prompts:string[]=[];const {service,store}=await setup(async r=>{prompts.push(r.prompt);return answer(r)});service.start('source','codex','advanced');const job=await finished(service);expect(job.status).toBe('completed');expect(prompts.every(p=>p.includes('Learner familiarity is advanced')&&p.includes('expert reader'))).toBe(true);expect(store.get(job.lessonId!)!.familiarity).toBe('advanced');expect(store.getBundle('source')!.familiarity).toBe('advanced');const {existsSync}=await import('node:fs');expect(existsSync(join(store.libraryRoot,'time','preparation','progress.json'))).toBe(true);expect(job.folder).toBe(join(store.libraryRoot,'time'));expect(job.slug).toBe('time')});
it('prepares with the settings in force when the job starts and keeps a snapshot',async()=>{const requests:AgentRequest[]=[];const {service,store}=await setup(async r=>{requests.push(r);return answer(r)});const settings=store.getSettings();settings.prompts.walkthroughGuidance='CUSTOM WALKTHROUGH RULE';settings.prompts.summary='Summarise briefly. {{sections}}';settings.lessons.expertName='Dr Rao';settings.preparation.codexModel='gpt-test';settings.preparation.timeoutMinutes=5;store.saveSettings(settings);service.start('source','codex');settings.prompts.summary='CHANGED AFTER START {{sections}}';store.saveSettings(settings);const job=await finished(service);expect(job.status).toBe('completed');const author=requests.find(r=>r.kind==='author')!;expect(author.prompt).toContain('CUSTOM WALKTHROUGH RULE');expect(author.prompt).not.toMatch(/\{\{/);expect(author.model).toBe('gpt-test');expect(author.timeoutMs).toBe(300_000);expect(requests.find(r=>r.kind==='summary')!.prompt).toMatch(/^Summarise briefly\./);const lesson=store.get(job.lessonId!)!;expect(lesson.modes.dialogue!.sections.flatMap(s=>s.blocks).some(b=>b.kind==='dialogue'&&b.speaker==='Dr Rao')).toBe(true);const {readFileSync}=await import('node:fs');expect(JSON.parse(readFileSync(join(store.libraryRoot,'time','preparation','settings.json'),'utf8')).prompts.summary).toBe('Summarise briefly. {{sections}}')});
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
 service.start('source','codex');expect((await finished(service)).status).toBe('completed');
 expect(store.list()).toHaveLength(1);
});
it('reports a running job as busy for both its original ID and the folder slug',async()=>{
 let release!:(v:unknown)=>void;const {service,store}=await setup(()=>new Promise(r=>release=r));
 const job=service.start('source','codex');
 expect(service.busy('source')).toBe(true);expect(service.busy(store.resolveId('source')!)).toBe(true);expect(service.busy('elsewhere')).toBe(false);
 await expect.poll(()=>!!release).toBe(true);service.stop(job.id);release(await answer({kind:'author'} as AgentRequest));await finished(service);
});

// ---- Resumable preparation: three one-paragraph sections → tasks r0-s00-p0, r0-s01-p0, r0-s02-p0.
const three='# One\n\nA delay of 42 ms.\n\n# Two\n\nA wait of 7 s.\n\n# Three\n\nA pause of 3 ms.';
const taskOf=(r:AgentRequest)=>r.name.match(/r\d+-s\d+-p\d+/)?.[0]??'';
/** Answers any section from the context in its prompt, keeping every number. */
async function teach(r:AgentRequest){
 if(r.kind!=='author')return answer(r);
 const id=r.prompt.match(/"section":\{"id":"(s\d+)"/)![1];
 const units=[...r.prompt.matchAll(/"id":"(s\d+-u\d+)","markdown":"((?:[^"\\]|\\.)*)"/g)].map(m=>({id:m[1],text:JSON.parse('"'+m[2]+'"') as string}));
 return {id,introduction:'Learn delay.',hostQuestion:'What is delay?',units:units.map(u=>({id:u.id,walkthrough:'Explained: '+u.text+' Here is why.',walkthroughSpoken:'Explained.',dialogue:'Picture this: '+u.text+' Then think.',dialogueSpoken:'Picture this.',question:null})),visuals:[]};
}
type Run=(r:AgentRequest,s:AbortSignal)=>Promise<unknown>;
async function setupThree(run:Run,atOnce=1){
 const dir=await mkdtemp(join(tmpdir(),'narad-job-'));dirs.push(dir);const store=new LessonStore(join(dir,'db'));stores.push(store);
 store.saveBundle({id:'source',title:'Time',text:'Explain',createdAt:new Date().toISOString(),status:'captured',sources:[{id:'a',title:'Time',kind:'article',markdown:three,assets:[],warnings:[],inventory:{images:0,inlineSvg:0,tables:0,savedVisuals:0}}]},[]);
 const settings=store.getSettings();settings.preparation.sectionsAtOnce=atOnce;store.saveSettings(settings);
 const runner={current:run};
 const service=new PreparationService(store,dir,{run:(r,s)=>runner.current(r,s),available:()=>[{id:'codex',available:true}]});services.push(service);
 const folder=join(store.libraryRoot,'time','preparation');
 const progress=async()=>JSON.parse(await readFile(join(folder,'progress.json'),'utf8'));
 return {dir,store,service,runner,folder,progress};
}
const failThird:Run=async r=>{if(r.kind==='author'&&taskOf(r)==='r0-s02-p0')throw new Error('Agent failed. boom');return teach(r)};
it('continues after an interrupted run by writing only the unfinished section',async()=>{
 const t=await setupThree(failThird);t.service.start('source','codex');const first=await finished(t.service);
 expect(first.status).toBe('failed');expect(first.completed).toBe(2);expect(first.total).toBe(3);
 expect((await t.progress()).sections['r0-s02-p0'].state).toBe('failed');
 const authored:string[]=[];t.runner.current=async r=>{if(r.kind==='author')authored.push(taskOf(r));return teach(r)};
 t.service.start('source','codex');const second=await finished(t.service);
 expect(second.error).toBeUndefined();expect(second.status).toBe('completed');expect(authored).toEqual(['r0-s02-p0']);
 expect(second.sections.map(s=>[s.task,s.state])).toEqual([['r0-s00-p0','done'],['r0-s01-p0','done'],['r0-s02-p0','done']]);
 const p=await t.progress();expect(p.calls.map((c:{n:number})=>c.n)).toEqual([...p.calls.map((c:{n:number})=>c.n)].sort((a,b)=>a-b));
});
it('redoes only the sections whose source changed when continuing',async()=>{
 const t=await setupThree(failThird);t.service.start('source','codex');await finished(t.service);
 const bundle=t.store.getBundle('source')!;t.store.saveBundle({...bundle,sources:[{...bundle.sources[0],markdown:three.replace('A delay of 42 ms.','A delay of 43 ms.')}]},[]);
 const authored:string[]=[];t.runner.current=async r=>{if(r.kind==='author')authored.push(taskOf(r));return teach(r)};
 t.service.start('source','codex');expect((await finished(t.service)).status).toBe('completed');
 expect(authored.sort()).toEqual(['r0-s00-p0','r0-s02-p0']);
});
it('marks a running progress file interrupted on startup and launches nothing',async()=>{
 const t=await setupThree(failThird);t.service.start('source','codex');await finished(t.service);
 const p=await t.progress();await writeFile(join(t.folder,'progress.json'),JSON.stringify({...p,status:'running'}));
 const calls:AgentRequest[]=[];const restarted=new PreparationService(t.store,t.dir,{run:async r=>{calls.push(r);return teach(r)},available:()=>[{id:'codex',available:true}]});services.push(restarted);
 expect(restarted.state().jobs[0].status).toBe('interrupted');expect(restarted.state().sessions).toEqual([]);
 await expect.poll(async()=>(await t.progress()).status).toBe('interrupted');
 await new Promise(r=>setTimeout(r,50));expect(calls).toEqual([]);
});
it('prepares sections two at a time and records both when they finish together',async()=>{
 const pending:{task:string;resolve:()=>void}[]=[];let inFlight=0,peak=0;
 const t=await setupThree(async r=>{if(r.kind!=='author')return teach(r);inFlight++;peak=Math.max(peak,inFlight);await new Promise<void>(resolve=>pending.push({task:taskOf(r),resolve}));inFlight--;return teach(r)},2);
 t.service.start('source','codex');
 await expect.poll(()=>pending.length).toBe(2);await new Promise(r=>setTimeout(r,30));expect(pending.length).toBe(2);expect(inFlight).toBe(2);
 expect(pending.map(p=>p.task).sort()).toEqual(['r0-s00-p0','r0-s01-p0']);
 const [a,b]=pending;a.resolve();b.resolve();
 await expect.poll(async()=>{const p=await t.progress();return [p.sections['r0-s00-p0'].state,p.sections['r0-s01-p0'].state]}).toEqual(['done','done']);
 await expect.poll(()=>pending.length).toBe(3);pending[2].resolve();
 expect((await finished(t.service)).status).toBe('completed');expect(peak).toBe(2);
});
it('starts over by archiving earlier sections and writing every section again',async()=>{
 const t=await setupThree(failThird);t.service.start('source','codex');await finished(t.service);
 const authored:string[]=[];t.runner.current=async r=>{if(r.kind==='author')authored.push(taskOf(r));return teach(r)};
 t.service.start('source','codex',undefined,'restart');expect((await finished(t.service)).status).toBe('completed');
 expect(authored.sort()).toEqual(['r0-s00-p0','r0-s01-p0','r0-s02-p0']);
 const runs=await readdir(join(t.folder,'runs'));const abandoned=runs.find(r=>r.endsWith('-abandoned'))!;expect(abandoned).toBeTruthy();
 expect(await readdir(join(t.folder,'runs',abandoned,'sections'))).toEqual(['r0-s00-p0.json','r0-s01-p0.json']);
 expect((await readdir(join(t.folder,'runs',abandoned))).sort()).toEqual(['calls','progress.json','sections']);
});
it('stops with finished sections kept and status stopped',async()=>{
 let release:(()=>void)|undefined;
 const t=await setupThree(async r=>{if(r.kind==='author'&&taskOf(r)==='r0-s01-p0')await new Promise<void>(res=>release=res);return teach(r)});
 const job=t.service.start('source','codex');await expect.poll(()=>!!release).toBe(true);
 t.service.stop(job.id);release!();const stopped=await finished(t.service);
 expect(stopped.status).toBe('stopped');expect((await t.progress()).status).toBe('stopped');
 expect(await readdir(join(t.folder,'sections'))).toEqual(['r0-s00-p0.json']);
 expect((await t.progress()).sections['r0-s01-p0'].state).toBe('waiting');
});
it('keeps the first published version under preparation/runs when a second is published',async()=>{
 const t=await setupThree(teach);t.service.start('source','codex');const first=await finished(t.service);expect(first.status).toBe('completed');
 const firstRun=(await t.progress()).runId;const firstLesson=JSON.parse(await readFile(join(t.store.libraryRoot,'time','lesson.json'),'utf8'));
 t.service.start('source','codex');await expect.poll(async()=>{const p=await t.progress();return p.runId!==firstRun&&p.status},{timeout:3000}).toBe('completed');
 const runs=await readdir(join(t.folder,'runs'));const published=runs.filter(r=>!r.endsWith('-abandoned'));
 expect(published.length).toBe(1);const files=await readdir(join(t.folder,'runs',published[0]));expect(files).toContain('lesson.json');expect(files).toContain('settings.json');
 expect(JSON.parse(await readFile(join(t.folder,'runs',published[0],'lesson.json'),'utf8'))).toEqual(firstLesson);
 expect(t.store.list()).toHaveLength(1);
});
it('reports no preparation for an item that was never prepared',async()=>{
 const t=await setupThree(teach);
 const {existsSync}=await import('node:fs');expect(existsSync(join(t.folder,'progress.json'))).toBe(false);expect(t.service.state().jobs).toEqual([]);
});
