import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { LessonStore } from '../server/store';
import { LibraryFs } from '../server/library';
import { TutorStore } from '../server/tutor-store';
import { PreparationService } from '../server/preparation';
import { migrateToLibrary } from '../server/migrate';
import type { AgentRequest } from '../server/agent-runner';
import { minimalLesson } from './fixture';

const dirs: string[] = []; const stores: LessonStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The schema of the SQLite store before library folders (commit 440ced5).
const legacySchema = `
CREATE TABLE IF NOT EXISTS deleted_samples (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preparation_jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL, saved_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY, document TEXT NOT NULL, saved_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS progress (lesson_id TEXT NOT NULL REFERENCES lessons(id), mode TEXT NOT NULL, block_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (lesson_id, mode));
CREATE TABLE IF NOT EXISTS source_bundles (id TEXT PRIMARY KEY, document TEXT NOT NULL, saved_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS source_assets (id TEXT PRIMARY KEY, bytes BLOB NOT NULL, type TEXT NOT NULL);`;
const inventory = { images: 0, inlineSvg: 0, tables: 0, savedVisuals: 0 };
const ATTENTION = 'c8a2e1f0-0000-4000-8000-00000000000a';
const SECOND = 'c8a2e1f0-0000-4000-8000-00000000000b';
const secondMarkdown = (beta: string) => `# One\n\nAlpha is 1 unit.\n\n# Two\n\n${beta}\n\n# Three\n\nGamma is 3 units.`;
const secondBundle = (beta: string) => ({ id: SECOND, title: 'Second Topic', text: 'Learn it', createdAt: '2026-01-02T00:00:00.000Z', status: 'captured',
  sources: [{ id: 'src-b', title: 'Second page', kind: 'article', url: 'https://example.com/second', markdown: secondMarkdown(beta), assets: [], warnings: [], inventory }] });
