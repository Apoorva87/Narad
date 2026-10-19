import { useState } from 'react';
import { BookOpen, Lightbulb, Maximize2, Bookmark } from 'lucide-react';
import type { Lesson, LessonBlock as Block } from '../../shared/lesson';
import { Markdown } from './Markdown';
import { Modal } from './Modal';

export function LessonBlock({ block, lesson, active, onSelect, onSource }: {
  block: Block; lesson: Lesson; active: boolean; onSelect: () => void;
  onSource: (sourceId: string, locator?: string) => void;
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
      {imageFailed ? <div role="alert" className="error-box">This image could not be loaded: {asset.alt}</div>
        : <button className="figure-button" onClick={() => setExpanded(true)} aria-label={'Enlarge diagram: ' + asset.alt}>
          <img src={asset.src} alt={asset.alt} onError={() => setImageFailed(true)} /><span className="enlarge-label"><Maximize2 size={14} /> Enlarge</span>
        </button>}
      <figcaption><span className="figure-origin">{asset.provenance === 'source' ? 'Source figure' : 'Teaching diagram'}</span>{asset.caption}</figcaption>
    </figure>}
    <Markdown>{block.markdown}</Markdown>
    <div className="block-attribution">
      {block.references.map(ref => <button key={ref.sourceId + ref.locator} onClick={() => onSource(ref.sourceId, ref.locator)}><BookOpen size={12} />{ref.locator}</button>)}
      {block.origin === 'teaching' && <span>Added explanation</span>}
    </div>
    {expanded && asset && <Modal title={asset.caption} wide onClose={() => setExpanded(false)}><img className="expanded-image" src={asset.src} alt={asset.alt} /><p className="muted">{asset.alt}</p></Modal>}
  </article>;
}
