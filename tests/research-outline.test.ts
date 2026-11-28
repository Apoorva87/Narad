import { describe, expect, it } from 'vitest';
import type { PreparationJob, PreparationState, SteerTopic, SteeringPlan } from '../shared/preparation';
import { buildOutlineTree, costLine, countPicks, countsLine, fullPatch, isStalePlan, mergeOutline, noteLabel, seedOutline, suggestedPicks, waitHint, type OutlineDraft } from '../src/components/ResearchOutline';
import { runCounts, stageLine } from '../src/components/PreparationPanel';
import { preparationNote } from '../src/components/Library';

const topic = (id: string, extra: Partial<SteerTopic> = {}): SteerTopic => ({ id, depth: 1, title: 'Topic ' + id, blurb: 'About ' + id, choice: 'summary', ...extra });
const plan = (topics: SteerTopic[], extra: Partial<SteeringPlan> = {}): SteeringPlan => ({ status: 'choosing', topics, budget: { total: 40, planned: topics.length, wanted: topics.length }, rev: 1, ...extra });
const none = new Set<string>();

describe('seedOutline', () => {
  it('copies choice and note from the server and starts focus empty', () => {
    const draft = seedOutline(plan([topic('t1', { choice: 'deeper', note: 'hi' }), topic('t2')], { focus: 'networks' }));
    expect(draft).toEqual({ focus: 'networks', topics: { t1: { choice: 'deeper', note: 'hi' }, t2: { choice: 'summary', note: '' } } });
  });
});

describe('mergeOutline', () => {
  const seeded = seedOutline(plan([topic('t1'), topic('t2')]));
  it('returns the same object when nothing changed so polling does not re-render', () => {
    expect(mergeOutline(seeded, plan([topic('t1'), topic('t2')]), none)).toBe(seeded);
  });
  it('seeds new topics and drops ones the server removed', () => {
    const merged = mergeOutline(seeded, plan([topic('t1'), topic('t1-1', { depth: 2, parentId: 't1', choice: 'summary' })]), none);
    expect(Object.keys(merged.topics)).toEqual(['t1', 't1-1']);
    expect(merged.topics['t1-1']).toEqual({ choice: 'summary', note: '' });
  });
  it('keeps a dirty choice or note over a stale server value', () => {
    const local: OutlineDraft = { focus: '', topics: { t1: { choice: 'skip', note: 'typing' }, t2: { choice: 'summary', note: '' } } };
    const merged = mergeOutline(local, plan([topic('t1'), topic('t2')]), new Set(['t1.choice', 't1.note']));
    expect(merged.topics.t1).toEqual({ choice: 'skip', note: 'typing' });
  });
  it('adopts the server value for fields that are not dirty (a failed expand reverts to summary)', () => {
    const local: OutlineDraft = { focus: '', topics: { t1: { choice: 'deeper', note: '' }, t2: { choice: 'summary', note: '' } } };
    expect(mergeOutline(local, plan([topic('t1', { choice: 'summary' }), topic('t2')]), none).topics.t1.choice).toBe('summary');
  });
  it('treats one field as dirty without freezing the other', () => {
    const local: OutlineDraft = { focus: '', topics: { t1: { choice: 'skip', note: 'old' }, t2: { choice: 'summary', note: '' } } };
    const merged = mergeOutline(local, plan([topic('t1', { choice: 'summary', note: 'new' }), topic('t2')]), new Set(['t1.choice']));
    expect(merged.topics.t1).toEqual({ choice: 'skip', note: 'new' });
  });
  it('keeps trailing whitespace the server trimmed away, so the caret is not disturbed', () => {
    const local: OutlineDraft = { focus: 'compare ', topics: { t1: { choice: 'summary', note: 'hello ' }, t2: { choice: 'summary', note: '' } } };
    const merged = mergeOutline(local, plan([topic('t1', { note: 'hello' }), topic('t2')], { focus: 'compare' }), none);
    expect(merged.topics.t1.note).toBe('hello ');
    expect(merged.focus).toBe('compare ');
  });
  it('keeps a dirty overall focus', () => {
    const local: OutlineDraft = { focus: 'typed', topics: seeded.topics };
    expect(mergeOutline(local, plan([topic('t1'), topic('t2')], { focus: 'older' }), new Set(['focus'])).focus).toBe('typed');
    expect(mergeOutline(local, plan([topic('t1'), topic('t2')], { focus: 'older' }), none).focus).toBe('older');
  });
});

