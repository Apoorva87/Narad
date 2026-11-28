import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { addUsage, steerMaxDepth, steerMaxTopics, type AgentUsage, type Provider, type PrepareAction, type PreparationJob, type PreparationState, type SteerPatch, type SteeringPlan } from '../shared/preparation';
import { isBlocking, type SourceBundle } from '../shared/sources';
import type { Familiarity } from '../shared/lesson';
import { renderPrompt, type Settings } from '../shared/settings';
import { LessonStore, StoreError } from './store';
import type { LibraryFs } from './library';
import { cliRunner, type AgentRunner } from './agent-runner';
import type { Download } from './capture';
import { prepareSources } from './intake';
import { authoredSectionSchema, type AuthoredSection } from './lesson-preparation';
import { CallRunner, type CallInput, type CallRecord } from './runner';
import { secureAgentPrompt, untrustedData } from './prompt-security';
import { addChildren, applyPatch, branches, linkBudgets, newPlan, outlineSchema, publicPlan, removeChildren, researchLeaves, steeredResearchSchema, steeredWriting, suggestedPlan, usableLink, withBudget, type StoredPlan, type TopicBrief } from './steering';
import { agentSectionSchema, authorBatchSchema, buildTeachingPlan, checkTeaching, compilePreparedBundle, normalizeTeaching, reconcileReviewIssues, researchSchema, reviewBatchSchema, reviewSchema, sectionHash, summarySchema, type TeachingTask } from './generation-content';

type SectionState = 'waiting' | 'writing' | 'reviewing' | 'done' | 'failed';
type RunStatus = 'running' | 'awaiting-input' | 'interrupted' | 'stopped' | 'failed' | 'completed';
/** `preparation/progress.json`: one item's run state, per-section state and per-call records. */
export type Progress = {
  runId: string; status: RunStatus | 'queued'; provider: Provider; level: Familiarity;
  startedAt: string; updatedAt: string;
  steps: { research: 'pending' | 'done' | 'skipped'; summary: 'pending' | 'done'; publish: 'pending' | 'done' };
  sections: Record<string, { title: string; sourceHash: string; state: SectionState; attempts: number; durationMs?: number; error?: string }>;
  calls: CallRecord[]; error?: string;
  /** Sum of every call's usage, retried attempts included. */
  usage?: AgentUsage;
  /** Where the previously published run was archived (`runs/<runId>`), so publishing puts the old lesson.json beside its settings. */
  previous?: string;
  /** Set (in a locked update) once the previous lesson.json is archived, before the new one is written, so a retried publish never archives twice. */
  archivedLesson?: string;
  /** When the item joined the queue, and what was asked for. Shown in the Agents list; the queue itself is kept in memory. */
  queuedAt?: string; request?: { familiarity?: Familiarity; action: PrepareAction; steer?: boolean };
  /** Set when the run was started with "Steer the research": its outline and choices live in `preparation/steering.json`. */
  steer?: boolean;
  /** The highest `rev` of an outline this item had before, so a newly drawn outline continues from it. */
  steerRev?: number;
  /** Things the run did that the learner may want to know, such as found articles it could not capture. */
  notes?: string[];
  /**
   * The status before the item was queued (`none`: never prepared, so this file is only a placeholder). Kept until a run
   * actually starts, so a queued "new version" of a published lesson still archives that lesson when it runs.
   */
  beforeQueue?: RunStatus | 'none';
};
type SavedSection = { task: string; title: string; sourceHash: string; teaching: AuthoredSection };
type Session = PreparationState['sessions'][number];
/** One running lesson. Everything a run owns — its abort controller, stage text, live agent sessions — lives here, so runs never share state. */
type Active = { slug: string; title: string; provider: Provider; stage: string; stopping: boolean; startedAt: string; controller: AbortController; done: Promise<void>; sessions: Session[]; steer?: boolean; mode?: Queued['mode'] };
/** `mode` marks the two short-lived steering jobs: breaking down one outline topic (`expand`) and researching the confirmed choices (`confirm`). */
type Queued = { slug: string; provider: Provider; familiarity?: Familiarity; action: PrepareAction; queuedAt?: string; seq?: number; steer?: boolean; mode?: 'expand' | 'confirm'; topicId?: string };
/** What a steered run adds to each section: its topic for the writer and reviewer, and the hash its saved section is kept under. */
type Shape = { topic: (task: TeachingTask) => TopicBrief | undefined; hash: (task: TeachingTask) => string };
type Run = (step: CallInput['step'], task: string, text: string, schema: CallInput['schema'], images?: string[], options?:Pick<CallInput,'multiAgent'|'reasoningEffort'>) => Promise<unknown>;

const PROGRESS = 'preparation/progress.json';
const STEERING = 'preparation/steering.json';
const NOT_WAITING = 'The outline can only be changed while it is waiting for your topic choices.';
const UNAVAILABLE = 'This agent is not available. Install it and sign in from a terminal, then restart Narad if PATH changed.';
const INTERRUPTED = 'Preparation was interrupted when the server stopped. Finished sections are saved; press Continue to resume.';
const QUEUE_INTERRUPTED = 'Not started — the server restarted while it was queued';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 3000);
const stageFor: Record<PreparationJob['status'], string> = {
  queued: 'Queued', running: 'Preparing', stopping: 'Stopping agent…', 'awaiting-input': 'Waiting for your topic choices', completed: 'Lesson ready', failed: 'Preparation needs attention',
  stopped: 'Stopped · finished sections kept', cancelled: 'Stopped', interrupted: 'Interrupted when the server stopped · finished sections kept',
};
const levelKey: Record<Familiarity, 'levelFoundational' | 'levelSomeBackground' | 'levelAdvanced'> = { foundational: 'levelFoundational', 'some-background': 'levelSomeBackground', advanced: 'levelAdvanced' };
/** Fills the shared slots once per job; each step adds its own data slots. */
function promptKit(settings: Settings, level: Familiarity, steered = false) {
  const p = settings.prompts;
  const principles = renderPrompt(p.principles, { level, levelGuidance: p[levelKey[level]] });
  const shared = { principles, level, walkthroughGuidance: p.walkthroughGuidance, dialogueGuidance: p.dialogueGuidance, visualGuidance: p.visualGuidance, courseGuidance: p.courseGuidance, steerGuidance: p.steerGuidance, maxLinks: String(settings.research.maxLinks) };
  type Key = 'research' | 'outline' | 'steeredResearch' | 'section' | 'revision' | 'review' | 'summary' | 'steerSummary';
  const template = (key: Key) => {
    if (key !== 'section' && key !== 'review') return p[key];
    // A section or review prompt customised before the course existed has no {{courseGuidance}} slot; the agent still needs the guidance.
    const text = /\{\{\s*courseGuidance\s*\}\}/.test(p[key]) ? p[key] : '{{courseGuidance}}\n' + p[key];
    // The same goes for {{steerGuidance}} in a steered lesson. Any other lesson drops the slot with its line, so its prompt reads as it did before steering existed.
    const slot = /\{\{\s*steerGuidance\s*\}\}/;
    return steered ? (slot.test(text) ? text : '{{steerGuidance}}\n' + text) : text.replace(/\{\{\s*steerGuidance\s*\}\}\n?/g, '');
  };
  // Every data slot is learner- or source-controlled: each is encoded as one untrusted JSON value so it cannot open a new prompt boundary.
  return (key: Key, values: Record<string, unknown>) =>
    renderPrompt(template(key), { ...shared, ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, untrustedData(name, value)])) });
}
function progressIssue(issues:string[]):string{
  const text=issues[0]?.replace(/\s+/g,' ').trim()??'Improving the draft.';
  return text.length>180?text.slice(0,177)+'…':text;
}

/**
 * Prepares up to `preparation.lessonsAtOnce` library items at the same time; further starts wait in a first-in, first-out
 * queue and start, in order, whenever a run ends or the setting is raised. Progress lives in each item's `preparation/` folder:
 * each finished section is saved as its own file, so a stopped, failed or interrupted run continues where it left off when the
 * user asks. Nothing resumes or starts on its own after a restart — a queued item becomes interrupted.
 *
 * "Steer the research" (topic-only items started with `steer`) adds a state that holds no slot and no agent: after one outline
 * call the run writes `preparation/steering.json` and rests in `awaiting-input` until the learner edits, breaks down topics
 * (`expand`, a short job) and confirms (`confirm`, which runs the rest of the preparation). That state survives restarts untouched.
 */
