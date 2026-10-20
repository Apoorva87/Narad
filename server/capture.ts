import { createHash, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import sharp from 'sharp';
import type { CapturedSource, AssetBlob, SourceAsset } from '../shared/sources';
import { downloadPublic } from './download';
export type Download = (url: string) => Promise<{ bytes: Buffer; type: string; url: string }>;
export function assetBlob(bytes: Buffer, type: string): AssetBlob {
  return { id: createHash('sha256').update(bytes).digest('hex'), bytes, type };
}
function assetPath(blob: AssetBlob) { return '/api/source-assets/' + blob.id; }
export async function rasterAsset(bytes: Buffer): Promise<AssetBlob> {
  const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  const format = metadata.format === 'heif' && metadata.compression === 'av1' ? 'avif' : metadata.format;
  if (!['png', 'jpeg', 'webp', 'gif', 'avif', 'tiff'].includes(format ?? '')) throw new Error('Unsupported image format.');
  return assetBlob(bytes, 'image/' + format);
}
async function svgAsset(svg: string): Promise<{ original: AssetBlob; preview: AssetBlob }> {
  // No external resources or executable SVG enter the renderer. Original bytes remain downloadable.
  if (/<!DOCTYPE|<!ENTITY|<\s*(script|foreignObject|image|style)\b|\bon\w+\s*=|@import/i.test(svg)) throw new Error('This SVG needs manual review before it can be displayed.');
  const $ = load(svg, { xml: true });
  $('*').each((_i, node) => {
    if (!('attribs' in node)) return;
    for (const value of Object.values(node.attribs)) {
      const withoutLocalReferences = value.replace(/url\(\s*(['"]?)#[\w:.-]+\1\s*\)/gi, '');
      if (/url\s*\(|\\|@import/i.test(withoutLocalReferences)) throw new Error('SVG references an external or unsupported resource.');
    }
  });
  $('[href], [xlink\\:href]').each((_i, node) => {
    const href = $(node).attr('href') ?? $(node).attr('xlink:href') ?? '';
    if (href && !href.startsWith('#')) throw new Error('SVG references an external resource.');
  });
  const original = assetBlob(Buffer.from(svg), 'image/svg+xml');
  const root = $('svg').first(); root.attr('xmlns', 'http://www.w3.org/2000/svg');
  for (const dimension of ['width', 'height']) {
    const value = root.attr(dimension) ?? '';
    if (/^[\d.]+em$/.test(value)) root.attr(dimension, String(parseFloat(value) * 20));
  }
  root.attr('color', '#17223b');
  const preview = assetBlob(await sharp(Buffer.from($.xml()), { density: 144, limitInputPixels: 40_000_000 }).png().toBuffer(), 'image/png');
  return { original, preview };
}

export async function captureArticle(url: string, download: Download = downloadPublic): Promise<{ source: CapturedSource; blobs: AssetBlob[] }> {
  const response = await download(url);
  if (!/text\/html|application\/xhtml\+xml/i.test(response.type)) throw new Error('This link is not an HTML article. Add a webpage link or upload an image.');
  const html = response.bytes.toString('utf8');
  const $ = load(html);
  const root = $('article').length ? $('article').first() : $('main').length ? $('main').first() : $('body');
  const source: CapturedSource = { id: randomUUID(), title: $('h1').first().text().trim() || $('title').text().trim() || new URL(url).hostname,
    kind: 'article', url: response.url, rawHtml: html, markdown: '', assets: [], warnings: [],
    inventory: { images: root.find('img').length, inlineSvg: root.find('svg').filter((_i, node) => $(node).parents('svg').length === 0).length, tables: root.find('table').length, savedVisuals: 0 } };
  if (root.find('canvas, iframe, video, audio, math').length) source.warnings.push('This page includes embedded media or MathML. Check the original for content that a static capture cannot display.');
  root.find('script[type^="math/tex"]').each((_i, node) => {
    const element = $(node);
    element.replaceWith($('<span>').attr('data-narad-math', element.text()).attr('data-display', element.attr('type')?.includes('mode=display') ? 'block' : 'inline').text(element.text()));
  });
  root.find('script, style, nav, button, noscript, form').remove();
  if (root.find('td[colspan], td[rowspan], th[colspan], th[rowspan]').length) source.warnings.push('A table contains merged cells. Its preview is flattened; consult the original for row and column grouping.');
  const blobs: AssetBlob[] = []; let downloadedBytes = response.bytes.length;
  const visuals = root.find('img, svg').filter((_i, node) => $(node).parents('svg').length === 0).toArray();
  // Keep source order while limiting network concurrency. No background worker infrastructure needed.
  const tasks = visuals.map((node, index) => {
    const element = $(node); const isSvg = node.tagName === 'svg';
    const svg = isSvg ? $.html(node) : undefined;
    const caption = element.closest('figure').find('figcaption').text().trim();
    const asset: SourceAsset = { id: 'source-asset-' + index, kind: isSvg ? 'inline-svg' : 'image', alt: element.attr('alt')?.trim() || element.attr('aria-label') || (isSvg ? 'Source equation or diagram ' : 'Source figure ') + (index + 1), caption };
    if (isSvg && /^[\d.]+em$/.test(element.attr('width') ?? '')) asset.widthEm = Math.min(100, parseFloat(element.attr('width')!));
    const rawSrc = element.attr('data-src') || element.attr('src') || element.attr('data-original');
    source.assets.push(asset);
    element.replaceWith($('<img>').attr('src', asset.id).attr('alt', asset.alt));
    return async () => {
      try {
        if (index >= 200) throw new Error('More than 200 visuals; review the remaining figures at the source.');
        if (downloadedBytes > 80 * 1024 * 1024) throw new Error('Source visuals exceed the 80 MB capture limit.');
        if (svg) {
          const { original, preview } = await svgAsset(svg); blobs.push(original, preview);
          asset.src = assetPath(preview); asset.originalSrc = assetPath(original);
        } else {
          if (!rawSrc) throw new Error('This figure has no accessible image URL.');
          let bytes: Buffer;
          if (/^data:image\/(png|jpeg|webp);base64,/.test(rawSrc)) bytes = Buffer.from(rawSrc.split(',')[1], 'base64');
          else { asset.originalUrl = new URL(rawSrc, response.url).href; bytes = (await download(asset.originalUrl)).bytes; }
          downloadedBytes += bytes.length;
          if (downloadedBytes > 80 * 1024 * 1024) throw new Error('Source visuals exceed the 80 MB capture limit.');
          if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(bytes.toString('utf8', 0, 500))) {
            const { original, preview } = await svgAsset(bytes.toString('utf8')); blobs.push(original, preview); asset.src = assetPath(preview); asset.originalSrc = assetPath(original);
          } else {
            const blob = await rasterAsset(bytes); blobs.push(blob); asset.src = assetPath(blob); asset.originalSrc = asset.src;
            if (blob.type === 'image/tiff') {
              const preview = assetBlob(await sharp(bytes, { limitInputPixels: 40_000_000 }).png().toBuffer(), 'image/png');
              blobs.push(preview); asset.src = assetPath(preview);
              source.warnings.push(asset.alt + ': TIFF preview shows the first page. Download the preserved original to review all pages.');
            }
          }
        }
        source.inventory.savedVisuals++;
      } catch (error) {
        asset.error = error instanceof Error ? error.message : 'Could not preserve this visual.';
        source.warnings.push(asset.alt + ': ' + asset.error);
      }
    };
  });
  for (let i = 0; i < tasks.length; i += 4) await Promise.all(tasks.slice(i, i + 4).map(task => task()));
  root.find('a[href]').each((_i, node) => {
    try { const href = new URL($(node).attr('href')!, response.url); $(node).attr('href', /^https?:$/.test(href.protocol) ? href.href : ''); } catch { $(node).removeAttr('href'); }
  });
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }); converter.use(gfm);
  // Article text such as "$5 to $10" must not become math; only the rules below emit $ delimiters.
  const escapeText = converter.escape.bind(converter);
  converter.escape = text => escapeText(text).replace(/\$/g, '\\$');
  converter.addRule('visuals-inside-code', {
    filter: node => ['CODE', 'PRE'].includes(node.nodeName) && !!node.querySelector('img, [data-narad-math]'),
    replacement: content => content,
  });
  converter.addRule('tex-equation', {
    filter: node => node.nodeName === 'SPAN' && node.hasAttribute('data-narad-math'),
    replacement: (_content, node) => {
      const element = node as HTMLElement; const latex = element.getAttribute('data-narad-math') ?? '';
      return element.getAttribute('data-display') === 'block' ? '\n\n$$\n' + latex + '\n$$\n\n' : '$' + latex + '$';
    },
  });
  converter.addRule('superscript-subscript', {
    filter: ['sup', 'sub'],
    // Footnote markers like <sup><a>[1]</a></sup> stay as text; KaTeX cannot render links.
    replacement: (content, node) => (node as HTMLElement).querySelector('a') || /[[\]()]/.test(content) ? content : '$' + (node.nodeName === 'SUP' ? '^' : '_') + '{' + content + '}$',
  });
  converter.addRule('all-tables', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = node as HTMLElement;
      const rows = Array.from(table.querySelectorAll('tr')).map(row => Array.from(row.children).filter(cell => ['TD', 'TH'].includes(cell.nodeName)));
      if (!rows.length) return '';
      const count = Math.max(...rows.map(row => row.length));
      const format = (cells: string[]) => '| ' + Array.from({ length: count }, (_unused, i) => cells[i] ?? '').join(' | ') + ' |';
      const values = rows.map(row => row.map(cell => converter.turndown(cell.innerHTML).replace(/\|/g, '\\|').replace(/\n+/g, ' ')));
      const header = rows[0].some(cell => cell.nodeName === 'TH') ? values.shift()! : [];
      const caption = table.querySelector('caption')?.textContent ?? '';
      return '\n\n' + (caption ? caption + '\n\n' : '') + [format(header), format(Array(count).fill('---')), ...values.map(format)].join('\n') + '\n\n';
    },
  });
  source.markdown = converter.turndown(root.html() ?? '');
  if (!source.markdown.trim()) source.warnings.push('No readable article content was found. This page may require JavaScript or a sign-in.');
  return { source, blobs };
}