const teaching = (section: string, value: string) => ({ id: section, introduction: 'Learn this part.', hostQuestion: 'What does it say?', visuals: [],
  units: [{ id: section + '-u00', walkthrough: `The value ${value} matters here because it sets the scale.`, walkthroughSpoken: 'The value matters.', dialogue: `Picture the value ${value} as a ruler mark.`, dialogueSpoken: 'Picture the value.' }] });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'narad-migrate-')); dirs.push(dir);
  const dbPath = join(dir, 'narad.sqlite');
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } }).png().toBuffer();
  const hash = createHash('sha256').update(png).digest('hex');
  const src = '/api/source-assets/' + hash;
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;'); db.exec(legacySchema);
  db.prepare('INSERT INTO source_assets (id, bytes, type) VALUES (?, ?, ?)').run(hash, png, 'image/png');
  const attention = { id: ATTENTION, title: 'Attention Paper', text: 'Teach attention', createdAt: '2026-01-01T00:00:00.000Z', status: 'captured', familiarity: 'foundational',
    sources: [{ id: 'src-a', title: 'Attention page', kind: 'article', url: 'https://example.com/attention', markdown: '# Attention\n\nA delay of 42 ms.\n\n![Chart](source-asset-0)',
      assets: [{ id: 'source-asset-0', kind: 'image', alt: 'Chart', caption: 'Delay chart', src, originalSrc: src, originalUrl: 'https://example.com/chart.png' }],
      warnings: ['A table contains merged cells. Spans are flattened.'], inventory: { ...inventory, images: 1, savedVisuals: 1 } }] };
  db.prepare('INSERT INTO source_bundles (id, document, saved_at) VALUES (?, ?, ?)').run(ATTENTION, JSON.stringify(attention), 1);
  db.prepare('INSERT INTO source_bundles (id, document, saved_at) VALUES (?, ?, ?)').run(SECOND, JSON.stringify(secondBundle('Beta is 2 units.')), 2);
  const lesson = { ...minimalLesson(), id: 'lesson-old-1', title: 'Attention lesson', sourceBundleId: ATTENTION,
    assets: [{ id: 'r0-source-asset-0', src, alt: 'Chart', caption: 'Delay chart', provenance: 'source', kind: 'image' }] };
  db.prepare('INSERT INTO lessons (id, document, saved_at) VALUES (?, ?, ?)').run(lesson.id, JSON.stringify(lesson), 3);
  const solo = { ...minimalLesson(), id: 'lesson-solo', title: 'Solo notes' };
  db.prepare('INSERT INTO lessons (id, document, saved_at) VALUES (?, ?, ?)').run(solo.id, JSON.stringify(solo), 4);
  db.prepare('INSERT INTO progress (lesson_id, mode, block_id, updated_at) VALUES (?, ?, ?, ?)').run('lesson-old-1', 'walkthrough', 'block-b', 5);
  const job = (id: string, bundleId: string, status: string, lessonId?: string) => db.prepare('INSERT INTO preparation_jobs (id, document, saved_at) VALUES (?, ?, ?)')
    .run(id, JSON.stringify({ id, bundleId, title: 'x', provider: 'claude', status, stage: '', completed: 2, total: 3, createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z', ...(lessonId && { lessonId }) }), 6);
  job('job-a', ATTENTION, 'completed', 'lesson-old-1');
  job('job-b', SECOND, 'interrupted');
  db.close();
  // Old preparation scratch folders.
  const prep = (id: string, files: Record<string, unknown>) => { mkdirSync(join(dir, 'preparations', id), { recursive: true }); for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, 'preparations', id, name), typeof value === 'string' ? value : JSON.stringify(value)); };
  prep('job-a', { 'source-snapshot.json': attention, 'r0-s00-p0.approved.json': teaching('s00', '42'), 'lesson.json': lesson });
  // The snapshot's second section differs from the source as it is now, so that approved section must not be imported,
  // even though its teaching would still pass the section checks.
  prep('job-b', { 'source-snapshot.json': secondBundle('Beta was roughly 2 units.'), 'r0-s00-p0.approved.json': teaching('s00', '1'), 'r0-s01-p0.approved.json': teaching('s01', '2'),
    'r0-s02-p0.approved.json': teaching('s02', '3'), 'r0-s00-p0.prompt.txt': 'prompt', 'agent.events.log': 'log' });
  prep('job-orphan', { 'notes.txt': 'no job record' });
  const store = new LessonStore(dbPath, join(dir, 'library')); stores.push(store);
  return { dir, dbPath, store, png };
}
const legacyCounts = (dbPath: string) => {
  const db = new DatabaseSync(dbPath);
  try { return Object.fromEntries(['lessons', 'progress', 'source_bundles', 'source_assets'].map(table => [table, (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n])); }
  finally { db.close(); }
};

it('migrates bundles, lessons, images, positions and preparation folders, then removes the legacy rows', async () => {
  const { dir, dbPath, store, png } = await fixture();
  const tutorDbPath = join(dir, 'tutor.sqlite');
  const tutorStore = new TutorStore(tutorDbPath);
  tutorStore.save({ id: 'turn-1', lessonId: 'lesson-old-1', mode: 'walkthrough', blockId: 'block-b', status: 'answered' } as any);
  const tutors = { moveLesson: vi.fn((from: string, to: string) => tutorStore.moveLesson(from, to)) };
  const result = migrateToLibrary({ dbPath, dataDir: dir, store, tutors, tutorDbPath });
  expect(result.skipped.filter(s => !s.includes('job-orphan'))).toEqual([]);
  expect(result.migrated).toBe(3);
  expect(tutorStore.list('attention-paper')).toHaveLength(1);
  tutorStore.close();

  const slug = store.resolveId('lesson-old-1')!;
  expect(slug).toBe('attention-paper');
  expect(store.resolveId(ATTENTION)).toBe(slug);
  const folder = join(store.libraryRoot, slug);
  const lessonJson = JSON.parse(readFileSync(join(folder, 'lesson.json'), 'utf8'));
  expect(lessonJson.assets[0].src).toMatch(/^media\//);
  expect(readFileSync(join(folder, lessonJson.assets[0].src))).toEqual(png);
  const bundle = store.getBundle(slug)!;
  expect(bundle.sources[0].assets[0].src).toMatch(new RegExp(`^/api/library/${slug}/media/`));
  expect(bundle.sources[0].assets[0].credit).toMatchObject({ pageTitle: 'Attention page', pageUrl: 'https://example.com/attention', mediaUrl: 'https://example.com/chart.png', caption: 'Delay chart' });
  expect(bundle.sources[0].warnings).toEqual([{ kind: 'info', message: 'A table contains merged cells. Spans are flattened.' }]);
  const meta = JSON.parse(readFileSync(join(folder, 'sources', readdirSync(join(folder, 'sources')).find(f => f.endsWith('.json'))!), 'utf8'));
  expect(meta.warnings[0]).toEqual({ kind: 'info', message: 'A table contains merged cells. Spans are flattened.' });
  const credits = readFileSync(join(folder, 'CREDITS.md'), 'utf8');
  expect(credits).toContain('Attention page'); expect(credits).toContain('https://example.com/attention');
  expect(store.getProgress(slug)).toEqual({ lastMode: 'walkthrough', positions: { walkthrough: 'block-b' } });
  expect(store.getProgress('lesson-old-1').positions.walkthrough).toBe('block-b');

  const solo = store.resolveId('lesson-solo')!;
  expect(readdirSync(join(store.libraryRoot, solo)).sort()).toEqual(['CREDITS.md', 'item.json', 'lesson.json', 'lesson.md']);
  expect(tutors.moveLesson).toHaveBeenCalledWith('lesson-old-1', slug);
  expect(tutors.moveLesson).toHaveBeenCalledWith('lesson-solo', solo);

  // Preparation folders move into their item; one with no matching item stays and is reported.
  expect(existsSync(join(folder, 'preparation', 'runs', 'legacy-job-a', 'lesson.json'))).toBe(true);
  expect(existsSync(join(dir, 'preparations', 'job-a'))).toBe(false);
  expect(existsSync(join(dir, 'preparations', 'job-orphan', 'notes.txt'))).toBe(true);
  expect(result.skipped.some(s => s.includes('job-orphan'))).toBe(true);
  expect(result.salvaged[slug]).toBeUndefined();
  expect(existsSync(join(folder, 'preparation', 'progress.json'))).toBe(false);

  expect(legacyCounts(dbPath)).toEqual({ lessons: 0, progress: 0, source_bundles: 0, source_assets: 0 });
  const backups = readdirSync(join(dir, 'backups')).sort();
  expect(backups).toHaveLength(2); expect(backups[0]).toMatch(/^narad-.+\.sqlite$/); expect(backups[1]).toMatch(/^tutor-.+\.sqlite$/);
  expect(legacyCounts(join(dir, 'backups', backups[0]))).toEqual({ lessons: 2, progress: 1, source_bundles: 2, source_assets: 1 });
  // The tutor backup was taken before threads moved to the new folder name.
  const tutorBackup = new DatabaseSync(join(dir, 'backups', backups[1]));
  expect(tutorBackup.prepare('SELECT lesson_id FROM tutor_turns').all()).toEqual([{ lesson_id: 'lesson-old-1' }]);
  tutorBackup.close();
});

it('salvages only approved sections whose source still matches and Continue resumes from them', async () => {
  const { dir, dbPath, store } = await fixture();
  const result = migrateToLibrary({ dbPath, dataDir: dir, store });
  const slug = store.resolveId(SECOND)!;
  expect(slug).toBe('second-topic');
  expect(result.salvaged).toEqual({ [slug]: 2 });
  const prep = join(store.libraryRoot, slug, 'preparation');
  expect(existsSync(join(prep, 'runs', 'legacy-job-b', 'r0-s01-p0.approved.json'))).toBe(true);
  expect(readdirSync(join(prep, 'sections')).sort()).toEqual(['r0-s00-p0.json', 'r0-s02-p0.json']);
  const progress = JSON.parse(readFileSync(join(prep, 'progress.json'), 'utf8'));
  expect(progress.status).toBe('interrupted');
  expect(progress.provider).toBe('claude');
  expect(Object.fromEntries(Object.entries(progress.sections).map(([task, s]: [string, any]) => [task, s.state]))).toEqual({ 'r0-s00-p0': 'done', 'r0-s01-p0': 'waiting', 'r0-s02-p0': 'done' });

  const authored: string[] = [];
  const run = async (r: AgentRequest) => {
    if (r.kind === 'review') return { approved: true, issues: [] };
    if (r.kind === 'summary') return { sections: [{ title: 'In brief', markdown: 'Values.', spokenText: 'Values.', sourceIds: ['src-b'] }, { title: 'Takeaway', markdown: 'Values matter.', spokenText: 'Values matter.', sourceIds: ['src-b'] }] };
    authored.push(r.prompt.match(/"id":"(s\d\d)"/)![1]);
    return { ...teaching('s01', '2'), units: teaching('s01', '2').units.map(u => ({ ...u, question: null })) };
  };
  const service = new PreparationService(store, dir, { run, available: () => [{ id: 'claude', available: true }] });
  await service.ready;
  expect(service.state().jobs.find(job => job.slug === slug)).toMatchObject({ status: 'interrupted', completed: 2, total: 3 });
  service.start(slug, 'claude');
  await expect.poll(() => service.state().jobs.find(job => job.slug === slug)?.status, { timeout: 3000 }).toBe('completed');
  expect(authored).toEqual(['s01']);
  await service.shutdown();
});

it('changes nothing when run a second time', async () => {
  const { dir, dbPath, store } = await fixture();
  const tutors = { moveLesson: vi.fn() };
  migrateToLibrary({ dbPath, dataDir: dir, store, tutors });
  const snapshot = () => readdirSync(store.libraryRoot, { recursive: true }).map(String).sort().map(file => file + ':' + safeRead(join(store.libraryRoot, file)));
  const before = snapshot();
  const again = migrateToLibrary({ dbPath, dataDir: dir, store, tutors });
  expect(again.migrated).toBe(0);
  expect(again.salvaged).toEqual({});
  expect(snapshot()).toEqual(before);
  expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
});
const safeRead = (path: string) => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return 'dir'; } };

