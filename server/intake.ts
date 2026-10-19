import { randomUUID } from 'node:crypto';
import { sourceInputSchema, type SourceInput, type SourceBundle, type AssetBlob, type CapturedSource } from '../shared/sources';
import { captureArticle, rasterAsset, type Download } from './capture';
import { StoreError } from './store';

export async function retrySources(previous: SourceBundle, download?: Download): Promise<{ bundle: SourceBundle; blobs: AssetBlob[] }> {
  const sources: CapturedSource[] = []; const blobs: AssetBlob[] = [];
  for (const source of previous.sources) {
    if (source.kind !== 'article' || !source.url || (previous.status === 'needs-review' && !source.warnings.length)) { sources.push(source); continue; }
    try {
      const captured = await captureArticle(source.url, download);
      sources.push({ ...captured.source, id: source.id }); blobs.push(...captured.blobs);
    } catch (error) { sources.push({ ...source, warnings: [error instanceof Error ? error.message : 'Could not recapture source.'] }); }
  }
  return { bundle: { ...previous, sources, status: sources.some(source => source.warnings.length) ? 'needs-review' : 'captured' }, blobs };
}

export async function prepareSources(input: SourceInput, download?: Download): Promise<{ bundle: SourceBundle; blobs: AssetBlob[] }> {
  const { title, text, images } = sourceInputSchema.parse(input);
  const urls = [...new Set((text.match(/https?:\/\/[^\s<>"\]]+/g) ?? []).map(url => url.replace(/[),.;]+$/, '')))];
  if (urls.length > 8) throw new StoreError('Add up to 8 links at a time.', 400);
  const sources: CapturedSource[] = []; const blobs: AssetBlob[] = [];
  const inventory = () => ({ images: 0, inlineSvg: 0, tables: 0, savedVisuals: 0 });
  if (text) sources.push({ id: randomUUID(), title: 'Your notes & learning intent', kind: 'note', markdown: text, assets: [], warnings: [], inventory: inventory() });
  for (const image of images) {
    let blob: AssetBlob;
    try { blob = await rasterAsset(Buffer.from(image.data.split(',')[1], 'base64')); }
    catch { throw new StoreError('Could not read ' + image.name + '. Choose a valid PNG, JPEG, or WebP image.', 400); }
    blobs.push(blob);
    sources.push({ id: randomUUID(), title: image.name, kind: 'image', markdown: '![Uploaded image](source-asset-upload)',
      assets: [{ id: 'source-asset-upload', kind: 'image', alt: image.name, caption: 'Uploaded source image · original preserved', src: '/api/source-assets/' + blob.id, originalSrc: '/api/source-assets/' + blob.id }], warnings: [], inventory: { ...inventory(), images: 1, savedVisuals: 1 } });
  }
  for (const url of urls) {
    try { const captured = await captureArticle(url, download); sources.push(captured.source); blobs.push(...captured.blobs); }
    catch (error) { sources.push({ id: randomUUID(), title: url, kind: 'article', url, markdown: '', assets: [], warnings: [error instanceof Error ? error.message : 'Could not capture this link.'], inventory: inventory() }); }
  }
  const inferredTitle = sources.find(source => source.kind === 'article' && source.markdown)?.title || text.replace(/https?:\/\/\S+/g, '').trim().split('\n')[0] || images[0]?.name || 'New learning idea';
  return { bundle: { id: randomUUID(), title: title || inferredTitle.slice(0, 180), text, sources, createdAt: new Date().toISOString(), status: sources.some(source => source.warnings.length) ? 'needs-review' : 'captured' }, blobs };
}
