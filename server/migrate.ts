import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseLesson, type Lesson } from '../shared/lesson';
import { providers, type Provider } from '../shared/preparation';
import { legacyWarning, type AssetBlob, type CaptureWarning, type SourceAsset, type SourceBundle } from '../shared/sources';
import { buildTeachingPlan, checkTeaching, sectionHash, type ChunkLimits, type TeachingTask } from './generation-content';
import { authoredSectionSchema } from './lesson-preparation';
import type { Progress } from './preparation';
import type { LessonStore } from './store';

export type MigrationResult = { migrated: number; salvaged: Record<string, number>; skipped: string[] };
type LegacyJob = { id: string; bundleId?: string; lessonId?: string; provider?: string; createdAt?: string };
type LegacyBundle = Omit<SourceBundle, 'sources'> & { sources: (Omit<SourceBundle['sources'][number], 'warnings'> & { warnings: (string | CaptureWarning)[] })[] };

const LEGACY_TABLES = ['progress', 'lessons', 'source_bundles', 'source_assets'];
const HASH_SRC = /^\/api\/source-assets\/([a-f0-9]{64})$/;
const SERVED_MEDIA = /^\/api\/library\/([a-z0-9][a-z0-9-]*)\/media\/([^/]+)$/;
const INTERRUPTED = 'Preparation was interrupted before Narad moved to library folders. Finished sections are saved; press Continue to resume.';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; } };

/**
 * Moves content from the pre-folder SQLite tables into library folders, once. Backs up the database first, writes every item,
 * re-reads and checks each one, and deletes the legacy rows only when all of them succeeded; otherwise the rows stay and the next
 * start retries. Items already migrated (their old ID is in a folder's `legacyIds`) are left alone. Old preparation folders move
 * into their item's `preparation/runs/legacy-<jobId>/`, and approved sections from an interrupted run are salvaged so Continue resumes them.
 */
