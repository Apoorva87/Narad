import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTeachingPlan, checkTeaching, compilePreparedBundle } from '../server/generation-content';
import { PreparationService } from '../server/preparation';
import { SpeechService } from '../server/speech';
import { LessonStore } from '../server/store';
import { parseLesson } from '../shared/lesson';
import { latestFigureIndex, flattenBlocks } from '../shared/navigation';
import { defaultSettings } from '../shared/settings';
import { NarrationController, type AudioPort, type NarrationItem, type NarrationState } from '../src/lib/narration';
import { buildNarrationItems } from '../src/lib/narration-items';
import { layoutDiagram } from '../src/lib/diagram-layout';
import { defaultSpeechPreferences } from '../shared/speech';
import { bundle, draft } from './generation-content.test';
import { courseMaterial, minimalLesson } from './fixture';

const summaries = [{ title: 'One', markdown: 'A delay.', spokenText: 'A delay.', sourceIds: ['one'] }, { title: 'Two', markdown: 'Another delay.', spokenText: 'Another delay.', sourceIds: ['two'] }, { title: 'Together', markdown: 'Compare equal units.', spokenText: 'Compare equal units.', sourceIds: ['one', 'two'] }];
const diagram = { title: 'From event to delay', caption: 'A delay is the time between two events.', spokenText: 'Start at the first event and follow the arrow to the second.', nodes: [{ id: 'a', label: 'First event' }, { id: 'b', label: 'Second event' }, { id: 'c', label: 'Delay' }], edges: [{ from: 'a', to: 'b', label: 'time passes' }, { from: 'b', to: 'c', label: null }] };
// `course` is loosely typed so a test can hand over deliberately broken material.
const taught = (task: Parameters<typeof draft>[0], course: any = { ...courseMaterial(), diagram }) => { const base = draft(task); return { ...base, units: base.units.map(unit => ({ ...unit, slide: '- Latency: **42 ms**\n- It is elapsed time' })), course }; };
const quizLesson = () => {
  const lesson = minimalLesson();
  lesson.modes.course = { title: 'Course', sections: [{ id: 'c', title: 'Check', blocks: [
    { id: 'slide', kind: 'text', markdown: '- A point', spokenText: 'A point, explained.', references: [], origin: 'teaching' },
    { id: 'q', kind: 'quiz', markdown: 'What is x?', spokenText: 'What is x? First option: two. Second option: three.', options: ['Two', 'Three'], answer: 0, explanation: 'x is two.', explanationSpoken: 'x is two because the lesson says so.', references: [], origin: 'teaching' },
    { id: 'end', kind: 'callout', title: 'Key takeaway', markdown: 'x is two.', spokenText: 'x is two.', references: [], origin: 'teaching' },
  ] }] };
  return parseLesson(lesson);
};

it('compiles a course of narrated slides, the source figure, a diagram, a shuffled check and a takeaway', () => {
  const tasks = buildTeachingPlan(bundle);
  const lesson = compilePreparedBundle(bundle, tasks.map(task => ({ task, teaching: taught(task) })), summaries, 'generated');
  const section = lesson.modes.course!.sections[0];
  expect(section.blocks.map(block => block.kind)).toEqual(['callout', 'text', 'figure', 'text', 'text', 'diagram', 'quiz', 'callout']);
  const slide = section.blocks[1], walkthrough = lesson.modes.walkthrough!.sections[0].blocks.find(block => block.kind === 'text')!;
  expect(slide.markdown).toContain('42 ms'); expect(slide.spokenText).toBe(walkthrough.spokenText);
  const quiz = section.blocks.find(block => block.kind === 'quiz')!; if (quiz.kind !== 'quiz') throw new Error('expected a quiz');
  expect([...quiz.options].sort()).toEqual(['Distance', 'Elapsed time', 'Mass']); expect(quiz.options[quiz.answer]).toBe('Elapsed time');
  expect(quiz.spokenText).toBe(`What does the delay measure? First option: ${quiz.options[0]}. Second option: ${quiz.options[1]}. Third option: ${quiz.options[2]}.`);
  // Across both sources the block IDs stay unique and the correct option is not always in the same place by construction.
  const all = lesson.modes.course!.sections.flatMap(item => item.blocks);
  expect(new Set(all.map(block => block.id)).size).toBe(all.length);
  expect(compilePreparedBundle(bundle, tasks.map(task => ({ task, teaching: taught(task) })), summaries, 'generated').modes.course).toEqual(lesson.modes.course);
});

