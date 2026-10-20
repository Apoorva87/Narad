import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { SourceAsset } from '../../shared/sources';
import { SourceVisual } from './SourceVisual';

/** `sourceUrl`, when an http(s) address, lets "Not captured" notes link to the original page. */
export function Markdown({ children, assets = [], onVideoPlay, sourceUrl }: { children: string; assets?: SourceAsset[]; onVideoPlay?: () => void; sourceUrl?: string }) {
  const original = sourceUrl && /^https?:\/\//i.test(sourceUrl) ? sourceUrl : undefined;
  return <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]}
    skipHtml components={{
      a: ({ href, children }) => <a href={href && /^https?:\/\//i.test(href) ? href : undefined} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt, src }) => { if (src?.startsWith('source-note-')) return <span className="inline-image-notice">Not captured: {alt || 'interactive figure'}.{original && <> <a href={original} target="_blank" rel="noopener noreferrer">Open the original ↗</a></>}</span>; const asset = assets.find(asset => asset.id === src); return asset ? <SourceVisual asset={asset} onPlay={onVideoPlay} /> : <span className="inline-image-notice">[Image: {alt || 'unlabeled'}. Attach it as a lesson figure to display it.]</span>; },
      table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
    }}>{children}</ReactMarkdown></div>;
}
