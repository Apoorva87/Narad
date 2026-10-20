import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tutorAnswerSchema, type TutorTurn } from '../shared/tutor';
import { TutorStore } from '../server/tutor-store';
import { buildTutorContext } from '../server/tutor-context';
import { minimalLesson } from './fixture';

const dirs: string[] = [];
const stores: TutorStore[] = [];
afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

function turn(overrides: Partial<TutorTurn> = {}): TutorTurn {
  return {
    id: 'turn-1', lessonId: 'fixture', mode: 'walkthrough', sectionId: 'first', blockId: 'block-a',
    question: 'Why is this exact?', provider: 'codex', scope: 'lesson', status: 'queued',
    stage: 'Waiting to read the passage', createdAt: '2026-10-19T12:00:00.000Z', updatedAt: '2026-10-19T12:00:00.000Z',
    ...overrides,
  };
}

describe('tutor answer contract', () => {
  it('accepts safe teaching components and rejects arbitrary embedded markup', () => {
    const answer = tutorAnswerSchema.parse({
      blocks: [
        { kind: 'text', markdown: 'The saved claim is **exact**.', spokenText: 'The saved claim is exact.' },
        { kind: 'diagram', title: 'Relationship', caption: 'A teaching diagram.', spokenText: 'A leads to B.', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: 'causes' }] },
      ],
      citations: [{ title: 'Original notes', url: null, sourceId: 'source-1', locator: 'section-1' }],
      suggestedFollowUps: ['Can you give an example?'],
    });
    expect(answer.blocks[1].kind).toBe('diagram');
    expect(() => tutorAnswerSchema.parse({ blocks: [{ kind: 'html', html: '<script>alert(1)</script>' }], citations: [], suggestedFollowUps: [] })).toThrow();
  });
});

describe('tutor persistence and context', () => {
  it('persists passage turns independently and marks interrupted work after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'narad-tutor-')); dirs.push(dir);
    const path = join(dir, 'tutor.sqlite');
    const store = new TutorStore(path); stores.push(store);
    store.save(turn());
    store.close();
    const reopened = new TutorStore(path); stores.push(reopened);
    expect(reopened.get('turn-1')).toMatchObject({ status: 'failed', blockId: 'block-a', error: 'Narad stopped before this answer finished.' });
    expect(reopened.list('fixture', 'walkthrough')).toHaveLength(1);
  });

  it('includes the exact block, neighbors, source text, familiarity, and earlier thread turns', () => {
    const lesson = minimalLesson();
    const context = buildTutorContext(lesson, 'walkthrough', 'block-a', [turn({ status: 'ready', answer: {
      blocks: [{ kind: 'text', markdown: 'Earlier answer.', spokenText: 'Earlier answer.' }], citations: [], suggestedFollowUps: [],
    } })]);
    expect(context).toMatchObject({ section: { id: 'first' }, active: { id: 'block-a' }, next: { id: 'block-b' }, familiarity: 'foundational' });
    expect(context.sources[0]).toMatchObject({ id: 'source-1', content: 'An exact statement.' });
    expect(context.thread[0]).toMatchObject({ question: 'Why is this exact?' });
  });
});
