import { describe, expect, it } from 'vitest';
import { buildTeachingPlan, compilePreparedBundle, checkTeaching, excerpt, reconcileReviewIssues, type TeachingTask } from '../server/generation-content';
import { authoredSectionSchema } from '../server/lesson-preparation';
import type { SourceBundle } from '../shared/sources';
const article = (id:string) => ({id,title:id,kind:'article' as const,markdown:'# Measure\n\nLatency is 42 ms.\n\n![Plot](source-asset-0)\n\n| A | B |\n| --- | --- |\n| x | 12 |',assets:[{id:'source-asset-0',kind:'image' as const,alt:'Plot',caption:'Plot',src:'/api/source-assets/'+'a'.repeat(64)}],warnings:[],inventory:{images:1,inlineSvg:0,tables:1,savedVisuals:1}});
export const bundle:SourceBundle={id:'collection',title:'Comparing measurements',createdAt:new Date().toISOString(),text:'Explain',status:'captured',sources:[article('one'),article('two')]};
export const draft=(task:TeachingTask)=>({id:task.section.id,introduction:'Understand the measurement.',hostQuestion:'What does this measurement mean?',units:task.section.units.filter(u=>u.kind!=='figure'&&u.kind!=='note').map(u=>({id:u.id,walkthrough:'The latency is 42 ms. The table value is 12. This is elapsed time.',walkthroughSpoken:'The latency is forty two milliseconds. The table value is twelve.',dialogue:'It takes 42 ms, and the table lists 12. Think of a stopwatch.',dialogueSpoken:'It takes forty two milliseconds. Think of a stopwatch.',question:'How should I interpret this?'})),visuals:task.assets.map(a=>({id:a.id,caption:'Latency plot',explanation:'Read the horizontal axis before comparing delays.',spokenText:'Read the horizontal axis before comparing delays.'}))});
it('assembles multiple sources without collisions and preserves exact tables and original snapshots',()=>{
 const tasks=buildTeachingPlan(bundle); const outputs=tasks.map(t=>({task:t,teaching:draft(t)}));
 const lesson=compilePreparedBundle(bundle,outputs,[{title:'One',markdown:'A delay.',spokenText:'A delay.',sourceIds:['one']},{title:'Two',markdown:'Another delay.',spokenText:'Another delay.',sourceIds:['two']},{title:'Together',markdown:'Compare equal units.',spokenText:'Compare equal units.',sourceIds:['one','two']}],'generated');
 expect(lesson.sources.map(s=>s.id)).toEqual(['one','two']);expect(new Set(lesson.assets.map(a=>a.id)).size).toBe(2);
 expect(lesson.modes.walkthrough!.sections).toHaveLength(2);
 expect(lesson.modes.dialogue!.sections.flatMap(s=>s.blocks).filter(b=>b.kind==='figure')).toHaveLength(2);
 expect(lesson.modes.walkthrough!.sections[0].blocks.some(b=>b.markdown.includes('| x | 12 |'))).toBe(true);
 expect(lesson.sources[1].content).toContain('Latency is 42 ms.');
});
it('treats an uploaded image as a required visual instead of dropping nonnumeric asset ids',()=>{
 const imageBundle={...bundle,sources:[{...article('photo'),kind:'image' as const,markdown:'![Photo](source-asset-upload)',assets:[{...article('photo').assets[0],id:'source-asset-upload'}]}]};
 const task=buildTeachingPlan(imageBundle)[0];expect(task.section.units[0].kind).toBe('figure');expect(task.assets[0].id).toBe('source-asset-upload');
 expect(checkTeaching(task,{...draft(task),visuals:[]})).toContain('Missing visual source-asset-upload');
});
it('rejects omitted numeric facts and missing units before publishing',()=>{
 const task=buildTeachingPlan(bundle)[0];const d=draft(task);d.units[0].walkthrough='It takes some time.';
 expect(checkTeaching(task,d).join(' ')).toContain('42');d.units=[];expect(checkTeaching(task,d).join(' ')).toContain('Missing unit');
});
it('refuses incomplete capture and segments large sources without dropping units',()=>{
 expect(()=>buildTeachingPlan({...bundle,status:'needs-review'})).toThrow(/capture/i);
 const long={...bundle,sources:[{...article('long'),assets:[],markdown:'# Long\n\n'+Array.from({length:20},(_,i)=>'Paragraph '+i+' '+('explanation '.repeat(80))).join('\n\n')}]};
 const tasks=buildTeachingPlan(long);expect(tasks.length).toBeGreaterThan(1);expect(tasks.flatMap(t=>t.section.units)).toHaveLength(20);
});
it('requires an individual summary per resource and a final synthesis',()=>{
 const outputs=buildTeachingPlan(bundle).map(task=>({task,teaching:draft(task)}));
 expect(()=>compilePreparedBundle(bundle,outputs,[{title:'Combined',markdown:'Both concern time.',spokenText:'Both concern time.',sourceIds:['one','two']}],'combined')).toThrow(/summary|synthesis/i);
});
it('gives an image-only conversation an expert response as well as its preserved figure',()=>{
 const b={...bundle,sources:[{...article('image'),kind:'image' as const,markdown:'![Plot](source-asset-0)'}]};const outputs=buildTeachingPlan(b).map(task=>({task,teaching:draft(task)}));
 const summaries=[{title:'Image',markdown:'The plot compares delays.',spokenText:'The plot compares delays.',sourceIds:['image']},{title:'Takeaway',markdown:'Use equal units.',spokenText:'Use equal units.',sourceIds:['image']}];
 const lesson=compilePreparedBundle(b,outputs,summaries,'image-lesson');expect(lesson.modes.dialogue!.sections[0].blocks.some(b=>b.kind==='dialogue'&&b.role==='expert')).toBe(true);
});
it('preserves figure dialogue turns as a conversation rather than reusing the walkthrough monologue',()=>{
 const b={...bundle,sources:[{...article('image'),kind:'image' as const,markdown:'![Plot](source-asset-0)'}]};const task=buildTeachingPlan(b)[0];const teaching=draft(task);const visual={...teaching.visuals[0],dialogueTurns:[{role:'host' as const,markdown:'What do the axes tell us?',spokenText:'What do the axes tell us?'},{role:'expert' as const,markdown:'The horizontal axis tells us which delay was measured.',spokenText:'The horizontal axis tells us which delay was measured.'}]};
 const lesson=compilePreparedBundle(b,[{task,teaching:{...teaching,visuals:[visual]}}],[{title:'Image',markdown:'A delay plot.',spokenText:'A delay plot.',sourceIds:['image']},{title:'Together',markdown:'Compare units.',spokenText:'Compare units.',sourceIds:['image']}],'visual-dialogue');
 const blocks=lesson.modes.dialogue!.sections[0].blocks;expect(blocks.some(b=>b.kind==='dialogue'&&b.role==='host'&&b.markdown==='What do the axes tell us?')).toBe(true);expect(blocks.some(b=>b.kind==='dialogue'&&b.role==='expert'&&b.markdown.includes('horizontal axis tells'))).toBe(true);expect(blocks.filter(b=>b.kind==='figure')).toHaveLength(1);
});
it('accepts complete visual dialogues of any length and discards invented hard-limit claims',()=>{
 const task=buildTeachingPlan(bundle)[0];const teaching=draft(task);const turns=Array.from({length:18},(_,index)=>({role:(index%2?'expert':'host') as 'host'|'expert',markdown:'Turn '+index,spokenText:'Turn '+index}));
 const reviewed={...teaching,visuals:teaching.visuals.map(visual=>({...visual,dialogueTurns:turns}))};
 const falseCount='Visual source-asset-0 has 18 dialogue turns, exceeding the required maximum of 12 per visual. Merge exchanges to reach 12 or fewer turns.';
 expect(authoredSectionSchema.safeParse(reviewed).success).toBe(true);
 expect(reconcileReviewIssues(reviewed,[falseCount])).toEqual([]);
 expect(reconcileReviewIssues(reviewed,[falseCount,'The orange shading is described as quantitative without a legend.'])).toEqual(['The orange shading is described as quantitative without a legend.']);
 const combined='Visual source-asset-0 has 18 dialogue turns, exceeding the required maximum of 12 per visual; it also mislabels the vertical axis as revenue instead of latency.';
 expect(reconcileReviewIssues(reviewed,[combined])).toEqual(['it also mislabels the vertical axis as revenue instead of latency.']);
 const differentInventedLimit='Visual source-asset-0 has 18 dialogue turns, exceeding the required maximum of 16 per visual. Merge exchanges to reach 16 or fewer turns.';
 expect(reconcileReviewIssues(reviewed,[differentInventedLimit])).toEqual([]);
});
it('does not accept invented non-URL source labels as discovered research links',async()=>{
 const {researchSchema}=await import('../server/generation-content');expect(researchSchema.safeParse({links:['Some authoritative article'],rationale:'Helpful'}).success).toBe(false);
});
describe('lesson description excerpt', () => {
  it('strips Markdown and math and stops at a sentence boundary', () => {
    expect(excerpt('**Bandwidth** sets a ceiling of $T = B/W$ tokens. See [the paper](https://x.y).')).toBe('Bandwidth sets a ceiling of tokens. See the paper.');
    expect(excerpt('One sentence that is long enough to pass the halfway mark of the limit. '+'More words follow here. '.repeat(12))).toSatisfy((text:string)=>text.length<=240&&text.endsWith('follow here.'));
    expect(excerpt('')).toBe('A source-grounded lesson.');
  });
});