it('leaves the course out when a saved section predates it, and keeps the other modes', () => {
  const tasks = buildTeachingPlan(bundle);
  const lesson = compilePreparedBundle(bundle, tasks.map((task, index) => ({ task, teaching: index ? taught(task) : draft(task) })), summaries, 'generated');
  expect(Object.keys(lesson.modes)).toEqual(['summary', 'walkthrough', 'dialogue']);
});

it('rejects course material a learner could not use', () => {
  const task = buildTeachingPlan(bundle)[0];
  expect(checkTeaching(task, taught(task))).toEqual([]);
  const check = courseMaterial().checks[0];
  const problems = (course: Record<string, unknown>) => checkTeaching(task, taught(task, { ...courseMaterial(), ...course })).join('\n');
  expect(problems({ checks: [{ ...check, answer: 3 }] })).toContain('not among its options');
  expect(problems({ checks: [{ ...check, options: ['Elapsed time', 'elapsed time', 'Mass'] }] })).toContain('repeats an option');
  expect(problems({ checks: [{ ...check, options: ['Elapsed time', 'All of the above', 'Mass'] }] })).toContain('stand alone');
  expect(problems({ checks: [{ ...check, options: ['$t_2 - t_1$', 'Distance', 'Mass'] }] })).toContain('plain text');
  expect(problems({ checks: [{ ...check, options: ['Costs $5', 'Distance', 'Mass'] }] })).toBe('');
  expect(problems({ diagram: { ...diagram, edges: [{ from: 'a', to: 'missing', label: null }] } })).toContain('missing box');
  expect(problems({ diagram: { ...diagram, edges: [{ from: 'a', to: 'b', label: null }] } })).toContain('no arrow: c');
  const noSlide = taught(task); delete (noSlide.units[0] as { slide?: string }).slide;
  expect(checkTeaching(task, noSlide).join('\n')).toContain('needs a slide');
});

it('rejects a saved lesson whose check marks an answer outside its options or whose diagram cannot be drawn', () => {
  const lesson = minimalLesson();
  const base = { markdown: 'Q', spokenText: 'Q', references: [], origin: 'teaching' };
  lesson.modes.course = { title: 'Course', sections: [{ id: 'c', title: 'C', blocks: [{ ...base, id: 'q', kind: 'quiz', options: ['a', 'b'], answer: 2, explanation: 'e', explanationSpoken: 'e' }] }] };
  expect(() => parseLesson(lesson)).toThrow(/not among its options/);
  lesson.modes.course.sections[0].blocks = [{ ...base, id: 'd', kind: 'diagram', title: 'T', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'z', label: null }] }];
  expect(() => parseLesson(lesson)).toThrow(/missing box/);
});

