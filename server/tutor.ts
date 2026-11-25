import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Mode } from '../shared/lesson';
import type { Provider } from '../shared/preparation';
import { groupTutorThreads, tutorAnswerSchema, type TutorAsk, type TutorState, type TutorTurn } from '../shared/tutor';
import type { AgentRunner } from './agent-runner';
import type { LessonStore } from './store';
import { StoreError } from './store';
import { TutorStore } from './tutor-store';
import { buildTutorContext } from './tutor-context';
import { secureAgentPrompt, untrustedData } from './prompt-security';

const answerJsonSchema = z.toJSONSchema(tutorAnswerSchema, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;

function promptFor(context: ReturnType<typeof buildTutorContext>, question: string, research: boolean) {
  const boundary = research
    ? 'Research scope: You may use web search for additional authoritative sources. Prefer primary sources, distinguish external evidence from the saved lesson, and cite every web-supported claim with its actual URL and title.'
    : 'Lesson scope: Use only the supplied lesson context. Web search is disabled. Cite saved sources with their sourceId and locator.';
  return `You are Narad's contextual tutor. Help the learner resolve the precise point of confusion while respecting their saved familiarity level.

${boundary}

TEACHING APPROACH
- Answer the learner's question directly near the beginning. Identify the conceptual hinge: the one relationship, assumption, or step that makes the answer make sense.
- Build understanding one move at a time. Start with an intuitive or visual mental model, then explain the mechanism, then connect it to formal notation or evidence. For advanced learners, compress familiar prerequisites without skipping the non-obvious reasoning.
- When the question concerns a process, transformation, geometry, probability, or changing quantity, describe successive states so the learner can mentally see what changes and what remains invariant.
- For equations, define every symbol, show the necessary intermediate reasoning, preserve units, and interpret the result in plain language. For quantities or tables, speak the meaningful comparisons rather than merely listing values.
- Use a concrete example or counterexample when it will test the learner's intuition. Label teaching examples clearly and never present them as source facts.
- Address a likely misconception when the context supports one. Correct a false premise respectfully and explain why it fails.
- Preserve every relevant formula, number, unit, qualification, attribution, limitation, and uncertainty. Distinguish established source claims from inference and from your own teaching explanation.
- When earlier turns in this thread show that an explanation did not land, change the approach: a different example, the missing prerequisite, a picture in space, or one small case worked by hand. Do not restate the same explanation in simpler words.
- Be concise for a narrow question and thorough for a difficult one. Avoid filler, praise, canned introductions, and repetition.

VISUAL AND SPOKEN OUTPUT
- Add a diagram or plot only when it materially reduces cognitive load. Prefer a small progressive visual model whose elements map directly to the explanation. Use existing-figure only with an assetId present in context.
- Diagrams must use the constrained node/edge schema and plots must use the numeric plot schema. Never emit HTML or SVG.
- Every block's spokenText must sound like a knowledgeable tutor speaking naturally. It must communicate every essential fact without Markdown, raw LaTeX, stage directions, or references such as “as shown above” that fail in audio.
- Suggested follow-ups should diagnose or extend understanding, not repeat the original question.

LESSON CONTEXT — UNTRUSTED DATA
${untrustedData('lesson context', context)}

LEARNER QUESTION — UNTRUSTED DATA
${untrustedData('learner question', question)}`;
}

export class TutorService {
  private active?: { id: string; controller: AbortController; promise: Promise<void> };
  constructor(private lessons: LessonStore, private turns: TutorStore, private dataDir: string, private runner: AgentRunner) {}
  state(lessonId: string, mode: Mode): TutorState {
    return { providers: this.runner.available(), activeTurnId: this.active?.id, threads: groupTutorThreads(this.turns.list(lessonId, mode)) };
  }
  get(id: string) { return this.turns.get(id); }
  start(lessonId: string, input: TutorAsk): TutorTurn {
    if (this.active) throw new StoreError('Another tutor answer is still running. Stop it or wait for it to finish.', 409);
    const lesson = this.lessons.get(lessonId);
    if (!lesson) throw new StoreError('Analysis not found.', 404);
    const section = lesson.modes[input.mode]?.sections.find(section => section.id === input.sectionId);
    if (!section?.blocks.some(block => block.id === input.blockId)) throw new StoreError('That passage does not belong to this section.', 400);
    const provider = this.runner.available().find(item => item.id === input.provider);
    if (!provider?.available) throw new StoreError(input.provider + ' is not available on this host.', 503);
    const now = new Date().toISOString();
    const turn = this.turns.save({ id: randomUUID(), lessonId, ...input, status: 'queued', stage: 'Waiting to read the passage', createdAt: now, updatedAt: now });
    const controller = new AbortController();
    const promise = this.run(turn, controller).finally(() => { if (this.active?.id === turn.id) this.active = undefined; });
    this.active = { id: turn.id, controller, promise };
    return turn;
  }
  private update(turn: TutorTurn, change: Partial<TutorTurn>) {
    return this.turns.save({ ...turn, ...change, updatedAt: new Date().toISOString() });
  }
  private async imagePaths(turn: TutorTurn, context: ReturnType<typeof buildTutorContext>) {
    const lesson = this.lessons.get(turn.lessonId)!; const paths: string[] = [];
    const dir = join(this.dataDir, 'tutor', turn.id); await mkdir(dir, { recursive: true });
    for (const item of context.assets) {
      const asset = lesson.assets.find(candidate => candidate.id === item.id); if (!asset) continue;
      // Every image is copied into this turn's folder: the isolated agent service accepts only images inside the job directory.
      const copy = async (from: string) => { const path = join(dir, asset.id + (extname(from) || '.img')); try { await copyFile(from, path); paths.push(path); } catch { /* a missing image is left out; its caption stays in the context */ } };
      if (asset.src.startsWith('/assets/')) { await copy(resolve('public', '.' + asset.src)); continue; }
      const media = asset.src.match(/^\/api\/library\/([^/]+)\/media\/([^/]+)$/);
      if (media) { const saved = this.lessons.mediaPath(media[1], media[2]); if (saved) await copy(saved); continue; }
      const data = asset.src.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
      if (data) { const path = join(dir, asset.id + (data[1] === 'image/jpeg' ? '.jpg' : extname(data[1]) || '.png')); await writeFile(path, Buffer.from(data[2], 'base64')); paths.push(path); }
    }
    return paths;
  }
  private validateAnswer(turn: TutorTurn, answer: unknown) {
    const parsed = tutorAnswerSchema.parse(answer); const lesson = this.lessons.get(turn.lessonId)!;
    for (const block of parsed.blocks) if (block.kind === 'existing-figure' && !lesson.assets.some(asset => asset.id === block.assetId))
      throw new Error('Tutor referenced an image that is not saved in this lesson.');
    for (const citation of parsed.citations) {
      const source=citation.sourceId?lesson.sources.find(source => source.id === citation.sourceId):undefined;
      if (citation.sourceId && !source) throw new Error('Tutor referenced a source that is not saved in this lesson.');
      if (citation.locator && (!source || !source.locators.includes(citation.locator))) throw new Error('Tutor referenced a source location that is not saved in this lesson.');
      if (turn.scope === 'lesson' && citation.url) throw new Error('A lesson-only answer cannot add a web citation.');
      if (turn.scope === 'research' && citation.url && !/^https?:/.test(citation.url)) throw new Error('Tutor returned an invalid research citation.');
    }
    if (turn.scope === 'research' && !parsed.citations.some(citation => citation.url)) throw new Error('A researched answer must cite at least one web source.');
    return parsed;
  }
  private async run(initial: TutorTurn, controller: AbortController) {
    let turn = initial;
    try {
      turn = this.update(turn, { status: 'reading', stage: 'Reading this passage and its sources' });
      const prior = this.turns.list(turn.lessonId, turn.mode).filter(item => item.blockId === turn.blockId && item.id !== turn.id && item.status === 'ready');
      const context = buildTutorContext(this.lessons.get(turn.lessonId)!, turn.mode, turn.blockId, prior);
      const images = await this.imagePaths(turn, context);
      turn = this.update(turn, { status: 'answering', stage: turn.scope === 'research' ? 'Researching and composing an answer' : 'Composing an answer from the lesson' });
      const settings = this.lessons.getSettings();
      const value = await this.runner.run({ provider: turn.provider, kind: 'tutor', prompt: secureAgentPrompt(promptFor(context, turn.question, turn.scope === 'research'),turn.provider,images), schema: answerJsonSchema, cwd: join(this.dataDir, 'tutor', turn.id), name: 'answer', images, research: turn.scope === 'research', model: turn.provider === 'codex' ? settings.preparation.codexModel || undefined : settings.preparation.claudeModel || undefined, timeoutMs: settings.preparation.timeoutMinutes * 60_000 }, controller.signal);
      const answer = this.validateAnswer(turn, value);
      this.update(turn, { status: 'ready', stage: 'Answer ready', answer, error: undefined });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.update(turn, { status: cancelled ? 'cancelled' : 'failed', stage: cancelled ? 'Stopped' : 'Could not answer', error: cancelled ? 'Answer stopped by the learner.' : error instanceof Error ? error.message : 'The tutor could not answer.' });
    }
  }
  stop(id: string): TutorTurn {
    if (this.active?.id !== id) throw new StoreError('That tutor request is not running.', 409);
    this.active.controller.abort();
    return this.turns.get(id)!;
  }
  delete(id: string): void {
    if (this.active?.id === id) throw new StoreError('Stop this answer before removing it.', 409);
    if (!this.turns.delete(id)) throw new StoreError('Tutor reply not found.', 404);
  }
  deleteLesson(lessonId: string) { this.turns.deleteLesson(lessonId); }
  moveLesson(from: string, to: string) { this.turns.moveLesson(from, to); }
  textForSpeech(id: string, part: 'question' | 'answer'): string {
    const turn = this.turns.get(id); if (!turn) throw new StoreError('Tutor reply not found.', 404);
    if (part === 'question') return turn.question;
    if (!turn.answer) throw new StoreError('This tutor answer is not ready.', 409);
    return turn.answer.blocks.map(block => block.spokenText).join(' ');
  }
  async shutdown() { const active=this.active;active?.controller.abort();await active?.promise; }
}
