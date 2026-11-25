import { useState } from 'react';
import { BookOpen, Lightbulb, Maximize2, Bookmark } from 'lucide-react';
import type { Lesson, LessonBlock as Block } from '../../shared/lesson';
import { Markdown } from './Markdown';
import { Modal } from './Modal';
import { CreditLine } from './CreditLine';
import { VideoEmbed } from './VideoEmbed';
import { ConceptDiagram } from './ConceptDiagram';
import { QuizBlock, type QuizState } from './QuizBlock';
import { StepsBlock } from './StepsBlock';

export function LessonBlock({ block, lesson, active, onSelect, onSource, onVideoPlay, slides, quiz, onAnswer, onRetry, narrating }: {
  block: Block; lesson: Lesson; active: boolean; onSelect: () => void;
  onSource: (sourceId: string, locator?: string) => void; onVideoPlay?: () => void;
  /** Course mode: a passage shows short key points while narration says more, so the narration text is offered for reading. */
  /** True while narration is speaking this passage. */
  narrating?: boolean;
  slides?: boolean; quiz?: QuizState; onAnswer?: (choice: number) => void; onRetry?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const asset = block.kind === 'figure' ? lesson.assets.find(asset => asset.id === block.assetId) : undefined;
  return <article id={'block-' + block.id} className={'lesson-block block-' + block.kind + (active ? ' active-block' : '')} aria-label={'Passage ' + block.id}>
    <button className="passage-marker" onClick={onSelect} aria-label={'Set reading position at ' + block.id} aria-pressed={active} title="Read from here"><Bookmark size={15} fill={active ? 'currentColor' : 'none'} /></button>
    {block.kind === 'callout' && <div className="callout-heading"><Lightbulb size={18} /><strong>{block.title}</strong></div>}
    {block.kind === 'dialogue' && <div className={'speaker ' + block.role}><span className="speaker-avatar">{block.speaker.charAt(0)}</span><strong>{block.speaker}</strong><span>{block.role === 'host' ? 'Curious host' : 'Your tutor'}</span></div>}
    {block.kind === 'equation' && <div className="equation"><Markdown>{'$$\n' + block.latex + '\n$$'}</Markdown></div>}
    {asset && <figure>
      {asset.kind === 'video' && asset.video ? <VideoEmbed video={asset.video} title={asset.alt} poster={asset.src} onPlay={() => onVideoPlay?.()} />
        : imageFailed ? <div role="alert" className="error-box">This image could not be loaded: {asset.alt}</div>
        : <button className="figure-button" onClick={() => setExpanded(true)} aria-label={'Enlarge diagram: ' + asset.alt}>
          <img src={asset.src} alt={asset.alt} loading="lazy" onError={() => setImageFailed(true)} /><span className="enlarge-label"><Maximize2 size={14} /> Enlarge</span>
        </button>}
      <figcaption><span className="figure-origin">{asset.provenance === 'source' ? 'Source figure' : 'Teaching diagram'}</span>{asset.caption}</figcaption>
      {asset.credit && <p className="figure-credit"><CreditLine credit={asset.credit} /></p>}
    </figure>}
    {block.kind === 'diagram' ? <ConceptDiagram title={block.title} caption={block.markdown} nodes={block.nodes} edges={block.edges} />
      : block.kind === 'steps' ? <StepsBlock block={block} revealAll={narrating} />
      : block.kind === 'quiz' ? <QuizBlock block={block} state={quiz} onAnswer={choice => onAnswer?.(choice)} onRetry={() => onRetry?.()} />
      : <Markdown onVideoPlay={onVideoPlay} assets={lesson.assets.map(asset => ({ ...asset, kind: asset.kind ?? 'image' }))}>{block.markdown}</Markdown>}
    {slides && block.kind === 'text' && block.origin === 'teaching' && block.spokenText.trim() !== block.markdown.trim() && <details className="spoken-notes"><summary>What the tutor says</summary><p>{block.spokenText}</p></details>}
    <div className="block-attribution">
      {block.references.map(ref => <button key={ref.sourceId + ref.locator} onClick={() => onSource(ref.sourceId, ref.locator)}><BookOpen size={12} />{ref.locator}</button>)}
      {block.origin === 'teaching' && <span>Added explanation</span>}
    </div>
    {expanded && asset && <Modal title={asset.caption} wide onClose={() => setExpanded(false)}><img className="expanded-image" src={asset.src} alt={asset.alt} /><p className="muted">{asset.alt}</p></Modal>}
  </article>;
}