class TestAudio implements AudioPort {
  duration = 1; ontimeupdate: (() => void) | null = null; src = ''; currentTime = 0; playbackRate = 1; preservesPitch = true;
  onended: (() => void) | null = null; onerror: (() => void) | null = null; played: string[] = [];
  async play() { this.played.push(this.src); } pause() {} load() {} removeAttribute() { this.src = ''; }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const player = (items: NarrationItem[]) => {
  const audio = new TestAudio(); let state: NarrationState = { status: 'idle' };
  const controller = new NarrationController(audio, async item => ({ url: `/${item.blockId}-${item.part ?? 'passage'}-${item.chunk}.wav`, release: () => {} }), next => { state = next; });
  const finish = async () => { audio.onended?.(); await tick(); };
  return { audio, controller, finish, state: () => state, start: async () => { controller.start(items, items.findIndex(item => item.blockId === 'q'), 1); await tick(); } };
};

it('speaks a check question, waits for the answer, then explains and moves on', async () => {
  const items = buildNarrationItems(quizLesson(), 'course', defaultSpeechPreferences, {});
  expect(items.map(item => [item.blockId, item.part ?? 'passage', !!item.gate])).toEqual([['slide', 'passage', false], ['q', 'passage', false], ['q', 'explanation', true], ['end', 'passage', false]]);
  const { audio, controller, finish, state, start } = player(items);
  await start(); await finish();
  expect(state()).toMatchObject({ status: 'paused', waiting: true, blockId: 'q', part: 'explanation' }); expect(audio.played).toEqual(['/q-passage-0.wav']);
  controller.answer('q'); await tick();
  expect(state()).toMatchObject({ status: 'playing', blockId: 'q', part: 'explanation' }); expect(state().waiting).toBeUndefined();
  await finish(); expect(audio.played).toEqual(['/q-passage-0.wav', '/q-explanation-0.wav', '/end-passage-0.wav']);
  controller.dispose();
});

it('does not wait when the learner answered before the question finished, and Play also continues', async () => {
  const items = buildNarrationItems(quizLesson(), 'course', defaultSpeechPreferences, {});
  const early = player(items); await early.start(); early.controller.answer('q'); await early.finish();
  expect(early.state()).toMatchObject({ status: 'playing', part: 'explanation' }); early.controller.dispose();
  const skipped = player(items); await skipped.start(); await skipped.finish(); skipped.controller.resume(); await tick();
  expect(skipped.state()).toMatchObject({ status: 'playing', part: 'explanation' }); skipped.controller.dispose();
});

const dirs: string[] = [], stores: LessonStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function wav() { const b = Buffer.alloc(48044); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(48000, 40); return b; }
async function library() { const dir = await mkdtemp(join(tmpdir(), 'narad-course-')); dirs.push(dir); const store = new LessonStore(join(dir, 'db')); stores.push(store); return { dir, store }; }

it('speaks a check explanation only for a check question', async () => {
  const { store } = await library(); const lesson = store.insert(quizLesson()); const spoken: string[] = [];
  const service = new SpeechService(store, { model: 'test', status: () => ({ state: 'ready' as const }), synthesize: async text => { spoken.push(text); return wav(); }, close: async () => {} });
  const request = { lessonId: lesson.id, mode: 'course' as const, chunk: 0, voice: 'Ryan' as const }; const signal = new AbortController().signal;
  await service.render({ ...request, blockId: 'q' }, signal); await service.render({ ...request, blockId: 'q', part: 'explanation' }, signal);
  expect(spoken).toEqual(['What is x? First option: two. Second option: three.', 'x is two because the lesson says so.']);
  await expect(service.render({ ...request, blockId: 'slide', part: 'explanation' }, signal)).rejects.toThrow(/chunk was not found/);
});

it('gives the agent the course guidance even when a customised section prompt has no slot for it', async () => {
  const { dir, store } = await library(); const prompts: string[] = [];
  store.saveSettings({ ...defaultSettings, prompts: { ...defaultSettings.prompts, section: 'Write it.\n{{input}}' } });
  store.saveBundle({ id: 'source', title: 'Time', text: 'Explain', createdAt: new Date().toISOString(), status: 'captured', sources: [{ id: 'a', title: 'Time', kind: 'article', markdown: '# Time\n\nA delay of 42 ms.', assets: [], warnings: [], inventory: { images: 0, inlineSvg: 0, tables: 0, savedVisuals: 0 } }] }, []);
  const service = new PreparationService(store, dir, { available: () => [{ id: 'claude', available: true }], run: async (request, signal) => { prompts.push(request.prompt); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  service.start('source', 'claude'); await expect.poll(() => prompts.length).toBe(1);
  expect(prompts[0]).toContain('one lesson of a narrated course'); expect(prompts[0]).toContain('Write it.');
  await service.shutdown();
});

it('holds a teaching diagram on screen like a figure and lays its boxes out top to bottom', () => {
  const lesson = minimalLesson(); const base = { references: [], origin: 'teaching' };
  lesson.modes.course = { title: 'Course', sections: [{ id: 'c', title: 'C', blocks: [{ ...base, id: 'd', kind: 'diagram', title: 'T', markdown: 'Caption', spokenText: 'Caption', nodes: diagram.nodes, edges: diagram.edges }, { ...base, id: 't', kind: 'text', markdown: 'After', spokenText: 'After' }] }] };
  expect(latestFigureIndex(flattenBlocks(parseLesson(lesson), 'course'), 1)).toBe(0);
  const layout = layoutDiagram([...diagram.nodes, { id: 'd', label: 'A much longer label that has to wrap over lines' }], [...diagram.edges, { from: 'c', to: 'a', label: 'loops back' }, { from: 'a', to: 'd', label: null }]);
  const y = Object.fromEntries(layout.nodes.map(node => [node.id, node.y]));
  expect(y.a).toBeLessThan(y.b); expect(y.b).toBeLessThan(y.c); expect(y.d).toBe(y.b);
  expect(layout.nodes.find(node => node.id === 'd')!.lines.length).toBeGreaterThan(1);
  expect(layout.nodes.every(node => node.x - node.width / 2 >= 0 && node.x + node.width / 2 <= layout.width && node.y + node.height / 2 <= layout.height)).toBe(true);
  expect(layout.edges).toHaveLength(4);
  // In a straight chain the arrow from the last box back to the first would run through the middle box, so it bows around the side.
  const loop = layoutDiagram(diagram.nodes, [...diagram.edges, { from: 'c', to: 'a', label: 'again' }]);
  expect(loop.edges.map(edge => edge.bowed)).toEqual([false, false, true]);
  expect(loop.edges[2].labelX).toBeGreaterThan(Math.max(...loop.nodes.map(node => node.x + node.width / 2)));
  expect(loop.edges[2].labelX + 30).toBeLessThan(loop.width);
  expect(loop.nodes.every(node => node.x - node.width / 2 >= 0 && node.x + node.width / 2 <= loop.width)).toBe(true);
});

it('tells the tutor what a check question offers and exports checks and diagrams as readable text', async () => {
  const { buildTutorContext } = await import('../server/tutor-context');
  const { renderLessonMarkdown } = await import('../server/library-render');
  const lesson = quizLesson();
  expect(buildTutorContext(lesson, 'course', 'q', []).active).toMatchObject({ kind: 'quiz', options: ['Two', 'Three'], correctOption: 'Two', explanation: 'x is two.' });
  delete (lesson.modes as { walkthrough?: unknown }).walkthrough;
  lesson.modes.course!.sections[0].blocks.push({ id: 'd', kind: 'diagram', title: 'Flow', markdown: 'Caption.', spokenText: 'Caption.', nodes: diagram.nodes, edges: diagram.edges, references: [], origin: 'teaching' });
  const text = renderLessonMarkdown(lesson);
  expect(text).toContain('1. Two\n2. Three\n\n*Answer: 1.* x is two.');
  expect(text).toContain('- First event → Second event (time passes)\n- Second event → Delay');
});

it('compiles a worked example into steps the reader reveals and narration speaks in full, and rejects LaTeX in its spoken text', () => {
  const tasks = buildTeachingPlan(bundle);
  const worked = { title: 'Two delays', problem: 'A teaching example: add delays of $2$ ms and $3$ ms.', problemSpoken: 'A teaching example: add delays of two and three milliseconds', steps: [{ markdown: 'Write the sum: $2 + 3$.', spokenText: 'Write the sum, two plus three.' }, { markdown: 'Compute: $2 + 3 = 5$ ms.', spokenText: 'Two plus three is five milliseconds.' }], result: 'The total is $5$ ms.', resultSpoken: 'The total is five milliseconds.' };
  const lesson = compilePreparedBundle(bundle, tasks.map(task => ({ task, teaching: taught(task, { ...courseMaterial(), worked }) })), summaries, 'generated');
  const block = lesson.modes.course!.sections[0].blocks.find(item => item.kind === 'steps')!; if (block.kind !== 'steps') throw new Error('expected a worked example');
  expect(lesson.modes.course!.sections[0].blocks.map(item => item.kind)).toEqual(['callout', 'text', 'figure', 'text', 'text', 'steps', 'quiz', 'callout']);
  expect(block).toMatchObject({ title: 'Two delays', markdown: worked.problem, steps: [{ markdown: 'Write the sum: $2 + 3$.' }, { markdown: 'Compute: $2 + 3 = 5$ ms.' }], result: 'The total is $5$ ms.' });
  expect(block.spokenText).toBe('A teaching example: add delays of two and three milliseconds. Write the sum, two plus three. Two plus three is five milliseconds. The total is five milliseconds.');
  const spokenLatex = { ...worked, steps: [worked.steps[0], { markdown: worked.steps[1].markdown, spokenText: 'Compute $2 + 3 = 5$.' }] };
  expect(checkTeaching(tasks[0], taught(tasks[0], { ...courseMaterial(), worked: spokenLatex })).join('\n')).toContain('say the mathematics in words');
  expect(checkTeaching(tasks[0], taught(tasks[0], { ...courseMaterial(), worked }))).toEqual([]);
});

it('rejects a check whose correct option gives itself away or whose wording depends on option order', () => {
  const task = buildTeachingPlan(bundle)[0]; const check = courseMaterial().checks[0];
  const problems = (change: Record<string, unknown>) => checkTeaching(task, taught(task, { ...courseMaterial(), checks: [{ ...check, ...change }] })).join('\n');
  const options = ['Sorting is what lets the middle comparison tell us which half cannot contain the target', 'Sorted lists have fewer items to look through', 'The middle element can only be located in a sorted list'];
  expect(problems({ options })).toContain('noticeably longer');
  // The same long option is fine as a distractor, and options of similar length pass.
  expect(problems({ options, answer: 1 })).toBe('');
  expect(problems({ options: ['The comparison tells us which half to discard', 'Sorted lists have fewer items to look through', 'The middle element can only be found when sorted'] })).toBe('');
  expect(problems({ explanation: 'Option A is right because a delay is elapsed time.' })).toContain('by letter, number or position');
  expect(problems({ explanationSpoken: 'The first option is right because a delay is elapsed time.' })).toContain('by letter, number or position');
  expect(problems({ explanation: 'A delay is elapsed time; the first event and the second event bound it.' })).toBe('');
  expect(problems({ explanation: 'This answers two questions at once: what is measured and in which unit. Answer: elapsed time.' })).toBe('');
});
