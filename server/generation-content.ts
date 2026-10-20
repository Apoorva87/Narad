import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseLesson, type Lesson } from '../shared/lesson';
import { isBlocking, type CapturedSource, type SourceAsset, type SourceBundle } from '../shared/sources';
import { authoredSectionSchema, compileTeachingLesson, splitSourceSections, type AuthoredSection, type SourceSection, type Speakers } from './lesson-preparation';
export type TeachingTask = { id: string; source: CapturedSource; section: SourceSection; assets: SourceAsset[] };
export type TeachingOutput = { task: TeachingTask; teaching: AuthoredSection };
export const agentSectionSchema = authoredSectionSchema.extend({ visuals: z.array(authoredSectionSchema.shape.visuals.element.extend({ dialogueTurns: authoredSectionSchema.shape.visuals.element.shape.dialogueTurns.unwrap() })), units: z.array(authoredSectionSchema.shape.units.element.extend({ question: z.string().nullable() })) });
export const summarySchema = z.object({ sections: z.array(z.object({ title: z.string().min(1), markdown: z.string().min(1), spokenText: z.string().min(1), sourceIds: z.array(z.string()).min(1) })).min(1) });
export type Summary = z.infer<typeof summarySchema>['sections'];
export const reviewSchema = z.object({ approved: z.boolean(), issues: z.array(z.string()) });
export const researchSchema = z.object({ links: z.array(z.string().regex(/^https?:\/\/[^\s]+$/)).min(1).max(4), rationale: z.string() });
export type ChunkLimits = { chunkChars: number; chunkUnits: number };
export function buildTeachingPlan(bundle: SourceBundle, limits: ChunkLimits = { chunkChars: 7000, chunkUnits: 8 }): TeachingTask[] {
  if (bundle.status !== 'captured' || bundle.sources.some(s=>isBlocking(s) || s.assets.some(a=>!a.src))) throw new Error('Finish source capture and resolve its warnings before preparing a lesson.');
  const sources = bundle.sources.some(s=>s.kind !== 'note') ? bundle.sources.filter(s=>s.kind !== 'note') : bundle.sources;
  const tasks: TeachingTask[] = [];
  for (const [index, source] of sources.entries()) {
    if (!source.markdown.trim()) throw new Error('Source is empty: '+source.title);
    for (const section of splitSourceSections(source.markdown)) {
      let units: SourceSection['units'] = []; let size = 0; let part = 0;
      const emit = () => {
        const ids = new Set(units.flatMap(u=>u.assetIds));
        tasks.push({id:`r${index}-${section.id}-p${part++}`,source,section:{...section,units},assets:source.assets.filter(a=>ids.has(a.id))}); units=[];size=0;
      };
      for (const unit of section.units) {
        if (unit.markdown.length > 24_000) throw new Error('A source paragraph/table is too large for reliable preparation. Split this source before retrying.');
        if (units.length && (size+unit.markdown.length>limits.chunkChars || units.length>=limits.chunkUnits)) emit();
        units.push(unit);size+=unit.markdown.length;
      }
      if (units.length || part===0) emit();
    }
  }
  return tasks;
}
/** Identifies a section's source: SHA-256 of its units' Markdown joined with blank lines, plus its sorted asset IDs. */
export function sectionHash(task: TeachingTask): string {
  return createHash('sha256').update(task.section.units.map(u=>u.markdown).join('\n\n')).update('\0').update(task.assets.map(a=>a.id).sort().join('\n')).digest('hex');
}
export function numericTokens(text:string):Set<string> {
  const cleaned=text.replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/https?:\/\/\S+/g,'').replace(/\\?\[\d+\\?\]/g,'').replace(/(\d),(?=\d{3})/g,'$1').replace(/^\s*`?\d+\.\s*/gm,'');
  return new Set(cleaned.match(/(?<![A-Za-z_\d])\d+(?:\.\d+)?/g)??[]);
}
export function checkTeaching(task:TeachingTask, input:unknown):string[] {
  const parsed=authoredSectionSchema.safeParse(input);
  if (!parsed.success) return ['Invalid teaching structure: '+parsed.error.message.slice(0,1500)];
  const teaching=parsed.data;const issues:string[]=[];
  if(teaching.id!==task.section.id) issues.push('Wrong section ID');
  const units=task.section.units.filter(u=>u.kind!=='figure' && u.kind!=='note');
  for(const unit of units) {
    const draft=teaching.units.find(u=>u.id===unit.id);
    if(!draft) {issues.push('Missing unit '+unit.id);continue;}
    for(const mode of ['walkthrough','dialogue'] as const) {
      if(unit.kind==='text') {const written=numericTokens(draft[mode]);const missing=[...numericTokens(unit.markdown)].filter(n=>!written.has(n));if(missing.length) issues.push(`${unit.id} ${mode} missing values: ${missing.join(', ')}`);}
      if(unit.kind==='text' && draft[mode].trim()===unit.markdown.trim()) issues.push(`${unit.id} ${mode} copies the source without explaining it`);
    }
  }
  if(teaching.units.length!==units.length || new Set(teaching.units.map(u=>u.id)).size!==units.length) issues.push('Unexpected or duplicate unit IDs');
  for(const asset of task.assets) if(!teaching.visuals.some(v=>v.id===asset.id)) issues.push('Missing visual '+asset.id);
  for (const visual of teaching.visuals) if (visual.dialogueTurns && (!visual.dialogueTurns.some(t=>t.role==='host') || !visual.dialogueTurns.some(t=>t.role==='expert'))) issues.push('Visual '+visual.id+' needs both host and expert dialogue turns.');
  if(teaching.visuals.some(v=>!task.assets.some(a=>a.id===v.id)) || new Set(teaching.visuals.map(v=>v.id)).size!==teaching.visuals.length) issues.push('Unexpected or duplicate visual IDs');
  return issues;
}
export function reconcileReviewIssues(teaching:AuthoredSection,issues:string[]):string[] {
  return issues.flatMap(issue=>{
    let disprovedCount=false;
    return issue.split(/(?<=[.!?])\s+|;\s*/).map(clause=>clause.trim()).filter(clause=>{
      const countClaim=clause.match(/^Visual\s+([A-Za-z0-9._-]+)\s+has\s+\d+\s+dialogue turns?,?\s+(?:(?:which|and)\s+)?(?:exceed(?:s|ing)?|is\s+(?:over|above))\s+(?:the\s+)?(?:required\s+)?maximum(?:\s+of)?\s+12(?:\s+per\s+visual)?[.!?]?$/i);
      if(countClaim){
        const turns=teaching.visuals.find(visual=>visual.id===countClaim[1])?.dialogueTurns;
        if(turns&&turns.length<=12){disprovedCount=true;return false}
      }
      if(disprovedCount&&/^(?:merge|combine|reduce|shorten|trim)\b.*\b(?:12|twelve)\s+or\s+fewer\s+(?:dialogue\s+)?turns?\b/i.test(clause))return false;
      return true;
    });
  });
}
/** A plain-text card description from the synthesis: no Markdown or math syntax, cut at a sentence. */
export function excerpt(markdown:string,limit=240):string {
  const text=markdown.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g,'').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[*_`#>|]/g,'').replace(/\s+/g,' ').trim();
  if(text.length<=limit)return text||'A source-grounded lesson.';
  const cut=text.slice(0,limit);const end=cut.lastIndexOf('. ');
  return end>limit/2?cut.slice(0,end+1):cut.slice(0,cut.lastIndexOf(' '))+'…';
}
export function compilePreparedBundle(bundle:SourceBundle, outputs:TeachingOutput[], summary:Summary, id:string, options:{limits?:ChunkLimits;speakers?:Speakers}={}):Lesson {
  const tasks=buildTeachingPlan(bundle,options.limits);
  if(outputs.length!==tasks.length || new Set(outputs.map(o=>o.task.id)).size!==tasks.length) throw new Error('Missing or duplicate teaching tasks.');
  const sources=[...new Map(tasks.map(t=>[t.source.id,t.source])).values()];
  const parts=sources.map((source,i)=>{
    const authored=splitSourceSections(source.markdown).map(section=>{
      const pieces=tasks.filter(t=>t.source.id===source.id && t.section.id===section.id).map(task=>{
        const output=outputs.find(o=>o.task.id===task.id);if(!output) throw new Error('Missing task '+task.id);
        const issues=checkTeaching(task,output.teaching);if(issues.length) throw new Error(issues.join('\n'));return output.teaching;
      });
      return {...pieces[0],units:pieces.flatMap(p=>p.units),visuals:[...new Map(pieces.flatMap(p=>p.visuals).map(v=>[v.id,v])).values()]};
    });
    const part=compileTeachingLesson({id:'part-'+i,title:source.title,description:'Prepared teaching',topic:'Learning',bundle:{...bundle,sources:[{...source,kind:'article'}]},authored,summary:[{title:'In brief',markdown:'Prepared separately.',spokenText:'Prepared separately.'}],speakers:options.speakers});
    const prefix='r'+i+'-';const assetIds=new Map(part.assets.map(a=>[a.id,prefix+a.id]));
    const rewrite=(text:string)=>text.replace(/\]\((source-asset-[a-zA-Z0-9_-]+)\)/g,(match,asset:string)=>assetIds.has(asset)?']('+assetIds.get(asset)+')':match);
    part.assets=part.assets.map(a=>({...a,id:prefix+a.id}));
    part.sources=part.sources.map(s=>({...s,kind:source.kind==='article'?'article':'note',content:rewrite(s.content)}));
    for(const mode of ['walkthrough','dialogue'] as const) part.modes[mode]!.sections=part.modes[mode]!.sections.map(s=>({...s,id:prefix+s.id,title:sources.length>1?source.title+' · '+s.title:s.title,blocks:s.blocks.map(b=>({...b,id:prefix+b.id,markdown:rewrite(b.markdown),...(b.kind==='figure'?{assetId:prefix+b.assetId}:{})}))}));
    return part;
  });
  const allSources=parts.flatMap(p=>p.sources);
  if (summary.length !== sources.length + 1) throw new Error('Provide one summary per source followed by an overall synthesis.');
  for (const [i, source] of sources.entries()) if (summary[i].sourceIds.length !== 1 || summary[i].sourceIds[0] !== source.id) throw new Error('Missing individual summary for '+source.title);
  const synthesis = summary.at(-1)!;
  if (synthesis.sourceIds.length !== sources.length || sources.some(source=>!synthesis.sourceIds.includes(source.id))) throw new Error('The synthesis must reference every source.');
  return parseLesson({version:1,id,title:bundle.title,description:excerpt(synthesis.markdown),topic:'Learning',createdAt:new Date().toISOString(),sourceBundleId:bundle.id,isSample:false,familiarity:bundle.familiarity??'foundational',sources:allSources,assets:parts.flatMap(p=>p.assets),modes:{
    summary:{title:'Quick summary',sections:summary.map((s,i)=>({id:'summary-'+i,title:s.title,blocks:[{id:'summary-'+i,kind:'text',markdown:s.markdown,spokenText:s.spokenText,origin:'teaching',references:s.sourceIds.map(sourceId=>({sourceId,locator:allSources.find(source=>source.id===sourceId)?.locators[0]??'Unknown source'}))}]}))},
    walkthrough:{title:'Detailed walkthrough',sections:parts.flatMap(p=>p.modes.walkthrough!.sections)},dialogue:{title:'Tutor dialogue',sections:parts.flatMap(p=>p.modes.dialogue!.sections)},
  }});
}
