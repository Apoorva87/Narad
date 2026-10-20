import { useState } from 'react';
import { ExternalLink, FileText } from 'lucide-react';
import type { Lesson } from '../../shared/lesson';
import { Markdown } from './Markdown';
import { Modal } from './Modal';
import { CreditLine } from './CreditLine';

export function SourceDialog({ lesson, sourceId, locator, onClose, onVideoPlay }: { lesson: Lesson; sourceId?: string; locator?: string; onClose: () => void; onVideoPlay?: () => void }) {
  const [selected, setSelected] = useState(sourceId || lesson.sources[0].id);
  const source = lesson.sources.find(item => item.id === selected)!;
  const credited = lesson.assets.filter(asset => asset.credit);
  return <Modal title="Original sources" onClose={onClose} wide>
    {lesson.sources.length > 1 && <div className="source-tabs">{lesson.sources.map(item => <button key={item.id} className={item.id === selected ? 'selected' : ''} onClick={() => setSelected(item.id)}>{item.title}</button>)}</div>}
    <div className="source-title"><FileText size={21} /><div><h3>{source.title}</h3><p>{locator && selected === sourceId ? 'Referenced location: ' + locator : 'Saved source snapshot'}</p></div></div>
    {source.url && <a className="text-link" href={source.url} target="_blank" rel="noopener noreferrer">Open original resource <ExternalLink size={14} /></a>}
    <div className="source-content"><Markdown onVideoPlay={onVideoPlay} sourceUrl={source.url} assets={lesson.assets.map(asset => ({ ...asset, kind: asset.kind ?? 'image' }))}>{source.content}</Markdown></div>
    {credited.length > 0 && <section className="credit-list" aria-label="Credits"><h4>Credits</h4><ul>{credited.map(asset => <li key={asset.id}><strong>{asset.alt}</strong><CreditLine credit={asset.credit!} /></li>)}</ul></section>}
  </Modal>;
}
