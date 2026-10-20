import type { PreparationJob } from '../shared/preparation';
import { DatabaseSync } from 'node:sqlite';
import { parseLesson, modes, type Lesson, type LessonSummary, type Mode, type Progress } from '../shared/lesson';
import { flattenBlocks } from '../shared/navigation';
import type { SourceBundle, BundleSummary, AssetBlob } from '../shared/sources';
import { resolveSettings, settingsOverrides, type Settings } from '../shared/settings';

export class StoreError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export class LessonStore {
  private db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
    this.db.exec('CREATE TABLE IF NOT EXISTS deleted_samples (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, document TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS preparation_jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL, saved_at INTEGER NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY, document TEXT NOT NULL, saved_at INTEGER NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS progress (lesson_id TEXT NOT NULL REFERENCES lessons(id), mode TEXT NOT NULL, block_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (lesson_id, mode));');
    this.db.exec('CREATE TABLE IF NOT EXISTS source_bundles (id TEXT PRIMARY KEY, document TEXT NOT NULL, saved_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS source_assets (id TEXT PRIMARY KEY, bytes BLOB NOT NULL, type TEXT NOT NULL);');
  }
  list(): LessonSummary[] {
    return this.db.prepare("SELECT document FROM lessons ORDER BY json_extract(document, '$.createdAt') DESC, id ASC").all().map(row => {
      const lesson = parseLesson(JSON.parse(row.document as string));
      const { id, title, description, topic, createdAt, isSample, familiarity, sourceBundleId } = lesson;
      return { id, title, description, topic, createdAt, isSample, familiarity, sourceBundleId,
        availableModes: modes.filter(mode => lesson.modes[mode]), sourceCount: lesson.sources.length,
        blockCount: flattenBlocks(lesson, lesson.modes.walkthrough ? 'walkthrough' : modes.find(mode => lesson.modes[mode])!).length };
    });
  }
  insert(input: unknown): Lesson {
    const lesson = parseLesson(input);
    if (lesson.sourceBundleId && !this.getBundle(lesson.sourceBundleId)) throw new StoreError('The source collection for this lesson was not found.', 400);
    if (this.get(lesson.id)) throw new StoreError('This analysis already exists. Use a new ID to import a separate copy.', 409);
    this.db.prepare('INSERT INTO lessons (id, document, saved_at) VALUES (?, ?, ?)').run(lesson.id, JSON.stringify(lesson), Date.now());
    return lesson;
  }
  get(id: string): Lesson | undefined {
    const row = this.db.prepare('SELECT document FROM lessons WHERE id = ?').get(id);
    return row ? parseLesson(JSON.parse(row.document as string)) : undefined;
  }
  setProgress(id: string, mode: Mode, blockId: string): void {
    const lesson = this.get(id);
    if (!lesson) throw new StoreError('Analysis not found.', 404);
    if (!flattenBlocks(lesson, mode).some(item => item.block.id === blockId)) throw new StoreError('That passage does not belong to this learning mode.', 400);
    this.db.prepare('INSERT INTO progress (lesson_id, mode, block_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(lesson_id, mode) DO UPDATE SET block_id=excluded.block_id, updated_at=excluded.updated_at')
      .run(id, mode, blockId, Date.now());
  }
  getProgress(id: string): Progress {
    const rows = this.db.prepare('SELECT mode, block_id FROM progress WHERE lesson_id = ? ORDER BY updated_at DESC, rowid DESC').all(id);
    return { lastMode: (rows[0]?.mode as Mode) ?? null,
      positions: Object.fromEntries(rows.map(row => [row.mode, row.block_id])) };
  }
  saveBundle(bundle: SourceBundle, blobs: AssetBlob[]): void {
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO source_assets (id, bytes, type) VALUES (?, ?, ?)');
      for (const blob of blobs) insert.run(blob.id, blob.bytes, blob.type);
      this.db.prepare('INSERT INTO source_bundles (id, document, saved_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document, saved_at=excluded.saved_at').run(bundle.id, JSON.stringify(bundle), Date.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  listBundles(): BundleSummary[] {
    return this.db.prepare("SELECT document FROM source_bundles ORDER BY json_extract(document, '$.createdAt') DESC").all().map(row => {
      const bundle = JSON.parse(row.document as string) as SourceBundle;
      return { id: bundle.id, title: bundle.title, createdAt: bundle.createdAt, status: bundle.status,
        lessonId: this.lessonIdForBundle(bundle.id),
        sourceCount: bundle.sources.length, visualCount: bundle.sources.reduce((sum, source) => sum + source.inventory.savedVisuals, 0), warningCount: bundle.sources.reduce((sum, source) => sum + source.warnings.length, 0) };
    });
  }
  getBundle(id: string): SourceBundle | undefined {
    const row = this.db.prepare('SELECT document FROM source_bundles WHERE id = ?').get(id);
    return row ? { ...JSON.parse(row.document as string), lessonId: this.lessonIdForBundle(id) } : undefined;
  }
  private lessonIdForBundle(id: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM lessons WHERE json_extract(document, '$.sourceBundleId') = ? ORDER BY saved_at DESC, rowid DESC LIMIT 1").get(id);
    return row?.id as string | undefined;
  }
  getAsset(id: string): { bytes: Uint8Array; type: string } | undefined {
    return this.db.prepare('SELECT bytes, type FROM source_assets WHERE id = ?').get(id) as { bytes: Uint8Array; type: string } | undefined;
  }
  saveJob(job: PreparationJob): void {
    this.db.prepare('INSERT INTO preparation_jobs (id, document, saved_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document, saved_at=excluded.saved_at').run(job.id, JSON.stringify(job), Date.now());
  }
  listJobs(): PreparationJob[] {
    return this.db.prepare('SELECT document FROM preparation_jobs ORDER BY saved_at DESC, rowid DESC LIMIT 50').all().map(row=>JSON.parse(row.document as string));
  }
  listJobsForBundle(bundleId:string):PreparationJob[] {
    return this.db.prepare("SELECT document FROM preparation_jobs WHERE json_extract(document, '$.bundleId') = ? ORDER BY saved_at DESC, rowid DESC").all(bundleId).map(row=>JSON.parse(row.document as string));
  }
  renameLesson(id: string, title: string): Lesson {
    const lesson = this.get(id);
    if (!lesson) throw new StoreError('Analysis not found.', 404);
    const renamed = parseLesson({ ...lesson, title });
    this.db.prepare('UPDATE lessons SET document = ? WHERE id = ?').run(JSON.stringify(renamed), id);
    return renamed;
  }
  renameBundle(id: string, title: string): SourceBundle {
    const bundle = this.getBundle(id);
    if (!bundle) throw new StoreError('Source collection not found.', 404);
    const { lessonId: _lesson, ...document } = { ...bundle, title };
    this.db.prepare('UPDATE source_bundles SET document = ? WHERE id = ?').run(JSON.stringify(document), id);
    return { ...bundle, title };
  }
  /** Removes the lesson and its reading positions from disk. Samples stay deleted across restarts. */
  deleteLesson(id: string): void {
    const lesson = this.get(id);
    if (!lesson) throw new StoreError('Analysis not found.', 404);
    this.transaction(() => {
      this.db.prepare('DELETE FROM progress WHERE lesson_id = ?').run(id);
      this.db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
      if (lesson.isSample) this.db.prepare('INSERT OR IGNORE INTO deleted_samples (id) VALUES (?)').run(id);
      for (const job of this.allJobs()) if (job.lessonId === id) { const { lessonId: _removed, ...rest } = job; this.saveJob(rest); }
    });
    this.compact();
  }
  /** Removes the collection, its preparation history, and any saved image no other item uses. */
  deleteBundle(id: string): PreparationJob[] {
    if (!this.getBundle(id)) throw new StoreError('Source collection not found.', 404);
    const jobs = this.allJobs().filter(job => job.bundleId === id);
    this.transaction(() => {
      this.db.prepare('DELETE FROM source_bundles WHERE id = ?').run(id);
      for (const job of jobs) this.db.prepare('DELETE FROM preparation_jobs WHERE id = ?').run(job.id);
    });
    this.compact();
    return jobs;
  }
  getSettings(): Settings {
    const row = this.db.prepare("SELECT document FROM settings WHERE id = 'user'").get();
    return resolveSettings(row ? JSON.parse(row.document as string) : {});
  }
  saveSettings(settings: Settings): Settings {
    this.db.prepare("INSERT INTO settings (id, document) VALUES ('user', ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(JSON.stringify(settingsOverrides(settings)));
    return this.getSettings();
  }
  isDeletedSample(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM deleted_samples WHERE id = ?').get(id); }
  private compact(): void {
    const used = new Set<string>();
    for (const row of this.db.prepare('SELECT document FROM lessons UNION ALL SELECT document FROM source_bundles').all())
      for (const match of (row.document as string).matchAll(/\/api\/source-assets\/([a-f0-9]{64})/g)) used.add(match[1]);
    const remove = this.db.prepare('DELETE FROM source_assets WHERE id = ?');
    this.transaction(() => { for (const row of this.db.prepare('SELECT id FROM source_assets').all()) if (!used.has(row.id as string)) remove.run(row.id as string); });
    // Deleted pages are zeroed (secure_delete); also flush them out of the write-ahead log.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }
  private allJobs(): PreparationJob[] { return this.db.prepare('SELECT document FROM preparation_jobs').all().map(row => JSON.parse(row.document as string)); }
  private transaction(work: () => void): void {
    this.db.exec('BEGIN');
    try { work(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