/** Makes the library writer throw for one item's files, as a crash part-way through writing that item would. */
const failWrites = (slug: string, file: RegExp) => {
  const original = LibraryFs.prototype.writeBytes;
  return vi.spyOn(LibraryFs.prototype, 'writeBytes').mockImplementation(function (this: LibraryFs, s: string, f: string, bytes: Uint8Array) {
    if (s === slug && file.test(f)) throw new Error('disk full');
    return original.call(this, s, f, bytes);
  });
};
const folders = (store: LessonStore) => readdirSync(store.libraryRoot);

it('keeps every legacy row when any item fails, reports it, and finishes on the next start', async () => {
  const { dir, dbPath, store } = await fixture();
  const spy = failWrites('second-topic', /^sources\//);
  const result = migrateToLibrary({ dbPath, dataDir: dir, store });
  expect(result.skipped.some(s => s.includes(SECOND) && s.includes('disk full'))).toBe(true);
  expect(legacyCounts(dbPath)).toEqual({ lessons: 2, progress: 1, source_bundles: 2, source_assets: 1 });
  // Folders that did migrate are served meanwhile, and their preparation folders already moved.
  expect(store.get('lesson-old-1')?.title).toBe('Attention lesson');
  expect(existsSync(join(dir, 'preparations', 'job-b'))).toBe(true);
  expect(folders(store).sort()).toEqual(['attention-paper', 'solo-notes']);

  spy.mockRestore();
  const retry = migrateToLibrary({ dbPath, dataDir: dir, store });
  expect(retry.skipped.filter(s => !s.includes('job-orphan'))).toEqual([]);
  expect(retry.migrated).toBe(1);
  expect(retry.salvaged).toEqual({ 'second-topic': 2 });
  expect(legacyCounts(dbPath)).toEqual({ lessons: 0, progress: 0, source_bundles: 0, source_assets: 0 });
  expect(store.list().filter(item => item.id === 'attention-paper')).toHaveLength(1);
});

it.each([
  ['a collection before its item.json', 'attention-paper', /^media\//],
  ['a collection after its item.json', 'second-topic', /^sources\//],
  ['a standalone lesson after its item.json', 'solo-notes', /^lesson\.json$/],
])('a crash while writing %s leaves exactly one folder per item after the retry', async (_label, slug, file) => {
  const { dir, dbPath, store } = await fixture();
  failWrites(slug, file);
  const first = migrateToLibrary({ dbPath, dataDir: dir, store });
  expect(first.skipped.some(s => s.includes('disk full'))).toBe(true);
  expect(folders(store)).not.toContain(slug);
  expect(legacyCounts(dbPath).lessons).toBe(2);
  vi.restoreAllMocks();
  const retry = migrateToLibrary({ dbPath, dataDir: dir, store });
  expect(retry.skipped.filter(s => !s.includes('job-orphan'))).toEqual([]);
  expect(folders(store).sort()).toEqual(['attention-paper', 'second-topic', 'solo-notes']);
  expect(store.get('lesson-old-1')!.id).toBe('attention-paper');
  expect(store.get('lesson-solo')!.id).toBe('solo-notes');
  expect(store.getBundle(SECOND)!.id).toBe('second-topic');
  expect(legacyCounts(dbPath)).toEqual({ lessons: 0, progress: 0, source_bundles: 0, source_assets: 0 });
});

it('a crash after an item is placed but before it is recorded finishes without a duplicate', async () => {
  const { dir, dbPath, store } = await fixture();
  const first = migrateToLibrary({ dbPath, dataDir: dir, store, tutors: { moveLesson: (from) => { if (from === 'lesson-solo') throw new Error('stopped'); } } });
  expect(first.skipped.some(s => s.includes('lesson-solo') && s.includes('stopped'))).toBe(true);
  expect(legacyCounts(dbPath).lessons).toBe(2);
  const moved: string[] = [];
  const retry = migrateToLibrary({ dbPath, dataDir: dir, store, tutors: { moveLesson: (from, to) => { moved.push(`${from}->${to}`); } } });
  expect(retry.skipped.filter(s => !s.includes('job-orphan'))).toEqual([]);
  expect(retry.migrated).toBe(0);
  expect(moved).toEqual(['lesson-solo->solo-notes']);
  expect(folders(store).sort()).toEqual(['attention-paper', 'second-topic', 'solo-notes']);
  expect(legacyCounts(dbPath).lessons).toBe(0);
});

it('removes staging folders left by a crash before migrating', async () => {
  const { dir, dbPath, store } = await fixture();
  mkdirSync(join(store.libraryRoot, '_migrating-leftover', 'attention-paper', 'media'), { recursive: true });
  writeFileSync(join(store.libraryRoot, '_migrating-leftover', 'attention-paper', 'item.json'), '{"title":"Half"}');
  migrateToLibrary({ dbPath, dataDir: dir, store });
  expect(folders(store).sort()).toEqual(['attention-paper', 'second-topic', 'solo-notes']);
});

it('never re-checks or brings back an item already migrated, even after the user edits or deletes it', async () => {
  const { dir, dbPath, store } = await fixture();
  const spy = failWrites('second-topic', /^sources\//);
  migrateToLibrary({ dbPath, dataDir: dir, store });
  spy.mockRestore();
  const sources = join(store.libraryRoot, 'attention-paper', 'sources');
  const markdown = join(sources, readdirSync(sources).find(f => f.endsWith('.md') && f !== 'notes.md')!);
  writeFileSync(markdown, readFileSync(markdown, 'utf8') + '\n\nMy own note.');
  rmSync(join(store.libraryRoot, 'solo-notes'), { recursive: true });
  const retry = migrateToLibrary({ dbPath, dataDir: dir, store });
  expect(retry.skipped.filter(s => !s.includes('job-orphan'))).toEqual([]);
  expect(readFileSync(markdown, 'utf8')).toContain('My own note.');
  expect(folders(store).sort()).toEqual(['attention-paper', 'second-topic']);
  expect(store.get('lesson-solo')).toBeUndefined();
  expect(legacyCounts(dbPath)).toEqual({ lessons: 0, progress: 0, source_bundles: 0, source_assets: 0 });
});

it('reports a corrupt legacy row, migrates the rest, and keeps every row', async () => {
  const { dir, dbPath, store } = await fixture();
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO source_bundles (id, document, saved_at) VALUES (?, ?, ?)').run('bad-bundle', '{not json', 9);
  db.prepare('INSERT INTO preparation_jobs (id, document, saved_at) VALUES (?, ?, ?)').run('bad-job', 'nope', 9);
  db.close();
  const result = migrateToLibrary({ dbPath, dataDir: dir, store });
  expect(result.skipped.some(s => s.includes('bad-bundle'))).toBe(true);
  expect(result.skipped.some(s => s.includes('bad-job'))).toBe(true);
  expect(folders(store).sort()).toEqual(['attention-paper', 'second-topic', 'solo-notes']);
  expect(legacyCounts(dbPath)).toEqual({ lessons: 2, progress: 1, source_bundles: 3, source_assets: 1 });
});

it('does nothing, and makes no backup, when there is no legacy data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'narad-migrate-')); dirs.push(dir);
  const store = new LessonStore(join(dir, 'narad.sqlite'), join(dir, 'library')); stores.push(store);
  expect(migrateToLibrary({ dbPath: join(dir, 'narad.sqlite'), dataDir: dir, store })).toEqual({ migrated: 0, salvaged: {}, skipped: [] });
  expect(existsSync(join(dir, 'backups'))).toBe(false);
});

it.each([false, true])('salvages matching sections from every legacy run, newest job first (older run files touched last: %s)', async (touchOld) => {
  const { dir, dbPath, store } = await fixture();
  // A newer run of the same collection that approved only its first section, with different teaching for it.
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO preparation_jobs (id, document, saved_at) VALUES (?, ?, ?)').run('job-c', JSON.stringify({ id: 'job-c', bundleId: SECOND, title: 'x', provider: 'claude',
    status: 'interrupted', stage: '', completed: 1, total: 3, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }), 7);
  db.close();
  const folder = join(dir, 'preparations', 'job-c'); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'source-snapshot.json'), JSON.stringify(secondBundle('Beta is 2 units.')));
  writeFileSync(join(folder, 'r0-s00-p0.approved.json'), JSON.stringify({ ...teaching('s00', '1'), introduction: 'Newer introduction.' }));
  // Touching the older run's files last makes file times wrongly rank it newest; the job's createdAt must decide.
  const old = join(dir, 'preparations', 'job-b');
  const later = new Date(Date.now() + 60_000);
  if (touchOld) for (const file of readdirSync(old)) utimesSync(join(old, file), later, later);
  const result = migrateToLibrary({ dbPath, dataDir: dir, store });
  const slug = store.resolveId(SECOND)!;
  expect(result.salvaged).toEqual({ [slug]: 2 });
  const sections = join(store.libraryRoot, slug, 'preparation', 'sections');
  expect(readdirSync(sections).sort()).toEqual(['r0-s00-p0.json', 'r0-s02-p0.json']);
  expect(JSON.parse(readFileSync(join(sections, 'r0-s00-p0.json'), 'utf8')).teaching.introduction).toBe('Newer introduction.');
  const progress = JSON.parse(readFileSync(join(store.libraryRoot, slug, 'preparation', 'progress.json'), 'utf8'));
  expect(progress.runId).toBe('legacy-job-c');
});

