/**
 * Fallback for Next.js pages built on Sanity: the HTML is server-rendered without figures, but the
 * React Server Components payload (`self.__next_f.push([1, "…"])` chunks) carries the article body as
 * Sanity portable text, image blocks included. This module finds that body and rebuilds it as plain
 * HTML (headings, paragraphs, lists, marks, <figure>s with cdn.sanity.io sources), so capture.ts can
 * run its normal visual pipeline over it. Everything here is pure parsing: nothing is fetched or run.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Item = { [key: string]: Json };
export type PortableTextArticle = { html: string; figures: number; skipped: string[] };

const MAX_PAYLOAD = 10 * 1024 * 1024;
const MAX_WIDTH = 1600;
const isItem = (value: Json | undefined): value is Item => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: Json | undefined) => typeof value === 'string' ? value : undefined;
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// React escapes RSC strings that begin with "$" by doubling it.
const rscText = (text: string) => text.startsWith('$$') ? text.slice(1) : text;

/** Concatenated, JSON-unescaped string payloads of `self.__next_f.push([1, "…"])` chunks. */
export function rscPayload(html: string): string {
  let payload = '';
  for (const match of html.matchAll(/self\.__next_f\.push\(\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g)) {
    try { payload += JSON.parse(match[1]) as string; } catch { /* A corrupt chunk only loses its own text. */ }
    if (payload.length > MAX_PAYLOAD) break;
  }
  return payload;
}

/** Every JSON array of objects in the payload that parses and has portable-text blocks at its top level. */
function portableTextArrays(payload: string): Item[][] {
  const found: Item[][] = [];
  // RSC rows are newline-separated and JSON rows never contain raw newlines, so scanning line by line keeps
  // raw text rows (`id:T…`) from desynchronising the string tracking for the rest of the payload.
  for (const line of payload.split('\n')) {
    if (!line.includes('"_type":"block"')) continue;
    const starts: number[] = []; let inString = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '[') starts.push(i);
      else if (c === ']') {
        const start = starts.pop();
        if (start === undefined || line[start + 1] !== '{') continue;
        const slice = line.slice(start, i + 1);
        if (!slice.includes('"_type":"block"')) continue;
        let value: Json;
        try { value = JSON.parse(slice) as Json; } catch { continue; }
        if (Array.isArray(value) && value.every(item => isItem(item) && typeof item._type === 'string') && value.some(item => isItem(item) && item._type === 'block')) found.push(value as Item[]);
      }
    }
  }
  return found;
}

const words = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length >= 3));
const blockText = (item: Item) => Array.isArray(item.children) ? item.children.map(child => isItem(child) ? rscText(str(child.text) ?? '') : '').join('') : '';

const ASSET_ID = /^image-([0-9a-f]{20,64})-(\d+)x(\d+)-([a-z0-9]+)$/i;
const SANITY_URL = /^https:\/\/cdn\.sanity\.io\/images\/[a-z0-9]+\/[\w-]+\/[0-9a-f]{20,64}-(\d+)x\d+\.([a-z0-9]+)(\?.*)?$/i;
/** Asset reference (`image-<hash>-WxH-ext`) or resolved cdn.sanity.io URL of an image-like block. */
function imageRef(item: Item): string | undefined {
  const image = isItem(item.image) ? item.image : undefined;
  for (const candidate of [item.asset, image?.asset, item.image]) {
    const values = typeof candidate === 'string' ? [candidate] : isItem(candidate) ? [candidate.url, candidate._ref, candidate._id].map(str) : [];
    const ref = values.find(value => value && (ASSET_ID.test(value) || SANITY_URL.test(value)));
    if (ref) return ref;
  }
  return undefined;
}

/**
 * Rendition choice: rasters wider than 1600 px ask Sanity for `?w=1600&fit=max` (same format, never upscaled),
 * which is plenty for teaching and keeps big screenshots well under the capture limits. Smaller images,
 * GIFs (resizing would drop their animation) and SVGs are fetched as the original asset.
 */
export function sanityImageUrl(ref: string, project?: { projectId: string; dataset: string }): string | undefined {
  const rendition = (url: string, width: number, ext: string) => width > MAX_WIDTH && !['gif', 'svg'].includes(ext.toLowerCase()) ? url + '?w=' + MAX_WIDTH + '&fit=max' : url;
  const resolved = ref.match(SANITY_URL);
  if (resolved) return resolved[3] ? ref : rendition(ref, Number(resolved[1]), resolved[2]);
  const id = ref.match(ASSET_ID);
  if (!id || !project) return undefined;
  const [, hash, width, height, ext] = id;
  return rendition(`https://cdn.sanity.io/images/${project.projectId}/${project.dataset}/${hash}-${width}x${height}.${ext}`, Number(width), ext);
}