const noteSource=()=>({...article('page'),url:'https://example.com/p',assets:[],markdown:'# Measure\n\nLatency is 42 ms.\n\n![Interactive figure](source-note-0)\n\nAfter that.',warnings:[{kind:'info' as const,message:'An interactive figure could not be kept.'}]});
it('prepares a page with informational warnings and compiles a Not captured callout',()=>{
 const b={...bundle,sources:[noteSource()]};const tasks=buildTeachingPlan(b);
 expect(tasks.flatMap(t=>t.section.units).filter(u=>u.kind==='note')).toHaveLength(1);
 const outputs=tasks.map(t=>({task:t,teaching:draft(t)}));
 expect(checkTeaching(tasks[0],draft(tasks[0]))).toEqual([]);
 const lesson=compilePreparedBundle(b,outputs,[{title:'One',markdown:'A.',spokenText:'A.',sourceIds:['page']},{title:'All',markdown:'B.',spokenText:'B.',sourceIds:['page']}],'lesson');
 const blocks=lesson.modes.walkthrough!.sections.flatMap(s=>s.blocks);
 const i=blocks.findIndex(x=>x.kind==='callout'&&x.title==='Not captured');
 expect(i).toBeGreaterThan(0);expect(blocks[i].markdown).toBe('An interactive figure here could not be kept. [Open the original ↗](https://example.com/p)');
 expect(blocks[i].origin).toBe('source');
});
it('refuses a source with a blocking warning',()=>{
 const b={...bundle,sources:[{...noteSource(),warnings:[{kind:'blocking' as const,message:'Plot: failed'}]}]};
 expect(()=>buildTeachingPlan(b)).toThrow(/capture/);
});
it('carries credit and a streamed video through the library folder into the lesson',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {LessonStore}=await import('../server/store');const {captureArticle}=await import('../server/capture');
 const html='<article><h1>Talks</h1><p>Watch now.</p><figure><iframe title="Lecture" src="https://www.youtube.com/embed/abcDEF123"></iframe><figcaption>Lecture. Credit: Ann</figcaption></figure></article>';
 const captured=await captureArticle('https://example.com/p',async url=>({bytes:Buffer.from(html),type:'text/html',url}));
 const dir=mkdtempSync(join(tmpdir(),'narad-video-'));const store=new LessonStore(join(dir,'db'));
 try{
  const saved=store.saveBundle({id:'b',title:'Talks',createdAt:new Date().toISOString(),text:'x',status:'captured',sources:[captured.source]},captured.blobs);
  const reloaded=store.getBundle(saved.id)!;const asset=reloaded.sources[0].assets[0];
  expect(asset).toMatchObject({kind:'video',src:'/assets/video-poster.svg',video:{provider:'youtube',embedUrl:'https://www.youtube-nocookie.com/embed/abcDEF123'},credit:{creditLine:'Lecture. Credit: Ann'}});
  const tasks=buildTeachingPlan(reloaded);expect(tasks.flatMap(t=>t.assets).map(a=>a.kind)).toEqual(['video']);
  const lesson=compilePreparedBundle(reloaded,tasks.map(t=>({task:t,teaching:draft(t)})),[{title:'S',markdown:'A talk.',spokenText:'A talk.',sourceIds:[reloaded.sources[0].id]},{title:'All',markdown:'A talk.',spokenText:'A talk.',sourceIds:[reloaded.sources[0].id]}],'lesson');
  expect(lesson.assets[0]).toMatchObject({kind:'video',video:{provider:'youtube'},credit:{creditLine:'Lecture. Credit: Ann',pageUrl:'https://example.com/p'}});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
