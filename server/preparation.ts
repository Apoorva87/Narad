import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { addUsage, type AgentUsage, type Provider, type PrepareAction, type PreparationJob, type PreparationState } from '../shared/preparation';
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
import { agentSectionSchema, authorBatchSchema, buildTeachingPlan, checkTeaching, compilePreparedBundle, normalizeTeaching, reconcileReviewIssues, researchSchema, reviewBatchSchema, reviewSchema, sectionHash, summarySchema, type TeachingTask } from './generation-content';

type SectionState = 'waiting' | 'writing' | 'reviewing' | 'done' | 'failed';
type RunStatus = 'running' | 'interrupted' | 'stopped' | 'failed' | 'completed';
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
  queuedAt?: string; request?: { familiarity?: Familiarity; action: PrepareAction };
  /**
   * The status before the item was queued (`none`: never prepared, so this file is only a placeholder). Kept until a run
   * actually starts, so a queued "new version" of a published lesson still archives that lesson when it runs.
   */
  beforeQueue?: RunStatus | 'none';
};
type SavedSection = { task: string; title: string; sourceHash: string; teaching: AuthoredSection };
type Session = PreparationState['sessions'][number];
/** One running lesson. Everything a run owns — its abort controller, stage text, live agent sessions — lives here, so runs never share state. */
type Active = { slug: string; title: string; provider: Provider; stage: string; stopping: boolean; startedAt: string; controller: AbortController; done: Promise<void>; sessions: Session[] };
type Queued = { slug: string; provider: Provider; familiarity?: Familiarity; action: PrepareAction; queuedAt?: string; seq?: number };
type Run = (step: CallInput['step'], task: string, text: string, schema: CallInput['schema'], images?: string[], options?:Pick<CallInput,'multiAgent'|'reasoningEffort'>) => Promise<unknown>;

