import type { PreparationState } from '../shared/preparation';
import { PreparationHistory, runCounts } from './components/PreparationPanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Library as LibraryIcon, PanelLeftClose, PanelLeftOpen, Plus, CircleHelp, LoaderCircle, Settings2 } from 'lucide-react';
import type { Lesson, LessonSummary } from '../shared/lesson';
import { api } from './lib/api';
import { Library } from './components/Library';
import { Reader } from './components/Reader';
import { ImportDialog } from './components/ImportDialog';
import { Modal } from './components/Modal';
import { AddLessonDialog } from './components/AddLessonDialog';
import { SourcePreview } from './components/SourcePreview';
import { VoiceStatus } from './components/VoiceStatus';
import { SettingsPage } from './components/SettingsPage';
import { HelpPage } from './components/HelpPage';
import { useSettings } from './lib/settings';
import type { BundleSummary, SourceBundle } from '../shared/sources';

function routeId() {
  const match = location.hash.match(/^#lesson\/([a-zA-Z0-9_-]+)$/);
  return match?.[1] ?? null;
}
function settingsRoute() { return location.hash === '#settings'; }
function helpRoute() { return location.hash === '#help'; }
function sourceRouteId() { return location.hash.match(/^#sources\/([a-zA-Z0-9_-]+)$/)?.[1] ?? null; }
export default function App() {
  const [preparation, setPreparation] = useState<PreparationState | null>(null);
  const runs = runCounts(preparation);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [jobsError, setJobsError] = useState('');
  const completedJobs = useRef<string | null>(null);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(routeId);
  const [settingsOpen, setSettingsOpen] = useState(settingsRoute);
  const [helpOpen, setHelpOpen] = useState(helpRoute);
  useSettings(); // Load saved settings early so dialogs open with the right defaults.
  const [sourceId, setSourceId] = useState<string | null>(sourceRouteId);
  const [bundle, setBundle] = useState<SourceBundle | null>(null);
  const [bundles, setBundles] = useState<BundleSummary[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const refreshPreparation = useCallback(async () => {
    const state = await api.preparation(); setPreparation(state); setJobsError('');
    const signature = state.jobs.filter(job=>!['running','stopping'].includes(job.status)).map(job=>job.id+':'+job.status).sort().join(',');
    if (completedJobs.current !== null && signature !== completedJobs.current) setReload(value=>value+1);
    completedJobs.current = signature;
  }, []);
  useEffect(() => {
    let cancelled=false; let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try {if(!cancelled) await refreshPreparation()}catch {if(!cancelled)setJobsError('Agent status unavailable')}finally {if(!cancelled)timer=setTimeout(poll,2000)}};
    void poll();return()=>{cancelled=true;clearTimeout(timer)};
  }, [refreshPreparation]);
  useEffect(() => {
    const onHash = () => { setSelected(routeId()); setSourceId(sourceRouteId()); setSettingsOpen(settingsRoute()); setHelpOpen(helpRoute()); window.scrollTo({ top: 0 }); setSidebarOpen(false); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const shownRoute = useRef<string | null>(null);
  useEffect(() => {
    // A background refresh (e.g. a finished preparation) must not remount the open reader: that stops narration and loses scroll.
    const route = (selected ?? '') + '|' + (sourceId ?? ''); const navigated = route !== shownRoute.current;
    let cancelled = false;
    // Until this navigation lands nothing is shown, so going Back mid-load counts as a navigation too (not a background refresh of a stale route).
    if (navigated) { shownRoute.current = null; setLoading(true); setError(''); setLesson(null); setBundle(null); }
    Promise.all([api.list(), selected && navigated ? api.lesson(selected) : Promise.resolve(null), api.bundles(), sourceId ? api.bundle(sourceId) : Promise.resolve(null)]).then(([list, document, sources, collection]) => {
      if (cancelled) return;
      setLessons(list); setBundles(sources); setBundle(collection);
      if (navigated) {
        // An old link (by a retired id) lands on the item's folder name; the address is replaced so Back does not return to it.
        const lessonId = document && document.id !== selected ? document.id : selected; const bundleId = collection && collection.id !== sourceId ? collection.id : sourceId;
        if (lessonId !== selected || bundleId !== sourceId) {
          history.replaceState(null, '', lessonId !== selected ? '#lesson/' + lessonId : '#sources/' + bundleId);
          if (lessonId !== selected) setSelected(lessonId); else setSourceId(bundleId);
        }
        setLesson(document); shownRoute.current = (lessonId ?? '') + '|' + (bundleId ?? ''); setLoading(false);
      }
    }).catch(error => { if (!cancelled && navigated) { setError(error.message || 'Could not connect to the local server.'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [selected, sourceId, reload]);
  function retry() { shownRoute.current = null; setReload(value => value + 1); }
  function open(id: string) { location.hash = 'lesson/' + id; }
  function openBundle(id: string) { location.hash = 'sources/' + id; }
  function back() { location.hash = ''; }
  function openSettings() { location.hash = 'settings'; }
  function openHelp() { location.hash = 'help'; }
  const pendingBundles = bundles.filter(bundle => !bundle.lessonId);
  return <div className={'app-shell' + (sidebarOpen ? ' sidebar-open' : '')}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); const main = document.getElementById('main-content'); main?.focus(); main?.scrollIntoView(); }}>Skip to content</a>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className="sidebar">
      <button className="brand" onClick={back} aria-label="Narad home"><img className="brand-symbol" src="/narad-mark.svg" alt="" /><span>Narad<span className="brand-subtitle">A voice for your everyday learning</span></span></button>
      <nav aria-label="Main navigation"><button className={'nav-item' + (!selected && !sourceId && !settingsOpen && !helpOpen ? ' selected' : '')} onClick={back}><LibraryIcon size={19} />Your library<span className="nav-count">{lessons.length + pendingBundles.length}</span></button><button className="nav-item" onClick={() => { setAddOpen(true); setSidebarOpen(false); }}><Plus size={19} />Add a lesson</button></nav>
      <div className="sidebar-lessons"><p>Saved analyses</p>{lessons.map(item => <button key={item.id} className={'sidebar-lesson' + (selected === item.id ? ' current' : '')} onClick={() => open(item.id)}><BookOpen size={15} /><span>{item.title}</span></button>)}</div>
      {pendingBundles.length > 0 && <div className="sidebar-lessons sidebar-sources"><p>Saved sources</p>{pendingBundles.map(item => <button key={item.id} className={'sidebar-lesson' + (sourceId === item.id ? ' current' : '')} onClick={() => openBundle(item.id)}><BookOpen size={15} /><span>{item.title}</span></button>)}</div>}
      <div className="sidebar-bottom"><button className={'nav-item' + (settingsOpen ? ' selected' : '')} onClick={openSettings}><Settings2 size={18} />Settings</button><button className="nav-item agent-status" aria-label={jobsError || 'Agents: ' + runs.running + ' running, ' + runs.queued + ' queued'} onClick={()=>setJobsOpen(true)}><LoaderCircle size={18} className={runs.running?'spin':''} />Agents<span className="nav-count">{jobsError?'!':runs.running+runs.queued}</span></button><button className={'nav-item' + (helpOpen ? ' selected' : '')} onClick={openHelp}><CircleHelp size={18} />Help &amp; architecture</button><div className="local-status"><span />Saved on this Mac</div></div>
    </aside>
    <div className="workspace"><VoiceStatus /><header className="workspace-header"><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle navigation">{sidebarOpen ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}</button><button className="mobile-brand" onClick={back}><img src="/narad-mark.svg" alt="" />Narad</button><button className="icon-button mobile-settings" onClick={openSettings} aria-label="Settings"><Settings2 size={19} /></button></header>
      <div id="main-content" tabIndex={-1}>{loading ? <div className="loading-state" role="status"><LoaderCircle size={28} className="spin" /><p>Opening your library…</p></div> : error ? <div className="page-error" role="alert"><h1>Could not open this view</h1><p>{error}</p><button className="primary-button" onClick={retry}>Try again</button>{(selected || sourceId) && <button className="secondary-button" onClick={back}>Back to library</button>}</div> : helpOpen ? <HelpPage onBack={back} /> : settingsOpen ? <SettingsPage onBack={back} /> : bundle ? <SourcePreview key={bundle.id} bundle={bundle} onBack={back} onOpenLesson={open} preparation={preparation} onPreparationChanged={refreshPreparation} /> : lesson ? <Reader key={lesson.id} lesson={lesson} onBack={back} /> : <Library lessons={lessons} bundles={bundles} jobs={preparation?.jobs ?? []} onOpen={open} onBundle={openBundle} onImport={() => setAddOpen(true)} onChanged={() => setReload(value => value + 1)} onSettings={openSettings} />}</div>
    </div>
    {addOpen && <AddLessonDialog onClose={() => setAddOpen(false)} onImport={() => { setAddOpen(false); setImportOpen(true); }} onSaved={bundle => { setAddOpen(false); setReload(value => value + 1); openBundle(bundle.id); }} />}
    {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onImported={lesson => { setImportOpen(false); setReload(value => value + 1); open(lesson.id); }} />}
    {jobsOpen && <Modal title="Agent activity" onClose={()=>setJobsOpen(false)}>{jobsError&&<p role="alert">{jobsError}</p>}<PreparationHistory state={preparation} onChanged={refreshPreparation} onOpenLesson={id=>{setJobsOpen(false);open(id)}} /></Modal>}
  </div>;
}
