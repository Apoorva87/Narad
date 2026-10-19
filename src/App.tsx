import { useEffect, useState } from 'react';
import { BookOpen, Library as LibraryIcon, PanelLeftClose, PanelLeftOpen, Plus, CircleHelp, ChevronRight, LoaderCircle } from 'lucide-react';
import type { Lesson, LessonSummary } from '../shared/lesson';
import { api } from './lib/api';
import { Library } from './components/Library';
import { Reader } from './components/Reader';
import { ImportDialog } from './components/ImportDialog';
import { Modal } from './components/Modal';
import { AddLessonDialog } from './components/AddLessonDialog';
import { SourcePreview } from './components/SourcePreview';
import type { BundleSummary, SourceBundle } from '../shared/sources';

function routeId() {
  const match = location.hash.match(/^#lesson\/([a-zA-Z0-9_-]+)$/);
  return match?.[1] ?? null;
}
function sourceRouteId() { return location.hash.match(/^#sources\/([a-zA-Z0-9_-]+)$/)?.[1] ?? null; }
export default function App() {
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(routeId);
  const [sourceId, setSourceId] = useState<string | null>(sourceRouteId);
  const [bundle, setBundle] = useState<SourceBundle | null>(null);
  const [bundles, setBundles] = useState<BundleSummary[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const onHash = () => { setSelected(routeId()); setSourceId(sourceRouteId()); window.scrollTo({ top: 0 }); setSidebarOpen(false); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    let cancelled = false; setLoading(true); setError(''); setLesson(null); setBundle(null);
    Promise.all([api.list(), selected ? api.lesson(selected) : Promise.resolve(null), api.bundles(), sourceId ? api.bundle(sourceId) : Promise.resolve(null)]).then(([list, document, sources, collection]) => {
      if (!cancelled) { setLessons(list); setLesson(document); setBundles(sources); setBundle(collection); setLoading(false); }
    }).catch(error => { if (!cancelled) { setError(error.message || 'Could not connect to the local server.'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [selected, sourceId, reload]);
  function open(id: string) { location.hash = 'lesson/' + id; }
  function openBundle(id: string) { location.hash = 'sources/' + id; }
  function back() { location.hash = ''; }
  return <div className={'app-shell' + (sidebarOpen ? ' sidebar-open' : '')}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); const main = document.getElementById('main-content'); main?.focus(); main?.scrollIntoView(); }}>Skip to content</a>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className="sidebar">
      <button className="brand" onClick={back} aria-label="Narad home"><img className="brand-symbol" src="/narad-mark.svg" alt="" /><span>Narad<span className="brand-subtitle">A space to understand</span></span></button>
      <nav aria-label="Main navigation"><button className={'nav-item' + (!selected && !sourceId ? ' selected' : '')} onClick={back}><LibraryIcon size={19} />Your library<span className="nav-count">{lessons.length}</span></button><button className="nav-item" onClick={() => { setAddOpen(true); setSidebarOpen(false); }}><Plus size={19} />Add a lesson</button></nav>
      <div className="sidebar-lessons"><p>Saved analyses</p>{lessons.map(item => <button key={item.id} className={'sidebar-lesson' + (selected === item.id ? ' current' : '')} onClick={() => open(item.id)}><BookOpen size={15} /><span>{item.title}</span></button>)}</div>
      <div className="sidebar-bottom"><button className="nav-item" onClick={() => setAboutOpen(true)}><CircleHelp size={18} />About this preview</button><div className="local-status"><span />Saved on this Mac</div></div>
    </aside>
    <div className="workspace"><header className="workspace-header"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle navigation">{sidebarOpen ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}</button><span>Learning workspace</span>{(selected || sourceId) && <><ChevronRight size={14} /><span>{sourceId ? 'Sources' : 'Reader'}</span></>}</div><span className="preview-label">Part 2A of 4 <span>·</span> Source intake</span></header>
      <div id="main-content" tabIndex={-1}>{loading ? <div className="loading-state" role="status"><LoaderCircle size={28} className="spin" /><p>Opening your library…</p></div> : error ? <div className="page-error" role="alert"><h1>Could not open this view</h1><p>{error}</p><button className="primary-button" onClick={() => setReload(value => value + 1)}>Try again</button>{(selected || sourceId) && <button className="secondary-button" onClick={back}>Back to library</button>}</div> : bundle ? <SourcePreview key={bundle.id} bundle={bundle} onBack={back} /> : lesson ? <Reader key={lesson.id} lesson={lesson} onBack={back} /> : <Library lessons={lessons} bundles={bundles} onOpen={open} onBundle={openBundle} onImport={() => setAddOpen(true)} />}</div>
    </div>
    {addOpen && <AddLessonDialog onClose={() => setAddOpen(false)} onImport={() => { setAddOpen(false); setImportOpen(true); }} onSaved={bundle => { setAddOpen(false); setReload(value => value + 1); openBundle(bundle.id); }} />}
    {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onImported={lesson => { setImportOpen(false); setReload(value => value + 1); open(lesson.id); }} />}
    {aboutOpen && <Modal title="Built around understanding" onClose={() => setAboutOpen(false)}><p className="modal-description">Narad turns resources into lessons you can read, hear, and discuss. We’re building it in four feedback checkpoints.</p><ol className="milestone-list"><li><strong>Library & reader</strong><span>Available now: modes, mathematics, diagrams, sources, and saved reading positions.</span></li><li><strong>Research & generation</strong><span>Available now: save ideas, images, and article links with their visuals. Next: prepare tutor explanations with Codex or Claude.</span></li><li><strong>Local narration</strong><span>Expressive voices, playback speed, highlighting, and interruption.</span></li><li><strong>Interactive tutor</strong><span>Questions, optional deeper explanations, and familiarity-based revisions.</span></li></ol></Modal>}
  </div>;
}
