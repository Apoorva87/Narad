import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonStore } from '../server/store';
import { PreparationService } from '../server/preparation';
import type { AgentRequest, AgentUsage } from '../server/agent-runner';
import sharp from 'sharp';
const dirs:string[]=[];const stores:LessonStore[]=[];const services:PreparationService[]=[];
afterEach(async()=>{for(const s of services.splice(0)) await s.shutdown();for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true})});
async function setup(run:(r:AgentRequest,s:AbortSignal,onSession?:(pid:number|null)=>void,onUsage?:(u:AgentUsage)=>void)=>Promise<unknown>,markdown='# Time\n\nA delay of 42 ms.'){const dir=await mkdtemp(join(tmpdir(),'narad-job-'));dirs.push(dir);const store=new LessonStore(join(dir,'db'));stores.push(store);store.saveBundle({id:'source',title:'Time',text:'Explain',createdAt:new Date().toISOString(),status:'captured',sources:[{id:'a',title:'Time',kind:'article',markdown,assets:[],warnings:[],inventory:{images:0,inlineSvg:0,tables:0,savedVisuals:0}}]},[]);const service=new PreparationService(store,dir,{run,available:()=>[{id:'codex',available:true},{id:'claude',available:true}]});services.push(service);return {dir,store,service}}
const answer=async(r:AgentRequest)=>{if(r.kind==='review')return{approved:true,issues:[]};if(r.kind==='summary')return{sections:[{title:'In brief',markdown:'A delay is measured in milliseconds.',spokenText:'A delay is measured in milliseconds.',sourceIds:['a']},{title:'Takeaway',markdown:'Measure the delay between events.',spokenText:'Measure the delay between events.',sourceIds:['a']}]} ;return{id:'s00',introduction:'Learn delay.',hostQuestion:'What is delay?',units:[{id:'s00-u00',walkthrough:'The 42 ms delay is elapsed time between two events.',walkthroughSpoken:'Forty two milliseconds is elapsed time between events.',dialogue:'Imagine timing two events with a stopwatch: the delay is 42 ms.',dialogueSpoken:'Imagine timing two events with a stopwatch.',question:null}],visuals:[]}};
async function finished(service:PreparationService){await expect.poll(()=>['running','stopping'].includes(service.state().jobs[0]?.status??'running'),{timeout:3000}).toBe(false);return service.state().jobs[0]}
it('prepares, reviews and saves three distinct modes with a persisted job',async()=>{const {service,store}=await setup(answer);service.start('source','codex');const job=await finished(service);expect(job.status).toBe('completed');const lesson=store.get(job.lessonId!)!;expect(Object.keys(lesson.modes)).toEqual(['summary','walkthrough','dialogue']);expect(store.getBundle('source')!.lessonId).toBe(lesson.id);expect(service.state().jobs[0].status).toBe('completed')});
it('allows one job at a time and never publishes after cancellation even if a provider returns late',async()=>{let release!:(v:unknown)=>void;const {service,store}=await setup(()=>new Promise(r=>release=r));const job=service.start('source','codex');expect(()=>service.start('source','claude')).toThrow(/already|running/i);await expect.poll(()=>!!release).toBe(true);service.stop(job.id);release(await answer({kind:'author'} as AgentRequest));await expect.poll(()=>service.state().jobs[0].status).toBe('stopped');expect(store.list()).toEqual([])});
it('does not publish rejected content and lets the learner stop revision',async()=>{
 let authors=0;const runner=async(r:AgentRequest,signal:AbortSignal)=>{if(r.kind==='review')return{approved:false,issues:['Unsupported interpretation of the units.']};if(r.kind==='author'&&++authors>1)await new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});return answer(r)};
 const {service,store}=await setup(runner);const started=service.start('source','codex');await expect.poll(()=>service.state().jobs[0].stage).toContain('Unsupported interpretation of the units.');expect(store.list()).toEqual([]);service.stop(started.id);expect((await finished(service)).status).toBe('stopped');expect(store.list()).toEqual([]);
});
it('prepares for the chosen level and keeps its progress in the item folder',async()=>{const prompts:string[]=[];const {service,store}=await setup(async r=>{prompts.push(r.prompt);return answer(r)});service.start('source','codex','advanced');const job=await finished(service);expect(job.status).toBe('completed');expect(prompts.every(p=>p.includes('Learner familiarity is advanced')&&p.includes('expert reader'))).toBe(true);expect(store.get(job.lessonId!)!.familiarity).toBe('advanced');expect(store.getBundle('source')!.familiarity).toBe('advanced');const {existsSync}=await import('node:fs');expect(existsSync(join(store.libraryRoot,'time','preparation','progress.json'))).toBe(true);expect(job.folder).toBe(join(store.libraryRoot,'time'));expect(job.slug).toBe('time')});
it('prepares with the settings in force when the job starts and keeps a snapshot',async()=>{const requests:AgentRequest[]=[];const {service,store}=await setup(async r=>{requests.push(r);return answer(r)});const settings=store.getSettings();settings.prompts.walkthroughGuidance='CUSTOM WALKTHROUGH RULE';settings.prompts.summary='Summarise briefly. {{sections}}';settings.lessons.expertName='Dr Rao';settings.preparation.codexModel='gpt-test';settings.preparation.timeoutMinutes=5;store.saveSettings(settings);service.start('source','codex');settings.prompts.summary='CHANGED AFTER START {{sections}}';store.saveSettings(settings);const job=await finished(service);expect(job.status).toBe('completed');const author=requests.find(r=>r.kind==='author')!;expect(author.prompt).toContain('CUSTOM WALKTHROUGH RULE');expect(author.prompt).not.toMatch(/\{\{/);expect(author.model).toBe('gpt-test');expect(author.reasoningEffort).toBe('low');expect(author.timeoutMs).toBe(300_000);expect(requests.find(r=>r.kind==='summary')!.prompt).toContain('Summarise briefly.');const lesson=store.get(job.lessonId!)!;expect(lesson.modes.dialogue!.sections.flatMap(s=>s.blocks).some(b=>b.kind==='dialogue'&&b.speaker==='Dr Rao')).toBe(true);const {readFileSync}=await import('node:fs');expect(JSON.parse(readFileSync(join(store.libraryRoot,'time','preparation','settings.json'),'utf8')).prompts.summary).toBe('Summarise briefly. {{sections}}')});
it('keeps revising until review approves and relays the current work',async()=>{
 let reviews=0;let serviceRef:PreparationService;const authorStages:string[]=[];const reviewStages:string[]=[];
 const runner=async(r:AgentRequest)=>{const stage=serviceRef.state().jobs[0].stage;if(r.kind==='author')authorStages.push(stage);if(r.kind==='review'){reviewStages.push(stage);reviews++;if(reviews<4)return{approved:false,issues:['Explain why the 42 ms measurement is qualified.']}}return answer(r)};
 const {service}=await setup(runner);serviceRef=service;service.start('source','codex');expect((await finished(service)).status).toBe('completed');
 expect(reviews).toBe(4);expect(authorStages[1]).toMatch(/Revising 1\/1 · draft 2 · Explain why the 42 ms measurement is qualified/);expect(reviewStages[0]).toMatch(/Reviewing 1\/1 · draft 1/);
});
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
const batchIds=(request:AgentRequest)=>[...new Set([...request.prompt.matchAll(/"taskId":"([^"]+)"/g)].map(match=>match[1]))];
const batchTeaching=(taskId:string,index:number)=>({id:'s0'+index,introduction:'Learn delay.',hostQuestion:'What is delay?',units:[{id:'s0'+index+'-u00',walkthrough:`The value ${[42,7,3][index]} is explained as elapsed time.`,walkthroughSpoken:'The value is explained as elapsed time.',dialogue:`Picture a stopwatch measuring ${[42,7,3][index]}.`,dialogueSpoken:'Picture a stopwatch measuring the value.',question:null}],visuals:[]});
const batchAnswer:Run=async request=>{
 if(request.kind==='summary')return answer(request);
 const ids=batchIds(request);
 if(request.kind==='review')return{results:ids.map(taskId=>({taskId,approved:true,issues:[]}))};
 return{results:ids.map(taskId=>({taskId,teaching:batchTeaching(taskId,Number(/-s(\d+)-/.exec(taskId)![1]))}))};
};
it('uses one native Codex coordinator for a three-section batch',async()=>{
 const requests:AgentRequest[]=[];const t=await setupThree(async(request,signal)=>{requests.push(request);return batchAnswer(request,signal)},3);
 t.service.start('source','codex');const job=await finished(t.service);expect(job.status).toBe('completed');
 const authors=requests.filter(request=>request.kind==='author');const reviews=requests.filter(request=>request.kind==='review');
 expect(authors).toHaveLength(1);expect(reviews).toHaveLength(1);
 expect(authors[0]).toMatchObject({multiAgent:true,reasoningEffort:'low',model:'gpt-6-sol'});
 expect(batchIds(authors[0])).toEqual(['r0-s00-p0','r0-s01-p0','r0-s02-p0']);
 expect(job.sections.map(section=>section.state)).toEqual(['done','done','done']);
});
it('requeues only a rejected section and relays its review issue',async()=>{
 const requests:AgentRequest[]=[];const authorStages:string[]=[];let serviceRef:PreparationService;let reviewRound=0;
 const t=await setupThree(async request=>{
  requests.push(request);const ids=batchIds(request);
  if(request.kind==='summary')return answer(request);
  if(request.kind==='review'){const reject=reviewRound++===0;return{results:ids.map(taskId=>({taskId,approved:!reject||taskId!=='r0-s01-p0',issues:reject&&taskId==='r0-s01-p0'?['Explain why the seven-second wait is elapsed time.']:[]}))}}
  authorStages.push(serviceRef.state().jobs[0].stage);
  return{results:ids.map(taskId=>{const index=Number(/-s(\d+)-/.exec(taskId)![1]);return{taskId,teaching:batchTeaching(taskId,index)}})};
 },3);serviceRef=t.service;
 t.service.start('source','codex');expect((await finished(t.service)).status).toBe('completed');
 expect(requests.filter(request=>request.kind==='author').map(batchIds)).toEqual([['r0-s00-p0','r0-s01-p0','r0-s02-p0'],['r0-s01-p0']]);
 expect(authorStages[1]).toContain('Explain why the seven-second wait is elapsed time.');
});
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
it('honors the configured native-subagent batch width',async()=>{
 const requests:AgentRequest[]=[];const t=await setupThree(async(r,s)=>{requests.push(r);return batchAnswer(r,s)},2);
 t.service.start('source','codex');expect((await finished(t.service)).status).toBe('completed');
 expect(requests.filter(request=>request.kind==='author').map(batchIds)).toEqual([['r0-s00-p0','r0-s01-p0'],['r0-s02-p0']]);
 expect(requests.filter(request=>request.kind==='author').map(request=>request.multiAgent)).toEqual([true,false]);
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
it('never overwrites the archived previous lesson when publishing is retried after a crash',async()=>{
 const t=await setupThree(teach);t.service.start('source','codex');expect((await finished(t.service)).status).toBe('completed');
 const original=await readFile(join(t.store.libraryRoot,'time','lesson.json'),'utf8');
 const insert=t.store.insert.bind(t.store);let crashed=false;
 t.store.insert=((lesson:unknown,options:{replace?:boolean})=>{const saved=insert(lesson,options);if(!crashed){crashed=true;throw new Error('Process died after writing the lesson.')}return saved}) as typeof t.store.insert;
 t.service.start('source','codex');expect((await finished(t.service)).status).toBe('failed');
 const p=await t.progress();await writeFile(join(t.folder,'progress.json'),JSON.stringify({...p,status:'running'}));
 const restarted=new PreparationService(t.store,t.dir,{run:teach,available:()=>[{id:'codex',available:true}]});services.push(restarted);await restarted.ready;
 restarted.start('source','codex');const again=await finished(restarted);expect(again.error).toBeUndefined();expect(again.status).toBe('completed');
 const published=(await readdir(join(t.folder,'runs'))).filter(r=>!r.endsWith('-abandoned'));
 expect(published).toHaveLength(1);expect(await readFile(join(t.folder,'runs',published[0],'lesson.json'),'utf8')).toBe(original);
});

it('sums token usage over every call and attempt and persists it with the run',async()=>{
 let reviews=0;
 const {service,store}=await setup(async(r,_s,_p,onUsage)=>{onUsage?.({inputTokens:100,outputTokens:10,cachedTokens:50,costUsd:0.5});if(r.kind==='review'&&reviews++===0)return{approved:false,issues:['Not yet.']};return answer(r)});
 service.start('source','codex');const job=await finished(service);expect(job.status).toBe('completed');
 const {readFileSync}=await import('node:fs');const progress=JSON.parse(readFileSync(join(store.libraryRoot,'time','preparation','progress.json'),'utf8'));
 const calls=progress.calls.length;expect(calls).toBeGreaterThan(2);
 expect(job.usage).toEqual({inputTokens:100*calls,outputTokens:10*calls,cachedTokens:50*calls,costUsd:0.5*calls});
 expect(progress.usage).toEqual(job.usage);
});
it('reports no usage when the agent gives none',async()=>{const {service}=await setup(answer);service.start('source','codex');const job=await finished(service);expect(job.usage).toBeUndefined()});
const sectionAnswer=async(r:AgentRequest)=>{if(r.kind!=='author')return answer(r);const section=r.name.match(/-(s\d+)-/)?.[1]??'s00';const value=section==='s00'?(r.prompt.includes('43 ms')?'43':'42'):'7';return{id:section,introduction:'Learn delay '+value+'.',hostQuestion:'What is this delay?',units:[{id:section+'-u00',walkthrough:`The ${value} ms delay is elapsed time between two events.`,walkthroughSpoken:`The delay is ${value} milliseconds.`,dialogue:`The measured delay is ${value} ms.`,dialogueSpoken:`The measured delay is ${value} milliseconds.`,question:null}],visuals:[]}};
const plotPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
/** A one-section bundle with a single saved plot, for review-reconciliation tests. */
async function setupPlot(review:()=>{approved:boolean;issues:string[]},holdRevisions=false){
 const turns=Array.from({length:12},(_,index)=>({role:(index%2?'expert':'host') as 'host'|'expert',markdown:'Turn '+index,spokenText:'Turn '+index}));
 const requests:AgentRequest[]=[];
 let authors=0;const runner=async(r:AgentRequest,signal:AbortSignal)=>{requests.push(r);if(r.kind==='review')return review();if(r.kind==='author'&&holdRevisions&&++authors>1)await new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});if(r.kind==='author')return{...await answer(r) as object,visuals:[{id:'source-asset-0',caption:'Latency plot',explanation:'The vertical axis shows latency.',spokenText:'The vertical axis shows latency.',dialogueTurns:turns}]};return answer(r)};
 const t=await setup(runner,'# Time\n\nA delay of 42 ms.\n\n![Plot](source-asset-0)');const bundle=t.store.getBundle('source')!;const assetId='a'.repeat(64);
 bundle.sources[0].assets=[{id:'source-asset-0',kind:'image',alt:'Plot',caption:'Latency plot',src:'/api/source-assets/'+assetId}];bundle.sources[0].inventory={images:1,inlineSvg:0,tables:0,savedVisuals:1};
 t.store.saveBundle(bundle,[{id:assetId,type:'image/png',bytes:plotPng}]);
 return {...t,requests};
}
it('accepts a section when the only review issue is a visual turn count the parsed draft disproves',async()=>{
 const {service,store}=await setupPlot(()=>({approved:false,issues:['Visual source-asset-0 has 14 dialogue turns, exceeding the required maximum of 12 per visual. Merge exchanges to reach 12 or fewer turns.']}));
 service.start('source','codex');const job=await finished(service);expect(job.error).toBeUndefined();expect(job.status).toBe('completed');expect(store.list()).toHaveLength(1);
});
it('retains semantic feedback when it shares an issue with a disproved visual turn count',async()=>{
 const {service,store}=await setupPlot(()=>({approved:false,issues:['Visual source-asset-0 has 14 dialogue turns, exceeding the required maximum of 12 per visual; it also mislabels the vertical axis as revenue instead of latency.']}),true);
 const started=service.start('source','codex');await expect.poll(()=>service.state().jobs[0].stage).toContain('mislabels the vertical axis');expect(service.state().jobs[0].stage).not.toContain('14 dialogue turns');service.stop(started.id);expect((await finished(service)).status).toBe('stopped');expect(store.list()).toEqual([]);
});
it('passes agent images from inside the call directory so the isolated agent service accepts them',async()=>{
 const {service,requests}=await setupPlot(()=>({approved:true,issues:[]}));
 service.start('source','codex');expect((await finished(service)).status).toBe('completed');
 const withImages=requests.filter(r=>r.images.length);expect(withImages.length).toBeGreaterThan(0);
 for(const r of withImages)for(const image of r.images)expect(image.startsWith(r.cwd+'/')).toBe(true);
});
it('keeps a fixed trust boundary around every agent task when teaching prompts are customized',async()=>{const requests:AgentRequest[]=[];const {service,store}=await setup(async r=>{requests.push(r);return answer(r)});const settings=store.getSettings();settings.prompts.principles='CUSTOM TEACHING PREFERENCE WITHOUT SECURITY TEXT';store.saveSettings(settings);service.start('source','codex');expect((await finished(service)).status).toBe('completed');expect(requests.length).toBeGreaterThan(2);expect(requests.every(request=>request.prompt.startsWith('NARAD_FIXED_POLICY_V1'))).toBe(true);expect(requests.every(request=>request.prompt.includes('CUSTOM TEACHING PREFERENCE WITHOUT SECURITY TEXT'))).toBe(true)});
it('wraps source and learner data in untrusted JSON values inside every preparation prompt',async()=>{const requests:AgentRequest[]=[];const {service}=await setup(async r=>{requests.push(r);return answer(r)});service.start('source','codex');expect((await finished(service)).status).toBe('completed');expect(requests.find(r=>r.kind==='author')!.prompt).toContain('{"trust":"untrusted","label":"input"');expect(requests.find(r=>r.kind==='review')!.prompt).toContain('{"trust":"untrusted","label":"draft"');expect(requests.find(r=>r.kind==='summary')!.prompt).toContain('{"trust":"untrusted","label":"sections"')});
it('reuses compatible approved sections after the preparation service restarts',async()=>{
 let run=1;const authored:string[]=[];const runner=async(r:AgentRequest,s:AbortSignal)=>{if(r.kind==='author'){const section=r.name.match(/-(s\d+)-/)?.[1]??'s00';authored.push(run+':'+section);if(run===1&&section==='s01')throw new Error('provider stopped')}return sectionAnswer(r)};
 const {service,store,dir}=await setup(runner,'# First\n\nA delay of 42 ms.\n\n# Second\n\nA delay of 7 ms.');const settings=store.getSettings();settings.preparation.sectionsAtOnce=1;store.saveSettings(settings);service.start('source','codex');expect((await finished(service)).status).toBe('failed');
 const restarted=new PreparationService(store,dir,{run:runner,available:()=>[{id:'codex',available:true},{id:'claude',available:true}]});services.push(restarted);run=2;restarted.start('source','codex');expect((await finished(restarted)).status).toBe('completed');
 expect(authored.filter(call=>call.startsWith('2:'))).toEqual(['2:s01']);
});
it('regenerates a previously approved section when its source changes',async()=>{
 let run=1;const authored:string[]=[];const runner=async(r:AgentRequest,s:AbortSignal)=>{if(r.kind==='author'){const section=r.name.match(/-(s\d+)-/)?.[1]??'s00';authored.push(run+':'+section);if(run===1&&section==='s01')throw new Error('provider stopped')}return sectionAnswer(r)};
 const {service,store,dir}=await setup(runner,'# First\n\nA delay of 42 ms.\n\n# Second\n\nA delay of 7 ms.');const settings=store.getSettings();settings.preparation.sectionsAtOnce=1;store.saveSettings(settings);service.start('source','codex');expect((await finished(service)).status).toBe('failed');
 const bundle=store.getBundle('source')!;bundle.sources[0].markdown='# First\n\nA delay of 43 ms.\n\n# Second\n\nA delay of 7 ms.';store.saveBundle(bundle,[]);
 const restarted=new PreparationService(store,dir,{run:runner,available:()=>[{id:'codex',available:true},{id:'claude',available:true}]});services.push(restarted);run=2;restarted.start('source','codex');expect((await finished(restarted)).status).toBe('completed');
 expect(authored.filter(call=>call.startsWith('2:')).sort()).toEqual(['2:s00','2:s01']);
});