export function migrateToLibrary(options: { dbPath: string; dataDir: string; store: LessonStore; tutors?: { moveLesson(from: string, to: string): void } }): MigrationResult {
  const { dbPath, dataDir, store, tutors } = options;
  const result: MigrationResult = { migrated: 0, salvaged: {}, skipped: [] };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name as string));
    const all = (table: string, order: string) => tables.has(table) ? db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() : [];
    const bundles = all('source_bundles', 'saved_at, rowid');
    // Newest first, so when two old lessons share a collection the newest is the one kept beside its sources.
    const lessons = all('lessons', 'saved_at DESC, rowid DESC');
    const jobs = new Map(all('preparation_jobs', 'saved_at, rowid').map(row => [row.id as string, JSON.parse(row.document as string) as LegacyJob]));
    const prepRoot = join(dataDir, 'preparations');
    const prepDirs = existsSync(prepRoot) ? readdirSync(prepRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : [];
    const targetFor = (jobId: string) => {
      const job = jobs.get(jobId);
      const snapshotId = readJson<{ id?: string }>(join(prepRoot, jobId, 'source-snapshot.json'))?.id;
      for (const id of [job?.lessonId, job?.bundleId, snapshotId]) { const slug = id ? store.resolveId(id) : undefined; if (slug) return slug; }
      return undefined;
    };
    if (!bundles.length && !lessons.length && !prepDirs.some(targetFor)) return result;

    try { backup(db, dataDir); }
    catch (error) { result.skipped.push('Backup failed, nothing was migrated: ' + message(error)); return result; }

    const blob = (hash: string): AssetBlob => {
      const row = db.prepare('SELECT bytes, type FROM source_assets WHERE id = ?').get(hash) as { bytes: Uint8Array; type: string } | undefined;
      if (!row) throw new Error('Saved image is missing: ' + hash);
      return { id: hash, bytes: Buffer.from(row.bytes), type: row.type };
    };
    const written = new Set<string>();
    let failed = false;
    const fail = (label: string, error: unknown) => { failed = true; result.skipped.push(`${label}: ${message(error)}`); };

    // 1. Source collections, with their images written into media/.
    const bundleSlugs = new Map<string, string>();
    const servedByHash = new Map<string, Map<string, string>>();
    for (const row of bundles) {
      const old = JSON.parse(row.document as string) as LegacyBundle;
      try {
        const existing = store.resolveId(old.id);
        let saved = existing ? store.getBundle(existing) : undefined;
        if (!saved) {
          const hashes = [...new Set([...(row.document as string).matchAll(/\/api\/source-assets\/([a-f0-9]{64})/g)].map(match => match[1]))];
          saved = store.saveBundle(normaliseBundle(old), hashes.map(blob));
          written.add(saved.id);
        }
        servedByHash.set(saved.id, verifyBundle(store, old, saved));
        bundleSlugs.set(old.id, saved.id);
      } catch (error) { fail(`${old.id} (${old.title})`, error); }
    }

    // 2. Lessons: into their collection's folder, or a folder of their own.
    const lessonSlugs = new Map<string, string>();
    for (const row of lessons) {
      const old = JSON.parse(row.document as string) as Lesson;
      try {
        let slug = store.resolveId(old.id);
        if (!slug || !store.get(slug)) {
          const known = !!old.sourceBundleId && bundles.some(bundle => bundle.id === old.sourceBundleId);
          const bundleSlug = old.sourceBundleId ? bundleSlugs.get(old.sourceBundleId) : undefined;
          if (known && !bundleSlug) throw new Error('its source collection did not migrate');
          const intoBundle = !!bundleSlug && !existsSync(join(store.library.dir(bundleSlug), 'lesson.json'));
          const served = intoBundle ? servedByHash.get(bundleSlug!) : undefined;
          const media: Record<string, Buffer> = {};
          const assets = old.assets.map((asset, index) => {
            const hash = asset.src.match(HASH_SRC)?.[1];
            if (!hash) return asset;
            const reused = served?.get(hash);
            if (reused) return { ...asset, src: reused };
            const { bytes, type } = blob(hash);
            const file = `lesson-${String(index + 1).padStart(2, '0')}.${extension(type)}`;
            media[file] = bytes;
            return { ...asset, src: 'media/' + file };
          });
          slug = store.insert({ ...old, assets, sourceBundleId: intoBundle ? old.sourceBundleId : undefined }, { media }).id;
          written.add(slug);
        }
        verifyLesson(store, old, slug);
        lessonSlugs.set(old.id, slug);
        if (old.id !== slug) tutors?.moveLesson(old.id, slug);
      } catch (error) { fail(`${old.id} (${old.title})`, error); }
    }

    // 3. Reading positions, keyed by folder name now. A position already saved under the new name wins.
    if (tables.has('progress') && tables.has('positions')) {
      const insert = db.prepare('INSERT OR IGNORE INTO positions (slug, mode, block_id, updated_at) VALUES (?, ?, ?, ?)');
      for (const row of db.prepare('SELECT lesson_id, mode, block_id, updated_at FROM progress').all()) {
        const slug = lessonSlugs.get(row.lesson_id as string);
        if (slug) insert.run(slug, row.mode as string, row.block_id as string, row.updated_at as number);
      }
    }

    // 4. Old preparation folders move into their item; those without one stay put.
    for (const jobId of prepDirs) {
      const slug = targetFor(jobId);
      if (!slug) { result.skipped.push(`preparations/${jobId}: no matching library item; left in place`); continue; }
      try { move(join(prepRoot, jobId), join(store.library.dir(slug), 'preparation', 'runs'), 'legacy-' + jobId); }
      catch (error) { result.skipped.push(`preparations/${jobId}: could not move: ${message(error)}`); }
    }

    // 5. Salvage approved sections for collections without a lesson.
    const { chunkChars, chunkUnits } = store.getSettings().preparation;
    for (const slug of new Set(bundleSlugs.values())) {
      try {
        const count = salvage(store, slug, { chunkChars, chunkUnits }, jobs);
        if (count) result.salvaged[slug] = count;
      } catch (error) { result.skipped.push(`${slug}: could not salvage sections: ${message(error)}`); }
    }

    // 6. Every item was written and read back: only now remove the legacy rows.
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

/** Copies the database, including anything still in its write-ahead log, to `backups/narad-<timestamp>.sqlite`. */
function backup(db: DatabaseSync, dataDir: string): string {
  const folder = join(dataDir, 'backups');
  mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let path = join(folder, `narad-${stamp}.sqlite`);
  for (let n = 2; existsSync(path); n++) path = join(folder, `narad-${stamp}-${n}.sqlite`);
  db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  return path;
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

/** Checks the folder reads back with the same sources and every image saved; returns old image hash → served path. */
function verifyBundle(store: LessonStore, old: LegacyBundle, saved: SourceBundle): Map<string, string> {
  const fresh = store.getBundle(saved.id);
  if (!fresh) throw new Error('the folder could not be read back');
  if (fresh.sources.length !== old.sources.length || fresh.sources.some((source, i) => source.markdown !== old.sources[i].markdown || source.assets.length !== old.sources[i].assets.length))
    throw new Error('the folder does not match the saved sources');
  const served = new Map<string, string>();
  fresh.sources.forEach((source, s) => source.assets.forEach((asset, a) => {
    const before = old.sources[s].assets[a];
    for (const key of ['src', 'originalSrc'] as const) {
      const hash = before[key]?.match(HASH_SRC)?.[1];
      if (!hash) continue;
      const media = asset[key]?.match(SERVED_MEDIA);
      if (!media || !store.mediaPath(media[1], media[2])) throw new Error(`image ${asset.id} was not saved`);
      served.set(hash, asset[key]!);
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
 * For a collection with no lesson and no current run: takes the newest legacy run with approved sections, imports each one whose task,
 * rebuilt from the collection as it is now, has the same source hash as the task rebuilt from the run's `source-snapshot.json`, and
 * writes `progress.json` as interrupted. Returns how many sections were imported.
 */
function salvage(store: LessonStore, slug: string, limits: ChunkLimits, jobs: Map<string, LegacyJob>): number {
  const dir = store.library.dir(slug);
  const prep = join(dir, 'preparation'), runs = join(prep, 'runs');
  if (existsSync(join(dir, 'lesson.json')) || existsSync(join(prep, 'progress.json')) || existsSync(join(prep, 'sections')) || !existsSync(runs)) return 0;
  const approved = (folder: string) => readdirSync(join(runs, folder)).filter(file => file.endsWith('.approved.json'));
  const newest = (folder: string) => Math.max(...approved(folder).map(file => statSync(join(runs, folder, file)).mtimeMs));
  const candidates = readdirSync(runs).filter(folder => folder.startsWith('legacy-') && existsSync(join(runs, folder, 'source-snapshot.json')) && approved(folder).length)
    .sort((a, b) => newest(b) - newest(a));
  const run = candidates[0];
  if (!run) return 0;
  const bundle = store.getBundle(slug)!;
  const snapshot = readJson<LegacyBundle>(join(runs, run, 'source-snapshot.json'));
  if (!snapshot) return 0;
  // The old run split its sources with the chunk limits in force then; current tasks use today's limits, as Continue will.
  const used = readJson<{ preparation?: Partial<ChunkLimits> }>(join(runs, run, 'settings.json'))?.preparation;
  const runLimits: ChunkLimits = { chunkChars: used?.chunkChars ?? limits.chunkChars, chunkUnits: used?.chunkUnits ?? limits.chunkUnits };
  let current: TeachingTask[], before: TeachingTask[];
  try { current = buildTeachingPlan(bundle, limits); before = buildTeachingPlan(normaliseBundle(snapshot), runLimits); }
  catch { return 0; }

  const sections: Progress['sections'] = {};
  let count = 0;
  for (const task of current) {
    const hash = sectionHash(task);
    const old = before.find(candidate => candidate.id === task.id);
    const parsed = old && sectionHash(old) === hash ? authoredSectionSchema.safeParse(readJson(join(runs, run, task.id + '.approved.json'))) : undefined;
    const teaching = parsed?.success && !checkTeaching(task, parsed.data).length ? parsed.data : undefined;
    if (teaching) { store.library.writeJson(slug, `preparation/sections/${task.id}.json`, { task: task.id, title: task.section.title, sourceHash: hash, teaching }); count++; }
    sections[task.id] = { title: task.section.title, sourceHash: hash, state: teaching ? 'done' : 'waiting', attempts: 0 };
  }
  if (!count) return 0;
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