describe('suggestedPicks and countPicks', () => {
  const topics = [topic('t1'), topic('t2'), topic('t3', { depth: 2, parentId: 't1' }), topic('t4')];
  it('suggests Summary for every topic', () => {
    expect(suggestedPicks(topics)).toEqual({ t1: 'summary', t2: 'summary', t3: 'summary', t4: 'summary' });
  });
  const pick = (choice: 'deeper' | 'summary' | 'skip') => ({ choice, note: '' });
  it('counts deeper, summary and skipped picks from the draft', () => {
    const counts = countPicks(topics, { t1: pick('deeper'), t2: pick('skip'), t3: pick('summary'), t4: pick('summary') });
    expect(counts).toEqual({ total: 4, deeper: 1, summary: 2, skipped: 1, unused: 0, active: 2 });
  });
  it('reports zero active topics when everything is skipped', () => {
    expect(countPicks([topic('t1')], { t1: pick('skip') }).active).toBe(0);
  });
  it('falls back to the server choice for a topic with no draft yet', () => {
    expect(countPicks([topic('t1', { choice: 'deeper' })], {}).deeper).toBe(1);
  });
  const family = [topic('t1', { children: ['t1-1', 't1-2'] }), topic('t1-1', { depth: 2, parentId: 't1' }), topic('t1-2', { depth: 2, parentId: 't1' }), topic('t2')];
  it('counts the sub-topics of a Deeper parent as the researched topics, not the parent', () => {
    expect(countPicks(family, { t1: pick('deeper') })).toEqual({ total: 4, deeper: 1, summary: 3, skipped: 0, unused: 0, active: 3 });
  });
  it('counts a skipped parent’s sub-topics as skipped, so nothing is kept when every top-level topic is skipped', () => {
    const counts = countPicks(family, { t1: pick('skip'), 't1-1': pick('summary'), 't1-2': pick('deeper'), t2: pick('skip') });
    expect(counts).toEqual({ total: 4, deeper: 0, summary: 0, skipped: 4, unused: 0, active: 0 });
  });
  it('treats a parent that is not Deeper as one topic and its sub-topics as not used', () => {
    const counts = countPicks(family, { t1: pick('summary'), 't1-1': pick('deeper'), 't1-2': pick('skip') });
    expect(counts).toEqual({ total: 4, deeper: 0, summary: 2, skipped: 0, unused: 2, active: 2 });
  });
  it('keeps a Deeper parent as one topic when all of its sub-topics are skipped', () => {
    expect(countPicks(family, { t1: pick('deeper'), 't1-1': pick('skip'), 't1-2': pick('skip'), t2: pick('skip') }).active).toBe(1);
  });
  it('formats the footer, leaving out zero counts and singularising', () => {
    expect(countsLine({ total: 4, deeper: 1, summary: 2, skipped: 1, unused: 0, active: 3 })).toBe('4 topics · 1 deeper · 1 skipped');
    expect(countsLine({ total: 1, deeper: 0, summary: 1, skipped: 0, unused: 0, active: 1 })).toBe('1 topic');
    expect(countsLine({ total: 4, deeper: 0, summary: 2, skipped: 0, unused: 2, active: 2 })).toBe('4 topics · 2 not used');
  });
});

describe('isStalePlan', () => {
  it('ignores a polled plan older than the page’s own last save, and accepts the same or a newer one', () => {
    expect(isStalePlan(plan([topic('t1')], { rev: 3 }), 4)).toBe(true);
    expect(isStalePlan(plan([topic('t1')], { rev: 4 }), 4)).toBe(false);
    expect(isStalePlan(plan([topic('t1')], { rev: 5 }), 4)).toBe(false);
  });
  it('accepts everything before the page has saved, and plans from a server that sends no rev', () => {
    expect(isStalePlan(plan([topic('t1')], { rev: 1 }), 0)).toBe(false);
    expect(isStalePlan({ ...plan([topic('t1')]), rev: undefined as unknown as number }, 0)).toBe(false);
  });
});

