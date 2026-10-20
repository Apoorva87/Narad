import { useState } from 'react';
import type { SourceAsset } from '../../shared/sources';
import { Modal } from './Modal';
import { CreditLine } from './CreditLine';
import { VideoEmbed } from './VideoEmbed';

export function SourceVisual({ asset, onPlay = () => {} }: { asset: SourceAsset; onPlay?: () => void }) {
  const [open, setOpen] = useState(false); const [failed, setFailed] = useState(false);
  if (asset.kind === 'video' && asset.video) return <span className="source-visual source-video"><VideoEmbed video={asset.video} title={asset.alt} poster={asset.src} onPlay={onPlay} /><span className="source-caption">{asset.caption || asset.alt}<small>Video · streams from the source</small>{asset.credit && <CreditLine credit={asset.credit} />}</span></span>;
  if (!asset.src || failed) return <span className="missing-visual"><strong>{asset.alt}</strong><span>{asset.error || 'This saved image could not be loaded.'}</span>{asset.originalUrl && /^https?:\/\//.test(asset.originalUrl) && <a href={asset.originalUrl} target="_blank" rel="noreferrer">Open original visual</a>}</span>;
  const inline = asset.kind === 'inline-svg';
  return <span className={inline ? 'source-equation' : 'source-visual'}>
    <button className="source-image-button" onClick={() => setOpen(true)} aria-label={'Enlarge ' + asset.alt}>
      <img src={asset.src} alt={asset.alt} loading="lazy" onError={() => setFailed(true)} style={inline && asset.widthEm ? { width: asset.widthEm + 'em' } : undefined} />
    </button>
    {!inline && <span className="source-caption">{asset.caption || asset.alt}<small>{asset.kind === 'video' ? 'Video' : 'Original source visual'} · click to enlarge</small>{asset.credit && <CreditLine credit={asset.credit} />}</span>}
    {open && <Modal title={asset.alt} onClose={() => setOpen(false)} wide><img className="enlarged-source-image" src={asset.src} alt={asset.alt} />{asset.caption && <p>{asset.caption}</p>}{asset.originalSrc && <a className="text-link" href={asset.originalSrc} download>Download original visual</a>}</Modal>}
  </span>;
}
