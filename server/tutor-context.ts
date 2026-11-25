import type { Lesson, LessonBlock, Mode } from '../shared/lesson';
import { flattenBlocks } from '../shared/navigation';
import type { TutorTurn } from '../shared/tutor';

function lessonBlock(block: LessonBlock) {
  return { id: block.id, kind: block.kind, markdown: block.markdown, spokenText: block.spokenText, references: block.references, origin: block.origin,
    // A question about a check or a diagram needs what the learner sees: the options and the reasoning, or the boxes and arrows.
    ...(block.kind === 'quiz' && { options: block.options, correctOption: block.options[block.answer], explanation: block.explanation }),
    ...(block.kind === 'diagram' && { title: block.title, nodes: block.nodes, edges: block.edges }) };
}

export function buildTutorContext(lesson: Lesson, mode: Mode, blockId: string, turns: TutorTurn[]) {
  const flat = flattenBlocks(lesson, mode);
  const index = flat.findIndex(item => item.block.id === blockId);
  if (index < 0) throw new Error('That passage does not belong to this learning mode.');
  const item = flat[index];
  const nearby = [flat[index - 1]?.block, item.block, flat[index + 1]?.block].filter((block): block is LessonBlock => !!block);
  const referenceIds = new Set(nearby.flatMap(block => block.references.map(reference => reference.sourceId)));
  const assetIds = nearby.filter(block => block.kind === 'figure').map(block => block.assetId);
  return {
    lesson: { id: lesson.id, title: lesson.title, topic: lesson.topic }, familiarity: lesson.familiarity, mode,
    section: { id: item.section.id, title: item.section.title },
    previous: flat[index - 1] ? lessonBlock(flat[index - 1].block) : null,
    active: lessonBlock(item.block),
    next: flat[index + 1] ? lessonBlock(flat[index + 1].block) : null,
    sources: lesson.sources.filter(source => referenceIds.has(source.id)).map(source => ({ id: source.id, title: source.title, content: source.content, locators: source.locators })),
    assets: lesson.assets.filter(asset => assetIds.includes(asset.id)).map(asset => ({ id: asset.id, kind: asset.kind, alt: asset.alt, caption: asset.caption, provenance: asset.provenance })),
    thread: turns.map(turn => ({ question: turn.question, answer: turn.answer ?? null })),
  };
}