describe('costLine, noteLabel and waitHint', () => {
  it('says how many articles will be read against a normal lesson', () => {
    expect(costLine({ total: 16, planned: 6, wanted: 6 }, 4)).toEqual({ main: 'About 6 articles to read', normal: '(a normal lesson uses up to 4)', cap: '' });
    expect(costLine({ total: 16, planned: 1, wanted: 1 }, 4).main).toBe('About 1 article to read');
  });
  it('adds the cap note only when the cap trims the plan', () => {
    expect(costLine({ total: 16, planned: 16, wanted: 21 }, 4).cap).toBe('Capped at 16 — 5 fewer than you asked for');
    expect(costLine({ total: 16, planned: 16, wanted: 16 }, 4).cap).toBe('');
  });
  it('labels the focus disclosure so a hidden note is still visible', () => {
    expect(noteLabel('', false)).toBe('Add a focus for this topic');
    expect(noteLabel('  ', false)).toBe('Add a focus for this topic');
    expect(noteLabel('Just RED and CoDel', false)).toBe('Focus: Just RED and CoDel');
    expect(noteLabel('one two three four five six seven eight', false)).toBe('Focus: one two three four five six…');
    expect(noteLabel('Just RED', true)).toBe('Edit focus');
  });
  it('offers a wait hint only for the outline and breakdown steps', () => {
    expect(waitHint('Drawing an outline of your topic')).toBe('This usually takes about a minute.');
    expect(waitHint('Breaking down "Fairness"')).toBe('This usually takes about a minute.');
    expect(waitHint('Finding sources')).toBe('');
  });
});

describe('buildOutlineTree', () => {
  it('nests children under their parent in display order', () => {
    const tree = buildOutlineTree([topic('t1', { children: ['t1-1', 't1-2'] }), topic('t1-1', { depth: 2, parentId: 't1' }), topic('t1-2', { depth: 2, parentId: 't1' }), topic('t2')]);
    expect(tree.map(node => node.topic.id)).toEqual(['t1', 't2']);
    expect(tree[0].children.map(node => node.topic.id)).toEqual(['t1-1', 't1-2']);
  });
  it('treats a topic whose parent is missing as top level and never loops', () => {
    const tree = buildOutlineTree([topic('a', { parentId: 'gone' }), topic('x', { parentId: 'y' }), topic('y', { parentId: 'x' })]);
    expect(tree.map(node => node.topic.id)).toEqual(['a']);
  });
});

describe('fullPatch', () => {
  it('sends every topic choice and note plus the overall focus', () => {
    const draft: OutlineDraft = { focus: ' fast ', topics: { t1: { choice: 'skip', note: '' }, t2: { choice: 'deeper', note: 'why' } } };
    expect(fullPatch(draft)).toEqual({ focus: ' fast ', topics: [{ id: 't1', choice: 'skip', note: '' }, { id: 't2', choice: 'deeper', note: 'why' }] });
  });
});

const job = (extra: Partial<PreparationJob>): PreparationJob => ({ id: 'j', bundleId: 'b', slug: 'j', title: 'T', provider: 'codex', status: 'running', stage: 'Writing 1/3', completed: 0, total: 3, createdAt: '', updatedAt: '', sections: [], folder: '/tmp', ...extra });
describe('stageLine, runCounts and the library note while waiting for picks', () => {
  it('says the lesson is waiting for the learner', () => {
    const plan = (status: 'choosing' | 'confirmed') => ({ status, topics: [], budget: { total: 10, planned: 0, wanted: 0 }, rev: 1 });
    expect(stageLine(job({ status: 'awaiting-input', stage: 'Outline ready', steering: plan('choosing') }))).toBe('Waiting for your picks');
    // A confirm interrupted before it started (or an unreadable plan) is not waiting for picks: Continue resumes it.
    expect(stageLine(job({ status: 'awaiting-input', stage: 'Outline ready', steering: plan('confirmed') }))).toBe('Ready to resume');
    expect(stageLine(job({ status: 'awaiting-input', stage: 'Outline ready' }))).toBe('Ready to resume');
    expect(stageLine(job({ status: 'queued', queuePosition: 2, queueLength: 3 }))).toBe('Queued · position 2 of 3');
    expect(stageLine(job({}))).toBe('Writing 1/3');
  });
  it('counts waiting jobs apart from running and queued ones', () => {
    const state: PreparationState = { jobs: [job({ id: 'a' }), job({ id: 'b', status: 'stopping' }), job({ id: 'c', status: 'queued' }), job({ id: 'd', status: 'awaiting-input' }), job({ id: 'e', status: 'completed' })], sessions: [], providers: [] };
    expect(runCounts(state)).toEqual({ running: 2, queued: 1, waiting: 1 });
    expect(runCounts(null)).toEqual({ running: 0, queued: 0, waiting: 0 });
  });
  it('asks the learner to choose topics, in the needs-review tone', () => {
    expect(preparationNote(job({ status: 'awaiting-input' }))).toEqual({ text: 'Choose topics to continue', tone: 'needs-review' });
  });
});
