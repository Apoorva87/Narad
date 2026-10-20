import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { type Provider, type PrepareAction, type PreparationJob, type PreparationState } from '../shared/preparation';
import type { Familiarity } from '../shared/lesson';
import { renderPrompt, type Settings } from '../shared/settings';
import { LessonStore, StoreError } from './store';
import type { LibraryFs } from './library';
import { cliRunner, type AgentRunner } from './agent-runner';
import type { Download } from './capture';
import { prepareSources } from './intake';
import { authoredSectionSchema, type AuthoredSection } from './lesson-preparation';
import { CallRunner, type CallInput, type CallRecord } from './runner';
import { agentSectionSchema, buildTeachingPlan, checkTeaching, compilePreparedBundle, researchSchema, reviewSchema, sectionHash, summarySchema, type TeachingTask } from './generation-content';

type SectionState = 'waiting' | 'writing' | 'reviewing' | 'done' | 'failed';
/** `preparation/progress.json`: one item's run state, per-section state and per-call records. */
export type Progress = {
  runId: string; status: 'running' | 'interrupted' | 'stopped' | 'failed' | 'completed'; provider: Provider; level: Familiarity;
  startedAt: string; updatedAt: string;
  steps: { research: 'pending' | 'done' | 'skipped'; summary: 'pending' | 'done'; publish: 'pending' | 'done' };
  sections: Record<string, { title: string; sourceHash: string; state: SectionState; attempts: number; durationMs?: number; error?: string }>;
  calls: CallRecord[]; error?: string;
  /** Where the previously published run was archived (`runs/<runId>`), so publishing puts the old lesson.json beside its settings. */
  previous?: string;
  /** Set (in a locked update) once the previous lesson.json is archived, before the new one is written, so a retried publish never archives twice. */
  archivedLesson?: string;
};
type SavedSection = { task: string; title: string; sourceHash: string; teaching: AuthoredSection };
type Active = { slug: string; title: string; provider: Provider; stage: string; stopping: boolean; startedAt: string; controller: AbortController; done: Promise<void> };
type Run = (step: CallInput['step'], task: string, text: string, schema: CallInput['schema'], images?: string[]) => Promise<unknown>;

const PROGRESS = 'preparation/progress.json';
const INTERRUPTED = 'Preparation was interrupted when the server stopped. Finished sections are saved; press Continue to resume.';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 3000);
const stageFor: Record<PreparationJob['status'], string> = {
  running: 'Preparing', stopping: 'Stopping agent…', completed: 'Lesson ready · all three modes saved', failed: 'Preparation needs attention',
  stopped: 'Stopped · finished sections kept', cancelled: 'Stopped', interrupted: 'Interrupted when the server stopped · finished sections kept',
};
const levelKey: Record<Familiarity, 'levelFoundational' | 'levelSomeBackground' | 'levelAdvanced'> = { foundational: 'levelFoundational', 'some-background': 'levelSomeBackground', advanced: 'levelAdvanced' };
/** Fills the shared slots once per job; each step adds its own data slots. */
function promptKit(settings: Settings, level: Familiarity) {
  const p = settings.prompts;
  const principles = renderPrompt(p.principles, { level, levelGuidance: p[levelKey[level]] });
  const shared = { principles, walkthroughGuidance: p.walkthroughGuidance, dialogueGuidance: p.dialogueGuidance, visualGuidance: p.visualGuidance, maxLinks: String(settings.research.maxLinks) };
  return (key: 'research' | 'section' | 'revision' | 'review' | 'summary', values: Record<string, string>) => renderPrompt(p[key], { ...shared, ...values });
}

/**
 * Prepares one library item at a time. Progress lives in the item's `preparation/` folder: each finished section is saved
 * as its own file, so a stopped, failed or interrupted run continues where it left off when the user asks. Nothing resumes on its own.
 */
