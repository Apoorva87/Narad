import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LessonStore } from '../server/store';
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
