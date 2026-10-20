import type { PreparationJob } from '../shared/preparation';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, sep } from 'node:path';
import { z } from 'zod';
import { familiarities, lessonSchema, modes, parseLesson, type Lesson, type LessonSummary, type Mode, type Progress } from '../shared/lesson';
import { flattenBlocks } from '../shared/navigation';
import type { SourceBundle, BundleSummary, AssetBlob, CapturedSource, SourceAsset } from '../shared/sources';
import { resolveSettings, settingsOverrides, type Settings } from '../shared/settings';
import { LibraryFs, mediaName, slugify, toServedSrc, toStoredSrc } from './library';
import { renderCredits, renderLessonMarkdown } from './library-render';

export class StoreError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export const slugPattern = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const isMediaName = (file: string) => /^[A-Za-z0-9._-]+$/.test(file) && !file.startsWith('.') && file.length <= 200;
const typeByExt: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };
const extByType: Record<string, string> = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };
export function mediaType(file: string): string { return typeByExt[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'; }

const itemSchema = z.object({
  title: z.string().trim().min(1), createdAt: z.string().min(1),
  level: z.enum(familiarities).optional(), status: z.enum(['captured', 'needs-review']).optional(),
  legacyIds: z.array(z.string()).default([]),
});
type Item = z.infer<typeof itemSchema>;
const sourceMetaSchema = z.object({
  id: z.string(), title: z.string(), kind: z.enum(['article', 'note', 'image']), url: z.string().optional(),
  assets: z.array(z.object({
    id: z.string(), kind: z.enum(['image', 'inline-svg']), alt: z.string(), caption: z.string(),
    src: z.string().optional(), originalSrc: z.string().optional(), originalUrl: z.string().optional(), widthEm: z.number().optional(), error: z.string().optional(),
  })),
  warnings: z.array(z.string()),
  inventory: z.object({ images: z.number(), inlineSvg: z.number(), tables: z.number(), savedVisuals: z.number() }),
});
type Parsed<T> = { value?: T; error?: string };
const pad = (n: number) => String(n).padStart(2, '0');

/** Library items live in one folder each under `libraryRoot`; SQLite keeps only settings, deleted samples, reading positions and jobs. */
export class LessonStore {
  readonly libraryRoot: string;
  private db: DatabaseSync;
  private fs: LibraryFs;
  private cache = new Map<string, { key: string; result: Parsed<unknown> }>();
  private temporaryRoot: boolean;
  private closed = false;
  constructor(path: string, libraryRoot?: string) {
    this.temporaryRoot = !libraryRoot && path === ':memory:';
    this.libraryRoot = libraryRoot ?? (this.temporaryRoot ? mkdtempSync(join(tmpdir(), 'narad-library-')) : join(dirname(path), 'library'));
    this.fs = new LibraryFs(this.libraryRoot);
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
    this.db.exec('CREATE TABLE IF NOT EXISTS deleted_samples (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, document TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS preparation_jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL, saved_at INTEGER NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS positions (slug TEXT NOT NULL, mode TEXT NOT NULL, block_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (slug, mode));');
  }

  /** The folder name for a slug or for any former lesson/collection ID listed in an item's `legacyIds`. */
  resolveId(id: string): string | undefined {
    const slugs = this.fs.slugs();
    if (slugPattern.test(id) && slugs.includes(id)) return id;
    return id ? slugs.find(slug => this.item(slug).item?.legacyIds.includes(id)) : undefined;
  }
  mediaPath(slug: string, file: string): string | undefined {
    if (!slugPattern.test(slug) || !isMediaName(file)) return undefined;
    const path = join(this.fs.dir(slug), 'media', file);
    return existsSync(path) && statSync(path).isFile() ? path : undefined;
  }

  list(): LessonSummary[] {
    const summaries: LessonSummary[] = [];
    for (const slug of this.fs.slugs()) {
      if (!this.has(slug, 'lesson.json')) continue;
      try {
        const lesson = this.lessonAt(slug)!;
        const { id, title, description, topic, createdAt, isSample, familiarity, sourceBundleId } = lesson;
        summaries.push({ id, title, description, topic, createdAt, isSample, familiarity, sourceBundleId,
          availableModes: modes.filter(mode => lesson.modes[mode]), sourceCount: lesson.sources.length,
          blockCount: flattenBlocks(lesson, lesson.modes.walkthrough ? 'walkthrough' : modes.find(mode => lesson.modes[mode])!).length });
      } catch (caught) {
        if (!(caught instanceof StoreError)) throw caught;
        const { item, title } = this.item(slug);
        summaries.push({ id: slug, title, description: '', topic: '', createdAt: item?.createdAt ?? '', isSample: false, familiarity: item?.level ?? 'foundational',
          sourceBundleId: item?.status ? slug : undefined, availableModes: [], sourceCount: 0, blockCount: 0, broken: caught.message });
      }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  /**
   * Saves a lesson into its source collection's folder, or a new folder named from its title.
   * `replace` publishes over a collection's existing lesson; `media` adds files to the folder's media/.
   */
  insert(input: unknown, options: { replace?: boolean; media?: Record<string, Uint8Array> } = {}): Lesson {
    const media = options.media ?? {};
    const lesson = parseLesson(input);
    const bundleSlug = lesson.sourceBundleId ? this.resolveId(lesson.sourceBundleId) : undefined;
    if (lesson.sourceBundleId && (!bundleSlug || !this.getBundle(bundleSlug))) throw new StoreError('The source collection for this lesson was not found.', 400);
    const existing = this.resolveId(lesson.id);
    if (existing && this.has(existing, 'lesson.json')) throw new StoreError('This analysis already exists. Use a new ID to import a separate copy.', 409);
    if (bundleSlug && !options.replace && this.has(bundleSlug, 'lesson.json')) throw new StoreError('This collection already has a lesson. Delete it or prepare a new version.', 409);
    for (const file of Object.keys(media)) if (!isMediaName(file)) throw new StoreError('Unsafe media file name: ' + file, 400);
    const slug = bundleSlug ?? slugify(lesson.title, new Set(this.fs.slugs()));
    const item: Item = bundleSlug ? this.validItem(slug) : { title: lesson.title, createdAt: lesson.createdAt, level: lesson.familiarity, legacyIds: [] };
    for (const [file, bytes] of Object.entries(media)) this.fs.writeBytes(slug, 'media/' + file, bytes);
    const written = new Map<string, Buffer>();
    const stored = parseLesson({ ...lesson, id: slug, sourceBundleId: bundleSlug, assets: lesson.assets.map(asset => ({ ...asset, src: this.storeMedia(slug, asset.src, new Map(), undefined, written) })) });
    this.fs.writeJson(slug, 'item.json', { ...item, legacyIds: [...new Set([...item.legacyIds, ...(lesson.id !== slug ? [lesson.id] : [])])] });
    this.writeLesson(slug, stored);
    return this.get(slug)!;
  }
  get(id: string): Lesson | undefined {
    const slug = this.resolveId(id);
    return slug ? this.lessonAt(slug) : undefined;
  }
  setProgress(id: string, mode: Mode, blockId: string): void {
    const lesson = this.get(id);
    if (!lesson) throw new StoreError('Analysis not found.', 404);
    if (!flattenBlocks(lesson, mode).some(item => item.block.id === blockId)) throw new StoreError('That passage does not belong to this learning mode.', 400);
    this.db.prepare('INSERT INTO positions (slug, mode, block_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(slug, mode) DO UPDATE SET block_id=excluded.block_id, updated_at=excluded.updated_at')
      .run(lesson.id, mode, blockId, Date.now());
  }
  getProgress(id: string): Progress {
    const rows = this.db.prepare('SELECT mode, block_id FROM positions WHERE slug = ? ORDER BY updated_at DESC, rowid DESC').all(this.resolveId(id) ?? id);
    return { lastMode: (rows[0]?.mode as Mode) ?? null,
      positions: Object.fromEntries(rows.map(row => [row.mode, row.block_id])) };
  }
  /** Writes item.json, sources/ and media/ for the collection (updating its folder when the ID resolves). Returns it with served image paths. */
  saveBundle(bundle: SourceBundle, blobs: AssetBlob[]): SourceBundle {
    const existing = this.resolveId(bundle.id);
    const slug = existing ?? slugify(bundle.title, new Set(this.fs.slugs()));
    const previous = existing ? this.validItem(slug) : undefined;
    const byId = new Map(blobs.map(blob => [blob.id, blob]));
    const written = new Map<string, Buffer>();
    const sources = bundle.sources.map((source, s) => ({ ...source, assets: source.assets.map((asset, a): SourceAsset => {
      const name = (ext: string) => mediaName(s + 1, a + 1, asset.caption || asset.alt, ext);
      const src = asset.src && this.storeMedia(slug, asset.src, byId, name, written);
      const originalSrc = asset.originalSrc && (asset.originalSrc === asset.src ? src : this.storeMedia(slug, asset.originalSrc, byId, name, written));
      return { ...asset, ...(src && { src }), ...(originalSrc && { originalSrc }) };
    }) }));
    this.fs.writeJson(slug, 'item.json', {
      title: bundle.title || previous?.title || 'Untitled', createdAt: previous?.createdAt ?? bundle.createdAt,
      level: bundle.familiarity ?? previous?.level, status: bundle.status,
      legacyIds: [...new Set([...(previous?.legacyIds ?? []), ...(bundle.id !== slug ? [bundle.id] : [])])],
    });
    this.fs.writeText(slug, 'sources/notes.md', bundle.text);
    const keep = new Set(['notes.md']);
    sources.forEach(({ markdown, rawHtml, ...meta }, index) => {
      const stem = `${pad(index + 1)}-${slugify(meta.title, new Set())}`;
      this.fs.writeText(slug, `sources/${stem}.md`, markdown); keep.add(stem + '.md');
      if (rawHtml !== undefined) { this.fs.writeText(slug, `sources/${stem}.html`, rawHtml); keep.add(stem + '.html'); }
      this.fs.writeJson(slug, `sources/${stem}.json`, meta); keep.add(stem + '.json');
    });
    for (const file of readdirSync(join(this.fs.dir(slug), 'sources'))) if (!keep.has(file)) rmSync(join(this.fs.dir(slug), 'sources', file), { recursive: true, force: true });
    this.tidy(slug);
    return this.getBundle(slug)!;
  }
  listBundles(): BundleSummary[] {
    const summaries: BundleSummary[] = [];
    for (const slug of this.fs.slugs()) {
      const { item, title, error } = this.item(slug);
      if (error ? this.has(slug, 'lesson.json') : !item?.status) continue;
      try {
        const bundle = this.bundleAt(slug)!;
        summaries.push({ id: slug, title: bundle.title, createdAt: bundle.createdAt, status: bundle.status, lessonId: bundle.lessonId,
          sourceCount: bundle.sources.length, visualCount: bundle.sources.reduce((sum, source) => sum + source.inventory.savedVisuals, 0), warningCount: bundle.sources.reduce((sum, source) => sum + source.warnings.length, 0) });
      } catch (caught) {
        if (!(caught instanceof StoreError)) throw caught;
        summaries.push({ id: slug, title, createdAt: item?.createdAt ?? '', status: 'needs-review', sourceCount: 0, visualCount: 0, warningCount: 0, broken: caught.message });
      }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  getBundle(id: string): SourceBundle | undefined {
    const slug = this.resolveId(id);
    return slug ? this.bundleAt(slug) : undefined;
  }
  saveJob(job: PreparationJob): void {
    this.db.prepare('INSERT INTO preparation_jobs (id, document, saved_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document, saved_at=excluded.saved_at').run(job.id, JSON.stringify(job), Date.now());
  }
  listJobs(): PreparationJob[] {
    return this.db.prepare('SELECT document FROM preparation_jobs ORDER BY saved_at DESC, rowid DESC LIMIT 50').all().map(row=>JSON.parse(row.document as string));
  }
  /** Retitles the lesson and its item, and renames the folder to match; reading positions move with it. */
  renameLesson(id: string, title: string): Lesson {
    const lesson = this.get(id);
    if (!lesson) throw new StoreError('Analysis not found.', 404);
    this.writeLesson(lesson.id, parseLesson({ ...this.read(lesson.id, 'lesson.json', lessonSchema)!.value, title }));
    return this.get(this.retitle(lesson.id, title))!;
  }
  /** Retitles the collection (the lesson keeps its own title) and renames the folder to match. */
  renameBundle(id: string, title: string): SourceBundle {
    const bundle = this.getBundle(id);
    if (!bundle) throw new StoreError('Source collection not found.', 404);
    return this.getBundle(this.retitle(bundle.id, title))!;
  }
  /** Removes the lesson (the whole folder unless its sources remain) and its reading positions. Samples stay deleted across restarts. */
  deleteLesson(id: string): void {
    const slug = this.resolveId(id);
    if (!slug || !this.has(slug, 'lesson.json')) throw new StoreError('Analysis not found.', 404);
    const ids = this.idsFor(slug, id);
    let isSample = false;
    try { isSample = !!this.lessonAt(slug)?.isSample; } catch { /* a broken lesson can still be deleted */ }
    this.transaction(() => {
      this.db.prepare('DELETE FROM positions WHERE slug = ?').run(slug);
      if (isSample) for (const value of ids) this.db.prepare('INSERT OR IGNORE INTO deleted_samples (id) VALUES (?)').run(value);
      for (const job of this.allJobs()) if (job.lessonId && ids.has(job.lessonId)) { const { lessonId: _removed, ...rest } = job; this.saveJob(rest); }
    });
    // Decided from the files, not item.json, so a hand-broken item.json never costs the sources.
    if (this.has(slug, 'sources')) {
      for (const file of ['lesson.json', 'lesson.md']) rmSync(join(this.fs.dir(slug), file), { force: true });
      this.tidy(slug);
    } else this.removeFolder(slug);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }
  /** Removes the collection's sources (the whole folder unless a lesson remains) and its preparation history. */
  deleteBundle(id: string): PreparationJob[] {
    const slug = this.resolveId(id);
    const found = slug ? this.item(slug) : undefined;
    if (!slug || !found || (found.error ? this.has(slug, 'lesson.json') : !found.item?.status)) throw new StoreError('Source collection not found.', 404);
    const ids = this.idsFor(slug, id);
    const jobs = this.allJobs().filter(job => ids.has(job.bundleId));
    this.transaction(() => { for (const job of jobs) this.db.prepare('DELETE FROM preparation_jobs WHERE id = ?').run(job.id); });
    if (found.item && this.has(slug, 'lesson.json')) {
      const { status: _status, ...rest } = found.item;
      rmSync(join(this.fs.dir(slug), 'sources'), { recursive: true, force: true });
      this.fs.writeJson(slug, 'item.json', rest);
      this.tidy(slug);
    } else this.removeFolder(slug);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
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
  close(): void {
    if (this.closed) return;
    this.db.close(); this.closed = true;
    if (this.temporaryRoot) rmSync(this.libraryRoot, { recursive: true, force: true });
  }

  private has(slug: string, file: string): boolean { return existsSync(join(this.fs.dir(slug), file)); }
  private text(slug: string, file: string): string | undefined { return this.fs.readBytes(slug, file)?.toString('utf8'); }
  /** Parses a JSON file, cached by inode, modification time and size so hand edits show up on the next request. */
  private read<T>(slug: string, file: string, schema: z.ZodType<T>): Parsed<T> | undefined {
    const path = join(this.fs.dir(slug), file);
    let key: string;
    try { const stat = statSync(path); key = `${stat.ino}:${stat.mtimeMs}:${stat.size}`; } catch { return undefined; }
    const hit = this.cache.get(path);
    let result = hit?.key === key ? hit.result as Parsed<T> : undefined;
    if (!result) {
      const raw = this.fs.readJson<unknown>(slug, file);
      const parsed = raw.error ? undefined : schema.safeParse(raw.value);
      const issue = parsed?.error?.issues[0];
      result = raw.error ? { error: `${file}: ${raw.error}` } : parsed!.success ? { value: parsed!.data } : { error: `${file}: ${issue!.path.join('.') || 'content'}: ${issue!.message}` };
      this.cache.set(path, { key, result });
    }
    return result.value === undefined ? result : { value: structuredClone(result.value) };
  }
  private item(slug: string): { item?: Item; title: string; error?: string } {
    if (!slugPattern.test(slug)) return { title: slug, error: `Folder name "${slug}" must use only lowercase letters, numbers and hyphens.` };
    const result = this.read(slug, 'item.json', itemSchema);
    if (result?.value) return { item: result.value, title: result.value.title };
    const raw = result && this.fs.readJson<{ title?: unknown }>(slug, 'item.json').value;
    return { title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title : slug, error: result?.error ?? 'item.json is missing.' };
  }
  private validItem(slug: string): Item {
    const { item, error } = this.item(slug);
    if (!item) throw new StoreError(error!, 422);
    return item;
  }
  private lessonAt(slug: string): Lesson | undefined {
    const result = this.read(slug, 'lesson.json', lessonSchema);
    if (!result) return undefined;
    const item = this.validItem(slug);
    if (!result.value) throw new StoreError(result.error!, 422);
    return { ...result.value, id: slug, sourceBundleId: item.status ? slug : undefined, assets: result.value.assets.map(asset => ({ ...asset, src: toServedSrc(slug, asset.src) })) };
  }
  private bundleAt(slug: string): SourceBundle | undefined {
    const { item, error } = this.item(slug);
    if (error) { if (this.has(slug, 'lesson.json')) return undefined; throw new StoreError(error, 422); }
    if (!item?.status) return undefined;
    const dir = join(this.fs.dir(slug), 'sources');
    const stems = existsSync(dir) ? readdirSync(dir).filter(file => /^\d{2,}-[a-z0-9-]+\.json$/.test(file)).sort().map(file => file.slice(0, -5)) : [];
    const served = (src?: string) => src && toServedSrc(slug, src);
    const sources = stems.map((stem): CapturedSource => {
      const meta = this.read(slug, `sources/${stem}.json`, sourceMetaSchema)!;
      if (!meta.value) throw new StoreError(meta.error!, 422);
      const rawHtml = this.text(slug, `sources/${stem}.html`);
      return { ...meta.value, markdown: this.text(slug, `sources/${stem}.md`) ?? '', ...(rawHtml !== undefined && { rawHtml }),
        assets: meta.value.assets.map(asset => ({ ...asset, ...(asset.src && { src: served(asset.src) }), ...(asset.originalSrc && { originalSrc: served(asset.originalSrc) }) })) };
    });
    return { id: slug, title: item.title, createdAt: item.createdAt, text: this.text(slug, 'sources/notes.md') ?? '', familiarity: item.level,
      status: item.status, lessonId: this.has(slug, 'lesson.json') ? slug : undefined, sources };
  }
  /**
   * Returns the stored (relative) form of an image path, writing captured bytes or copying another item's media into this folder.
   * Never overwrites a different file of the same name. Paths it cannot resolve are returned unchanged.
   */
  private storeMedia(slug: string, src: string, blobs: Map<string, AssetBlob>, name: ((ext: string) => string) | undefined, written: Map<string, Buffer>): string {
    let bytes: Buffer, file: string;
    const blob = blobs.get(src.match(/^\/api\/source-assets\/([a-f0-9]{64})$/)?.[1] ?? '');
    const other = src.match(/^\/api\/library\/([a-z0-9][a-z0-9-]*)\/media\/([^/]+)$/);
    const otherPath = other && this.mediaPath(other[1], other[2]);
    if (blob && name) { bytes = Buffer.from(blob.bytes); file = name(extByType[blob.type] ?? blob.type.split('/')[1] ?? 'bin'); }
    else if (toStoredSrc(slug, src).startsWith('media/')) return toStoredSrc(slug, src);
    else if (other && otherPath) { bytes = readFileSync(otherPath); file = name?.(extname(other[2]).slice(1)) ?? other[2]; }
    else return src;
    const base = file;
    for (let n = 2; ; n++) {
      const prior = written.get(file) ?? this.fs.readBytes(slug, 'media/' + file);
      if (!prior || prior.equals(bytes)) break;
      file = base.replace(/(\.[^.]+)?$/, `-${n}$1`);
    }
    if (!written.has(file)) { this.fs.writeBytes(slug, 'media/' + file, bytes); written.set(file, bytes); }
    return 'media/' + file;
  }
  private writeLesson(slug: string, lesson: Lesson): void {
    this.fs.writeJson(slug, 'lesson.json', lesson);
    this.fs.writeText(slug, 'lesson.md', renderLessonMarkdown(lesson));
    this.tidy(slug);
  }
  /** After any change: drops media no file references, regenerates CREDITS.md and forgets cached parses. */
  private tidy(slug: string): void {
    this.forget(slug);
    const dir = this.fs.dir(slug);
    const sources = existsSync(join(dir, 'sources')) ? readdirSync(join(dir, 'sources')).filter(file => file.endsWith('.json')).map(file => 'sources/' + file) : [];
    const used = new Set(['lesson.json', ...sources].flatMap(file => [...(this.text(slug, file) ?? '').matchAll(/media\/([A-Za-z0-9._-]+)/g)].map(match => match[1])));
    if (existsSync(join(dir, 'media'))) for (const file of readdirSync(join(dir, 'media'))) if (!used.has(file)) rmSync(join(dir, 'media', file), { recursive: true, force: true });
    const item = this.item(slug).item;
    if (!item) return;
    let captured: CapturedSource[] = [];
    try { captured = (item.status && this.bundleAt(slug)?.sources) || []; } catch { /* a broken source file keeps the previous credits */ return; }
    this.fs.writeText(slug, 'CREDITS.md', renderCredits({ title: item.title, sources: captured, lesson: this.read(slug, 'lesson.json', lessonSchema)?.value }));
  }
  /** Updates item.json's title and renames the folder to its new slug, moving reading positions and remembering the old slug. */
  private retitle(slug: string, title: string): string {
    const item = this.validItem(slug);
    const next = slugify(title, new Set(this.fs.slugs().filter(other => other !== slug)));
    if (next !== slug && existsSync(this.fs.dir(next))) throw new StoreError('Another item already uses that folder name.', 409);
    this.fs.writeJson(slug, 'item.json', { ...item, title, legacyIds: next === slug ? item.legacyIds : [...new Set([...item.legacyIds, slug])] });
    if (next !== slug) {
      this.fs.rename(slug, next);
      this.db.prepare('UPDATE positions SET slug = ? WHERE slug = ?').run(next, slug);
      this.forget(slug);
    }
    this.tidy(next);
    return next;
  }
  private idsFor(slug: string, id: string): Set<string> { return new Set([slug, id, ...(this.item(slug).item?.legacyIds ?? [])]); }
  private removeFolder(slug: string): void { this.fs.remove(slug); this.forget(slug); }
  private forget(slug: string): void {
    const prefix = this.fs.dir(slug) + sep;
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key);
  }
  private allJobs(): PreparationJob[] { return this.db.prepare('SELECT document FROM preparation_jobs').all().map(row => JSON.parse(row.document as string)); }
  private transaction(work: () => void): void {
    this.db.exec('BEGIN');
    try { work(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
