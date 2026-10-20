import { PreparationPanel } from './PreparationPanel';
import type { PreparationState } from '../../shared/preparation';
import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, FileText, Image, Link, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { isBlocking, type SourceBundle } from '../../shared/sources';
import { Markdown } from './Markdown';
import { api } from '../lib/api';

export function SourcePreview({ bundle: initialBundle, onBack, onOpenLesson, preparation, onPreparationChanged }: { bundle: SourceBundle; onBack: () => void; onOpenLesson: (id: string) => void; preparation: PreparationState | null; onPreparationChanged: () => Promise<void> }) {
  const [bundle, setBundle] = useState(initialBundle);
  useEffect(() => { setBundle(initialBundle); }, [initialBundle]);
  const [retrying, setRetrying] = useState(false); const [retryError, setRetryError] = useState('');
  async function retry() {
    setRetrying(true); setRetryError('');
    try { setBundle(await api.retrySources(bundle.id)); }
    catch (error) { setRetryError(error instanceof Error ? error.message : 'Retry failed.'); }
    finally { setRetrying(false); }
  }
  const articleIndex = bundle.sources.findIndex(source => source.kind === 'article' && source.markdown);
  const [index, setIndex] = useState(articleIndex >= 0 ? articleIndex : 0);
  const source = bundle.sources[index];
  return <div className="source-preview">
    <button className="back-link" onClick={onBack}><ArrowLeft size={16} />Back to library</button>
    <p className="intro-label">Your source collection</p><h1>{bundle.title}</h1>
    <div className="source-stage"><CheckCircle2 size={20} /><div><strong>{bundle.lessonId ? 'Your tutor lesson is ready' : 'Sources saved · ready for review'}</strong><p>{bundle.lessonId ? 'Open the brief summary, detailed walkthrough, or host–expert conversation.' : 'This is your captured source material. The tutor’s explanation has not been generated yet.'}</p>{bundle.lessonId && <button className="primary-button" onClick={() => onOpenLesson(bundle.lessonId!)}>Open learning modes</button>}{bundle.sources.some(source => source.kind === 'article') && <button className="text-link" disabled={retrying} onClick={() => void retry()}>{retrying ? 'Capturing article sources…' : bundle.status === 'needs-review' ? 'Retry incomplete sources' : 'Refresh article capture'}</button>}{retryError && <p role="alert">{retryError}</p>}</div></div>
    <PreparationPanel bundleId={bundle.id} familiarity={bundle.familiarity} ready={!bundle.sources.some(isBlocking)} state={preparation} onChanged={onPreparationChanged} onOpenLesson={onOpenLesson} />
    <div className="source-layout"><aside className="source-picker" aria-label="Saved sources"><h2>{bundle.sources.length} saved sources</h2>{bundle.sources.map((item, i) => <button key={item.id} onClick={() => setIndex(i)} aria-current={i === index ? 'true' : undefined} className={i === index ? 'current' : ''}>{item.kind === 'image' ? <Image size={17} /> : item.kind === 'article' ? <Link size={17} /> : <FileText size={17} />}<span>{item.title}<small>{isBlocking(item) ? 'Needs review' : item.kind === 'note' ? 'Your words' : item.inventory.savedVisuals + ' visuals saved'}</small></span></button>)}</aside>
      <article className="captured-article" key={source.id}>
        <div className="capture-heading"><span className="source-kind">{source.kind === 'article' ? 'Captured article' : source.kind === 'image' ? 'Uploaded image' : 'Learning intent'}</span>{source.url && <a href={source.url} target="_blank" rel="noreferrer">Visit original<ExternalLink size={14} /></a>}</div>
        <h2>{source.title}</h2>
        {source.kind !== 'note' && <div className="visual-inventory"><span><strong>{source.inventory.images}</strong> images</span><span><strong>{source.inventory.inlineSvg}</strong> SVG equations & diagrams</span><span><strong>{source.inventory.tables}</strong> tables</span><span><strong>{source.inventory.savedVisuals}/{source.inventory.images + source.inventory.inlineSvg}</strong> visuals saved</span></div>}
        {source.warnings.some(warning => warning.kind === 'blocking') && <details className="capture-warnings" open><summary><AlertCircle size={16} />{source.warnings.filter(warning => warning.kind === 'blocking').length} capture {source.warnings.filter(warning => warning.kind === 'blocking').length === 1 ? 'issue' : 'issues'} to review</summary><ul>{source.warnings.filter(warning => warning.kind === 'blocking').map((warning, i) => <li key={i}>{warning.message}</li>)}</ul></details>}
        {source.warnings.some(warning => warning.kind === 'info') && <details className="capture-warnings capture-notes"><summary><Info size={16} />{source.warnings.filter(warning => warning.kind === 'info').length} {source.warnings.filter(warning => warning.kind === 'info').length === 1 ? 'note' : 'notes'} · not captured</summary><ul>{source.warnings.filter(warning => warning.kind === 'info').map((warning, i) => <li key={i}>{warning.message}</li>)}</ul></details>}
        {source.kind === 'note' ? <div className="source-note-text">{source.markdown}</div> : <Markdown assets={source.assets}>{source.markdown}</Markdown>}
        {source.kind === 'image' && <p className="stage-note">The original image is saved. Reading its labels and explaining its content will happen during lesson preparation.</p>}
        {source.kind === 'article' && <p className="stage-note">Static source capture preserves the content found in this page’s article body. Interactive charts, sign-in content, and JavaScript-only sections may require a separate source or image.</p>}
      </article>
    </div>
  </div>;
}
