import { useEffect, useRef, type TouchEvent } from 'react';
import { Captions, CaptionsOff, LoaderCircle, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import type { Lesson } from '../../shared/lesson';
import { latestFigureIndex, type LocatedBlock } from '../../shared/navigation';
import type { useNarration } from '../hooks/useNarration';
import { Markdown } from './Markdown';
import { CreditLine } from './CreditLine';
import { VideoEmbed } from './VideoEmbed';

/** Podcast-style view: narration plays while the most recent figure stays on screen until the next one. */
export function Presentation({ lesson, blocks, activeIndex, narration, transcript, onTranscript, onMove, onExit }: {
  lesson: Lesson; blocks: LocatedBlock[]; activeIndex: number; narration: ReturnType<typeof useNarration>;
  transcript: boolean; onTranscript: () => void; onMove: (offset: number) => void; onExit: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const exitRef = useRef(onExit); exitRef.current = onExit;
  const touch = useRef<{ x: number; y: number; time: number } | null>(null);
  const current = blocks[activeIndex];
  const figureIndex = latestFigureIndex(blocks, activeIndex);
  const figure = figureIndex >= 0 ? blocks[figureIndex].block : undefined;
  const asset = figure?.kind === 'figure' ? lesson.assets.find(item => item.id === figure.assetId) : undefined;
  const { state, server, preferences } = narration;
  const active = state.status === 'playing' || state.status === 'loading';
  const status = server?.state === 'not-installed' ? server.message : state.status === 'loading' ? (server?.state === 'loading' ? 'Loading the local voice model…' : 'Preparing narration…') : state.status === 'paused' ? 'Paused' : state.status === 'ended' ? 'End of lesson' : state.status === 'error' ? state.error : '';

  useEffect(() => {
    const element = root.current!; let entered = false; let lock: { release(): Promise<void> } | undefined;
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    element.querySelector<HTMLButtonElement>('.presentation-play')?.focus();
    // Fullscreen on desktop only; phones keep their browser chrome and use the fixed overlay.
    if (matchMedia('(pointer: fine)').matches && element.requestFullscreen) element.requestFullscreen().then(() => { entered = true; }).catch(() => {});
    const onFullscreen = () => { if (entered && !document.fullscreenElement) exitRef.current(); };
    const wake = () => { if (document.visibilityState === 'visible') (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen').then(value => { lock = value; }).catch(() => {}); };
    wake();
    document.addEventListener('fullscreenchange', onFullscreen); document.addEventListener('visibilitychange', wake);
    return () => {
      document.body.style.overflow = previousOverflow; void lock?.release().catch(() => {});
      document.removeEventListener('fullscreenchange', onFullscreen); document.removeEventListener('visibilitychange', wake);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  function touchStart(event: TouchEvent) {
    if ((event.target as HTMLElement).closest('button, select, a, .video-embed, .presentation-transcript')) { touch.current = null; return; }
    touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, time: Date.now() };
  }
  function touchEnd(event: TouchEvent) {
    const start = touch.current; touch.current = null; if (!start) return;
    const dx = event.changedTouches[0].clientX - start.x, dy = event.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) onMove(dx < 0 ? 1 : -1);
    else if (dy > 90 && dy > Math.abs(dx)) onExit();
    else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && Date.now() - start.time < 350) narration.toggle();
  }

  return <div ref={root} className="presentation" role="dialog" aria-modal="true" aria-label={'Presenting ' + lesson.title} onTouchStart={touchStart} onTouchEnd={touchEnd}>
    <header className="presentation-top">
      <div><strong>{lesson.title}</strong><span>{current.section.title}</span></div>
      <button className="presentation-icon" onClick={onExit} aria-label="Exit presentation" title="Exit (Esc)"><X size={20} /></button>
    </header>
    <div className={'presentation-stage' + (transcript ? '' : ' no-transcript')}>
      {asset
        ? <figure key={asset.id} className="presentation-figure">{asset.kind === 'video' && asset.video ? <VideoEmbed video={asset.video} title={asset.alt} poster={asset.src} onPlay={narration.pause} /> : <img src={asset.src} alt={asset.alt} />}<figcaption>{asset.caption}</figcaption>{asset.credit && <p className="figure-credit"><CreditLine credit={asset.credit} /></p>}</figure>
        : <div key="title" className="presentation-title-card"><img src="/narad-mark.svg" alt="" /><h2>{current.section.title}</h2><p>{lesson.title}</p></div>}
      {transcript && <div className="presentation-transcript" aria-live="polite">
        {current.block.kind === 'dialogue' && <span className={'presentation-speaker ' + current.block.role}>{current.block.speaker}</span>}
        {current.block.kind === 'equation' && <Markdown>{'$$\n' + current.block.latex + '\n$$'}</Markdown>}
        <Markdown onVideoPlay={narration.pause} assets={lesson.assets.map(item => ({ ...item, kind: item.kind ?? 'image' }))}>{current.block.markdown}</Markdown>
      </div>}
    </div>
    <footer className="presentation-controls">
      <div className="presentation-progress" aria-hidden="true"><span style={{ width: ((activeIndex + 1) / blocks.length) * 100 + '%' }} /></div>
      <div className="presentation-buttons">
        <span className="presentation-count">{activeIndex + 1} / {blocks.length}</span>
        <button className="presentation-icon" onClick={() => onMove(-1)} disabled={activeIndex === 0} aria-label="Previous passage" title="Previous (←)"><SkipBack size={20} /></button>
        <button className="presentation-play" onClick={narration.toggle} disabled={server?.state === 'not-installed'} aria-label={active ? 'Pause narration' : 'Play narration'} title="Play/pause (Space)">
          {state.status === 'loading' ? <LoaderCircle size={26} className="spin" /> : active ? <Pause size={26} /> : <Play size={26} />}
        </button>
        <button className="presentation-icon" onClick={() => onMove(1)} disabled={activeIndex === blocks.length - 1} aria-label="Next passage" title="Next (→)"><SkipForward size={20} /></button>
        <div className="presentation-extra">
          <select aria-label="Playback speed" value={preferences.rate} onChange={event => narration.updatePreferences({ ...preferences, rate: Number(event.target.value) })}>{[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select>
          <button className="presentation-icon" onClick={onTranscript} aria-pressed={transcript} aria-label={transcript ? 'Hide transcript' : 'Show transcript'} title="Transcript (T)">{transcript ? <Captions size={20} /> : <CaptionsOff size={20} />}</button>
        </div>
      </div>
      <p className={'presentation-status' + (state.status === 'error' ? ' speech-error' : '')} role="status">{status || <span className="presentation-hint">Tap to play or pause · Swipe to change passage · Swipe down to exit</span>}</p>
    </footer>
  </div>;
}
