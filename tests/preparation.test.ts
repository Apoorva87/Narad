import { describe, expect, it } from 'vitest';
import { compileTeachingLesson, splitSourceSections } from '../server/lesson-preparation';
import type { SourceBundle } from '../shared/sources';

const source = { id: 'article-1', title: 'An article', kind: 'article' as const, markdown: '# A section\n\nA result of 42 units.\n\n![Plot](source-asset-0)\n\n| Measure | Value |\n| --- | --- |\n| Latency | 12 |', assets: [{ id: 'source-asset-0', kind: 'image' as const, src: '/api/source-assets/' + 'a'.repeat(64), alt: 'Plot', caption: 'Original plot' }], warnings: [], inventory: { images: 1, inlineSvg: 0, tables: 1, savedVisuals: 1 } };
const bundle: SourceBundle = { id: 'bundle-1', title: 'A topic', createdAt: '2026-10-19T00:00:00.000Z', text: 'Explain', status: 'captured', sources: [source] };
const authored = [{ id: 's00', introduction: 'Let’s understand how the result is measured.', hostQuestion: 'What does this result mean?', units: [
  { id: 's00-u00', walkthrough: 'The result is 42 units: a quantity, not a rate.', walkthroughSpoken: 'The result is forty two units. That is a quantity, not a rate.', dialogue: 'Think of 42 as a quantity. There is no time denominator here.', dialogueSpoken: 'Think of forty two as a quantity. There is no time denominator here.' },
  { id: 's00-u02', walkthrough: 'The table records latency, which is a duration.', walkthroughSpoken: 'The table records latency, which is a duration.', dialogue: 'Here we switch from quantity to a delay of 12.', dialogueSpoken: 'Here we switch from quantity to a delay of twelve.' },
], visuals: [{ id: 'source-asset-0', caption: 'How the result is plotted', explanation: 'Use the axes to identify what was measured.', spokenText: 'Use the axes to identify what was measured.' }] }];
const input = () => ({ id: 'prepared-topic', title: 'Understanding the result', description: 'Learn the reasoning.', topic: 'Science', bundle, authored, summary: [{ title: 'In brief', markdown: 'The quantity and latency measure different things.', spokenText: 'The quantity and latency measure different things.' }] });

describe('teaching lesson preparation', () => {
  it('compiles distinct teaching modes with source-order figures and exact tables', () => {
    const lesson = compileTeachingLesson(input());
    expect(lesson.sourceBundleId).toBe(bundle.id);
    expect(lesson.modes.summary?.sections[0].blocks[0].markdown).toContain('different things');
    for (const mode of ['walkthrough', 'dialogue'] as const) {
      const blocks = lesson.modes[mode]!.sections[0].blocks;
      expect(blocks.filter(block => block.kind === 'figure').map(block => block.assetId)).toEqual(['source-asset-0']);
      expect(blocks.findIndex(block => block.kind === 'figure')).toBeLessThan(blocks.findIndex(block => block.id.endsWith('-table')));
      expect(blocks.find(block => block.id.endsWith('-table'))?.markdown).toContain('| Latency | 12 |');
      expect(blocks.every(block => block.spokenText.length > 0)).toBe(true);
    }
    expect(lesson.modes.dialogue?.sections[0].blocks[0]).toMatchObject({ kind: 'dialogue', role: 'host' });
    expect(lesson.sources[0].content).toBe(source.markdown);
  });
  it('refuses to publish when a source unit or visual explanation is absent', () => {
    const missingUnit = structuredClone(input()); missingUnit.authored[0].units.pop();
    expect(() => compileTeachingLesson(missingUnit)).toThrow(/s00-u02/);
    const missingVisual = structuredClone(input()); missingVisual.authored[0].visuals = [];
    expect(() => compileTeachingLesson(missingVisual)).toThrow(/source-asset-0/);
  });
  it('preserves source headings and stable unit identifiers', () => {
    const sections = splitSourceSections(source.markdown + '\n\n## An empty heading');
    expect(sections.map(section => section.title)).toEqual(['A section', 'An empty heading']);
    expect(sections[0].units.map(unit => unit.kind)).toEqual(['text', 'figure', 'table']);
    expect(sections[1].units).toEqual([]);
  });
  it('keeps introductory prose before the first heading as a covered source unit', () => {
    const sections = splitSourceSections('There are 42 units.\n\n## Details\n\nA second explanation.');
    expect(sections[0].title).toBe('Introduction');
    expect(sections[0].units[0].markdown).toBe('There are 42 units.');
    expect(sections[1].title).toBe('Details');
  });
});
it('uses readable heading labels when source headings contain Markdown links',()=>{
 expect(splitSourceSections('## [Further reading](https://example.com)\n\nA link.')[0].title).toBe('Further reading');
});