export class PreparationService {
  private active?: Active;
  private sessions: PreparationState['sessions'] = [];
  private closing = false;
  private fs: LibraryFs;
  /** Settles once startup has marked runs left `running` as interrupted. */
  readonly ready: Promise<void>;
  constructor(private store: LessonStore, private dataDir: string, private runner: AgentRunner = cliRunner, private download?: Download) {
    this.fs = store.library;
    const marking = this.fs.slugs().filter(slug => this.read(slug)?.status === 'running')
      .map(slug => this.update(slug, p => { if (p.status === 'running') { p.status = 'interrupted'; p.error = INTERRUPTED; this.settle(p); } }));
    this.ready = Promise.all(marking).then(() => undefined, error => console.error('Could not mark interrupted preparations:', error));
  }
  state(): PreparationState { return { jobs: this.jobs(), sessions: [...this.sessions], providers: this.runner.available() }; }
  start(bundleId: string, provider: Provider, familiarity?: Familiarity, action: PrepareAction = 'continue'): PreparationJob {
    if (this.closing) throw new StoreError('The server is shutting down.', 503);
    if (this.active) throw new StoreError('A preparation is already running. Stop it or wait for it to finish.', 409);
    if (!this.runner.available().some(p => p.id === provider && p.available)) throw new StoreError('This agent is not available. Install it and sign in from a terminal, then restart Narad if PATH changed.', 400);
    const found = this.store.getBundle(bundleId); if (!found) throw new StoreError('Source collection not found.', 404);
    const bundle = familiarity && familiarity !== found.familiarity ? this.store.saveBundle({ ...found, familiarity }, []) : found;
    buildTeachingPlan(bundle);
    const active: Active = { slug: bundle.id, title: bundle.title, provider, stage: 'Starting preparation', stopping: false, startedAt: new Date().toISOString(), controller: new AbortController(), done: Promise.resolve() };
    this.active = active;
    active.done = this.prepare(active, action, this.store.getSettings())
      .catch(error => this.finishFailed(active, error))
      .catch(error => console.error('Could not record the preparation outcome:', error))
      .finally(() => { this.sessions = []; if (this.active === active) this.active = undefined; });
    return this.job(active.slug, this.read(active.slug));
  }
  stop(id: string): PreparationJob {
    const slug = this.store.resolveId(id) ?? id;
    if (this.active?.slug === slug) {
      this.active.stopping = true; this.active.stage = 'Stopping agent…'; this.active.controller.abort();
      return this.job(slug, this.read(slug));
    }
    const existing = this.jobs().find(job => job.id === slug);
    if (existing) return existing;
    throw new StoreError('Preparation not found.', 404);
  }
  /** True while this collection is being prepared, matching old IDs and renamed slugs alike. */
  busy(bundleId: string) { const active = this.active?.slug; if (!active) return false; return active === bundleId || this.store.resolveId(bundleId) === active; }
  /** Deletes drafts that older versions of Narad kept outside the library folders. */
  async forget(jobs: { id: string }[]) { await Promise.all(jobs.map(job => rm(join(this.dataDir, 'preparations', job.id), { recursive: true, force: true }))); }
  async shutdown() { this.closing = true; if (this.active) { this.active.controller.abort(); await this.active.done; } await this.ready; }

