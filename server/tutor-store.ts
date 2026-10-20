import { DatabaseSync } from 'node:sqlite';
import { modes, type Mode } from '../shared/lesson';
import type { TutorTurn } from '../shared/tutor';

export class TutorStore {
  private db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
    this.db.exec('CREATE TABLE IF NOT EXISTS tutor_turns (id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, mode TEXT NOT NULL, block_id TEXT NOT NULL, document TEXT NOT NULL, saved_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS tutor_turn_anchor ON tutor_turns(lesson_id, mode, block_id, saved_at);');
    const active = this.db.prepare("SELECT id, document FROM tutor_turns WHERE json_extract(document, '$.status') IN ('queued','reading','answering')").all();
    for (const row of active) {
      const turn = JSON.parse(row.document as string) as TutorTurn;
      this.save({ ...turn, status: 'failed', stage: 'Interrupted', error: 'Narad stopped before this answer finished.', updatedAt: new Date().toISOString() });
    }
  }
  save(turn: TutorTurn): TutorTurn {
    this.db.prepare('INSERT INTO tutor_turns (id, lesson_id, mode, block_id, document, saved_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document, saved_at=excluded.saved_at')
      .run(turn.id, turn.lessonId, turn.mode, turn.blockId, JSON.stringify(turn), Date.now());
    return turn;
  }
  get(id: string): TutorTurn | undefined {
    const row = this.db.prepare('SELECT document FROM tutor_turns WHERE id = ?').get(id);
    return row ? JSON.parse(row.document as string) as TutorTurn : undefined;
  }
  list(lessonId: string, mode?: Mode): TutorTurn[] {
    if (mode && !modes.includes(mode)) return [];
    const rows = mode
      ? this.db.prepare('SELECT document FROM tutor_turns WHERE lesson_id = ? AND mode = ? ORDER BY saved_at, rowid').all(lessonId, mode)
      : this.db.prepare('SELECT document FROM tutor_turns WHERE lesson_id = ? ORDER BY saved_at, rowid').all(lessonId);
    return rows.map(row => JSON.parse(row.document as string) as TutorTurn);
  }
  delete(id: string): boolean { return this.db.prepare('DELETE FROM tutor_turns WHERE id = ?').run(id).changes > 0; }
  deleteLesson(lessonId: string): void { this.db.prepare('DELETE FROM tutor_turns WHERE lesson_id = ?').run(lessonId); }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}

