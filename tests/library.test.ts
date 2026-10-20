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
