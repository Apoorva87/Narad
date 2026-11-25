import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowDown, ArrowUp, BookOpen, Check, ChevronDown, Download, FileText, List, MessageCircle, AlignLeft, GraduationCap, Keyboard, MonitorPlay, School } from 'lucide-react';
import { modes, modeLabels, familiarityLabels, type Lesson, type Mode, type Progress } from '../../shared/lesson';
import { flattenBlocks, latestFigureIndex, moveBlock } from '../../shared/navigation';
import { planSpeech, spokenPart } from '../../shared/speech';
import { artworkFor } from '../lib/artwork';
import { api, exportLesson } from '../lib/api';
import { LessonBlock } from './LessonBlock';
import { SourceDialog } from './SourceDialog';
import { useNarration } from '../hooks/useNarration';
import { usePlaybackFollow } from '../hooks/usePlaybackFollow';
import { SpeechControls } from './SpeechControls';
import { Presentation } from './Presentation';
import { Modal } from './Modal';
import { ReplyThread } from './ReplyThread';
import { useTutor } from '../hooks/useTutor';
import { useTutorPlayback } from '../hooks/useTutorPlayback';
import { QuizBlock, type QuizState } from './QuizBlock';

const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const shortcuts: [string, string][] = [['Space or K', 'Play or pause narration'], ['→ or L', 'Next passage'], ['← or J', 'Previous passage'], ['Shift+→ / Shift+←', 'Next or previous section'], ['1 · 2 · 3 · 4', 'Switch learning mode'], ['− / +', 'Slower or faster'], ['P', 'Presentation mode'], ['T', 'Show or hide transcript while presenting'], ['A', 'Ask the tutor about this passage while presenting'], ['Esc', 'Leave presentation'], ['?', 'Show these shortcuts']];
const gestures: [string, string][] = [['Tap', 'Play or pause'], ['Swipe left / right', 'Next or previous passage'], ['Swipe down', 'Leave presentation'], ['Lock screen & headphones', 'Play, pause, skip passages']];

