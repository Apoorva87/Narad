import { useState } from 'react';
import { Search, BookOpen, FilePlus2, FolderOpen, Pencil, Trash2, Check, X, LoaderCircle, Settings2 } from 'lucide-react';
import type { LessonSummary } from '../../shared/lesson';
import { familiarityLabels } from '../../shared/lesson';
import type { BundleSummary } from '../../shared/sources';
import { api } from '../lib/api';
import { Modal } from './Modal';

type Item = { kind: 'lesson'; id: string; title: string; createdAt: string; lesson: LessonSummary } | { kind: 'sources'; id: string; title: string; createdAt: string; bundle: BundleSummary };
function searchable(value: string) { return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
function shortDate(iso: string) {
  const date = new Date(iso); const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today, ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function Library({ lessons, bundles, onOpen, onBundle, onImport, onChanged, onSettings }: { lessons: LessonSummary[]; bundles: BundleSummary[]; onOpen: (id: string) => void; onBundle: (id: string) => void; onImport: () => void; onChanged: () => void; onSettings: () => void }) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [renameError, setRenameError] = useState('');
  const [deleting, setDeleting] = useState<Item | null>(null);
  const search = searchable(query);
  const pendingBundles = bundles.filter(bundle => !bundle.lessonId);
  const items: Item[] = [
    ...lessons.map(lesson => ({ kind: 'lesson' as const, id: lesson.id, title: lesson.title, createdAt: lesson.createdAt, lesson })),
    ...pendingBundles.map(bundle => ({ kind: 'sources' as const, id: bundle.id, title: bundle.title, createdAt: bundle.createdAt, bundle })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const filtered = items.filter(item => searchable(item.kind === 'lesson' ? item.title + ' ' + item.lesson.description + ' ' + item.lesson.topic : item.title).includes(search));
  async function rename(item: Item) {
    const title = editing?.title.trim() ?? '';
    if (!title || title === item.title) { setEditing(null); return; }
    try { await (item.kind === 'lesson' ? api.renameLesson(item.id, title) : api.renameBundle(item.id, title)); setEditing(null); setRenameError(''); onChanged(); }
    catch (error) { setRenameError(error instanceof Error ? error.message : 'Could not rename.'); }
  }
  return <div className="library-view">
    <div className="library-heading"><div><h1>Your learning library</h1><p className="page-description">{lessons.length} {lessons.length === 1 ? 'lesson' : 'lessons'}{pendingBundles.length ? ' · ' + pendingBundles.length + ' awaiting preparation' : ''}</p></div>
      <div className="library-actions"><label className="search"><Search size={17} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a topic or lesson…" aria-label="Search lessons" /></label>
        <button className="primary-button" onClick={onImport}><FilePlus2 size={17} />Add a lesson</button>
        <button className="icon-button settings-button" onClick={onSettings} aria-label="Settings" title="Settings"><Settings2 size={19} /></button></div></div>
    {filtered.length > 0 && <ul className="library-list" aria-label="Library items, newest first">
      {filtered.map(item => {
        const lesson = item.kind === 'lesson' ? item.lesson : undefined; const bundle = item.kind === 'sources' ? item.bundle : undefined;
        const detail = lesson
          ? [lesson.isSample ? 'Sample lesson' : 'Lesson', familiarityLabels[lesson.familiarity], lesson.availableModes.length + (lesson.availableModes.length === 1 ? ' mode' : ' modes'), lesson.sourceCount + (lesson.sourceCount === 1 ? ' source' : ' sources')]
          : ['Sources', bundle!.sourceCount + (bundle!.sourceCount === 1 ? ' source' : ' sources'), bundle!.visualCount + ' visuals'];
        return <li key={item.kind + item.id} className={'library-row ' + (lesson ? 'lesson-row' : 'source-row')}>
          {editing?.id === item.id
            ? <form className="row-rename" onSubmit={event => { event.preventDefault(); void rename(item); }}>
                <span className="row-icon">{lesson ? <BookOpen size={18} /> : <FolderOpen size={18} />}</span>
                <input autoFocus value={editing.title} maxLength={180} aria-label="New title" onChange={event => setEditing({ id: item.id, title: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') { setEditing(null); setRenameError(''); } }} />
                <button type="submit" className="icon-button" aria-label="Save title"><Check size={17} /></button>
                <button type="button" className="icon-button" aria-label="Cancel rename" onClick={() => { setEditing(null); setRenameError(''); }}><X size={17} /></button>
                {renameError && <p className="row-error" role="alert">{renameError}</p>}
              </form>
            : <button className="library-row-main" onClick={() => lesson ? onOpen(item.id) : onBundle(item.id)}>
                <span className="row-icon">{lesson ? <BookOpen size={18} /> : <FolderOpen size={18} />}</span>
                <span className="row-text"><strong>{item.title}</strong>
                  {lesson && <span className="row-description">{lesson.description}</span>}
                  <small>{detail.join(' · ')}<span className="row-date-inline"> · {shortDate(item.createdAt)}</span>{bundle && <em className={bundle.warningCount ? 'needs-review' : ''}>{bundle.warningCount ? bundle.warningCount + ' capture issues to review' : 'Awaiting preparation'}</em>}</small></span>
                <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{shortDate(item.createdAt)}</time>
              </button>}
          {editing?.id !== item.id && <div className="row-actions">
            <button className="icon-button" aria-label={'Rename ' + item.title} title="Rename" onClick={() => { setEditing({ id: item.id, title: item.title }); setRenameError(''); }}><Pencil size={15} /></button>
            <button className="icon-button danger" aria-label={'Delete ' + item.title} title="Delete" onClick={() => setDeleting(item)}><Trash2 size={15} /></button>
          </div>}
        </li>;
      })}
    </ul>}
    {!filtered.length && <div className="empty-state"><Search size={26} /><h3>{query ? 'No matching library items' : 'Your next idea belongs here'}</h3><p>{query ? 'Try a different topic or clear your search.' : 'Add an idea, a source, or a prepared lesson to start your library.'}</p>{query && <button className="secondary-button" onClick={() => setQuery('')}>Clear search</button>}</div>}
    {deleting && <DeleteDialog item={deleting} hasSources={deleting.kind === 'lesson' && !!deleting.lesson.sourceBundleId && bundles.some(bundle => bundle.id === deleting.lesson.sourceBundleId)} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); onChanged(); }} />}
  </div>;
}

function DeleteDialog({ item, hasSources, onClose, onDeleted }: { item: Item; hasSources: boolean; onClose: () => void; onDeleted: () => void }) {
  const [withSources, setWithSources] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function remove() {
    setBusy(true); setError('');
    try { await (item.kind === 'lesson' ? api.deleteLesson(item.id, hasSources && withSources) : api.deleteBundle(item.id)); onDeleted(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not delete.'); setBusy(false); }
  }
  return <Modal title={'Delete “' + item.title + '”?'} onClose={() => { if (!busy) onClose(); }}>
    <p className="modal-description">{item.kind === 'lesson'
      ? 'This permanently removes the lesson and your reading positions from this Mac.' + (item.lesson.isSample ? ' Deleted sample lessons are not restored.' : '')
      : 'This permanently removes the saved sources, captured images, and any preparation drafts from this Mac.'} This cannot be undone.</p>
    {hasSources && <label className="delete-option"><input type="checkbox" checked={withSources} onChange={event => setWithSources(event.target.checked)} disabled={busy} />Also delete its saved sources and preparation drafts</label>}
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button danger-button" onClick={() => void remove()} disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}Delete permanently</button></div>
  </Modal>;
}