  /** Runs found across item folders, newest first; a `running` file with no live run is reported as interrupted. */
  private jobs(): PreparationJob[] {
    const jobs = this.fs.slugs().flatMap(slug => { const progress = this.read(slug); return progress ? [this.job(slug, progress)] : []; });
    if (this.active && !jobs.some(job => job.slug === this.active!.slug)) jobs.push(this.job(this.active.slug, undefined));
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50);
  }
  private job(slug: string, progress: Progress | undefined): PreparationJob {
    const active = this.active?.slug === slug ? this.active : undefined;
    const status: PreparationJob['status'] = active ? (active.stopping ? 'stopping' : 'running') : progress?.status === 'running' ? 'interrupted' : progress?.status ?? 'running';
    const sections = Object.entries(progress?.sections ?? {}).map(([task, s]) => ({ task, title: s.title, state: s.state, ...(s.durationMs !== undefined && { durationMs: s.durationMs }), ...(s.error && { error: s.error }) }));
    const title = active?.title ?? this.fs.readJson<{ title?: string }>(slug, 'item.json').value?.title ?? slug;
    const error = active ? undefined : status === 'interrupted' ? progress?.error ?? INTERRUPTED : progress?.error;
    const now = new Date().toISOString();
    return {
      id: slug, bundleId: slug, slug, title, provider: active?.provider ?? progress?.provider ?? 'codex', status, stage: active?.stage ?? stageFor[status],
      completed: sections.filter(s => s.state === 'done').length, total: sections.length,
      createdAt: progress?.startedAt ?? active?.startedAt ?? now, updatedAt: progress?.updatedAt ?? now, sections, folder: this.fs.dir(slug),
      ...(status === 'completed' && { lessonId: slug }), ...(error && { error }),
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
    const status: Progress['status'] = !aborted ? 'failed' : active.stopping ? 'stopped' : 'interrupted';
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
    const teaching = authoredSectionSchema.safeParse(saved.teaching);
    return teaching.success && !checkTeaching(task, teaching.data).length ? teaching.data : undefined;
  }

  private async prepare(active: Active, action: PrepareAction, settings: Settings) {
    const { slug, provider } = active; const signal = active.controller.signal;
    let bundle = this.store.getBundle(slug)!;
    const level = bundle.familiarity ?? 'foundational';
    await this.fs.withLock(slug, async () => {
      const prior = this.read(slug);
      let keep: Progress | undefined, previous: string | undefined;
      // A published run is kept whole, with the settings its lesson used; a run for another level, or Start over, is set aside.
      if (prior?.status === 'completed') previous = this.archive(slug, prior.runId, ['sections', 'calls', 'progress.json', 'settings.json']);
      else if (prior && (action === 'restart' || prior.level !== level)) this.archive(slug, stamp() + '-abandoned', ['sections', 'calls', 'progress.json']);
      else keep = prior;
      const now = new Date().toISOString();
      const progress: Progress = keep
        ? { ...keep, status: 'running', provider, level, updatedAt: now }
        : { runId: stamp(), status: 'running', provider, level, startedAt: now, updatedAt: now, steps: { research: 'pending', summary: 'pending', publish: 'pending' }, sections: {}, calls: [], ...(previous && { previous }) };
      delete progress.error;
      this.fs.writeJson(slug, PROGRESS, progress);
      // The settings this attempt uses, kept beside its sections so a lesson's instructions stay inspectable.
      this.fs.writeJson(slug, 'preparation/settings.json', settings);
    });
    const dir = join(this.fs.dir(slug), 'preparation');
    const calls = new CallRunner(dir, this.runner, call => this.update(slug, p => { p.calls.push(call); p.calls.sort((a, b) => a.n - b.n); }));
    const prompt = promptKit(settings, level);
    const limits = { chunkChars: settings.preparation.chunkChars, chunkUnits: settings.preparation.chunkUnits };
    const run: Run = (step, task, text, schema, images = []) => {
      let session: PreparationState['sessions'][number] | undefined;
      return calls.run({ step, task, prompt: text, schema, images, provider, model: (provider === 'codex' ? settings.preparation.codexModel : settings.preparation.claudeModel) || undefined, timeoutMs: settings.preparation.timeoutMinutes * 60_000 }, signal, pid => {
        if (session) this.sessions = this.sessions.filter(s => s !== session);
        session = pid ? { jobId: slug, provider, pid, startedAt: new Date().toISOString() } : undefined;
        if (session) this.sessions = [...this.sessions, session];
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

    // Up to `sectionsAtOnce` sections in flight. After a failure no new section starts; those in flight finish first.
    const todo = tasks.filter(task => !results.has(task.id));
    let failure: unknown; let next = 0;
    const worker = async () => {
      while (failure === undefined && !signal.aborted && next < todo.length) {
        const task = todo[next++];
        try { results.set(task.id, await this.section(slug, task, tasks, bundle.text, active, run, prompt, settings)); }
        catch (error) { failure ??= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(settings.preparation.sectionsAtOnce, todo.length) }, worker));
    if (failure !== undefined) throw failure;
    signal.throwIfAborted();

    active.stage = 'Preparing the brief summary and synthesis';
    const outputs = tasks.map(task => ({ task, teaching: results.get(task.id)! }));
    const summaryContext = outputs.map(({ task, teaching }) => ({ sourceId: task.source.id, sourceTitle: task.source.title, section: task.section.title, introduction: teaching.introduction }));
    const summary = summarySchema.parse(await run('summary', 'summary', prompt('summary', { sections: JSON.stringify(summaryContext) }), summarySchema));
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
        const folder = join(this.fs.dir(slug), 'preparation', 'images'); await mkdir(folder, { recursive: true });
        const path = join(folder, task.id + '-' + asset.id + '.png'); await writeFile(path, await sharp(await readFile(file)).png().toBuffer()); images.push(path);
      }
      const context = JSON.stringify({ learningIntent: intent, source: { id: task.source.id, title: task.source.title, url: task.source.url }, section: { ...task.section, units: task.section.units.filter(u => u.kind !== 'note') }, visualOrder: task.assets.map(a => ({ id: a.id, kind: a.kind, caption: a.caption, alt: a.alt, ...(a.kind === 'video' && { note: 'A video that streams from its source; explain what it shows from its title, caption' + (a.src === '/assets/video-poster.svg' ? '.' : ' and poster image.') }) })), allSectionTitles: tasks.filter(t => t.source.id === task.source.id).map(t => t.section.title) });
      const instruction = prompt('section', { input: context });
      let teaching: AuthoredSection | undefined; let issues: string[] = [];
      for (let round = 0; round < settings.preparation.reviewRounds; round++) {
        await mark({ state: 'writing', error: undefined }, true);
        const structured = agentSectionSchema.parse(await run('author', task.id, instruction + (issues.length ? '\n' + prompt('revision', { issues: issues.join('\n'), draft: JSON.stringify(teaching) }) : ''), agentSectionSchema, images));
        teaching = authoredSectionSchema.parse({ ...structured, units: structured.units.map(u => ({ ...u, question: u.question ?? undefined })) });
        issues = checkTeaching(task, teaching); if (issues.length) continue;
        await mark({ state: 'reviewing' });
        active.stage = `Checking ${index}/${tasks.length} · ${task.section.title}`;
        const review = reviewSchema.parse(await run('review', task.id, prompt('review', { source: context, draft: JSON.stringify(teaching) }), reviewSchema, images));
        issues = review.approved && review.issues.length === 0 ? [] : review.issues.length ? review.issues : ['Content review did not approve this section.'];
        if (!issues.length) break;
      }
      if (issues.length || !teaching) throw new Error('Section ' + task.section.title + ' needs review: ' + issues.join('; '));
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
