import { describe, expect, it } from 'vitest';
import { parseLesson } from '../shared/lesson';
import { flattenBlocks, latestFigureIndex, moveBlock } from '../shared/navigation';
import samples from '../content/samples.json';
import { minimalLesson } from './fixture';

describe('prepared lesson boundary', () => {
  it('accepts a source-backed lesson with a clearly labeled teaching addition', () => {
    expect(parseLesson(minimalLesson()).modes.walkthrough?.sections[1].blocks[0].origin).toBe('teaching');
  });
  it.each(['duplicate-block', 'missing-source', 'missing-locator', 'missing-asset', 'unsafe-asset', 'missing-narration', 'empty-mode', 'uncited-source'])(
    'rejects %s before it can reach the reader', (kind) => {
      const lesson = minimalLesson();
      const block = lesson.modes.walkthrough.sections[0].blocks[0];
      if (kind === 'duplicate-block') lesson.modes.walkthrough.sections[1].blocks[0].id = block.id;
      if (kind === 'missing-source') block.references[0].sourceId = 'does-not-exist';
      if (kind === 'missing-locator') block.references[0].locator = 'does-not-exist';
      if (kind === 'missing-asset') Object.assign(block, { kind: 'figure', assetId: 'missing' });
      if (kind === 'unsafe-asset') lesson.assets = [{ id: 'evil', src: 'javascript:alert(1)', alt: 'Bad image', caption: 'Bad image', provenance: 'teaching' }];
      if (kind === 'missing-narration') block.spokenText = '';
      if (kind === 'empty-mode') lesson.modes.walkthrough.sections = [];
      if (kind === 'uncited-source') block.references = [];
      expect(() => parseLesson(lesson)).toThrow();
    },
  );
  it('rejects an executable source URL', () => {
    const lesson = minimalLesson(); lesson.sources[0].url = 'javascript:alert(1)';
    expect(() => parseLesson(lesson)).toThrow();
  });
});

describe('reader navigation', () => {
  it('crosses sections and clamps at either end', () => {
    const lesson = parseLesson(minimalLesson());
    expect(moveBlock(lesson, 'walkthrough', 'block-a', 1)?.block.id).toBe('block-b');
    expect(moveBlock(lesson, 'walkthrough', 'block-a', -1)?.block.id).toBe('block-a');
    expect(moveBlock(lesson, 'walkthrough', 'block-b', 1)?.block.id).toBe('block-b');
    expect(moveBlock(lesson, 'walkthrough', 'unknown', 0)?.block.id).toBe('block-a');
  });
  it('returns no blocks for a mode that has not been prepared', () => {
    expect(flattenBlocks(parseLesson(minimalLesson()), 'dialogue')).toEqual([]);
  });
});
describe('latest figure', () => {
  it('holds the most recent figure until the next one appears', () => {
    const lesson = samples.find(item => item.id === 'gradient-descent')!;
    const blocks = flattenBlocks(parseLesson(lesson), 'walkthrough');
    const figure = blocks.findIndex(item => item.block.kind === 'figure');
    expect(latestFigureIndex(blocks, figure - 1)).toBe(-1);
    expect(latestFigureIndex(blocks, figure)).toBe(figure);
    expect(latestFigureIndex(blocks, blocks.length - 1)).toBe(figure);
  });
});

describe('video assets', () => {
  const lessonWith = (video: unknown, kind = 'video') => { const lesson = minimalLesson(); lesson.assets = [{ id: 'v', src: '/assets/video-poster.svg', alt: 'Talk', caption: 'Talk', provenance: 'source', kind, ...(video ? { video } : {}) }]; return lesson; };
  it('accepts streamed embeds and requires a video object', () => {
    expect(parseLesson(lessonWith({ provider: 'youtube', url: 'https://youtu.be/x', embedUrl: 'https://www.youtube-nocookie.com/embed/x' })).assets[0].kind).toBe('video');
    expect(() => parseLesson(lessonWith(undefined))).toThrow();
  });
  it('rejects an embed on another host', () => {
    expect(() => parseLesson(lessonWith({ provider: 'youtube', url: 'https://evil.example/embed', embedUrl: 'https://evil.example/embed' }))).toThrow();
    expect(() => parseLesson(lessonWith({ provider: 'vimeo', url: 'https://vimeo.com/1', embedUrl: 'https://www.youtube.com/embed/x' }))).toThrow();
    expect(() => parseLesson(lessonWith({ provider: 'file', url: 'https://a.example/v.mp4', embedUrl: 'https://evil.example/embed' }))).toThrow();
    expect(() => parseLesson(lessonWith({ provider: 'file', url: 'http://a.example/v.mp4', embedUrl: 'http://a.example/v.mp4' }))).toThrow();
    expect(parseLesson(lessonWith({ provider: 'file', url: 'https://a.example/v.mp4', embedUrl: 'https://a.example/v.mp4' })).assets).toHaveLength(1);
  });
});
