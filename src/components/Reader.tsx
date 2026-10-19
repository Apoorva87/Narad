import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowDown, ArrowUp, BookOpen, Check, ChevronDown, Download, FileText, List, MessageCircle, Headphones, AlignLeft, GraduationCap } from 'lucide-react';
import { modes, modeLabels, type Lesson, type Mode, type Progress } from '../../shared/lesson';
import { flattenBlocks, moveBlock } from '../../shared/navigation';
import { api, downloadLesson } from '../lib/api';
import { LessonBlock } from './LessonBlock';
import { SourceDialog } from './SourceDialog';

const modeIcons = { summary: AlignLeft, walkthrough: BookOpen, dialogue: MessageCircle };
export function Reader({ lesson, onBack }: { lesson: Lesson; onBack: () => void }) {
  const defaultMode = lesson.modes.walkthrough ? 'walkthrough' : modes.find(mode => lesson.modes[mode])!;
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [activeId, setActiveId] = useState('');
  const [progress, setProgress] = useState<Progress>({ lastMode: null, positions: {} });
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState('Position saved locally');
  const [source, setSource] = useState<{ sourceId?: string; locator?: string } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const saveQueue = useRef(Promise.resolve());
  const blocks = flattenBlocks(lesson, mode);
  const activeIndex = Math.max(0, blocks.findIndex(item => item.block.id === activeId));
  const current = blocks[activeIndex];
  const sections = lesson.modes[mode]!.sections;
  const familiarityLabel = { foundational: 'Foundational', 'some-background': 'Some background', advanced: 'Advanced' }[lesson.familiarity];

  useEffect(() => {
    let cancelled = false;
    api.progress(lesson.id).then(saved => {
      if (cancelled) return;
      const initialMode = saved.lastMode && lesson.modes[saved.lastMode] ? saved.lastMode : defaultMode;
      const initialBlocks = flattenBlocks(lesson, initialMode);
      const savedId = saved.positions[initialMode];
      setMode(initialMode); setProgress(saved);
      setActiveId(initialBlocks.find(item => item.block.id === savedId)?.block.id ?? initialBlocks[0].block.id);
      setReady(true);
      if (savedId && savedId !== initialBlocks[0].block.id) requestAnimationFrame(() => document.getElementById('block-' + savedId)?.scrollIntoView({ block: 'center' }));
    }).catch(() => {
      if (!cancelled) { setReady(true); setActiveId(flattenBlocks(lesson, defaultMode)[0].block.id); setSaveState('Could not restore your position'); }
    });
    return () => { cancelled = true; };
  }, [lesson, defaultMode]);

  function select(blockId: string, nextMode: Mode = mode, scroll = true) {
    setActiveId(blockId);
    setProgress(previous => ({ lastMode: nextMode, positions: { ...previous.positions, [nextMode]: blockId } }));
    setSaveState('Saving position…');
    saveQueue.current = saveQueue.current.then(async () => {
      try { await api.saveProgress(lesson.id, nextMode, blockId); setSaveState('Position saved locally'); }
      catch { setSaveState('Position not saved. Check your connection.'); }
    });
    if (scroll) requestAnimationFrame(() => document.getElementById('block-' + blockId)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }));
  }
  function changeMode(nextMode: Mode) {
    const nextBlocks = flattenBlocks(lesson, nextMode);
    const target = nextBlocks.find(item => item.block.id === progress.positions[nextMode]) ?? nextBlocks[0];
    setMode(nextMode); select(target.block.id, nextMode, false);
    requestAnimationFrame(() => {
      if (target === nextBlocks[0]) window.scrollTo({ top: 0 });
      else document.getElementById('block-' + target.block.id)?.scrollIntoView({ block: 'center' });
    });
  }
  function move(offset: number) {
    const target = moveBlock(lesson, mode, activeId, offset);
    if (target) select(target.block.id);
  }
  function sectionMove(offset: number) {
    const target = sections[current.sectionIndex + offset];
    if (target) select(target.blocks[0].id);
  }
  return <div className="reader-view">
    <div className="reader-topline"><button className="back-link" onClick={onBack}><ArrowLeft size={16} />Your library</button><span className="reader-topic">{lesson.topic}</span></div>
    <header className="reader-heading">
      <div className="reader-badges">{lesson.isSample && <span className="sample-badge">Sample lesson</span>}<span><GraduationCap size={15} />{familiarityLabel}</span></div>
      <h1>{lesson.title}</h1><p>{lesson.description}</p>
      <div className="reader-actions"><button onClick={() => setSource({})}><FileText size={16} />{lesson.sources.length} {lesson.sources.length === 1 ? 'source' : 'sources'}</button><button onClick={() => downloadLesson(lesson)}><Download size={16} />Export lesson</button></div>
    </header>
    <div className="mode-bar"><div className="mode-tabs" role="tablist" aria-label="Learning mode">{modes.filter(mode => lesson.modes[mode]).map(item => {
      const Icon = modeIcons[item];
      return <button key={item} role="tab" aria-selected={item === mode} aria-controls="lesson-content" id={'tab-' + item} onClick={() => changeMode(item)} disabled={!ready}><Icon size={17} />{modeLabels[item]}</button>;
    })}</div><button className="outline-toggle" onClick={() => setOutlineOpen(!outlineOpen)} aria-expanded={outlineOpen}><List size={17} />Contents<ChevronDown size={14} /></button></div>
    <div className="reader-columns">
      <main id="lesson-content" role="tabpanel" aria-labelledby={'tab-' + mode} className="lesson-content">
        <p className="mode-introduction">{mode === 'walkthrough' ? 'Take it section by section. Equations, examples, and assumptions stay with the explanation.' : mode === 'summary' ? 'The main ideas at a glance. Open the walkthrough for the complete explanation.' : 'A conversation that makes room for the questions you might be thinking.'}</p>
        {!ready ? <p role="status">Restoring your reading position…</p> : sections.map((section, index) => <section key={mode + section.id} className="lesson-section" aria-labelledby={'section-' + section.id}>
          <header className="section-heading"><span className="section-number">{String(index + 1).padStart(2, '0')}</span><div><h2 id={'section-' + section.id}>{section.title}</h2>{section.description && <p>{section.description}</p>}</div></header>
          {section.blocks.map(block => <LessonBlock key={mode + block.id} block={block} lesson={lesson} active={block.id === activeId}
            onSelect={() => select(block.id, mode, false)} onSource={(sourceId, locator) => setSource({ sourceId, locator })} />)}
        </section>)}
        <div className="lesson-end"><Check size={21} /><h3>You’ve reached the end of this {mode === 'dialogue' ? 'conversation' : mode === 'summary' ? 'summary' : 'walkthrough'}.</h3><p>{mode === 'summary' && lesson.modes.walkthrough ? 'There is more to understand in the detailed walkthrough.' : 'Revisit any section, or explore the same idea in another mode.'}</p>
          {mode === 'summary' && lesson.modes.walkthrough && <button className="secondary-button" onClick={() => changeMode('walkthrough')}>Read the full walkthrough</button>}
        </div>
      </main>
      <aside className={'section-outline' + (outlineOpen ? ' outline-open' : '')} aria-label="Lesson sections">
        <div className="outline-sticky"><h2>In this lesson</h2><ol>{sections.map((section, index) => <li key={section.id}><button aria-current={current?.section.id === section.id ? 'location' : undefined} onClick={() => { select(section.blocks[0].id); setOutlineOpen(false); }} disabled={!ready}><span>{String(index + 1).padStart(2, '0')}</span>{section.title}</button></li>)}</ol>
          <div className="reader-note"><Headphones size={20} /><strong>Read first. Listen next.</strong><p>Local narration arrives in Part 3. This version lets you explore the lesson and its visuals.</p></div>
        </div>
      </aside>
    </div>
    <footer className="reading-controls">
      <div className="reading-status"><BookOpen size={19} /><div><strong>Passage {activeIndex + 1} of {blocks.length}</strong><span role="status">{saveState}</span></div></div>
      <div className="navigation-group"><button className="icon-button section-nav" disabled={!ready || current.sectionIndex === 0} onClick={() => sectionMove(-1)} aria-label="Previous section" title="Previous section"><List size={15} /><ArrowUp size={13} /></button>
        <button className="control-button" disabled={!ready || activeIndex === 0} onClick={() => move(-1)} aria-label="Previous passage"><ArrowUp size={16} /><span>Previous</span></button>
        <button className="control-button next-control" disabled={!ready || activeIndex === blocks.length - 1} onClick={() => move(1)} aria-label="Next passage"><span>Next passage</span><ArrowDown size={16} /></button>
        <button className="icon-button section-nav" disabled={!ready || current.sectionIndex === sections.length - 1} onClick={() => sectionMove(1)} aria-label="Next section" title="Next section"><List size={15} /><ArrowDown size={13} /></button></div>
    </footer>
    {source && <SourceDialog lesson={lesson} {...source} onClose={() => setSource(null)} />}
  </div>;
}