/** The Sanity project and dataset most often named by cdn.sanity.io URLs on the page, else by the payload. */
function sanityProject(html: string, payload: string) {
  const counts = new Map<string, number>();
  for (const match of (html + payload).matchAll(/cdn\.sanity\.io\/(?:images|files)\/([a-z0-9]+)\/([\w-]+)\//gi)) counts.set(match[1] + '/' + match[2], (counts.get(match[1] + '/' + match[2]) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) { const [projectId, dataset] = best.split('/'); return { projectId, dataset }; }
  const projectId = payload.match(/"projectId":"([a-z0-9]+)"/)?.[1]; const dataset = payload.match(/"dataset":"([\w-]+)"/)?.[1];
  return projectId && dataset ? { projectId, dataset } : undefined;
}

const DECORATORS: Record<string, string> = { strong: 'strong', em: 'em', code: 'code', underline: 'u', 'strike-through': 's' };
function inline(item: Item): string {
  const defs = new Map((Array.isArray(item.markDefs) ? item.markDefs : []).filter(isItem).map(def => [str(def._key), def]));
  return (Array.isArray(item.children) ? item.children : []).filter(isItem).map(child => {
    let html = esc(rscText(str(child.text) ?? '')).replace(/\n/g, '<br>');
    if (!html) return '';
    let href: string | undefined;
    for (const mark of (Array.isArray(child.marks) ? child.marks : []).map(str)) {
      if (!mark) continue;
      if (DECORATORS[mark]) html = `<${DECORATORS[mark]}>${html}</${DECORATORS[mark]}>`;
      else { const def = defs.get(mark); href ??= def && (str(def.href) ?? str(def.url)); }
    }
    return href ? `<a href="${esc(href)}">${html}</a>` : html;
  }).join('');
}

const isVideoHost = (url: string) => { try { return /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|player\.vimeo\.com)$/.test(new URL(url).hostname); } catch { return false; } };
const CONTENT_FIELDS = ['text', 'body', 'content', 'html', 'markdown', 'title', 'children', 'rows', 'items'];

/** Rebuild an article body from portable text, in order. Unrenderable content blocks are named in `skipped`. */
export function renderPortableText(items: Item[], project?: { projectId: string; dataset: string }): PortableTextArticle {
  let html = ''; let figures = 0; const skipped: string[] = [];
  const lists: { tag: string; level: number; open: boolean }[] = [];
  const closeList = () => { const list = lists.pop()!; html += (list.open ? '</li>' : '') + `</${list.tag}>`; };
  for (const item of items) {
    const type = str(item._type) ?? '';
    const listItem = type === 'block' ? str(item.listItem) : undefined;
    if (!listItem) while (lists.length) closeList();
    if (type === 'block') {
      const content = inline(item);
      if (listItem) {
        const level = typeof item.level === 'number' && item.level > 0 ? item.level : 1; const tag = listItem === 'number' ? 'ol' : 'ul';
        while (lists.length && lists.at(-1)!.level > level) closeList();
        if (lists.length && lists.at(-1)!.level === level && lists.at(-1)!.tag !== tag) closeList();
        if (!lists.length || lists.at(-1)!.level < level) { html += `<${tag}>`; lists.push({ tag, level, open: false }); }
        const list = lists.at(-1)!; html += (list.open ? '</li>' : '') + '<li>' + content; list.open = true;
        continue;
      }
      if (!blockText(item).trim()) continue;
      const style = str(item.style) ?? 'normal';
      html += /^h[1-6]$/.test(style) ? `<${style}>${content}</${style}>` : style === 'blockquote' ? `<blockquote><p>${content}</p></blockquote>` : `<p>${content}</p>`;
      continue;
    }
    const ref = imageRef(item);
    if (ref) {
      const image = isItem(item.image) ? item.image : undefined;
      const alt = [item.alt, item.altText, image?.alt, image?.altText, isItem(image?.asset) ? image.asset.altText : undefined].map(str).find(text => text?.trim())?.trim();
      const caption = [item.caption, image?.caption].map(str).find(text => text?.trim())?.trim();
      const src = sanityImageUrl(ref, project);
      html += '<figure><img' + (src ? ` src="${esc(src)}"` : '') + (alt ? ` alt="${esc(alt)}"` : '') + '>' + (caption ? `<figcaption>${esc(caption)}</figcaption>` : '') + '</figure>';
      figures++;
      continue;
    }
    const code = str(item.code);
    if (code) { const language = str(item.language)?.match(/^[\w+-]+$/)?.[0]; html += `<pre><code${language ? ` class="language-${language}"` : ''}>${esc(code)}</code></pre>`; continue; }
    const url = str(item.url);
    if (url && /video/i.test(type)) {
      const title = str(item.caption) ?? str(item.title);
      html += isVideoHost(url) ? `<iframe src="${esc(url)}"${title ? ` title="${esc(title)}"` : ''}></iframe>` : `<video src="${esc(url)}"></video>`;
      continue;
    }
    if (CONTENT_FIELDS.some(field => { const value = item[field]; return typeof value === 'string' ? !!value.trim() : Array.isArray(value) && value.length > 0; }) && !skipped.includes(type)) skipped.push(type);
  }
  while (lists.length) closeList();
  return { html, figures, skipped };
}

/**
 * The article body found in the page's RSC payload, rendered as HTML, or undefined when there is no payload,
 * nothing matches the server-rendered text, or the matching body has no figures (then the HTML capture stands).
 * Identification: among portable-text arrays, the one sharing the most distinct words (3+ letters) with the
 * captured page text, provided at least 12 of its words and 60% of its vocabulary appear there. Related-post
 * teasers and banners share only a handful of words, so they lose to the body.
 */
export function portableTextArticle(html: string, pageText: string, title?: string): PortableTextArticle | undefined {
  const payload = rscPayload(html);
  if (!payload.includes('"_type":"block"')) return undefined;
  const page = words(pageText);
  let best: { items: Item[]; matched: number } | undefined;
  for (const items of portableTextArrays(payload)) {
    const vocabulary = words(items.map(item => item._type === 'block' ? blockText(item) : '').join(' '));
    let matched = 0; for (const word of vocabulary) if (page.has(word)) matched++;
    if (matched >= 12 && matched / vocabulary.size >= 0.6 && matched > (best?.matched ?? 0)) best = { items, matched };
  }
  if (!best || !best.items.some(item => !!imageRef(item))) return undefined;
  const article = renderPortableText(best.items, sanityProject(html, payload));
  if (title && !best.items.some(item => item._type === 'block' && item.style === 'h1')) article.html = `<h1>${esc(title)}</h1>` + article.html;
  return article;
}