const modeIcons = { summary: AlignLeft, walkthrough: BookOpen, dialogue: MessageCircle, course: School };
const endNames = { summary: 'summary', walkthrough: 'walkthrough', dialogue: 'conversation', course: 'course' };
export function Reader({ lesson, onBack }: { lesson: Lesson; onBack: () => void }) {
  const defaultMode = lesson.sourceBundleId && lesson.modes.summary ? 'summary' : lesson.modes.walkthrough ? 'walkthrough' : modes.find(mode => lesson.modes[mode])!;
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [activeId, setActiveId] = useState('');
  const [progress, setProgress] = useState<Progress>({ lastMode: null, positions: {} });
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState('Position saved locally');
  const [source, setSource] = useState<{ sourceId?: string; locator?: string } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [transcript, setTranscript] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const saveQueue = useRef(Promise.resolve());
  const blocks = flattenBlocks(lesson, mode);
  const activeIndex = Math.max(0, blocks.findIndex(item => item.block.id === activeId));
  const current = blocks[activeIndex];
  const sections = lesson.modes[mode]!.sections;
  const familiarityLabel = familiarityLabels[lesson.familiarity];
  const availableModes = modes.filter(item => lesson.modes[item]);
  const followPlayback=usePlaybackFollow(lesson,mode);
  const tutor=useTutor(lesson.id,mode);
  const narration = useNarration(lesson,mode,activeId,blockId=>select(blockId,mode,false,true),followPlayback,tutor.playback);
  const tutorPlayback=useTutorPlayback();
  function toggleNarration(){tutorPlayback.stop();narration.toggle()}
  // Check-question answers live only while the lesson is open, so a later visit is a fresh attempt. `first` records the first try.
  const [quiz, setQuiz] = useState<Record<string, QuizState & { first?: boolean }>>({});
  useEffect(() => setQuiz({}), [lesson.id]);
  const quizBlocks = blocks.flatMap(item => item.block.kind === 'quiz' ? [item.block] : []);
  function answerQuiz(blockId: string, choice: number) {
    const correct = quizBlocks.find(block => block.id === blockId)?.answer === choice;
    setQuiz(previous => ({ ...previous, [blockId]: { choice, first: previous[blockId]?.first ?? correct } }));
    narration.answer(blockId);
  }
  const retryQuiz = (blockId: string) => setQuiz(previous => ({ ...previous, [blockId]: { first: previous[blockId]?.first } }));
  // Narration that reaches the explanation of an unanswered question shows the answer it is explaining.
  const explaining = narration.state.part === 'explanation' && narration.state.status === 'playing' ? narration.state.blockId : undefined;
  useEffect(() => { if (explaining) setQuiz(previous => previous[explaining]?.choice !== undefined || previous[explaining]?.revealed ? previous : { ...previous, [explaining]: { revealed: true, first: previous[explaining]?.first ?? false } }); }, [explaining]);
  const firstTry = quizBlocks.filter(block => quiz[block.id]?.first).length, attempted = quizBlocks.filter(block => quiz[block.id]?.first !== undefined).length;

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

  function select(blockId: string, nextMode: Mode = mode, scroll = true, fromNarration = false) {
    if (!fromNarration) {tutorPlayback.stop();narration.navigate(blockId)}
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
    narration.stop();
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
  function present() {
    setPresenting(true);
    // Entering presentation is the user's gesture, so narration may start immediately.
    if (!['playing', 'loading'].includes(narration.state.status)) toggleNarration();
  }
  function changeRate(step: number) {
    const index = rates.indexOf(narration.preferences.rate);
    const rate = rates[Math.max(0, Math.min(rates.length - 1, (index < 0 ? 2 : index) + step))];
    narration.updatePreferences({ ...narration.preferences, rate });
  }
  const [askAt, setAskAt] = useState<string | null>(null);
  const replyThread = (sectionId: string, blockId: string, expanded: boolean, onToggle: () => void) => <ReplyThread key={blockId} lesson={lesson} mode={mode} sectionId={sectionId} blockId={blockId} thread={tutor.threadFor(blockId)} providers={tutor.state.providers} expanded={expanded} busy={!!tutor.state.activeTurnId} playback={tutorPlayback.state}
    onToggle={onToggle} onBegin={()=>{const wasPlaying=['playing','loading'].includes(narration.state.status);narration.pause();tutorPlayback.stop();return wasPlaying}}
    onAsk={tutor.ask} onStop={tutor.stop} onRemove={tutor.remove} onPlay={(turn,part)=>{narration.pause();void tutorPlayback.play(turn,narration.preferences,part)}} onContinue={()=>{tutorPlayback.stop();narration.resume()}} />;
  useEffect(() => { if (!presenting) setAskAt(null); }, [presenting]);
  const toggleAsk = () => setAskAt(value => value ? null : blocks[activeIndex]?.block.id ?? null);
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = event => {
    if (!ready || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === ' ') { if (target.closest('button, a, summary')) return; toggleNarration(); }
    else if (key === 'k') toggleNarration();
    else if (key === 'ArrowRight' || key === 'l') { if (event.shiftKey) sectionMove(1); else move(1); }
    else if (key === 'ArrowLeft' || key === 'j') { if (event.shiftKey) sectionMove(-1); else move(-1); }
    else if (['1', '2', '3', '4'].includes(key) && availableModes[Number(key) - 1]) changeMode(availableModes[Number(key) - 1]);
    else if (key === '-' || key === '_') changeRate(-1);
    else if (key === '=' || key === '+') changeRate(1);
    else if (key === 'p') { if (presenting) setPresenting(false); else present(); }
    else if (key === 't' && presenting) setTranscript(value => !value);
    else if (key === 'a' && presenting) toggleAsk();
    else if (key === 'Escape' && presenting) setPresenting(false);
    else if (key === '?') setHelpOpen(true);
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  // Lock-screen, headphone and keyboard media keys.
  const mediaActions = useRef({ toggle: toggleNarration, move });
  mediaActions.current = { toggle: toggleNarration, move };
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const actions: [MediaSessionAction, () => void][] = [['play', () => mediaActions.current.toggle()], ['pause', () => mediaActions.current.toggle()], ['nexttrack', () => mediaActions.current.move(1)], ['previoustrack', () => mediaActions.current.move(-1)]];
    for (const [action, handler] of actions) try { session.setActionHandler(action, handler); } catch { /* Unsupported action. */ }
    return () => { for (const [action] of actions) try { session.setActionHandler(action, null); } catch { /* Unsupported action. */ } session.metadata = null; };
  }, []);
  // Lock screen and headphone controls: the spoken sentence as the title, the current slide as artwork.
  const spokenIndex = narration.state.blockId ? blocks.findIndex(item => item.block.id === narration.state.blockId) : -1;
  const spoken = blocks[spokenIndex >= 0 ? spokenIndex : activeIndex];
  const sentence = spoken ? planSpeech((spokenIndex >= 0 && spokenPart(spoken.block, narration.state.part)) || spoken.block.spokenText)[spokenIndex >= 0 ? narration.state.chunk ?? 0 : 0]?.text : undefined;
  const slideIndex = latestFigureIndex(blocks, spokenIndex >= 0 ? spokenIndex : activeIndex);
  const slide = slideIndex >= 0 && blocks[slideIndex].block.kind === 'figure' ? lesson.assets.find(asset => asset.id === (blocks[slideIndex].block as { assetId: string }).assetId)?.src : undefined;
  const speaker = spoken?.block.kind === 'dialogue' ? spoken.block.speaker : spoken?.section.title;
  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    let cancelled = false;
    const publish = (artwork: MediaImage[]) => { if (!cancelled) navigator.mediaSession.metadata = new MediaMetadata({ title: sentence ?? lesson.title, artist: speaker ?? 'Narad · ' + modeLabels[mode], album: lesson.title, artwork }); };
    publish([{ src: '/narad-mark.svg', sizes: '512x512', type: 'image/svg+xml' }]);
    void artworkFor(slide ?? '/narad-mark.svg').then(src => publish([{ src, sizes: '512x512', type: 'image/png' }]));
    return () => { cancelled = true; };
  }, [sentence, speaker, slide, lesson.title, mode]);
  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = narration.state.status === 'playing' ? 'playing' : narration.state.status === 'paused' ? 'paused' : 'none';
  }, [narration.state.status]);
  return <div className="reader-view">
    <header className="reader-heading">
      <div className="reader-topline"><button className="back-link" onClick={()=>{tutorPlayback.stop();narration.stop();onBack()}}><ArrowLeft size={16} />Your library</button>{lesson.topic !== 'Learning' && <span className="reader-topic">{lesson.topic}</span>}{lesson.isSample && <span className="sample-badge">Sample lesson</span>}<span className="reader-level"><GraduationCap size={14} />{familiarityLabel}</span></div>
      <h1>{lesson.title}</h1><p>{lesson.description}</p>
    </header>
    <div className="mode-bar"><div className="mode-tabs" role="tablist" aria-label="Learning mode">{modes.filter(mode => lesson.modes[mode]).map(item => {
      const Icon = modeIcons[item];
      return <button key={item} role="tab" aria-selected={item === mode} aria-controls="lesson-content" id={'tab-' + item} onClick={() => changeMode(item)} disabled={!ready}><Icon size={17} />{modeLabels[item]}</button>;
    })}</div><div className="reader-actions"><button className="present-action" onClick={present} disabled={!ready} aria-label="Present" title="Presentation mode (P)"><MonitorPlay size={16} /><span>Present</span></button><button className="shortcuts-action" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts" title="Shortcuts (?)"><Keyboard size={16} /></button><button onClick={() => {narration.pause();setSource({})}} title="Original sources"><FileText size={16} /><span>{lesson.sources.length} {lesson.sources.length === 1 ? 'source' : 'sources'}</span></button><button onClick={() => void exportLesson(lesson.id).catch(() => setSaveState('Could not export this lesson.'))} className="export-action" aria-label="Export lesson" title="Export lesson"><Download size={16} /><span>Export</span></button><button className="outline-toggle" onClick={() => setOutlineOpen(!outlineOpen)} aria-expanded={outlineOpen}><List size={17} /><span>Contents</span><ChevronDown size={14} /></button></div></div>
    <div className="reader-columns">
      <main id="lesson-content" role="tabpanel" aria-labelledby={'tab-' + mode} className="lesson-content">
        {!ready ? <p role="status">Restoring your reading position…</p> : sections.map((section, index) => <section key={mode + section.id} className="lesson-section" aria-labelledby={'section-' + section.id}>
          <header className="section-heading"><span className="section-number">{String(index + 1).padStart(2, '0')}</span><div><h2 id={'section-' + section.id}>{section.title}</h2>{section.description && <p>{section.description}</p>}</div></header>
          {section.blocks.map(block => <div className="passage-with-replies" key={mode + block.id}><LessonBlock block={block} lesson={lesson} active={block.id === activeId} slides={mode === 'course'} quiz={quiz[block.id]} onAnswer={choice => answerQuiz(block.id, choice)} onRetry={() => retryQuiz(block.id)}
            onSelect={() => select(block.id, mode, false)} onSource={(sourceId, locator) => {tutorPlayback.stop();narration.pause();setSource({ sourceId, locator })}} onVideoPlay={() => {tutorPlayback.stop();narration.pause()}} />
            {replyThread(section.id, block.id, tutor.expanded.has(block.id), () => tutor.toggle(block.id))}
          </div>)}
          {tutor.error&&<p className="reply-error" role="status">{tutor.error}</p>}
        </section>)}
        <div className="lesson-end"><Check size={21} /><h3>You’ve reached the end of this {endNames[mode]}.</h3><p>{mode === 'summary' && lesson.modes.walkthrough ? 'There is more to understand in the detailed walkthrough.' : 'Revisit any section, or explore the same idea in another mode.'}</p>
          {quizBlocks.length > 0 && <p className="quiz-score" role="status">{attempted === 0 ? `This course has ${quizBlocks.length} check ${quizBlocks.length === 1 ? 'question' : 'questions'} to try.` : `You got ${firstTry} of ${attempted} right on the first try` + (attempted < quizBlocks.length ? ` · ${quizBlocks.length - attempted} still to answer.` : '.')}</p>}
          {mode === 'summary' && lesson.modes.walkthrough && <button className="secondary-button" onClick={() => changeMode('walkthrough')}>Read the full walkthrough</button>}
        </div>
      </main>
      <aside className={'section-outline' + (outlineOpen ? ' outline-open' : '')} aria-label="Lesson sections">
        <div className="outline-sticky"><h2>In this lesson</h2><ol>{sections.map((section, index) => <li key={section.id}><button aria-current={current?.section.id === section.id ? 'location' : undefined} onClick={() => { select(section.blocks[0].id); setOutlineOpen(false); }} disabled={!ready}><span>{String(index + 1).padStart(2, '0')}</span>{section.title}</button></li>)}</ol>
          </div>
      </aside>
    </div>
    <footer className="reading-controls narration-enabled">
      <SpeechControls narration={{...narration,toggle:toggleNarration}} disabled={!ready} dialogue={mode==='dialogue'} onPresent={present}/>
      <div className="reading-navigation">
      <div className="reading-status"><BookOpen size={19} /><div><strong>Passage {activeIndex + 1} of {blocks.length}</strong><span role="status" className={/not|Could/.test(saveState) ? 'save-problem' : 'sr-only'}>{saveState}</span></div></div>
      <div className="navigation-group"><button className="icon-button section-nav" disabled={!ready || current.sectionIndex === 0} onClick={() => sectionMove(-1)} aria-label="Previous section" title="Previous section"><List size={15} /><ArrowUp size={13} /></button>
        <button className="control-button" disabled={!ready || activeIndex === 0} onClick={() => move(-1)} aria-label="Previous passage"><ArrowUp size={16} /><span>Previous</span></button>
        <button className="control-button next-control" disabled={!ready || activeIndex === blocks.length - 1} onClick={() => move(1)} aria-label="Next passage"><span>Next passage</span><ArrowDown size={16} /></button>
        <button className="icon-button section-nav" disabled={!ready || current.sectionIndex === sections.length - 1} onClick={() => sectionMove(1)} aria-label="Next section" title="Next section"><List size={15} /><ArrowDown size={13} /></button></div>
      </div>
    </footer>
    {source && <SourceDialog lesson={lesson} {...source} onVideoPlay={() => {tutorPlayback.stop();narration.pause()}} onClose={() => setSource(null)} />}
    {presenting && current && <Presentation lesson={lesson} blocks={blocks} activeIndex={activeIndex} narration={{...narration,toggle:toggleNarration}} transcript={transcript} onTranscript={() => setTranscript(value => !value)} onMove={move} onExit={() => { setPresenting(false); setAskAt(null); }} askAt={askAt} onToggleAsk={toggleAsk} onAskCurrent={() => setAskAt(current.block.id)} renderQuiz={block => <QuizBlock block={block} state={quiz[block.id]} onAnswer={choice => answerQuiz(block.id, choice)} onRetry={() => retryQuiz(block.id)} />} renderThread={blockId => { const located = blocks.find(item => item.block.id === blockId); return located ? replyThread(located.section.id, blockId, true, () => {}) : null; }} />}
    {helpOpen && <Modal title="Shortcuts" onClose={() => setHelpOpen(false)}>
      <h3 className="shortcut-heading">Keyboard</h3><dl className="shortcut-list">{shortcuts.map(([keys, action]) => <div key={keys}><dt>{keys.split(' ').map((part, i) => /^(or|\/|·)$/.test(part) ? <span key={i}> {part} </span> : <kbd key={i}>{part}</kbd>)}</dt><dd>{action}</dd></div>)}</dl>
      <h3 className="shortcut-heading">Touch, in presentation mode</h3><dl className="shortcut-list">{gestures.map(([gesture, action]) => <div key={gesture}><dt>{gesture}</dt><dd>{action}</dd></div>)}</dl>
    </Modal>}
  </div>;
}
