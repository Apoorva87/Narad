import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LibraryFs, mediaName, slugify, toServedSrc, toStoredSrc } from '../server/library';

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'narad-lib-')); dirs.push(dir);
  return { dir, fs: new LibraryFs(dir) };
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('slugify', () => {
  it('lowercases, strips accents and punctuation', () => {
    expect(slugify('Understanding Jalapeño: fast inference!', new Set())).toBe('understanding-jalapeno-fast-inference');
  });
  it('falls back to untitled', () => { expect(slugify('🧠🔥', new Set())).toBe('untitled'); });
  it('suffixes collisions', () => {
    expect(slugify('Interpretability', new Set(['interpretability']))).toBe('interpretability-2');
    expect(slugify('Interpretability', new Set(['interpretability', 'interpretability-2']))).toBe('interpretability-3');
  });
  it('caps length at 60 with no trailing dash', () => {
    const slug = slugify('word '.repeat(40), new Set());
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('LibraryFs', () => {
  it('round-trips json and lists slugs, ignoring . and _ names', () => {
    const { dir, fs } = setup();
    fs.writeJson('a', 'lesson.json', { x: 1 });
    mkdirSync(join(dir, '.hidden')); mkdirSync(join(dir, '_trash'));
    expect(fs.readJson<{ x: number }>('a', 'lesson.json').value).toEqual({ x: 1 });
    expect(fs.slugs()).toEqual(['a']);
    expect(fs.exists('a')).toBe(true);
  });
  it('keeps the earlier file readable after a crash mid-write', () => {
    const { fs } = setup();
    fs.writeJson('a', 'lesson.json', { v: 1 });
    writeFileSync(join(fs.dir('a'), 'lesson.json.tmp-1-1'), '{"v":');
    expect(fs.readJson('a', 'lesson.json').value).toEqual({ v: 1 });
  });
  it('returns an error for invalid JSON instead of throwing', () => {
    const { fs } = setup();
    fs.writeText('a', 'lesson.json', '{nope');
    expect(fs.readJson('a', 'lesson.json').error).toMatch(/Unexpected|JSON/);
  });
  it('writes and reads bytes, renames, and removes', () => {
    const { fs } = setup();
    fs.writeBytes('a', 'media/x.png', new Uint8Array([1, 2, 3]));
    expect([...fs.readBytes('a', 'media/x.png')!]).toEqual([1, 2, 3]);
    expect(fs.readBytes('a', 'media/none.png')).toBeUndefined();
    fs.rename('a', 'b');
    expect(fs.exists('a')).toBe(false);
    expect(fs.exists('b')).toBe(true);
    fs.remove('b');
    expect(fs.exists('b')).toBe(false);
  });
  it('rejects path traversal', () => {
    const { fs } = setup();
    expect(() => fs.writeText('a', '../evil.txt', 'x')).toThrow();
    expect(() => fs.dir('../x')).toThrow();
  });
  it('serializes concurrent writers per slug', async () => {
    const { fs } = setup();
    fs.writeJson('a', 'n.json', 0);
    const bump = () => fs.withLock('a', async () => {
      const n = fs.readJson<number>('a', 'n.json').value!;
      await new Promise(r => setTimeout(r, 10));
      fs.writeJson('a', 'n.json', n + 1);
    });
    await Promise.all([bump(), bump()]);
    expect(fs.readJson('a', 'n.json').value).toBe(2);
  });
  it('keeps the lock usable after a failing task', async () => {
    const { fs } = setup();
    await expect(fs.withLock('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(fs.withLock('a', async () => 5)).resolves.toBe(5);
  });
});

describe('media helpers', () => {
  it('names media files', () => {
    expect(mediaName(1, 3, 'Attention pattern', 'png')).toBe('01-fig-03-attention-pattern.png');
  });
  it('maps src between stored and served forms', () => {
    expect(toServedSrc('a', 'media/x.png')).toBe('/api/library/a/media/x.png');
    expect(toStoredSrc('a', '/api/library/a/media/x.png')).toBe('media/x.png');
    for (const s of ['data:image/png;base64,AAA', '/assets/foo.svg']) {
      expect(toServedSrc('a', s)).toBe(s);
      expect(toStoredSrc('a', s)).toBe(s);
    }
  });
});

describe('renderCredits', () => {
  it('lists every image, video and upload from its credit, grouped by source page, with lesson-only credits too', async () => {
    const { renderCredits } = await import('../server/library-render');
    const { minimalLesson } = await import('./fixture');
    const at = '2026-10-19T00:00:00.000Z';
    const inventory = { images: 1, inlineSvg: 0, tables: 0, savedVisuals: 1 };
    const article = { id: 'a', title: 'Owl article', kind: 'article' as const, url: 'https://example.com/owls', markdown: '', warnings: [], inventory, assets: [
      { id: 'i1', kind: 'image' as const, alt: 'Owl', caption: 'A barn owl', src: '/api/library/owls/media/owl-01.jpg',
        credit: { pageTitle: 'Owl article', pageUrl: 'https://example.com/owls', mediaUrl: 'https://example.com/owl.jpg', caption: 'A barn owl', creditLine: 'Photo: Jane Doe', license: 'CC BY-SA 4.0', capturedAt: at } },
      { id: 'v1', kind: 'video' as const, alt: 'Owl flight', caption: 'Owl in flight', video: { provider: 'youtube' as const, url: 'https://www.youtube.com/watch?v=abc', embedUrl: 'https://www.youtube-nocookie.com/embed/abc' },
        credit: { pageTitle: 'Owl article', pageUrl: 'https://example.com/owls', mediaUrl: 'https://www.youtube.com/watch?v=abc', caption: 'Owl in flight', capturedAt: at } },
    ] };
    const upload = { id: 'u', title: 'My sketch', kind: 'image' as const, markdown: '', warnings: [], inventory, assets: [
      { id: 'u1', kind: 'image' as const, alt: 'Sketch', caption: 'My sketch', src: '/api/library/owls/media/sketch.png', credit: { pageTitle: 'My sketch', pageUrl: '', creditLine: 'Your upload: My sketch', capturedAt: at } },
    ] };
    const lesson = { ...minimalLesson(), assets: [
      { id: 'l1', src: 'media/owl-01.jpg', alt: 'Owl', caption: 'A barn owl', provenance: 'source', kind: 'image',
        credit: { pageTitle: 'Owl article', pageUrl: 'https://example.com/owls', mediaUrl: 'https://example.com/owl.jpg', creditLine: 'Photo: Jane Doe', license: 'CC BY-SA 4.0', capturedAt: at } },
      { id: 'l2', src: 'media/lesson-02.png', alt: 'Map', caption: 'Range map', provenance: 'source', kind: 'image',
        credit: { pageTitle: 'Range atlas', pageUrl: 'https://atlas.example.org/owls', mediaUrl: 'https://atlas.example.org/map.png', creditLine: 'Map: Atlas Team', license: 'CC0', capturedAt: at } },
    ] };
    const md = renderCredits({ title: 'Owls', sources: [article, upload], lesson });
    expect(md).toContain('owl-01.jpg'); expect(md).toContain('Photo: Jane Doe'); expect(md).toContain('CC BY-SA 4.0');
    expect(md).toContain('https://example.com/owl.jpg');
    expect(md).toContain('Owl in flight'); expect(md).toContain('https://www.youtube.com/watch?v=abc');
    expect(md).toContain('sketch.png'); expect(md).toContain('Your upload: My sketch');
    expect(md).toContain('## Range atlas'); expect(md).toContain('lesson-02.png'); expect(md).toContain('Map: Atlas Team'); expect(md).toContain('https://atlas.example.org/owls');
    // The lesson's copy of a source image is not listed twice.
    expect(md.match(/owl-01\.jpg/g)).toHaveLength(1);
  });
});