export class PreparationService {
  private active = new Map<string, Active>();
  private queue: Queued[] = [];
  private closing = false;
  private seq = 0;
  /** Items taken out of the queue by `whileDequeued`; `cancelled` is set when the user stops them meanwhile. */
  private out = new Map<string, { cancelled: boolean }>();
  private fs: LibraryFs;
  /** Settles once startup has marked runs left `running` or `queued` as interrupted. */
  readonly ready: Promise<void>;
  constructor(private store: LessonStore, private dataDir: string, private runner: AgentRunner = cliRunner, private download?: Download) {
    this.fs = store.library;
    const marking = this.fs.slugs().filter(slug => { const status = this.read(slug)?.status; return status === 'running' || status === 'queued'; })
      .map(slug => this.update(slug, p => {
        if (p.status === 'running') { p.status = 'interrupted'; p.error = INTERRUPTED; this.settle(p); }
        else if (p.status === 'queued') { p.status = 'interrupted'; p.error = QUEUE_INTERRUPTED + '. Press Continue to start it.'; }
      }));
    this.ready = Promise.all(marking).then(() => undefined, error => console.error('Could not mark interrupted preparations:', error));
  }
  state(): PreparationState { return { jobs: this.jobs(), sessions: [...this.active.values()].flatMap(active => active.sessions), providers: this.runner.available() }; }
  /** Starts now when a slot is free, otherwise queues the item. Starting an item that is already running or queued returns its current job. */
  start(bundleId: string, provider: Provider, familiarity?: Familiarity, action: PrepareAction = 'continue', steer = false): PreparationJob {
    if (this.closing) throw new StoreError('The server is shutting down.', 503);
    const slug = this.store.resolveId(bundleId) ?? bundleId;
    if (this.active.has(slug) || this.queued(slug) >= 0) return this.job(slug, this.read(slug));
    // An outline waiting for the learner is not restarted by a repeated start; only Start over leaves it. A waiting item whose
    // outline is already confirmed (the server stopped between the two writes of a confirmation) or unreadable goes on:
    // the run resumes the confirmed choices, or draws the outline again.
    const prior = this.read(slug);
    if (prior?.status === 'awaiting-input' && action !== 'restart' && this.plan(slug)?.status === 'choosing') return this.job(slug, prior);
    if (!this.available(provider)) throw new StoreError(UNAVAILABLE, 400);
    const found = this.store.getBundle(slug); if (!found) throw new StoreError('Source collection not found.', 404);
    buildTeachingPlan(found);
    // A steered lesson stays steered, whatever a later Continue, Start over or level change sends.
    const steered = steer || !!prior?.steer || !!prior?.request?.steer;
    return this.begin({ slug: found.id, provider, familiarity, action, ...(steered && { steer: true }) }, found.familiarity ?? 'foundational');
  }
  /** Starts the entry now when a slot is free and nobody waits, otherwise queues it. */
  private begin(entry: Queued, level: Familiarity): PreparationJob {
    // Waiting items go first: fill any free slot from the queue, then start this one only if a slot is still free and nobody waits.
    this.pump();
    if (this.active.size < this.limit() && !this.queue.length) return this.launch(entry);
    return this.enqueue(entry, level);
  }
  private available(provider: Provider) { return this.runner.available().some(p => p.id === provider && p.available); }

