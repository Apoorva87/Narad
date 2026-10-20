import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseLesson, type Lesson } from '../shared/lesson';
import { providers, type Provider } from '../shared/preparation';
import { legacyWarning, type AssetBlob, type CaptureWarning, type Credit, type SourceAsset, type SourceBundle } from '../shared/sources';
import { buildTeachingPlan, checkTeaching, sectionHash, type ChunkLimits, type TeachingTask } from './generation-content';
import { authoredSectionSchema } from './lesson-preparation';
import { slugify } from './library';
import type { Progress } from './preparation';
import { LessonStore } from './store';

export type MigrationResult = { migrated: number; salvaged: Record<string, number>; skipped: string[] };
type LegacyJob = { id: string; bundleId?: string; lessonId?: string; provider?: string; createdAt?: string };
type LegacyBundle = Omit<SourceBundle, 'sources'> & { sources: (Omit<SourceBundle['sources'][number], 'warnings'> & { warnings: (string | CaptureWarning)[] })[] };
/** One folder to write: a collection with its newest lesson, a collection alone, or a lesson alone. */
type Served = { src: string; credit?: Credit };
type Group = { bundle?: LegacyBundle; bundleDoc?: string; lesson?: Lesson };

const LEGACY_TABLES = ['progress', 'lessons', 'source_bundles', 'source_assets'];
const STAGING = '_migrating-';
const HASH_SRC = /^\/api\/source-assets\/([a-f0-9]{64})$/;
const SERVED_MEDIA = /^\/api\/library\/([a-z0-9][a-z0-9-]*)\/media\/([^/]+)$/;
const INTERRUPTED = 'Preparation was interrupted before Narad moved to library folders. Finished sections are saved; press Continue to resume.';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; } };

/**
 * Moves content from the pre-folder SQLite tables into library folders, once.
 * - Backs up narad.sqlite (and the tutor database, when given) before any write, once: a later start that retries failed items
 *   reuses the first backup pair, which still holds every legacy row.
 * - Builds each item in a staging folder the library ignores (`_migrating-…`), checks it there, then renames it into place, so a
 *   crash never leaves a half-written item; leftover staging folders are removed on the next start.
 * - Records every placed item in `migration_done`; recorded items are never checked or written again, so later edits and deletions stand.
 * - Deletes the legacy rows only when every row migrated; otherwise all rows stay and the next start retries the rest.
 * Old preparation folders move into their item's `preparation/runs/legacy-<jobId>/`, and approved sections from an interrupted run
 * are salvaged so Continue resumes them.
 */