const PROGRESS = 'preparation/progress.json';
const INTERRUPTED = 'Preparation was interrupted when the server stopped. Finished sections are saved; press Continue to resume.';
const QUEUE_INTERRUPTED = 'Not started — the server restarted while it was queued';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 3000);
const stageFor: Record<PreparationJob['status'], string> = {
  queued: 'Queued', running: 'Preparing', stopping: 'Stopping agent…', completed: 'Lesson ready · all three modes saved', failed: 'Preparation needs attention',
  stopped: 'Stopped · finished sections kept', cancelled: 'Stopped', interrupted: 'Interrupted when the server stopped · finished sections kept',
};
const levelKey: Record<Familiarity, 'levelFoundational' | 'levelSomeBackground' | 'levelAdvanced'> = { foundational: 'levelFoundational', 'some-background': 'levelSomeBackground', advanced: 'levelAdvanced' };
/** Fills the shared slots once per job; each step adds its own data slots. */
function promptKit(settings: Settings, level: Familiarity) {
  const p = settings.prompts;
  const principles = renderPrompt(p.principles, { level, levelGuidance: p[levelKey[level]] });
  const shared = { principles, walkthroughGuidance: p.walkthroughGuidance, dialogueGuidance: p.dialogueGuidance, visualGuidance: p.visualGuidance, maxLinks: String(settings.research.maxLinks) };
  // Every data slot is learner- or source-controlled: each is encoded as one untrusted JSON value so it cannot open a new prompt boundary.
  return (key: 'research' | 'section' | 'revision' | 'review' | 'summary', values: Record<string, unknown>) =>
    renderPrompt(p[key], { ...shared, ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, untrustedData(name, value)])) });
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
  start(bundleId: string, provider: Provider, familiarity?: Familiarity, action: PrepareAction = 'continue'): PreparationJob {
    if (this.closing) throw new StoreError('The server is shutting down.', 503);
    const slug = this.store.resolveId(bundleId) ?? bundleId;
    if (this.active.has(slug) || this.queued(slug) >= 0) return this.job(slug, this.read(slug));
    if (!this.runner.available().some(p => p.id === provider && p.available)) throw new StoreError('This agent is not available. Install it and sign in from a terminal, then restart Narad if PATH changed.', 400);
    const found = this.store.getBundle(slug); if (!found) throw new StoreError('Source collection not found.', 404);
    buildTeachingPlan(found);
    // Waiting items go first: fill any free slot from the queue, then start this one only if a slot is still free and nobody waits.
    this.pump();
    if (this.active.size < this.limit() && !this.queue.length) return this.launch({ slug: found.id, provider, familiarity, action });
    return this.enqueue({ slug: found.id, provider, familiarity, action }, found.familiarity ?? 'foundational');
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
    this.queue.splice(index, 1);
    await this.update(slug, p => {
      if (p.status !== 'queued') return;
      const before = p.beforeQueue;
      p.status = before === 'completed' ? 'completed' : 'stopped';
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
    if (!await this.dequeue(slug)) return action(); // started or removed while waiting for the lock
    const out = { cancelled: false }; this.out.set(slug, out);
    try { return await action(); }
    catch (error) {
      if (!this.closing && !out.cancelled && this.queued(slug) < 0 && !this.active.has(slug)) {
        // Back where it was by original order, not by its old index: items ahead of it may have started or left meanwhile.
        const later = this.queue.findIndex(other => this.after(other, entry));
        this.queue.splice(later < 0 ? this.queue.length : later, 0, entry);
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
        if (!this.runner.available().some(p => p.id === next.provider && p.available)) throw new StoreError('This agent is not available. Install it and sign in from a terminal, then restart Narad if PATH changed.', 400);
        this.launch(next);
      } catch (error) {
        this.update(next.slug, p => { if (p.status === 'queued') { p.status = 'failed'; p.error = message(error); delete p.queuedAt; delete p.request; } })
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
      p.status = 'queued'; p.provider = entry.provider; p.queuedAt = now; p.request = { ...(entry.familiarity && { familiarity: entry.familiarity }), action: entry.action };
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
  private launch({ slug, provider, familiarity, action }: Queued): PreparationJob {
    const found = this.store.getBundle(slug)!;
    const bundle = familiarity && familiarity !== found.familiarity ? this.store.saveBundle({ ...found, familiarity }, []) : found;
    buildTeachingPlan(bundle);
    const settings = this.store.getSettings(); // anything that can throw runs before the slot is taken
    const active: Active = { slug: bundle.id, title: bundle.title, provider, stage: 'Starting preparation', stopping: false, startedAt: new Date().toISOString(), controller: new AbortController(), done: Promise.resolve(), sessions: [] };
    this.active.set(active.slug, active);
    active.done = this.prepare(active, action, settings)
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
    return {
      id: slug, bundleId: slug, slug, title, provider: active?.provider ?? queuedEntry?.provider ?? progress?.provider ?? 'codex', status, stage,
      completed: sections.filter(s => s.state === 'done').length, total: sections.length,
      createdAt: progress?.startedAt ?? active?.startedAt ?? now, updatedAt: progress?.updatedAt ?? now, sections, folder: this.fs.dir(slug),
      ...(position && { queuePosition: position, queueLength: this.queue.length }),
      ...(status === 'completed' && { lessonId: slug }), ...(progress?.usage && { usage: progress.usage }), ...(error && { error }),
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

  private async prepare(active: Active, action: PrepareAction, settings: Settings) {
    const { slug, provider } = active; const signal = active.controller.signal;
    let bundle = this.store.getBundle(slug)!;
    const level = bundle.familiarity ?? 'foundational';
    await this.fs.withLock(slug, async () => {
      const read = this.read(slug);
      // A placeholder written while the item was queued holds no run of its own.
      const prior = read?.beforeQueue === 'none' ? undefined : read;
      const priorStatus = prior?.beforeQueue ?? prior?.status;
      let keep: Progress | undefined, previous: string | undefined;
      // A published run is kept whole, with the settings its lesson used; a run for another level, or Start over, is set aside.
      if (priorStatus === 'completed') previous = this.archive(slug, prior!.runId, ['sections', 'calls', 'progress.json', 'settings.json']);
      else if (prior && (action === 'restart' || prior.level !== level)) this.archive(slug, stamp() + '-abandoned', ['sections', 'calls', 'progress.json']);
      else keep = prior;
      const now = new Date().toISOString();
      const progress: Progress = keep
        ? { ...keep, status: 'running', provider, level, updatedAt: now }
        : { runId: stamp(), status: 'running', provider, level, startedAt: now, updatedAt: now, steps: { research: 'pending', summary: 'pending', publish: 'pending' }, sections: {}, calls: [], ...(previous && { previous }) };
      delete progress.error; delete progress.queuedAt; delete progress.request; delete progress.beforeQueue;
      this.fs.writeJson(slug, PROGRESS, progress);
      // The settings this attempt uses, kept beside its sections so a lesson's instructions stay inspectable.
      this.fs.writeJson(slug, 'preparation/settings.json', settings);
    });
    const dir = join(this.fs.dir(slug), 'preparation');
    const calls = new CallRunner(dir, this.runner, call => this.update(slug, p => { p.calls.push(call); p.usage = addUsage(p.usage, call.usage); if (!p.usage) delete p.usage; p.calls.sort((a, b) => a.n - b.n); }));
    const prompt = promptKit(settings, level);
    const limits = { chunkChars: settings.preparation.chunkChars, chunkUnits: settings.preparation.chunkUnits };
    const run: Run = (step, task, text, schema, images = [], options = {}) => {
      let session: Session | undefined;
      return calls.run({ step, task, prompt: secureAgentPrompt(text, provider, images), schema, images, provider, model: (provider === 'codex' ? settings.preparation.codexModel : settings.preparation.claudeModel) || undefined, timeoutMs: settings.preparation.timeoutMinutes * 60_000, ...(provider==='codex'&&{reasoningEffort:settings.preparation.codexReasoning}), ...options }, signal, pid => {
        if (session) active.sessions = active.sessions.filter(s => s !== session);
        session = pid ? { jobId: slug, slug, provider, pid, startedAt: new Date().toISOString() } : undefined;
        if (session) active.sessions = [...active.sessions, session];
      });
    };

    if (bundle.sources.every(s => s.kind === 'note')) {
      active.stage = 'Finding sources for your topic';
      const linkSchema = researchSchema.extend({ links: researchSchema.shape.links.max(settings.research.maxLinks) });
      const research = linkSchema.parse(await run('research', 'research', prompt('research', { request: bundle.text }), linkSchema));
      const captured = await prepareSources({ title: bundle.title, text: research.links.join('\n') }, this.download, settings.capture); signal.throwIfAborted();
      // Saving moves captured images into the folder; continue with the served paths it returns.
      bundle = this.store.saveBundle({ ...bundle, sources: [...bundle.sources, ...captured.bundle.sources.filter(s => s.kind === 'article')], status: captured.bundle.status }, captured.blobs);
      await this.update(slug, p => { p.steps.research = 'done'; });
    } else await this.update(slug, p => { if (p.steps.research === 'pending') p.steps.research = 'skipped'; });

    // Rebuild the plan from the current sources and keep every saved section whose source is unchanged.
    const tasks = buildTeachingPlan(bundle, limits);
    const results = new Map<string, AuthoredSection>();
    await this.update(slug, p => {
      const sections: Progress['sections'] = {};
      for (const task of tasks) {
        const hash = sectionHash(task); const reused = this.saved(slug, task, hash); const before = p.sections[task.id];
        if (reused) results.set(task.id, reused);
        sections[task.id] = reused
          ? { title: task.section.title, sourceHash: hash, state: 'done', attempts: before?.attempts ?? 0, ...(before?.durationMs !== undefined && { durationMs: before.durationMs }) }
          : { title: task.section.title, sourceHash: hash, state: 'waiting', attempts: 0 };
      }
      p.sections = sections; p.steps.summary = 'pending'; p.steps.publish = 'pending';
    });

    // Codex coordinates a bounded batch through native subagents. A single item and Claude keep the direct path.
    const todo = tasks.filter(task => !results.has(task.id));
    if(provider==='codex'&&settings.preparation.sectionsAtOnce>1&&todo.length>1) await this.sectionBatches(slug,todo,tasks,bundle.text,active,run,prompt,settings,results);
    else for(const task of todo)results.set(task.id,await this.section(slug,task,tasks,bundle.text,active,run,prompt,settings));
    signal.throwIfAborted();

    active.stage = 'Preparing the brief summary and synthesis';
    const outputs = tasks.map(task => ({ task, teaching: results.get(task.id)! }));
    const summaryContext = outputs.map(({ task, teaching }) => ({ sourceId: task.source.id, sourceTitle: task.source.title, section: task.section.title, introduction: teaching.introduction }));
    const summary = summarySchema.parse(await run('summary', 'summary', prompt('summary', { sections: summaryContext }), summarySchema));
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
  private async sectionBatches(slug:string,todo:TeachingTask[],tasks:TeachingTask[],intent:string,active:Active,run:Run,prompt:ReturnType<typeof promptKit>,settings:Settings,results:Map<string,AuthoredSection>) {
    type Pending={task:TeachingTask;index:number;started:number;draft:number;issues:string[];teaching?:AuthoredSection};
    const signal=active.controller.signal;
    const queue:Pending[]=todo.map(task=>({task,index:tasks.indexOf(task)+1,started:Date.now(),draft:0,issues:[]}));
    const mark=(item:Pending,patch:Partial<Progress['sections'][string]>,attempt=false)=>this.update(slug,p=>{
      const section=p.sections[item.task.id];if(!section)return;Object.assign(section,patch);if(attempt)section.attempts++;if(section.error===undefined)delete section.error;
    });
    let batchNumber=0;
    while(queue.length){
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
          const context={learningIntent:intent,source:{id:item.task.source.id,title:item.task.source.title,url:item.task.source.url},section:{...item.task.section,units:item.task.section.units.filter(unit=>unit.kind!=='note')},visualOrder,allSectionTitles:tasks.filter(candidate=>candidate.source.id===item.task.source.id).map(candidate=>candidate.section.title)};
          inputs.push({taskId:item.task.id,sourceData:context,...(item.teaching&&{previousDraft:item.teaching,issues:item.issues})});
          item.draft++;await mark(item,{state:'writing',error:undefined},true);
        }
        const titles=batch.map(item=>item.task.section.title).join(' · ');const revising=batch.some(item=>item.issues.length);
        active.stage=`${revising?'Revising':'Writing'} ${batch.length} section${batch.length===1?'':'s'} ${batch.length>1?'with '+batch.length+' Codex subagents':'in the Codex coordinator'} · draft ${Math.max(...batch.map(item=>item.draft))} · ${revising?progressIssue(batch.flatMap(item=>item.issues)):titles}`;
        const authorInstructions=`NARAD_MULTI_AGENT_COORDINATOR_V1\nYou are coordinating ${batch.length} independent section-writing task${batch.length===1?'':'s'}. ${batch.length>1?'Spawn exactly one subagent per task item immediately and run them in parallel.':'Complete the single task directly.'} Give each worker only its assigned task item plus the shared teaching rules below. Wait for every worker, verify that every requested taskId appears exactly once, and return the combined structured result. Do not merge sections or omit an item. For an item with previousDraft and issues, return a complete corrected replacement. Attached images are numbered in the task data; inspect them and preserve that association.\n`+
          prompt('section',{input:inputs})+(batch.some(item=>item.issues.length)?'\n'+prompt('revision',{issues:batch.map(item=>({taskId:item.task.id,issues:item.issues})),draft:batch.map(item=>({taskId:item.task.id,draft:item.teaching}))}):'');
        const authorIds=batch.map(item=>item.task.id);
        const authored=authorBatchSchema(authorIds).parse(await run('author','batch-'+batchNumber,authorInstructions,authorBatchSchema(authorIds),images,{multiAgent:batch.length>1,reasoningEffort:settings.preparation.codexReasoning}));
        const authoredById=new Map(authored.results.map(result=>[result.taskId,result.teaching]));
        const reviewable:Pending[]=[];
        for(const item of batch){
          const structured=authoredById.get(item.task.id)!;
          item.teaching=normalizeTeaching(authoredSectionSchema.parse({...structured,units:structured.units.map(unit=>({...unit,question:unit.question??undefined}))}));
          item.issues=checkTeaching(item.task,item.teaching);
          if(item.issues.length){await mark(item,{state:'waiting'});queue.push(item)}else{await mark(item,{state:'reviewing'});reviewable.push(item)}
        }
        if(!reviewable.length)continue;
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
          const saved:SavedSection={task:item.task.id,title:item.task.section.title,sourceHash:sectionHash(item.task),teaching:item.teaching!};
          this.fs.writeJson(slug,`preparation/sections/${item.task.id}.json`,saved);results.set(item.task.id,item.teaching!);
          await mark(item,{state:'done',durationMs:Date.now()-item.started,error:undefined});
        }
      }catch(error){
        if(!signal.aborted)await Promise.all(batch.map(item=>mark(item,{state:'failed',durationMs:Date.now()-item.started,error:message(error)})));
        throw error;
      }
    }
  }

  private async section(slug: string, task: TeachingTask, tasks: TeachingTask[], intent: string, active: Active, run: Run, prompt: ReturnType<typeof promptKit>, settings: Settings): Promise<AuthoredSection> {
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
      const context = { learningIntent: intent, source: { id: task.source.id, title: task.source.title, url: task.source.url }, section: { ...task.section, units: task.section.units.filter(u => u.kind !== 'note') }, visualOrder: task.assets.map(a => ({ id: a.id, kind: a.kind, caption: a.caption, alt: a.alt, ...(a.kind === 'video' && { note: 'A video that streams from its source; explain what it shows from its title, caption' + (a.src === '/assets/video-poster.svg' ? '.' : ' and poster image.') }) })), allSectionTitles: tasks.filter(t => t.source.id === task.source.id).map(t => t.section.title) };
      const instruction = prompt('section', { input: context });
      let teaching: AuthoredSection | undefined; let issues: string[] = [];
      // No round ceiling: revise until deterministic checks and review approve; the stage names the draft and current issue so the user can stop.
      for (let round = 0; ; round++) {
        const draft = round + 1;
        active.stage = issues.length ? `Revising ${index}/${tasks.length} · draft ${draft} · ${progressIssue(issues)}` : `Writing ${index}/${tasks.length} · draft ${draft} · ${task.section.title}`;
        await mark({ state: 'writing', error: undefined }, true);
        const structured = agentSectionSchema.parse(await run('author', task.id, instruction + (issues.length ? '\n' + prompt('revision', { issues, draft: teaching }) : ''), agentSectionSchema, images));
        teaching = normalizeTeaching(authoredSectionSchema.parse({ ...structured, units: structured.units.map(u => ({ ...u, question: u.question ?? undefined })) }));
        issues = checkTeaching(task, teaching); if (issues.length) continue;
        await mark({ state: 'reviewing' });
        active.stage = `Reviewing ${index}/${tasks.length} · draft ${draft} · ${task.section.title}`;
        const review = reviewSchema.parse(await run('review', task.id, prompt('review', { source: context, draft: teaching }), reviewSchema, images));
        // Deterministic checks are authoritative for structure and visual dialogue counts: drop review claims the parsed draft disproves.
        const reviewIssues = reconcileReviewIssues(teaching, review.issues);
        issues = reviewIssues.length ? reviewIssues : review.issues.length ? [] : review.approved ? [] : ['Content review did not approve this section.'];
        if (!issues.length) break;
      }
      if (!teaching) throw new Error('Section ' + task.section.title + ' did not produce a draft.');
      const saved: SavedSection = { task: task.id, title: task.section.title, sourceHash: sectionHash(task), teaching };
      this.fs.writeJson(slug, `preparation/sections/${task.id}.json`, saved);
      await mark({ state: 'done', durationMs: Date.now() - started, error: undefined });
      return teaching;
    } catch (error) {
      if (!active.controller.signal.aborted) await mark({ state: 'failed', durationMs: Date.now() - started, error: message(error) });
      throw error;
    }
  }
}
