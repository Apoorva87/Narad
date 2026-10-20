import { z } from 'zod';
import { parseLesson, type Lesson, type LessonBlock, type Section } from '../shared/lesson';
import type { SourceBundle } from '../shared/sources';

const prose = z.string().trim().min(1);
export const authoredSectionSchema = z.object({
  id: prose, introduction: prose, hostQuestion: prose,
  units: z.array(z.object({ id: prose, walkthrough: prose, walkthroughSpoken: prose, dialogue: prose, dialogueSpoken: prose, question: prose.optional() })),
  visuals: z.array(z.object({ id: prose, caption: prose, explanation: prose, spokenText: prose, dialogueTurns: z.array(z.object({ role: z.enum(['host', 'expert']), markdown: prose, spokenText: prose })).min(2).max(12).optional() })),
});
export type AuthoredSection = z.infer<typeof authoredSectionSchema>;
export type SourceUnit = { id: string; kind: 'text' | 'table' | 'figure'; markdown: string; assetIds: string[] };
export type SourceSection = { id: string; title: string; units: SourceUnit[] };
export type TeachingInput = {
  id: string; title: string; description: string; topic: string; bundle: SourceBundle;
  authored: AuthoredSection[];
  summary: { title: string; markdown: string; spokenText: string; sourceSections?: string[] }[];
  speakers?: Speakers;
};
export type Speakers = { host: string; expert: string };
export function splitSourceSections(markdown: string): SourceSection[] {
  return markdown.split(/(?=^#{1,3} )/m).filter(part => part.trim()).map((part, i) => {
    const lines = part.split('\n');
    const heading = /^#{1,3} /.test(lines[0]) ? lines.shift()! : 'Introduction';
    const id = 's' + String(i).padStart(2, '0');
    const units = lines.join('\n').trim().split(/\n\s*\n/).filter(chunk => chunk.trim()).map((chunk, j): SourceUnit => ({
      id: id + '-u' + String(j).padStart(2, '0'), markdown: chunk.trim(),
      kind: /^!\[[^\]]*\]\(source-asset-[a-zA-Z0-9_-]+\)$/.test(chunk.trim()) ? 'figure' : chunk.trimStart().startsWith('|') ? 'table' : 'text',
      assetIds: [...chunk.matchAll(/\]\((source-asset-[a-zA-Z0-9_-]+)\)/g)].map(match => match[1]),
    }));
    return { id, title: heading.replace(/^#+\s*/, '').replace(/\\\./g, '.').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'), units };
  });
}

