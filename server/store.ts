import { DatabaseSync } from 'node:sqlite';
import { parseLesson, modes, type Lesson, type LessonSummary, type Mode, type Progress } from '../shared/lesson';
import { flattenBlocks } from '../shared/navigation';

export class StoreError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export class LessonStore {
  private db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY, document TEXT NOT NULL, saved_at INTEGER NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS progress (lesson_id TEXT NOT NULL REFERENCES lessons(id), mode TEXT NOT NULL, block_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (lesson_id, mode));');
  }
  list(): LessonSummary[] {
    return this.db.prepare('SELECT document FROM lessons ORDER BY saved_at DESC, id ASC').all().map(row => {
      const lesson = parseLesson(JSON.parse(row.document as string));
      const { id, title, description, topic, createdAt, isSample, familiarity } = lesson;
      return { id, title, description, topic, createdAt, isSample, familiarity,
        availableModes: modes.filter(mode => lesson.modes[mode]), sourceCount: lesson.sources.length,
        blockCount: flattenBlocks(lesson, lesson.modes.walkthrough ? 'walkthrough' : modes.find(mode => lesson.modes[mode])!).length };
    });
  }
  insert(input: unknown): Lesson {
    const lesson = parseLesson(input);
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
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
