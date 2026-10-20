import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { LessonStore, StoreError } from '../server/store';
import { LibraryFs } from '../server/library';
import { assetBlob } from '../server/capture';
import type { SourceBundle } from '../shared/sources';
import { minimalLesson } from './fixture';

const dirs: string[] = [];
const stores: LessonStore[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'narad-test-')); dirs.push(dir);
  const path = join(dir, 'test.sqlite');
  const store = new LessonStore(path); stores.push(store);
  return { store, path };
}
afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
describe('saved library', () => {
  it('retains lesson, exact equation, and reading position after reopening the database', () => {
    const { store, path } = setup();
    store.insert(minimalLesson());
    store.setProgress('fixture', 'walkthrough', 'block-b');
    store.close();
    const reopened = new LessonStore(path); stores.push(reopened);
    expect(reopened.get('fixture')?.modes.walkthrough?.sections[1].blocks[0]).toMatchObject({ latex: 'x = 2' });
    expect(reopened.getProgress('fixture')).toEqual({ lastMode: 'walkthrough', positions: { walkthrough: 'block-b' } });
  });
  it('rejects duplicate imports without overwriting the original', () => {
    const { store } = setup(); store.insert(minimalLesson());
    expect(() => store.insert({ ...minimalLesson(), title: 'Overwrite attempt' })).toThrow();
    expect(store.get('fixture')?.title).toBe('A lesson');
  });
  it('rejects a block from another mode and nonexistent analyses', () => {
    const { store } = setup(); store.insert(minimalLesson());
    expect(() => store.setProgress('fixture', 'dialogue', 'block-a')).toThrow();
    expect(() => store.setProgress('fixture', 'walkthrough', 'unknown')).toThrow();
    expect(() => store.setProgress('unknown', 'walkthrough', 'block-a')).toThrow();
    expect(store.getProgress('fixture').positions).toEqual({});
  });
});
describe('library folders', () => {
  const blob = assetBlob(Buffer.from('png-bytes'), 'image/png');
  const bundle = (): SourceBundle => ({ id: 'bundle-old', title: 'Attention notes', createdAt: '2026-10-19T12:00:00.000Z', text: 'Teach attention.', status: 'captured', sources: [{
    id: 'source-1', title: 'Attention article', kind: 'article', url: 'https://example.com/a', markdown: '# Attention\n\nText.', rawHtml: '<p>Text</p>', warnings: [],
    inventory: { images: 1, inlineSvg: 0, tables: 0, savedVisuals: 1 },
    assets: [{ id: 'source-asset-0', kind: 'image', alt: 'Attention map', caption: '', src: '/api/source-assets/' + blob.id, originalSrc: '/api/source-assets/' + blob.id }] }] });
  it('defaults the library next to the database', () => {
    const { store, path } = setup();
    expect(store.libraryRoot).toBe(join(dirname(path), 'library'));
  });
  it('round-trips a source collection through its folder with its media bytes', () => {
    const { store } = setup();
    const saved = store.saveBundle(bundle(), [blob]);
    expect(saved.id).toBe('attention-notes');
    const read = store.getBundle('attention-notes')!;
    const src = read.sources[0].assets[0].src!;
    expect(src).toMatch(/^\/api\/library\/attention-notes\/media\/01-fig-01-attention-map\.png$/);
    expect(saved.sources[0].assets[0].src).toBe(src);
    expect(read.sources[0]).toMatchObject({ id: 'source-1', markdown: '# Attention\n\nText.', rawHtml: '<p>Text</p>', url: 'https://example.com/a' });
    expect(read.text).toBe('Teach attention.');
    expect(new LibraryFs(store.libraryRoot).readBytes('attention-notes', src.replace('/api/library/attention-notes/', ''))).toEqual(blob.bytes);
    expect(existsSync(join(store.libraryRoot, 'attention-notes', 'sources', '01-attention-article.md'))).toBe(true);
    expect(store.resolveId('bundle-old')).toBe('attention-notes');
  });
  it('writes a prepared lesson into its collection folder with relative image paths', () => {
    const { store } = setup();
    const saved = store.saveBundle(bundle(), [blob]);
    const lesson = minimalLesson(); lesson.sourceBundleId = 'bundle-old';
    lesson.assets = [{ id: 'fig', src: saved.sources[0].assets[0].src, alt: 'Map', caption: 'Map', provenance: 'source', kind: 'image' }];
    expect(store.insert(lesson)).toMatchObject({ id: 'attention-notes', sourceBundleId: 'attention-notes' });
    const raw = JSON.parse(readFileSync(join(store.libraryRoot, 'attention-notes', 'lesson.json'), 'utf8'));
    expect(raw.assets[0].src).toMatch(/^media\//);
    expect(store.get('attention-notes')!.assets[0].src).toMatch(/^\/api\/library\//);
    expect(store.get('fixture')!.id).toBe('attention-notes');
    expect(store.getBundle('attention-notes')!.lessonId).toBe('attention-notes');
    expect(readFileSync(join(store.libraryRoot, 'attention-notes', 'lesson.md'), 'utf8')).toContain('An exact statement.');
    expect(readFileSync(join(store.libraryRoot, 'attention-notes', 'CREDITS.md'), 'utf8')).toContain('https://example.com/a');
  });
  it('marks a hand-broken lesson.json as broken without hiding other items', () => {
    const { store } = setup();
    store.insert(minimalLesson()); store.insert({ ...minimalLesson(), id: 'other', title: 'Other lesson' });
    writeFileSync(join(store.libraryRoot, 'a-lesson', 'lesson.json'), '{');
    const list = store.list();
    expect(list).toHaveLength(2);
    const broken = list.find(item => item.id === 'a-lesson')!;
    expect(broken.broken).toMatch(/lesson\.json/);
    expect(list.find(item => item.id === 'other-lesson')!.broken).toBeUndefined();
    let error: unknown; try { store.get('a-lesson'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ status: 422, message: broken.broken });
    const invalid = minimalLesson(); invalid.modes.walkthrough.sections[0].blocks[0].spokenText = ' ';
    writeFileSync(join(store.libraryRoot, 'a-lesson', 'lesson.json'), JSON.stringify(invalid));
    expect(store.list().find(item => item.id === 'a-lesson')!.broken).toMatch(/lesson\.json: .*spokenText/);
  });
  it('renames the folder and keeps reading positions', () => {
    const { store } = setup();
    store.insert(minimalLesson()); store.setProgress('a-lesson', 'walkthrough', 'block-b');
    expect(store.renameLesson('a-lesson', 'Better name')).toMatchObject({ id: 'better-name', title: 'Better name' });
    expect(existsSync(join(store.libraryRoot, 'a-lesson'))).toBe(false);
    expect(store.getProgress('better-name').positions).toEqual({ walkthrough: 'block-b' });
    expect(store.resolveId('fixture')).toBe('better-name');
  });
  it('deletes the folder and its reading positions', () => {
    const { store } = setup();
    store.insert(minimalLesson()); store.setProgress('a-lesson', 'walkthrough', 'block-b');
    store.deleteLesson('a-lesson');
    expect(existsSync(join(store.libraryRoot, 'a-lesson'))).toBe(false);
    expect(store.getProgress('a-lesson').positions).toEqual({});
  });
  it('resolves legacy IDs listed in a hand-made item.json', () => {
    const { store } = setup();
    mkdirSync(join(store.libraryRoot, 'hand-made'), { recursive: true });
    writeFileSync(join(store.libraryRoot, 'hand-made', 'item.json'), JSON.stringify({ title: 'Hand made', createdAt: '2026-10-19T12:00:00.000Z', legacyIds: ['lesson-old'] }));
    writeFileSync(join(store.libraryRoot, 'hand-made', 'lesson.json'), JSON.stringify(minimalLesson()));
    expect(store.resolveId('lesson-old')).toBe('hand-made');
    expect(store.resolveId('Hand/made')).toBeUndefined();
    expect(store.get('lesson-old')!.id).toBe('hand-made');
  });
});
