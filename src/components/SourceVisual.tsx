import { useState } from 'react';
import type { SourceAsset } from '../../shared/sources';
import { Modal } from './Modal';

export function SourceVisual({ asset }: { asset: SourceAsset }) {
  const [open, setOpen] = useState(false); const [failed, setFailed] = useState(false);
  if (!asset.src || failed) return <span className="missing-visual"><strong>{asset.alt}</strong><span>{asset.error || 'This saved image could not be loaded.'}</span>{asset.originalUrl && /^https?:\/\//.test(asset.originalUrl) && <a href={asset.originalUrl} target="_blank" rel="noreferrer">Open original visual</a>}</span>;
  const inline = asset.kind === 'inline-svg';
  return <span className={inline ? 'source-equation' : 'source-visual'}>
    <button className="source-image-button" onClick={() => setOpen(true)} aria-label={'Enlarge ' + asset.alt}>
      <img src={asset.src} alt={asset.alt} loading="lazy" onError={() => setFailed(true)} style={inline && asset.widthEm ? { width: asset.widthEm + 'em' } : undefined} />
    </button>
    {!inline && <span className="source-caption">{asset.caption || asset.alt}<small>{asset.kind === 'video' ? 'Video' : 'Original source visual'} · click to enlarge</small>{asset.video && <a className="text-link" href={asset.video.url} target="_blank" rel="noreferrer">Watch at the source ↗</a>}</span>}
    {open && <Modal title={asset.alt} onClose={() => setOpen(false)} wide><img className="enlarged-source-image" src={asset.src} alt={asset.alt} />{asset.caption && <p>{asset.caption}</p>}{asset.originalSrc && <a className="text-link" href={asset.originalSrc} download>Download original visual</a>}</Modal>}
  </span>;
}