export function migrateToLibrary(options: { dbPath: string; dataDir: string; store: LessonStore; tutors?: { moveLesson(from: string, to: string): void }; tutorDbPath?: string }): MigrationResult {
  const { dbPath, dataDir, store, tutors, tutorDbPath } = options;
  const result: MigrationResult = { migrated: 0, salvaged: {}, skipped: [] };
  if (existsSync(store.libraryRoot))
    for (const entry of readdirSync(store.libraryRoot)) if (entry.startsWith(STAGING)) rmSync(join(store.libraryRoot, entry), { recursive: true, force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name as string));
    const all = (table: string, order: string) => tables.has(table) ? db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() : [];
    const bundleRows = all('source_bundles', 'saved_at, rowid');
    // Newest first, so when two old lessons share a collection the newest is the one kept beside its sources.
    const lessonRows = all('lessons', 'saved_at DESC, rowid DESC');
    let failed = false;
    const fail = (label: string, error: unknown) => { failed = true; result.skipped.push(`${label}: ${message(error)}`); };
    const parse = <T>(table: string, row: Record<string, unknown>): T | undefined => {
      try { return JSON.parse(row.document as string) as T; } catch (error) { fail(`${table} ${String(row.id)}: unreadable row`, error); return undefined; }
    };
    const jobs = new Map<string, LegacyJob>();
    const prepRoot = join(dataDir, 'preparations');
    const prepDirs = existsSync(prepRoot) ? readdirSync(prepRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : [];
    const targetFor = (jobId: string) => {
      const job = jobs.get(jobId);
      const snapshotId = readJson<{ id?: string }>(join(prepRoot, jobId, 'source-snapshot.json'))?.id;
      for (const id of [job?.lessonId, job?.bundleId, snapshotId]) { const slug = id ? store.resolveId(id) : undefined; if (slug) return slug; }
      return undefined;
    };
    if (!bundleRows.length && !lessonRows.length && !prepDirs.some(targetFor)) return result;

    // One backup pair per migration: legacy rows are never deleted until every item has migrated, so the pair an earlier start took
    // (before it created `migration_done`) still holds everything; a start retrying failed items does not add another.
    const backedUp = tables.has('migration_done') && existsSync(join(dataDir, 'backups')) && readdirSync(join(dataDir, 'backups')).some(file => /^narad-.+\.sqlite$/.test(file));
    try { if (!backedUp) { backup(db, dataDir, 'narad'); if (tutorDbPath && existsSync(tutorDbPath)) backupFile(tutorDbPath, dataDir, 'tutor'); } }
    catch (error) { result.skipped.push('Backup failed, nothing was migrated: ' + message(error)); return result; }

    for (const row of all('preparation_jobs', 'saved_at, rowid')) { const job = parse<LegacyJob>('preparation_jobs', row); if (job) jobs.set(row.id as string, job); }
    db.exec('CREATE TABLE IF NOT EXISTS migration_done (old_id TEXT PRIMARY KEY, slug TEXT NOT NULL, done_at INTEGER NOT NULL)');
    const done = new Map(db.prepare('SELECT old_id, slug FROM migration_done').all().map(row => [row.old_id as string, row.slug as string]));
    const record = db.prepare('INSERT OR REPLACE INTO migration_done (old_id, slug, done_at) VALUES (?, ?, ?)');
    const blob = (hash: string): AssetBlob => {
      const row = db.prepare('SELECT bytes, type FROM source_assets WHERE id = ?').get(hash) as { bytes: Uint8Array; type: string } | undefined;
      if (!row) throw new Error('Saved image is missing: ' + hash);
      return { id: hash, bytes: Buffer.from(row.bytes), type: row.type };
    };

    // Plan one folder per collection (with its newest lesson) and per remaining lesson; recorded items are skipped.
    const groups: Group[] = [];
    const byBundle = new Map<string, Group>();
    const unreadable = new Set<string>();
    for (const row of bundleRows) {
      const bundle = parse<LegacyBundle>('source_bundles', row);
      if (!bundle) { unreadable.add(row.id as string); continue; }
      if (done.has(bundle.id)) continue;
      const group: Group = { bundle, bundleDoc: row.document as string };
      groups.push(group); byBundle.set(bundle.id, group);
    }
    for (const row of lessonRows) {
      const lesson = parse<Lesson>('lessons', row);
      if (!lesson || done.has(lesson.id)) continue;
      if (lesson.sourceBundleId && unreadable.has(lesson.sourceBundleId)) { fail(`${lesson.id} (${lesson.title})`, 'its source collection row is unreadable'); continue; }
      const home = lesson.sourceBundleId ? byBundle.get(lesson.sourceBundleId) : undefined;
      if (home && !home.lesson) home.lesson = lesson; else groups.push({ lesson });
    }

    const written = new Set<string>();
    for (const group of groups) {
      const ids = [group.bundle?.id, group.lesson?.id].filter((id): id is string => !!id);
      const label = group.bundle ? `${group.bundle.id} (${group.bundle.title})` : `${group.lesson!.id} (${group.lesson!.title})`;
      try {
        // Placed by an earlier start that stopped before recording it: check it and record it.
        const found = ids.map(id => store.resolveId(id)).find(Boolean);
        const slug = found ?? stage(store, group, blob);
        if (found) {
          if (group.bundle) verifyBundle(store, group.bundle, found);
          if (group.lesson) { if (store.resolveId(group.lesson.id) !== found) throw new Error('the lesson is missing from its folder'); verifyLesson(store, group.lesson, found); }
        } else written.add(slug);
        if (group.lesson && group.lesson.id !== slug) tutors?.moveLesson(group.lesson.id, slug);
        for (const id of ids) { record.run(id, slug, Date.now()); done.set(id, slug); }
      } catch (error) { fail(label, error); }
    }

    // Reading positions, keyed by folder name now. A position already saved under the new name wins; deleted items get none.
    if (tables.has('progress') && tables.has('positions')) {
      const insert = db.prepare('INSERT OR IGNORE INTO positions (slug, mode, block_id, updated_at) VALUES (?, ?, ?, ?)');
      for (const row of db.prepare('SELECT lesson_id, mode, block_id, updated_at FROM progress').all()) {
        const slug = done.get(row.lesson_id as string);
        if (slug && store.library.exists(slug)) insert.run(slug, row.mode as string, row.block_id as string, row.updated_at as number);
      }
    }

    // Old preparation folders move into their item; those without one stay put.
    for (const jobId of prepDirs) {
      const slug = targetFor(jobId);
      if (!slug) { result.skipped.push(`preparations/${jobId}: no matching library item; left in place`); continue; }
      try { move(join(prepRoot, jobId), join(store.library.dir(slug), 'preparation', 'runs'), 'legacy-' + jobId); }
      catch (error) { result.skipped.push(`preparations/${jobId}: could not move: ${message(error)}`); }
    }

    // Salvage approved sections for collections without a lesson.
    const { chunkChars, chunkUnits } = store.getSettings().preparation;
    const bundleSlugs = new Set(bundleRows.map(row => done.get(row.id as string)).filter((slug): slug is string => !!slug && store.library.exists(slug)));
    for (const slug of bundleSlugs) {
      try {
        const count = salvage(store, slug, { chunkChars, chunkUnits }, jobs);
        if (count) result.salvaged[slug] = count;
      } catch (error) { result.skipped.push(`${slug}: could not salvage sections: ${message(error)}`); }
    }

    // Every row migrated: only now remove the legacy rows.
    if (!failed) {
      db.exec('BEGIN');
      try { for (const table of LEGACY_TABLES) if (tables.has(table)) db.exec(`DELETE FROM ${table}`); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    }
    result.migrated = written.size;
    return result;
  } finally { db.close(); }
}

/**
 * Writes one item into `<library>/_migrating-…/<slug>/` with a store of its own, checks it, records its old IDs in `legacyIds`,
 * then renames it into the library under a free folder name. Returns that name. The staging folder is always removed.
 */
function stage(store: LessonStore, group: Group, blob: (hash: string) => AssetBlob): string {
  const ids = [group.bundle?.id, group.lesson?.id].filter((id): id is string => !!id);
  const root = join(store.libraryRoot, STAGING + ids[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80));
  rmSync(root, { recursive: true, force: true });
  const staging = new LessonStore(':memory:', root);
  try {
    let slug: string | undefined;
    let served = new Map<string, Served>();
    if (group.bundle) {
      const hashes = [...new Set([...group.bundleDoc!.matchAll(/\/api\/source-assets\/([a-f0-9]{64})/g)].map(match => match[1]))];
      slug = staging.saveBundle(normaliseBundle(group.bundle), hashes.map(blob)).id;
      served = verifyBundle(staging, group.bundle, slug);
    }
    if (group.lesson) {
      const media: Record<string, Buffer> = {};
      const assets = group.lesson.assets.map((asset, index) => {
        const hash = asset.src.match(HASH_SRC)?.[1];
        if (!hash) return asset;
        const reused = served.get(hash);
        if (reused) return { ...asset, src: reused.src, ...(!asset.credit && reused.credit && { credit: reused.credit }) };
        const { bytes, type } = blob(hash);
        const file = `lesson-${String(index + 1).padStart(2, '0')}.${extension(type)}`;
        media[file] = bytes;
        return { ...asset, src: 'media/' + file };
      });
      slug = staging.insert({ ...group.lesson, assets, sourceBundleId: group.bundle?.id }, { media }).id;
      verifyLesson(staging, group.lesson, slug);
    }
    const taken = new Set(store.library.slugs());
    const final = taken.has(slug!) ? slugify(slug!, taken) : slug!;
    const item = staging.library.readJson<{ legacyIds?: string[] }>(slug!, 'item.json').value!;
    staging.library.writeJson(slug!, 'item.json', { ...item, legacyIds: [...new Set([...(item.legacyIds ?? []), ...ids])].filter(id => id !== final) });
    renameSync(staging.library.dir(slug!), store.library.dir(final));
    if (group.bundle && !store.getBundle(final)) throw new Error('the folder could not be read back');
    if (group.lesson && !store.get(final)) throw new Error('the lesson could not be read back');
    return final;
  } finally { staging.close(); rmSync(root, { recursive: true, force: true }); }
}

/** Copies a database, including anything still in its write-ahead log, to `backups/<name>-<timestamp>.sqlite`. */
function backup(db: DatabaseSync, dataDir: string, name: string): string {
  const folder = join(dataDir, 'backups');
  mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let path = join(folder, `${name}-${stamp}.sqlite`);
  for (let n = 2; existsSync(path); n++) path = join(folder, `${name}-${stamp}-${n}.sqlite`);
  db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  return path;
}
function backupFile(dbPath: string, dataDir: string, name: string): string {
  const db = new DatabaseSync(dbPath);
  try { db.exec('PRAGMA busy_timeout=5000;'); return backup(db, dataDir, name); } finally { db.close(); }
}

/** Warnings become objects, and each image gets a credit from what the old capture recorded. */
function normaliseBundle(old: LegacyBundle): SourceBundle {
  return { ...old, sources: old.sources.map(source => ({ ...source,
    warnings: source.warnings.map(warning => typeof warning === 'string' ? legacyWarning(warning) : warning),
    assets: source.assets.map((asset): SourceAsset => asset.credit ? asset : { ...asset, credit: {
      pageTitle: source.title, pageUrl: source.url ?? '', ...(asset.originalUrl && { mediaUrl: asset.originalUrl }), ...(asset.caption && { caption: asset.caption }),
      ...(source.kind === 'image' && { creditLine: 'Your upload: ' + source.title }), capturedAt: old.createdAt } }),
  })) };
}

/** Checks the folder reads back with the same sources and every image saved; returns old image hash → served path and credit. */
function verifyBundle(store: LessonStore, old: LegacyBundle, slug: string): Map<string, Served> {
  const fresh = store.getBundle(slug);
  if (!fresh) throw new Error('the folder could not be read back');
  if (fresh.sources.length !== old.sources.length || fresh.sources.some((source, i) => source.markdown !== old.sources[i].markdown || source.assets.length !== old.sources[i].assets.length))
    throw new Error('the folder does not match the saved sources');
  const served = new Map<string, Served>();
  fresh.sources.forEach((source, s) => source.assets.forEach((asset, a) => {
    const before = old.sources[s].assets[a];
    for (const key of ['src', 'originalSrc'] as const) {
      const hash = before[key]?.match(HASH_SRC)?.[1];
      if (!hash) continue;
      const media = asset[key]?.match(SERVED_MEDIA);
      if (!media || !store.mediaPath(media[1], media[2])) throw new Error(`image ${asset.id} was not saved`);
      if (!served.has(hash)) served.set(hash, { src: asset[key]!, ...(asset.credit && { credit: asset.credit }) });
    }
  }));
  return served;
}

function verifyLesson(store: LessonStore, old: Lesson, slug: string): void {
  const fresh = store.get(slug);
  if (!fresh) throw new Error('the lesson could not be read back');
  if (JSON.stringify(fresh.modes) !== JSON.stringify(parseLesson(old).modes)) throw new Error('the lesson does not match the saved lesson');
  for (const asset of fresh.assets) {
    if (HASH_SRC.test(asset.src)) throw new Error(`image ${asset.id} was not saved`);
    const media = asset.src.match(SERVED_MEDIA);
    if (media && !store.mediaPath(media[1], media[2])) throw new Error(`image ${asset.id} is missing`);
  }
}

function extension(type: string): string { return ({ 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' } as Record<string, string>)[type] ?? (type.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin'); }

/** Renames `from` to `<parent>/<name>` (or `<name>-2`, …), copying when it lies on another disk. */
function move(from: string, parent: string, name: string): void {
  mkdirSync(parent, { recursive: true });
  let target = join(parent, name);
  for (let n = 2; existsSync(target); n++) target = join(parent, `${name}-${n}`);
  try { renameSync(from, target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(from, target, { recursive: true }); rmSync(from, { recursive: true, force: true });
  }
}

/**
 * For a collection with no lesson and no current run: looks through every legacy run, newest job first (by the job record's
 * `createdAt`, then folder name), and for each task rebuilt from the collection as it is now imports the first approved section
 * whose task, rebuilt from that run's own `source-snapshot.json` and chunk limits, has the same source hash and still passes the
 * section checks. Writes `progress.json` as interrupted. Returns how many sections were imported.
 */
function salvage(store: LessonStore, slug: string, limits: ChunkLimits, jobs: Map<string, LegacyJob>): number {
  const dir = store.library.dir(slug);
  const prep = join(dir, 'preparation'), runs = join(prep, 'runs');
  if (existsSync(join(dir, 'lesson.json')) || existsSync(join(prep, 'progress.json')) || existsSync(join(prep, 'sections')) || !existsSync(runs)) return 0;
  const created = (folder: string) => { const at = Date.parse(jobs.get(folder.slice('legacy-'.length))?.createdAt ?? ''); return Number.isNaN(at) ? -Infinity : at; };
  const candidates = readdirSync(runs).filter(folder => folder.startsWith('legacy-') && existsSync(join(runs, folder, 'source-snapshot.json')))
    .sort((a, b) => created(b) - created(a) || (b < a ? -1 : b > a ? 1 : 0));
  if (!candidates.length) return 0;
  const bundle = store.getBundle(slug)!;
  let current: TeachingTask[];
  try { current = buildTeachingPlan(bundle, limits); } catch { return 0; }
  // Each old run split its sources with the chunk limits in force then; current tasks use today's limits, as Continue will.
  const plans = candidates.flatMap(run => {
    const snapshot = readJson<LegacyBundle>(join(runs, run, 'source-snapshot.json'));
    if (!snapshot) return [];
    const used = readJson<{ preparation?: Partial<ChunkLimits> }>(join(runs, run, 'settings.json'))?.preparation;
    const runLimits: ChunkLimits = { chunkChars: used?.chunkChars ?? limits.chunkChars, chunkUnits: used?.chunkUnits ?? limits.chunkUnits };
    try { return [{ run, before: buildTeachingPlan(normaliseBundle(snapshot), runLimits) }]; } catch { return []; }
  });

  const sections: Progress['sections'] = {};
  let count = 0;
  const contributed = new Set<string>();
  for (const task of current) {
    const hash = sectionHash(task);
    let teaching: ReturnType<typeof authoredSectionSchema.parse> | undefined;
    for (const { run, before } of plans) {
      const old = before.find(candidate => candidate.id === task.id);
      if (!old || sectionHash(old) !== hash) continue;
      const parsed = authoredSectionSchema.safeParse(readJson(join(runs, run, task.id + '.approved.json')));
      if (parsed.success && !checkTeaching(task, parsed.data).length) { teaching = parsed.data; contributed.add(run); break; }
    }
    if (teaching) { store.library.writeJson(slug, `preparation/sections/${task.id}.json`, { task: task.id, title: task.section.title, sourceHash: hash, teaching }); count++; }
    sections[task.id] = { title: task.section.title, sourceHash: hash, state: teaching ? 'done' : 'waiting', attempts: 0 };
  }
  if (!count) return 0;
  // The newest run that gave a section names the resumed run.
  const run = plans.find(candidate => contributed.has(candidate.run))!.run;
  const job = jobs.get(run.slice('legacy-'.length));
  const provider: Provider = providers.includes(job?.provider as Provider) ? job!.provider as Provider : 'codex';
  const now = new Date().toISOString();
  const progress: Progress = {
    runId: run, status: 'interrupted', provider, level: bundle.familiarity ?? 'foundational', startedAt: job?.createdAt ?? now, updatedAt: now,
    steps: { research: bundle.sources.every(source => source.kind === 'note') ? 'pending' : 'skipped', summary: 'pending', publish: 'pending' },
    sections, calls: [], error: INTERRUPTED,
  };
  store.library.writeJson(slug, 'preparation/progress.json', progress);
  return count;
}