export function compileTeachingLesson(input: TeachingInput): Lesson {
  const articles = input.bundle.sources.filter(source => source.kind === 'article');
  if (articles.length !== 1) throw new Error('This preparation format requires exactly one captured article.');
  const source = articles[0];
  if (!source.markdown || source.assets.some(asset => !asset.src)) throw new Error('Complete source capture before preparing the lesson.');
  const layout = splitSourceSections(source.markdown);
  const authored = z.array(authoredSectionSchema).parse(input.authored);
  if (new Set(authored.map(section => section.id)).size !== authored.length || authored.length !== layout.length) throw new Error('Provide exactly one teaching section per source section.');
  const notes = new Map(authored.flatMap(section => section.visuals).map(visual => [visual.id, visual]));
  const assets = source.assets.map(asset => {
    const note = notes.get(asset.id); if (!note) throw new Error('Missing visual explanation: ' + asset.id);
    return { id: asset.id, src: asset.src!, kind: asset.kind, widthEm: asset.widthEm, alt: note.caption, caption: note.caption, provenance: 'source' as const };
  });
  const { host, expert } = input.speakers ?? { host: 'Maya', expert: 'Arun' };
  const makeMode = (mode: 'walkthrough' | 'dialogue'): Section[] => layout.map(section => {
    const teaching = authored.find(item => item.id === section.id);
    if (!teaching) throw new Error('Missing teaching section: ' + section.id);
    const nonFigures = section.units.filter(unit => unit.kind !== 'figure');
    const unitIds = teaching.units.map(unit => unit.id);
    if (new Set(unitIds).size !== unitIds.length || unitIds.some(id => !nonFigures.some(unit => unit.id === id))) throw new Error('Unexpected or duplicate teaching unit in ' + section.id);
    const references = [{ sourceId: source.id, locator: section.title }];
    const prefix = mode === 'walkthrough' ? 'w-' : 'd-';
    const blocks: LessonBlock[] = mode === 'walkthrough'
      ? [{ id: prefix + section.id + '-intro', kind: 'callout', title: 'What to understand here', markdown: teaching.introduction, spokenText: teaching.introduction, origin: 'teaching', references }]
      : [{ id: prefix + section.id + '-host', kind: 'dialogue', speaker: host, role: 'host', markdown: teaching.hostQuestion, spokenText: teaching.hostQuestion, origin: 'teaching', references }];
    if (mode === 'dialogue' && nonFigures.length === 0) blocks.push({ id: prefix + section.id + '-intro', kind: 'dialogue', speaker: expert, role: 'expert', markdown: teaching.introduction, spokenText: teaching.introduction, origin: 'teaching', references });
    for (const unit of section.units) {
      if (unit.kind !== 'figure') {
        const explanation = teaching.units.find(item => item.id === unit.id);
        if (!explanation) throw new Error('Missing teaching unit: ' + unit.id);
        if (mode === 'dialogue' && explanation.question) blocks.push({ id: prefix + unit.id + '-host', kind: 'dialogue', speaker: host, role: 'host', markdown: explanation.question, spokenText: explanation.question, origin: 'teaching', references });
        const common = { id: prefix + unit.id, references, origin: 'teaching' as const };
        blocks.push(mode === 'walkthrough'
          ? { ...common, kind: 'text', markdown: explanation.walkthrough, spokenText: explanation.walkthroughSpoken }
          : { ...common, kind: 'dialogue', role: 'expert', speaker: expert, markdown: explanation.dialogue, spokenText: explanation.dialogueSpoken });
        if (unit.kind === 'table') blocks.push({ id: prefix + unit.id + '-table', kind: 'text', markdown: unit.markdown, spokenText: 'The original table is shown here for reference.', origin: 'source', references });
      }
      for (const assetId of unit.assetIds) {
        const visual = teaching.visuals.find(item => item.id === assetId);
        if (!visual) throw new Error('Missing visual explanation in ' + section.id + ': ' + assetId);
        const turns = mode === 'dialogue' ? visual.dialogueTurns : undefined;
        blocks.push({ id: prefix + unit.id + '-' + assetId, kind: 'figure', assetId, markdown: turns ? visual.caption : visual.explanation, spokenText: turns ? 'Let’s look at the source visual together.' : visual.spokenText, origin: 'teaching', references });
        turns?.forEach((turn, i) => blocks.push({ id: prefix + unit.id + '-' + assetId + '-turn-' + i, kind: 'dialogue', role: turn.role, speaker: turn.role === 'host' ? host : expert, markdown: turn.markdown, spokenText: turn.spokenText, origin: 'teaching', references }));
      }
    }
    return { id: section.id, title: section.title, blocks };
  });
  if (!input.summary.length) throw new Error('Provide a quick summary.');
  return parseLesson({ version: 1, id: input.id, title: input.title, description: input.description, topic: input.topic,
    sourceBundleId: input.bundle.id, createdAt: new Date().toISOString(), isSample: false, familiarity: 'foundational',
    sources: [{ id: source.id, title: source.title, kind: 'article', url: source.url, content: source.markdown, locators: layout.map(section => section.title) }], assets,
    modes: {
      summary: { title: 'Quick summary', sections: input.summary.map((section, i) => ({ id: 'summary-' + i, title: section.title, blocks: [{ id: 'summary-' + i, kind: 'text', markdown: section.markdown, spokenText: section.spokenText, origin: 'teaching', references: (section.sourceSections ?? [layout[0].id]).map(id => ({ sourceId: source.id, locator: layout.find(item => item.id === id)?.title ?? id })) }] })) },
      walkthrough: { title: 'Detailed walkthrough', sections: makeMode('walkthrough') },
      dialogue: { title: 'Tutor dialogue', sections: makeMode('dialogue') },
    },
  });
}