it('keeps image credits on migrated lesson assets', async () => {
  const { dir, dbPath, store } = await fixture();
  migrateToLibrary({ dbPath, dataDir: dir, store });
  const lessonJson = JSON.parse(readFileSync(join(store.libraryRoot, 'attention-paper', 'lesson.json'), 'utf8'));
  expect(lessonJson.assets[0].credit).toMatchObject({ pageTitle: 'Attention page', pageUrl: 'https://example.com/attention', mediaUrl: 'https://example.com/chart.png' });
});

it('does not make another backup on each start while an item keeps failing', async () => {
  const { dir, dbPath, store } = await fixture();
  failWrites('second-topic', /^sources\//);
  const tutorDbPath = join(dir, 'tutor.sqlite'); new TutorStore(tutorDbPath).close();
  for (let n = 0; n < 3; n++) expect(migrateToLibrary({ dbPath, dataDir: dir, store, tutorDbPath }).skipped.some(s => s.includes('disk full'))).toBe(true);
  expect(readdirSync(join(dir, 'backups')).sort().map(f => f.split('-')[0])).toEqual(['narad', 'tutor']);
  vi.restoreAllMocks();
  migrateToLibrary({ dbPath, dataDir: dir, store, tutorDbPath });
  expect(readdirSync(join(dir, 'backups'))).toHaveLength(2);
  expect(legacyCounts(dbPath).lessons).toBe(0);
});
