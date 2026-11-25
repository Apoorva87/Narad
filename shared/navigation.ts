import type { Lesson, LessonBlock, Mode, Section } from './lesson';
export type LocatedBlock = { block: LessonBlock; section: Section; sectionIndex: number };
export function flattenBlocks(lesson: Lesson, mode: Mode): LocatedBlock[] {
  return lesson.modes[mode]?.sections.flatMap((section, sectionIndex) =>
    section.blocks.map(block => ({ block, section, sectionIndex }))) ?? [];
}
export function moveBlock(lesson: Lesson, mode: Mode, blockId: string, offset: number): LocatedBlock | undefined {
  const blocks = flattenBlocks(lesson, mode);
  const index = Math.max(0, blocks.findIndex(item => item.block.id === blockId));
  return blocks[Math.max(0, Math.min(blocks.length - 1, index + offset))];
}
/** The visual on screen at this passage: the most recent figure or teaching diagram at or before it. */
export function latestFigureIndex(blocks: LocatedBlock[], index: number): number {
  for (let i = Math.min(index, blocks.length - 1); i >= 0; i--) if (blocks[i].block.kind === 'figure' || blocks[i].block.kind === 'diagram') return i;
  return -1;
}