  /** The saved outline of a steered item, whatever its state. */
  steering(id: string): SteeringPlan {
    const plan = this.plan(this.store.resolveId(id) ?? id);
    if (!plan) throw new StoreError('This lesson has no outline.', 404);
    return publicPlan(plan);
  }
  /** Saves the learner's focus, choices and notes. Only while the outline is waiting for them. */
  patchSteering(id: string, patch: SteerPatch): SteeringPlan {
    const { slug, plan } = this.awaiting(id);
    applyPatch(plan, patch);
    return publicPlan(this.savePlan(slug, plan));
  }
  /** Removes a topic's sub-topics, leaving one card on Summary. No agent call. */
  collapse(id: string, topicId: string): SteeringPlan {
    const { slug, plan } = this.awaiting(id);
    if (!plan.topics.some(item => item.id === topicId)) throw new StoreError('This topic is not in the outline.', 400);
    if (!removeChildren(plan, topicId)) throw new StoreError('This topic has no sub-topics.', 409);
    return publicPlan(this.savePlan(slug, plan));
  }
  /** Breaks one topic of a waiting outline into sub-topics with one short agent call, then returns to waiting. */
  expand(id: string, topicId: string): PreparationJob {
    const { slug, plan, progress } = this.awaiting(id);
    const topic = plan.topics.find(item => item.id === topicId);
    if (!topic) throw new StoreError('This topic is not in the outline.', 400);
    if (topic.depth >= steerMaxDepth) throw new StoreError('This topic cannot be broken down further.', 409);
    if (topic.children?.length) throw new StoreError('This topic is already broken down.', 409);
    if (plan.topics.length + 2 > steerMaxTopics) throw new StoreError('The outline is full. Skip or confirm the topics you have.', 409);
    if (!this.available(progress.provider)) throw new StoreError(UNAVAILABLE, 400);
    // The earlier choice is kept in the outline, so a breakdown that fails, is stopped or leaves the queue puts it back.
    plan.expanding = { topicId, choice: topic.choice };
    topic.choice = 'deeper'; this.savePlan(slug, plan);
    try { return this.begin({ slug, provider: progress.provider, action: 'continue', mode: 'expand', topicId }, progress.level); }
    catch (error) { this.unsteer(slug, { mode: 'expand', topicId }); throw error; }
  }
  /** Accepts the outline choices and starts (or queues) the rest of the preparation. `suggested` takes the agent's outline as drawn. */
  confirm(id: string, input: { patch?: SteerPatch; suggested?: boolean } = {}): PreparationJob {
    const { slug, plan, progress } = this.awaiting(id);
    const limits = this.store.getSettings().research;
    const next = structuredClone(plan);
    if (!input.suggested && input.patch) applyPatch(next, input.patch);
    // The suggested outline is only checked here. It replaces the learner's outline when the run starts, so a confirmation
    // that is taken out of the queue leaves their breakdowns, notes and focus as they were.
    const { budget } = withBudget(input.suggested ? suggestedPlan(next) : next, limits);
    const leaves = researchLeaves(input.suggested ? suggestedPlan(next) : next).length;
    if (!leaves) throw new StoreError('Keep at least one topic to make a lesson.', 409);
    if (budget.planned > budget.total) throw new StoreError(`These choices need at least ${leaves} links, more than the limit of ${budget.total}. Skip some topics, or raise the limit in Settings.`, 409);
    if (!this.available(progress.provider)) throw new StoreError(UNAVAILABLE, 400);
    next.status = 'confirmed'; next.budget = budget; if (input.suggested) next.suggested = true;
    this.writePlan(slug, next);
    try { return this.begin({ slug, provider: progress.provider, action: 'continue', mode: 'confirm' }, progress.level); }
    catch (error) { this.writePlan(slug, plan); throw error; }
  }
  /** The item's outline while it is waiting for choices; 409 in any other state. */
  private awaiting(id: string): { slug: string; plan: StoredPlan; progress: Progress } {
    if (this.closing) throw new StoreError('The server is shutting down.', 503);
    const slug = this.store.resolveId(id) ?? id;
    const progress = this.read(slug); if (!progress) throw new StoreError('Preparation not found.', 404);
    const plan = this.plan(slug);
    if (this.active.has(slug) || this.queued(slug) >= 0 || progress.status !== 'awaiting-input' || plan?.status !== 'choosing') throw new StoreError(NOT_WAITING, 409);
    return { slug, plan, progress };
  }
  private plan(slug: string): StoredPlan | undefined { return this.fs.readJson<StoredPlan>(slug, STEERING).value; }
  /** The only write of steering.json: `rev` always ends above both the saved outline's and the given one's. */
  private writePlan(slug: string, plan: StoredPlan): StoredPlan {
    plan.rev = Math.max(this.plan(slug)?.rev ?? 0, plan.rev ?? 0) + 1;
    this.fs.writeJson(slug, STEERING, plan); return plan;
  }
  /** Every writer reads, changes and writes the outline without awaiting in between, so writes never interleave. */
  private savePlan(slug: string, plan: StoredPlan, limits = this.store.getSettings().research): StoredPlan {
    return this.writePlan(slug, withBudget(plan, limits));
  }
  /** Undoes what queueing or starting a steering job changed in the outline, so the learner is back at their choices. */
  private unsteer(slug: string, entry: Pick<Queued, 'mode' | 'topicId'>) {
    const plan = this.plan(slug); if (!plan || !entry.mode) return;
    if (entry.mode === 'confirm') { if (plan.status !== 'confirmed') return; plan.status = 'choosing'; delete plan.suggested; }
    else {
      const before = plan.expanding; if (!before || (entry.topicId && before.topicId !== entry.topicId)) return;
      delete plan.expanding;
      const topic = plan.topics.find(item => item.id === before.topicId);
      if (topic && !topic.children?.length) topic.choice = before.choice;
    }
    this.savePlan(slug, plan);
  }
  async stop(id: string): Promise<PreparationJob> {
    const slug = this.store.resolveId(id) ?? id;
    const active = this.active.get(slug);
    const out = this.out.get(slug); if (out) out.cancelled = true;
    if (active) {
      active.stopping = true; active.stage = 'Stopping agent…'; active.controller.abort();
      return this.job(slug, this.read(slug));
    }
    if (await this.dequeue(slug)) return this.job(slug, this.read(slug));
    if (this.read(slug)?.status === 'awaiting-input') {
      // Nothing is running: the outline is kept, and Continue returns to it.
      await this.update(slug, p => { if (p.status === 'awaiting-input') { p.status = 'stopped'; delete p.error; } });
      return this.job(slug, this.read(slug));
    }
    const existing = this.jobs().find(job => job.id === slug);
    if (existing) return existing;
    throw new StoreError('Preparation not found.', 404);
  }
  /**
   * Takes a queued item out of the queue and records it as stopped (a queued new version of a published lesson goes back to
   * completed). Finished sections are untouched. Resolves false when the item was not queued. Called before delete and rename.
   */
  async dequeue(id: string): Promise<boolean> {
    const slug = this.store.resolveId(id) ?? id;
    const index = this.queued(slug); if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    this.unsteer(slug, entry);
    await this.update(slug, p => {
      if (p.status !== 'queued') return;
      const before = p.beforeQueue;
      p.status = before === 'completed' ? 'completed' : before === 'awaiting-input' ? 'awaiting-input' : 'stopped';
      delete p.queuedAt; delete p.request; delete p.error;
      if (before !== 'none') delete p.beforeQueue;
    });
    return true;
  }
  /**
   * Runs `action` (a rename or delete) with the item out of the queue. When the action throws, the item goes back to its
   * place in the queue with its queued progress restored, so a failed rename or delete never loses a waiting lesson.
   */
  async whileDequeued<T>(id: string, action: () => T | Promise<T>): Promise<T> {
    const slug = this.store.resolveId(id) ?? id;
    const index = this.queued(slug);
    if (index < 0) return action();
    const entry = this.queue[index];
    await this.fs.withLock(slug, async () => undefined); // let the queued write land before taking the snapshot
    const before = this.read(slug);
    const saved = before && { status: before.status, queuedAt: before.queuedAt, request: before.request, beforeQueue: before.beforeQueue, error: before.error };
    const outline = entry.mode ? this.plan(slug) : undefined;
    if (!await this.dequeue(slug)) return action(); // started or removed while waiting for the lock
    const out = { cancelled: false }; this.out.set(slug, out);
    try { return await action(); }
    catch (error) {
      if (!this.closing && !out.cancelled && this.queued(slug) < 0 && !this.active.has(slug)) {
        // Back where it was by original order, not by its old index: items ahead of it may have started or left meanwhile.
        const later = this.queue.findIndex(other => this.after(other, entry));
        this.queue.splice(later < 0 ? this.queue.length : later, 0, entry);
        if (outline) this.writePlan(slug, outline);
        if (saved) await this.update(slug, p => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete (p as Record<string, unknown>)[key]; else (p as Record<string, unknown>)[key] = value; });
        this.pump();
      }
      throw error;
    }
    finally { if (this.out.get(slug) === out) this.out.delete(slug); }
  }
  /** True when `a` was queued after `b` (by persisted time, then by arrival order for ties). */
  private after(a: Queued, b: Queued) { return (a.queuedAt ?? '') !== (b.queuedAt ?? '') ? (a.queuedAt ?? '') > (b.queuedAt ?? '') : (a.seq ?? 0) > (b.seq ?? 0); }
  /** Lets queued items use slots freed by a raised `lessonsAtOnce`. Lowering it never stops a running lesson. */
  settingsChanged() { this.pump(); }
  /** True while this collection is being prepared (not merely queued), matching old IDs and renamed slugs alike. */
  busy(bundleId: string) { return this.active.has(bundleId) || [...this.active.keys()].includes(this.store.resolveId(bundleId) ?? ''); }
  /** Deletes drafts that older versions of Narad kept outside the library folders. */
  async forget(jobs: { id: string }[]) { await Promise.all(jobs.map(job => rm(join(this.dataDir, 'preparations', job.id), { recursive: true, force: true }))); }
  /** Stops every running lesson (they become interrupted) and waits for all of them. Queued items stay queued on disk and become interrupted on the next start. */
  async shutdown() {
    this.closing = true; this.queue = [];
    const running = [...this.active.values()];
    for (const active of running) active.controller.abort();
    await Promise.all(running.map(active => active.done));
    await this.ready;
  }

  private limit() { return this.store.getSettings().preparation.lessonsAtOnce; }
  private queued(slug: string) { return this.queue.findIndex(entry => entry.slug === slug); }
  /** Starts the oldest queued items while slots are free. A queued item that can no longer start is marked failed and skipped. */
  /** Never throws: it runs from a finished run's `finally`, where an exception would become an unhandled rejection. */
  private pump() {
    try { this.fill(); } catch (error) { console.error('Could not start the next queued preparation:', error); }
  }
  private fill() {
    while (!this.closing && this.queue.length && this.active.size < this.limit()) {
      const next = this.queue.shift()!;
      try {
        if (!this.store.getBundle(next.slug)) throw new StoreError('Source collection not found.', 404);
        if (!this.available(next.provider)) throw new StoreError(UNAVAILABLE, 400);
        this.launch(next);
      } catch (error) {
        // A topic breakdown that cannot start leaves the outline as it was, still waiting.
        if (next.mode === 'expand') this.unsteer(next.slug, next);
        this.update(next.slug, p => { if (p.status === 'queued') { p.status = next.mode === 'expand' ? 'awaiting-input' : 'failed'; p.error = message(error); delete p.queuedAt; delete p.request; if (next.mode === 'expand') delete p.beforeQueue; } })
          .catch(failure => console.error('Could not record a queued preparation that failed to start:', failure));
      }
    }
  }
  private enqueue(entry: Queued, level: Familiarity): PreparationJob {
    const now = new Date().toISOString();
    entry.queuedAt = now; entry.seq = ++this.seq;
    this.queue.push(entry);
    const mark = (p: Progress) => {
      p.beforeQueue ??= p.status === 'queued' ? 'none' : p.status;
      p.status = 'queued'; p.provider = entry.provider; p.queuedAt = now; p.request = { ...(entry.familiarity && { familiarity: entry.familiarity }), action: entry.action, ...((entry.steer || p.request?.steer) && { steer: true }) };
    };
    const prior = this.read(entry.slug);
    const placeholder: Progress = { runId: stamp(), status: 'queued', provider: entry.provider, level, startedAt: now, updatedAt: now, steps: { research: 'pending', summary: 'pending', publish: 'pending' }, sections: {}, calls: [], beforeQueue: 'none' };
    if (prior) mark(prior); else mark(placeholder);
    // Written under the item's lock, so a later start (prepare) or removal (dequeue) always sees it; the in-memory queue is authoritative meanwhile.
    void this.fs.withLock(entry.slug, async () => {
      const progress = this.read(entry.slug) ?? placeholder;
      mark(progress); progress.updatedAt = new Date().toISOString();
      this.fs.writeJson(entry.slug, PROGRESS, progress);
    }).catch(error => console.error('Could not record the queued preparation:', error));
    return this.job(entry.slug, prior ?? placeholder);
  }
  private launch(entry: Queued): PreparationJob {
    const { slug, provider, familiarity, action } = entry;
    const found = this.store.getBundle(slug)!;
    const bundle = familiarity && familiarity !== found.familiarity ? this.store.saveBundle({ ...found, familiarity }, []) : found;
    buildTeachingPlan(bundle);
    const settings = this.store.getSettings(); // anything that can throw runs before the slot is taken
    const topic = entry.mode === 'expand' ? this.plan(slug)?.topics.find(item => item.id === entry.topicId) : undefined;
    const active: Active = { slug: bundle.id, title: bundle.title, provider, stage: topic ? `Breaking down "${topic.title}"` : 'Starting preparation', stopping: false, startedAt: new Date().toISOString(), controller: new AbortController(), done: Promise.resolve(), sessions: [],
      ...(entry.mode && { mode: entry.mode }), ...(entry.steer && bundle.sources.every(s => s.kind === 'note') && { steer: true }) };
    this.active.set(active.slug, active);
    active.done = (entry.mode === 'expand' ? this.breakDown(active, entry.topicId ?? '', settings) : this.prepare(active, action, settings, !!entry.steer))
      .catch(error => this.finishFailed(active, error))
      .catch(error => console.error('Could not record the preparation outcome:', error))
      .finally(() => { active.sessions = []; if (this.active.get(active.slug) === active) this.active.delete(active.slug); this.pump(); });
    return this.job(active.slug, this.read(active.slug));
  }

  /** Runs found across item folders, newest first; a `running` or `queued` file with no live run or queue entry is reported as interrupted. */
  private jobs(): PreparationJob[] {
    const jobs = this.fs.slugs().flatMap(slug => { const progress = this.read(slug); return progress ? [this.job(slug, progress)] : []; });
    for (const slug of [...this.active.keys(), ...this.queue.map(entry => entry.slug)]) if (!jobs.some(job => job.slug === slug)) jobs.push(this.job(slug, undefined));
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50);
  }
  private job(slug: string, progress: Progress | undefined): PreparationJob {
    const active = this.active.get(slug);
    const position = this.queued(slug) + 1;
    const status: PreparationJob['status'] = active ? (active.stopping ? 'stopping' : 'running') : position ? 'queued'
      : progress?.status === 'running' || progress?.status === 'queued' ? 'interrupted' : progress?.status ?? 'running';
    const sections = Object.entries(progress?.sections ?? {}).map(([task, s]) => ({ task, title: s.title, state: s.state, ...(s.durationMs !== undefined && { durationMs: s.durationMs }), ...(s.error && { error: s.error }) }));
    const title = active?.title ?? this.fs.readJson<{ title?: string }>(slug, 'item.json').value?.title ?? slug;
    const neverStarted = status === 'interrupted' && (progress?.status === 'queued' || progress?.beforeQueue !== undefined);
    const error = active || position ? undefined : status === 'interrupted' ? progress?.error ?? (neverStarted ? QUEUE_INTERRUPTED + '. Press Continue to start it.' : INTERRUPTED) : progress?.error;
    const stage = active?.stage ?? (position ? `Queued · position ${position} of ${this.queue.length}` : neverStarted ? QUEUE_INTERRUPTED : stageFor[status]);
    const now = new Date().toISOString();
    const queuedEntry = position ? this.queue[position - 1] : undefined;
    const steer = progress?.steer || active?.steer || queuedEntry?.steer;
    // The outline is shown while the learner is choosing and while a steering job of theirs runs or waits for a slot.
    const saved = status === 'awaiting-input' || active?.mode === 'expand' || queuedEntry?.mode ? this.plan(slug) : undefined;
    const steering = saved && publicPlan(saved);
    return {
      id: slug, bundleId: slug, slug, title, provider: active?.provider ?? queuedEntry?.provider ?? progress?.provider ?? 'codex', status, stage,
      completed: sections.filter(s => s.state === 'done').length, total: sections.length,
      createdAt: progress?.startedAt ?? active?.startedAt ?? now, updatedAt: progress?.updatedAt ?? now, sections, folder: this.fs.dir(slug),
      ...(position && { queuePosition: position, queueLength: this.queue.length }),
      ...(status === 'completed' && { lessonId: slug }), ...(progress?.usage && { usage: progress.usage }), ...(error && { error }),
      ...(steer && { steer: true }), ...(steering && { steering }),
    };
  }
  private read(slug: string): Progress | undefined { return this.fs.readJson<Progress>(slug, PROGRESS).value; }
  /** Read-modify-write of progress.json, serialized per item so concurrent sections never lose each other's updates. */
  private update(slug: string, mutate: (progress: Progress) => void): Promise<void> {
    return this.fs.withLock(slug, async () => {
      const progress = this.read(slug); if (!progress) return;
      mutate(progress); progress.updatedAt = new Date().toISOString();
      this.fs.writeJson(slug, PROGRESS, progress);
    });
  }
  /** Sections caught mid-step go back to waiting; finished and failed ones keep their state. */
  private settle(progress: Progress) { for (const section of Object.values(progress.sections)) if (section.state === 'writing' || section.state === 'reviewing') section.state = 'waiting'; }
  private async finishFailed(active: Active, error: unknown) {
    const aborted = active.controller.signal.aborted;
    // Stop → stopped; server shutdown → interrupted (the user did not ask to stop); anything else → failed with its error.
    const status: RunStatus = !aborted ? 'failed' : active.stopping ? 'stopped' : 'interrupted';
    await this.update(active.slug, p => {
      p.status = status;
      if (status === 'failed') p.error = message(error); else if (status === 'interrupted') p.error = INTERRUPTED; else delete p.error;
      this.settle(p);
    });
  }
  /** Moves the named entries of `preparation/` into a new `preparation/runs/<name>/` and returns its path relative to `preparation/`. */
  private archive(slug: string, name: string, entries: string[]): string {
    const prep = join(this.fs.dir(slug), 'preparation');
    let folder = name;
    for (let n = 2; existsSync(join(prep, 'runs', folder)); n++) folder = `${name}-${n}`;
    mkdirSync(join(prep, 'runs', folder), { recursive: true });
    for (const entry of entries) if (existsSync(join(prep, entry))) renameSync(join(prep, entry), join(prep, 'runs', folder, entry));
    return 'runs/' + folder;
  }
  /** A saved section is reused only when its source hash matches and it still passes the section checks. */
  private saved(slug: string, task: TeachingTask, hash: string): AuthoredSection | undefined {
    const saved = this.fs.readJson<SavedSection>(slug, `preparation/sections/${task.id}.json`).value;
    if (saved?.sourceHash !== hash) return undefined;
    const teaching = authoredSectionSchema.safeParse(saved.teaching);const normalized=teaching.success?normalizeTeaching(teaching.data):undefined;
    return normalized && !checkTeaching(task, normalized).length ? normalized : undefined;
  }

  /** The agent caller for one run: records every call in the item's folder and tracks its live sessions. */
  private agent(active: Active, settings: Settings): Run {
    const { slug, provider } = active; const signal = active.controller.signal;
    const dir = join(this.fs.dir(slug), 'preparation');
    const calls = new CallRunner(dir, this.runner, call => this.update(slug, p => { p.calls.push(call); p.usage = addUsage(p.usage, call.usage); if (!p.usage) delete p.usage; p.calls.sort((a, b) => a.n - b.n); }));
    return (step, task, text, schema, images = [], options = {}) => {
      let session: Session | undefined;
      return calls.run({ step, task, prompt: secureAgentPrompt(text, provider, images), schema, images, provider, model: (provider === 'codex' ? settings.preparation.codexModel : settings.preparation.claudeModel) || undefined, timeoutMs: settings.preparation.timeoutMinutes * 60_000, ...(provider==='codex'&&{reasoningEffort:settings.preparation.codexReasoning}), ...options }, signal, pid => {
        if (session) active.sessions = active.sessions.filter(s => s !== session);
        session = pid ? { jobId: slug, slug, provider, pid, startedAt: new Date().toISOString() } : undefined;
        if (session) active.sessions = [...active.sessions, session];
      });
    };
  }

  /** The short job behind `expand`: one outline call for one topic, then back to waiting whatever happens. */
  private async breakDown(active: Active, topicId: string, settings: Settings) {
    const { slug } = active; const signal = active.controller.signal;
    const bundle = this.store.getBundle(slug)!;
    await this.update(slug, p => { p.status = 'running'; p.provider = active.provider; delete p.error; delete p.queuedAt; delete p.request; delete p.beforeQueue; });
    let title = 'this topic';
    try {
      const plan = this.plan(slug); const topic = plan?.topics.find(item => item.id === topicId);
      if (!plan || !topic) throw new Error('This topic is no longer in the outline.');
      title = topic.title; active.stage = `Breaking down "${title}"`;
      // `outline` is every other topic, so the new sub-topics overlap neither a sibling nor a cousin.
      const others = plan.topics.filter(item => item.id !== topic.id);
      const parent = { title: topic.title, blurb: topic.blurb, note: topic.note ?? null, focus: plan.focus ?? null, siblings: others.filter(item => item.parentId === topic.parentId).map(item => item.title), outline: others.map(item => item.title) };
      const outline = outlineSchema.parse(await this.agent(active, settings)('outline', 'outline-' + topic.id, promptKit(settings, bundle.familiarity ?? 'foundational')('outline', { request: bundle.text, parent }), outlineSchema));
      signal.throwIfAborted();
      const current = this.plan(slug);
      if (!current || !addChildren(current, topicId, outline.topics)) throw new Error('The outline is full.');
      delete current.expanding;
      this.savePlan(slug, current, settings.research);
      await this.update(slug, p => { p.status = 'awaiting-input'; });
    } catch (error) {
      this.unsteer(slug, { mode: 'expand', topicId });
      // Stop and shutdown end as stopped or interrupted; Continue then returns to the outline.
      if (signal.aborted) throw error;
      const reason = message(error).replace(/\s+/g, ' ').trim();
      await this.update(slug, p => { p.status = 'awaiting-input'; p.error = `Could not break down "${title}": ${reason.length > 200 ? reason.slice(0, 199) + '…' : reason}`; });
    }
  }

  /**
   * The research step of a steered run. Draws the outline and returns undefined to wait for the learner; once they confirmed,
   * finds links branch by branch (saved after each call, so an interruption repeats only the branches without links), captures
   * them all at once and returns the bundle with the articles that could be captured.
   */
  private async steered(active: Active, bundle: SourceBundle, settings: Settings, run: Run, prompt: ReturnType<typeof promptKit>): Promise<SourceBundle | undefined> {
    const { slug } = active; const signal = active.controller.signal;
    let plan = this.plan(slug);
    if (!plan) {
      active.stage = 'Drawing an outline of your topic';
      const outline = outlineSchema.parse(await run('outline', 'outline', prompt('outline', { request: bundle.text, parent: null }), outlineSchema));
      signal.throwIfAborted();
      // A new outline continues the numbering of the one it replaces, so the page never takes it for an older copy.
      plan = newPlan(outline.topics, settings.research); plan.rev = this.read(slug)?.steerRev ?? 0;
      this.writePlan(slug, plan);
    }
    if (plan.status === 'choosing') {
      signal.throwIfAborted();
      // A breakdown cut short when the server stopped left its topic marked Deeper; put its earlier choice back.
      if (plan.expanding) this.unsteer(slug, { mode: 'expand' });
      await this.update(slug, p => { p.status = 'awaiting-input'; });
      return undefined;
    }
    if (plan.suggested) plan = this.savePlan(slug, suggestedPlan(plan), settings.research);
    const budgets = linkBudgets(plan, settings.research);
    const seen = new Set(plan.topics.flatMap(topic => topic.links ?? []));
    const kept = branches(plan);
    const all = kept.flatMap(branch => branch.leaves);
    // The limit may have been lowered since the outline was confirmed: topics are served in outline order until it is used up,
    // and the rest get no links (the writers are then told those topics are not covered).
    let left = settings.research.steeredMaxLinks - all.reduce((sum, leaf) => sum + (leaf.links?.length ?? 0), 0);
    const allowed = new Map<string, number>();
    for (const leaf of all) if (!leaf.links) { const n = Math.max(0, Math.min(budgets.get(leaf.id) ?? 1, left)); allowed.set(leaf.id, n); left -= n; if (!n) leaf.links = []; }
    for (const [index, { top, leaves }] of kept.entries()) {
      const todo = leaves.filter(leaf => !leaf.links);
      if (!todo.length) continue;
      signal.throwIfAborted();
      active.stage = `Finding sources · topic ${index + 1} of ${kept.length} · ${top.title}`;
      const topics = todo.map(leaf => ({ topicId: leaf.id, title: leaf.title, blurb: leaf.blurb, note: leaf.note ?? null, links: allowed.get(leaf.id) ?? 1 }));
      const schema = steeredResearchSchema(todo.map(leaf => leaf.id));
      const found = schema.parse(await run('research', 'steer-' + top.id, prompt('steeredResearch', { request: bundle.text, topics: { focus: plan.focus ?? null, branch: { title: top.title, blurb: top.blurb, note: top.note ?? null }, topics, alreadyUsed: [...seen] } }), schema));
      signal.throwIfAborted();
      for (const result of found.topics) {
        const leaf = todo.find(item => item.id === result.topicId)!;
        // The same cleanup capture applies, so a link is recognised as a repeat however it was punctuated. A link capture
        // could not take (too long, or not one plain address) is left out here: once saved it would fail every Continue.
        leaf.links = [...new Set(result.links.flatMap(url => usableLink(url) ?? []))].filter(url => !seen.has(url)).slice(0, allowed.get(leaf.id) ?? 1);
        for (const url of leaf.links) seen.add(url);
      }
      this.writePlan(slug, plan);
    }
    // Each link stays with the topic it was found for, from here to the section that is written from it.
    const links: { topicId: string; link: string }[] = [];
    for (const leaf of all) {
      const mine = (leaf.links ?? []).filter(url => usableLink(url) === url && !links.some(item => item.link === url)).slice(0, Math.max(0, settings.research.steeredMaxLinks - links.length));
      if (leaf.links && mine.length !== leaf.links.length) leaf.links = mine;
      links.push(...mine.map(url => ({ topicId: leaf.id, link: url })));
    }
    if (!links.length) throw new Error('Research found no articles for the chosen topics. Press Start over to draw a new outline.');
    active.stage = `Capturing ${links.length} article${links.length === 1 ? '' : 's'}`;
    const captured = await prepareSources({ title: bundle.title, text: links.map(item => item.link).join('\n') }, this.download, { maxLinks: settings.research.steeredMaxLinks, maxImages: settings.capture.maxImages }, signal); signal.throwIfAborted();
    // One page that cannot be captured, or cannot be taught from, must not end the run: it is left out and noted.
    const limits = { chunkChars: settings.preparation.chunkChars, chunkUnits: settings.preparation.chunkUnits };
    const articles = captured.bundle.sources.filter(s => s.kind === 'article');
    const problem = (source: SourceBundle['sources'][number]): string | undefined => {
      const blocking = source.warnings.find(warning => warning.kind === 'blocking'); if (blocking || isBlocking(source)) return blocking?.message ?? 'Could not capture this link.';
      try { buildTeachingPlan({ ...bundle, sources: [source], status: 'captured' }, limits); } catch (error) { return message(error); }
      return undefined;
    };
    const dropped = articles.flatMap(source => { const reason = problem(source); return reason ? [{ source, reason }] : []; });
    const usable = articles.filter(source => !dropped.some(item => item.source === source));
    if (dropped.length) await this.update(slug, p => { p.notes = [...(p.notes ?? []), ...dropped.map(({ source, reason }) => `Left out ${source.url ?? source.title}: ${reason.replace(/\s+/g, ' ').slice(0, 300)}`)].slice(-60); });
    if (!usable.length) throw new Error(`None of the ${articles.length} article${articles.length === 1 ? '' : 's'} found for your topics could be captured. First problem: ${dropped[0]?.reason ?? 'unknown'}`);
    // Capture keeps the order of the links, one source each; a page may answer from another address than the one found.
    const from = (source: SourceBundle['sources'][number]) => articles.length === links.length ? links[articles.indexOf(source)] : links.find(item => item.link === source.url);
    plan.sources = usable.flatMap(source => { const found = from(source); return found ? [{ ...found, sourceId: source.id, ...(source.url && { url: source.url }) }] : []; });
    this.writePlan(slug, plan);
    // Saving moves captured images into the folder; continue with the served paths it returns.
    return this.store.saveBundle({ ...bundle, sources: [...bundle.sources, ...usable], status: 'captured' }, captured.blobs);
  }

  private async prepare(active: Active, action: PrepareAction, settings: Settings, steerRequested = false) {
    const { slug, provider } = active; const signal = active.controller.signal;
    let bundle = this.store.getBundle(slug)!;
    const level = bundle.familiarity ?? 'foundational';
    let topicOnly = bundle.sources.every(s => s.kind === 'note');
    let steer = false;
    await this.fs.withLock(slug, async () => {
      const read = this.read(slug);
      // A placeholder written while the item was queued holds no run of its own.
      const prior = read?.beforeQueue === 'none' ? undefined : read;
      const priorStatus = prior?.beforeQueue ?? prior?.status;
      let keep: Progress | undefined, previous: string | undefined;
      // A published run is kept whole, with the settings its lesson used; a run for another level, or Start over, is set aside.
      // The outline behind a published steered lesson stays in place (a copy goes with the archived run), so a new version,
      // however it is asked for, is written for the same choices from the same articles.
      const saved = this.plan(slug);
      const carry = priorStatus === 'completed' && !!prior!.steer && !topicOnly && saved?.status === 'confirmed';
      const unfinished = !!prior?.steer && priorStatus !== 'completed';
      if (priorStatus === 'completed') {
        previous = this.archive(slug, prior!.runId, ['sections', 'calls', 'progress.json', 'settings.json', ...(carry ? [] : ['steering.json'])]);
        if (carry) copyFileSync(join(this.fs.dir(slug), STEERING), join(this.fs.dir(slug), 'preparation', previous, 'steering.json'));
      }
      else if (prior && action === 'restart') {
        this.archive(slug, stamp() + '-abandoned', ['sections', 'calls', 'progress.json', 'steering.json']);
        // Start over on an unfinished steered lesson draws a new outline, so the articles its research added go as well
        // (a steered lesson starts from notes only: every article in it was found by research).
        if (unfinished && !topicOnly) { bundle = this.store.saveBundle({ ...bundle, sources: bundle.sources.filter(s => s.kind === 'note') }, []); topicOnly = bundle.sources.every(s => s.kind === 'note'); }
      }
      // The outline and its picks do not depend on the level: they stay, and only the written sections are set aside.
      else if (prior && prior.level !== level) this.archive(slug, stamp() + '-abandoned', ['sections', 'calls', 'progress.json', ...(unfinished ? [] : ['steering.json'])]);
      else keep = prior;
      steer = carry || (unfinished && (action !== 'restart' || topicOnly)) || (topicOnly && (steerRequested || (!prior && !!read?.request?.steer)));
      const rev = Math.max(read?.steerRev ?? 0, saved?.rev ?? 0);
      const now = new Date().toISOString();
      const progress: Progress = keep
        ? { ...keep, status: 'running', provider, level, updatedAt: now }
        : { runId: stamp(), status: 'running', provider, level, startedAt: now, updatedAt: now, steps: { research: 'pending', summary: 'pending', publish: 'pending' }, sections: {}, calls: [], ...(previous && { previous }) };
      if (steer) progress.steer = true;
      if (rev) progress.steerRev = rev;
      delete progress.error; delete progress.queuedAt; delete progress.request; delete progress.beforeQueue;
      this.fs.writeJson(slug, PROGRESS, progress);
      // The settings this attempt uses, kept beside its sections so a lesson's instructions stay inspectable.
      this.fs.writeJson(slug, 'preparation/settings.json', settings);
    });
    const dir = join(this.fs.dir(slug), 'preparation');
    const prompt = promptKit(settings, level);
    const limits = { chunkChars: settings.preparation.chunkChars, chunkUnits: settings.preparation.chunkUnits };
    const run = this.agent(active, settings);

    if (topicOnly && steer) {
      const researched = await this.steered(active, bundle, settings, run, prompt);
      // Waiting for the learner's choices: the run ends here and frees its slot.
      if (!researched) return;
      bundle = researched;
      await this.update(slug, p => { p.steps.research = 'done'; });
    } else if (topicOnly) {
      active.stage = 'Finding sources for your topic';
      const linkSchema = researchSchema.extend({ links: researchSchema.shape.links.max(settings.research.maxLinks) });
      const research = linkSchema.parse(await run('research', 'research', prompt('research', { request: bundle.text }), linkSchema));
      const captured = await prepareSources({ title: bundle.title, text: research.links.join('\n') }, this.download, settings.capture); signal.throwIfAborted();
      // Saving moves captured images into the folder; continue with the served paths it returns.
      bundle = this.store.saveBundle({ ...bundle, sources: [...bundle.sources, ...captured.bundle.sources.filter(s => s.kind === 'article')], status: captured.bundle.status }, captured.blobs);
      await this.update(slug, p => { p.steps.research = 'done'; });
    } else await this.update(slug, p => { if (p.steps.research === 'pending') p.steps.research = 'skipped'; });

    // A steered lesson is written for the learner's choices, not only for the request they started from.
    const outline = steer ? this.plan(slug) : undefined;
    const writing = outline?.status === 'confirmed' ? steeredWriting(bundle.text, outline, bundle.sources.filter(s => s.kind === 'article')) : undefined;
    const intent = writing?.intent ?? bundle.text;
    // Rebuild the plan from the current sources and keep every saved section whose source is unchanged.
    const tasks = buildTeachingPlan(bundle, limits);
    // Each section learns the topic its article was found for. Only the section that opens a topic is given the previous
    // topic to bridge from, and only the one that closes it the next.
    const briefs = new Map<string, TopicBrief>();
    if (writing) for (const [index, task] of tasks.entries()) {
      const id = writing.topicId(task.source.id); const brief = id && writing.brief(id); if (!brief) continue;
      const same = (other: TeachingTask) => writing.topicId(other.source.id) === id;
      briefs.set(task.id, { ...brief, previous: tasks.slice(0, index).some(same) ? null : brief.previous, next: tasks.slice(index + 1).some(same) ? null : brief.next });
    }
    const shape: Shape = { topic: task => briefs.get(task.id), hash: task => { const brief = briefs.get(task.id); return sectionHash(task, brief && { coverage: brief.coverage, note: brief.note }); } };
    const write = writing ? promptKit(settings, level, true) : prompt;
    const results = new Map<string, AuthoredSection>();
    await this.update(slug, p => {
      const sections: Progress['sections'] = {};
      for (const task of tasks) {
        const hash = shape.hash(task); const reused = this.saved(slug, task, hash); const before = p.sections[task.id];
        if (reused) results.set(task.id, reused);
        sections[task.id] = reused
          ? { title: task.section.title, sourceHash: hash, state: 'done', attempts: before?.attempts ?? 0, ...(before?.durationMs !== undefined && { durationMs: before.durationMs }) }
          : { title: task.section.title, sourceHash: hash, state: 'waiting', attempts: 0 };
      }
      p.sections = sections; p.steps.summary = 'pending'; p.steps.publish = 'pending';
    });

    // Codex coordinates a bounded batch through native subagents. A single item and Claude keep the direct path.
    const todo = tasks.filter(task => !results.has(task.id));
    if(provider==='codex'&&settings.preparation.sectionsAtOnce>1&&todo.length>1) await this.sectionBatches(slug,todo,tasks,intent,active,run,write,settings,results,shape);
    else for(const task of todo)results.set(task.id,await this.section(slug,task,tasks,intent,active,run,write,settings,shape));
    signal.throwIfAborted();

    active.stage = 'Preparing the brief summary and synthesis';
    const outputs = tasks.map(task => ({ task, teaching: results.get(task.id)! }));
    const summaryContext = outputs.map(({ task, teaching }) => ({ sourceId: task.source.id, sourceTitle: task.source.title, section: task.section.title, introduction: teaching.introduction, ...(briefs.has(task.id) && { topic: briefs.get(task.id)!.title }) }));
    // A steered summary keeps one section per source (the lesson is compiled that way) but is told the learner's outline to follow.
    const summary = summarySchema.parse(await run('summary', 'summary', prompt('summary', { sections: summaryContext }) + (writing ? '\n' + prompt('steerSummary', { outline: writing.outline }) : ''), summarySchema));
    await this.update(slug, p => { p.steps.summary = 'done'; });
    const progress = this.read(slug)!;
    const lesson = compilePreparedBundle(bundle, outputs, summary.sections, 'lesson-' + progress.runId, { limits, speakers: { host: settings.lessons.hostName, expert: settings.lessons.expertName } });
    signal.throwIfAborted();
    active.stage = 'Publishing the lesson';
    // The previous version stays readable under runs/; the store then writes lesson.json, lesson.md and CREDITS.md atomically.
    const previousLesson = join(this.fs.dir(slug), 'lesson.json');
    if (!progress.archivedLesson && existsSync(previousLesson)) {
      const target = progress.previous && existsSync(join(dir, progress.previous)) ? progress.previous : this.archive(slug, stamp(), []);
      // Never replace an archived version: after a crash, lesson.json may already be this run's lesson.
      if (!existsSync(join(dir, target, 'lesson.json'))) copyFileSync(previousLesson, join(dir, target, 'lesson.json'));
      await this.update(slug, p => { p.archivedLesson = target; });
    }
    this.store.insert(lesson, { replace: true });
    await this.update(slug, p => { p.steps.publish = 'done'; p.status = 'completed'; delete p.previous; delete p.archivedLesson; delete p.error; });
  }

  /** One Codex parent call delegates each item in a batch, then a separate parent call delegates independent reviews. */
  private async sectionBatches(slug:string,todo:TeachingTask[],tasks:TeachingTask[],intent:string,active:Active,run:Run,prompt:ReturnType<typeof promptKit>,settings:Settings,results:Map<string,AuthoredSection>,shape:Shape) {
    type Pending={task:TeachingTask;index:number;started:number;draft:number;issues:string[];teaching?:AuthoredSection};
    const signal=active.controller.signal;
    const queue:Pending[]=todo.map(task=>({task,index:tasks.indexOf(task)+1,started:Date.now(),draft:0,issues:[]}));
    const mark=(item:Pending,patch:Partial<Progress['sections'][string]>,attempt=false)=>this.update(slug,p=>{
      const section=p.sections[item.task.id];if(!section)return;Object.assign(section,patch);if(attempt)section.attempts++;if(section.error===undefined)delete section.error;
    });
    type ReviewOutcome={error?:unknown};
    type InFlightReview={batchNumber:number;completed:boolean;outcome:Promise<ReviewOutcome>};
    let inFlightReview:InFlightReview|undefined;
    const finishReview=async()=>{
      if(!inFlightReview)return;
      const review=inFlightReview;inFlightReview=undefined;
      const outcome=await review.outcome;if(outcome.error)throw outcome.error;
    };
    const startReview=(batchNumber:number,batch:Pending[],reviewable:Pending[],inputs:unknown[],images:string[])=>{
      const record:InFlightReview={batchNumber,completed:false,outcome:Promise.resolve({})};
      record.outcome=(async()=>{
        try{
          active.stage=`Reviewing ${reviewable.length} section${reviewable.length===1?'':'s'} ${reviewable.length>1?'with '+reviewable.length+' Codex subagents':'in the Codex coordinator'} · ${reviewable.map(item=>item.task.section.title).join(' · ')}`;
          const reviewInputs=reviewable.map(item=>({taskId:item.task.id,source:inputs[batch.indexOf(item)],draft:item.teaching}));
          const reviewInstructions=`NARAD_MULTI_AGENT_REVIEW_COORDINATOR_V1\nYou are coordinating ${reviewable.length} independent curriculum reviews. ${reviewable.length>1?'Spawn exactly one reviewer subagent per task item immediately and run them in parallel.':'Complete the single review directly.'} Each reviewer must compare only its assigned source and draft using the shared review rules below. Wait for every reviewer, verify that every requested taskId appears exactly once, and return the combined structured result without softening or combining issues.\n`+prompt('review',{source:reviewInputs.map(item=>({taskId:item.taskId,source:item.source})),draft:reviewInputs.map(item=>({taskId:item.taskId,draft:item.draft}))});
          const reviewIds=reviewable.map(item=>item.task.id);
          const reviewed=reviewBatchSchema(reviewIds).parse(await run('review','batch-'+batchNumber,reviewInstructions,reviewBatchSchema(reviewIds),images,{multiAgent:reviewable.length>1,reasoningEffort:settings.preparation.codexReasoning}));
          const reviewById=new Map(reviewed.results.map(result=>[result.taskId,result]));
          for(const item of reviewable){
            const review=reviewById.get(item.task.id)!;const reviewIssues=reconcileReviewIssues(item.teaching!,review.issues);
            item.issues=reviewIssues.length?reviewIssues:review.issues.length?[]:review.approved?[]:['Content review did not approve this section.'];
            if(item.issues.length){await mark(item,{state:'waiting'});queue.push(item);continue}
            const saved:SavedSection={task:item.task.id,title:item.task.section.title,sourceHash:shape.hash(item.task),teaching:item.teaching!};
            this.fs.writeJson(slug,`preparation/sections/${item.task.id}.json`,saved);results.set(item.task.id,item.teaching!);
            await mark(item,{state:'done',durationMs:Date.now()-item.started,error:undefined});
          }
          return {};
        }catch(error){
          if(!signal.aborted)await Promise.all(reviewable.map(item=>mark(item,{state:'failed',durationMs:Date.now()-item.started,error:message(error)})));
          throw error;
        }
      })().then(outcome=>{record.completed=true;return outcome},error=>{record.completed=true;return {error}});
      inFlightReview=record;
    };
    let batchNumber=0;
    while(queue.length||inFlightReview){
      if(!queue.length){await finishReview();continue}
      signal.throwIfAborted();
      const batch=queue.splice(0,settings.preparation.sectionsAtOnce);batchNumber++;
      try{
        const images:string[]=[];const inputs:unknown[]=[];
        const folder=join(this.fs.dir(slug),'preparation','calls','images');await mkdir(folder,{recursive:true});
        for(const item of batch){
          const visualOrder:unknown[]=[];
          for(const asset of item.task.assets){
            if(asset.kind==='video'&&asset.src==='/assets/video-poster.svg'){
              visualOrder.push({id:asset.id,kind:asset.kind,caption:asset.caption,alt:asset.alt,note:'A video that streams from its source; explain what it shows from its title and caption.'});continue;
            }
            const media=asset.src!.match(/^\/api\/library\/([^/]+)\/media\/([^/]+)$/);const file=media&&this.store.mediaPath(media[1],media[2]);
            if(!file)throw new Error('Saved source visual is missing: '+asset.id);
            const path=join(folder,item.task.id+'-'+asset.id+'.png');await writeFile(path,await sharp(await readFile(file)).png().toBuffer());images.push(path);
            visualOrder.push({id:asset.id,kind:asset.kind,caption:asset.caption,alt:asset.alt,attachment:'attached image '+images.length,...(asset.kind==='video'&&{note:'A video that streams from its source; explain what it shows from its title, caption and poster image.'})});
          }
          const topic=shape.topic(item.task);
          const context={learningIntent:intent,...(topic&&{topic}),source:{id:item.task.source.id,title:item.task.source.title,url:item.task.source.url},section:{...item.task.section,units:item.task.section.units.filter(unit=>unit.kind!=='note')},visualOrder,allSectionTitles:tasks.filter(candidate=>candidate.source.id===item.task.source.id).map(candidate=>candidate.section.title)};
          inputs.push({taskId:item.task.id,sourceData:context,...(item.teaching&&{previousDraft:item.teaching,issues:item.issues})});
          item.draft++;await mark(item,{state:'writing',error:undefined},true);
        }
        const titles=batch.map(item=>item.task.section.title).join(' · ');const revising=batch.some(item=>item.issues.length);
        const writingStage=`${revising?'Revising':'Writing'} ${batch.length} section${batch.length===1?'':'s'} ${batch.length>1?'with '+batch.length+' Codex subagents':'in the Codex coordinator'} · draft ${Math.max(...batch.map(item=>item.draft))} · ${revising?progressIssue(batch.flatMap(item=>item.issues)):titles}`;
        active.stage=inFlightReview&&!inFlightReview.completed?`${writingStage} while reviewing batch ${inFlightReview.batchNumber}`:writingStage;
        const authorInstructions=`NARAD_MULTI_AGENT_COORDINATOR_V1\nYou are coordinating ${batch.length} independent section-writing task${batch.length===1?'':'s'}. ${batch.length>1?'Spawn exactly one subagent per task item immediately and run them in parallel.':'Complete the single task directly.'} Give each worker only its assigned task item plus the shared teaching rules below. Wait for every worker, verify that every requested taskId appears exactly once, and return the combined structured result. Do not merge sections or omit an item. For an item with previousDraft and issues, return a complete corrected replacement. Attached images are numbered in the task data; inspect them and preserve that association.\n`+
          prompt('section',{input:inputs})+(batch.some(item=>item.issues.length)?'\n'+prompt('revision',{issues:batch.map(item=>({taskId:item.task.id,issues:item.issues})),draft:batch.map(item=>({taskId:item.task.id,draft:item.teaching}))}):'');
        const authorIds=batch.map(item=>item.task.id);
        const authored=authorBatchSchema(authorIds).parse(await run('author','batch-'+batchNumber,authorInstructions,authorBatchSchema(authorIds),images,{multiAgent:batch.length>1,reasoningEffort:settings.preparation.codexReasoning}));
        const authoredById=new Map(authored.results.map(result=>[result.taskId,result.teaching]));
        const reviewable:Pending[]=[];
        for(const item of batch){
          const structured=authoredById.get(item.task.id)!;
          const authoredTeaching=authoredSectionSchema.parse({...structured,units:structured.units.map(unit=>({...unit,question:unit.question?.trim()||undefined}))});
          item.issues=checkTeaching(item.task,authoredTeaching);
          item.teaching=item.issues.length?authoredTeaching:normalizeTeaching(authoredTeaching);
          if(item.issues.length){await mark(item,{state:'waiting'});queue.push(item)}else{await mark(item,{state:'reviewing'});reviewable.push(item)}
        }
        if(reviewable.length){await finishReview();startReview(batchNumber,batch,reviewable,inputs,images)}
      }catch(error){
        if(inFlightReview){const review=inFlightReview;inFlightReview=undefined;await review.outcome;}
        if(!signal.aborted)await Promise.all(batch.map(item=>mark(item,{state:'failed',durationMs:Date.now()-item.started,error:message(error)})));
        throw error;
      }
    }
    await finishReview();
  }

  private async section(slug: string, task: TeachingTask, tasks: TeachingTask[], intent: string, active: Active, run: Run, prompt: ReturnType<typeof promptKit>, settings: Settings, shape: Shape): Promise<AuthoredSection> {
    const started = Date.now(); const index = tasks.indexOf(task) + 1;
    const mark = (patch: Partial<Progress['sections'][string]>, attempt = false) => this.update(slug, p => {
      const section = p.sections[task.id]; if (!section) return;
      Object.assign(section, patch); if (attempt) section.attempts++;
      if (section.error === undefined) delete section.error;
    });
    try {
      active.stage = `Writing ${index}/${tasks.length} · ${task.source.title} · ${task.section.title}`;
      const images: string[] = [];
      for (const asset of task.assets) {
        // A video without a captured poster has no image to show the agent; its title and caption still go in the context.
        if (asset.kind === 'video' && asset.src === '/assets/video-poster.svg') continue;
        const media = asset.src!.match(/^\/api\/library\/([^/]+)\/media\/([^/]+)$/); const file = media && this.store.mediaPath(media[1], media[2]);
        if (!file) throw new Error('Saved source visual is missing: ' + asset.id);
        // Kept inside the agent's job directory (calls/), which the isolated agent service requires of every image.
        const folder = join(this.fs.dir(slug), 'preparation', 'calls', 'images'); await mkdir(folder, { recursive: true });
        const path = join(folder, task.id + '-' + asset.id + '.png'); await writeFile(path, await sharp(await readFile(file)).png().toBuffer()); images.push(path);
      }
      const topic = shape.topic(task);
      const context = { learningIntent: intent, ...(topic && { topic }), source: { id: task.source.id, title: task.source.title, url: task.source.url }, section: { ...task.section, units: task.section.units.filter(u => u.kind !== 'note') }, visualOrder: task.assets.map(a => ({ id: a.id, kind: a.kind, caption: a.caption, alt: a.alt, ...(a.kind === 'video' && { note: 'A video that streams from its source; explain what it shows from its title, caption' + (a.src === '/assets/video-poster.svg' ? '.' : ' and poster image.') }) })), allSectionTitles: tasks.filter(t => t.source.id === task.source.id).map(t => t.section.title) };
      const instruction = prompt('section', { input: context });
      let teaching: AuthoredSection | undefined; let issues: string[] = [];
      // No round ceiling: revise until deterministic checks and review approve; the stage names the draft and current issue so the user can stop.
      for (let round = 0; ; round++) {
        const draft = round + 1;
        active.stage = issues.length ? `Revising ${index}/${tasks.length} · draft ${draft} · ${progressIssue(issues)}` : `Writing ${index}/${tasks.length} · draft ${draft} · ${task.section.title}`;
        await mark({ state: 'writing', error: undefined }, true);
        const structured = agentSectionSchema.parse(await run('author', task.id, instruction + (issues.length ? '\n' + prompt('revision', { issues, draft: teaching }) : ''), agentSectionSchema, images));
        const authoredTeaching = authoredSectionSchema.parse({ ...structured, units: structured.units.map(u => ({ ...u, question: u.question?.trim() || undefined })) });
        issues = checkTeaching(task, authoredTeaching);
        teaching = issues.length ? authoredTeaching : normalizeTeaching(authoredTeaching);
        if (issues.length) continue;
        await mark({ state: 'reviewing' });
        active.stage = `Reviewing ${index}/${tasks.length} · draft ${draft} · ${task.section.title}`;
        const review = reviewSchema.parse(await run('review', task.id, prompt('review', { source: context, draft: teaching }), reviewSchema, images));
        // Deterministic checks are authoritative for structure and visual dialogue counts: drop review claims the parsed draft disproves.
        const reviewIssues = reconcileReviewIssues(teaching, review.issues);
        issues = reviewIssues.length ? reviewIssues : review.issues.length ? [] : review.approved ? [] : ['Content review did not approve this section.'];
        if (!issues.length) break;
      }
      if (!teaching) throw new Error('Section ' + task.section.title + ' did not produce a draft.');
      const saved: SavedSection = { task: task.id, title: task.section.title, sourceHash: shape.hash(task), teaching };
      this.fs.writeJson(slug, `preparation/sections/${task.id}.json`, saved);
      await mark({ state: 'done', durationMs: Date.now() - started, error: undefined });
      return teaching;
    } catch (error) {
      if (!active.controller.signal.aborted) await mark({ state: 'failed', durationMs: Date.now() - started, error: message(error) });
      throw error;
    }
  }
}
