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
type TextOf = (raw: string) => string;
// React escapes RSC strings that begin with "$" by doubling it; long strings become "$<id>" references to text rows.
const textResolver = (text: Map<string, string> = new Map()): TextOf => raw =>
  raw.startsWith('$$') ? raw.slice(1) : /^\$[0-9a-f]{1,8}$/i.test(raw) ? text.get(raw.slice(1).toLowerCase()) ?? '' : raw;

/** Concatenated, JSON-unescaped string payloads of `self.__next_f.push([1, "…"])` chunks; '' if over the size cap. */
export function rscPayload(html: string): string {
  let payload = ''; const marker = 'self.__next_f.push(';
  // Scanned by hand: a backtracking regex over a multi-megabyte string literal overflows V8's stack.
  for (let at = html.indexOf(marker); at >= 0; at = html.indexOf(marker, at + 1)) {
    const head = /^\[\s*1\s*,\s*"/.exec(html.slice(at + marker.length, at + marker.length + 32));
    if (!head) continue;
    const open = at + marker.length + head[0].length - 1; let close = open + 1;
    while (close < html.length && html[close] !== '"') close += html[close] === '\\' ? 2 : 1;
    if (close >= html.length) break;
    // Checked before decoding and appending, so the payload never exceeds the cap. Oversized pages keep the text capture.
    if (payload.length + close - open > MAX_PAYLOAD) return '';
    try { payload += JSON.parse(html.slice(open, close + 1)) as string; } catch { /* A corrupt chunk only loses its own text. */ }
    at = close;
  }
  return payload;
}

const MAX_NODES = 2_000_000;
const MAX_CANDIDATES = 500;
type Rows = { json: string[]; text: Map<string, string> };
/**
 * Split an RSC payload into rows. JSON rows are `id:JSON\n`; text rows are `id:T<hex byte length>,<text>`
 * with no terminator, so they are measured in UTF-8 bytes rather than split on newlines.
 */
export function rscRows(payload: string): Rows {
  const rows: Rows = { json: [], text: new Map() }; let pos = 0;
  const toLineEnd = (from: number) => { const nl = payload.indexOf('\n', from); return nl < 0 ? payload.length : nl; };
  while (pos < payload.length) {
    const head = /^([0-9a-f]{1,8}):/i.exec(payload.slice(pos, pos + 10));
    if (!head) { pos = toLineEnd(pos) + 1; continue; }
    const body = pos + head[0].length;
    const text = payload[body] === 'T' ? /^T([0-9a-f]{1,8}),/i.exec(payload.slice(body, body + 11)) : null;
    if (text) {
      const length = parseInt(text[1], 16); let i = body + text[0].length; let bytes = 0;
      while (i < payload.length && bytes < length) { const cp = payload.codePointAt(i)!; bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; i += cp > 0xffff ? 2 : 1; }
      rows.text.set(head[1].toLowerCase(), payload.slice(body + text[0].length, i)); pos = i; continue;
    }
    const end = toLineEnd(body); rows.json.push(payload.slice(body, end)); pos = end + 1;
  }
  return rows;
}

/**
 * Every JSON array in the payload whose items all have a `_type` and include portable-text blocks.
 * Linear time: each JSON row is parsed once, then walked iteratively with node and candidate caps, so nesting
 * depth cannot multiply the work or overflow the stack. Rows that are not valid JSON are skipped.
 */
function portableTextArrays(rows: Rows): Item[][] {
  const found: Item[][] = []; let nodes = 0;
  for (const row of rows.json) {
    if (!row.includes('"_type":"block"')) continue;
    let root: Json;
    try { root = JSON.parse(row) as Json; } catch { continue; }
    const stack: Json[] = [root];
    while (stack.length) {
      if (++nodes > MAX_NODES) return found;
      const value = stack.pop()!;
      if (Array.isArray(value)) {
        if (value.length && value.every(item => isItem(item) && typeof item._type === 'string') && value.some(item => isItem(item) && item._type === 'block')) {
          found.push(value as Item[]);
          if (found.length >= MAX_CANDIDATES) return found;
        }
        for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
      } else if (isItem(value)) for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
    }
  }
  return found;
}

const words = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length >= 3));
const blockText = (item: Item, textOf: TextOf) => Array.isArray(item.children) ? item.children.map(child => isItem(child) ? textOf(str(child.text) ?? '') : '').join('') : '';

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
function inline(item: Item, textOf: TextOf): string {
  const defs = new Map((Array.isArray(item.markDefs) ? item.markDefs : []).filter(isItem).map(def => [str(def._key), def]));
  return (Array.isArray(item.children) ? item.children : []).filter(isItem).map(child => {
    let html = esc(textOf(str(child.text) ?? '')).replace(/\n/g, '<br>');
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
export function renderPortableText(items: Item[], project?: { projectId: string; dataset: string }, textOf: TextOf = textResolver()): PortableTextArticle {
  let html = ''; let figures = 0; const skipped: string[] = [];
  const lists: { tag: string; level: number; open: boolean }[] = [];
  const closeList = () => { const list = lists.pop()!; html += (list.open ? '</li>' : '') + `</${list.tag}>`; };
  for (const item of items) {
    const type = str(item._type) ?? '';
    const listItem = type === 'block' ? str(item.listItem) : undefined;
    if (!listItem) while (lists.length) closeList();
    if (type === 'block') {
      const content = inline(item, textOf);
      if (listItem) {
        const level = typeof item.level === 'number' && item.level > 0 ? item.level : 1; const tag = listItem === 'number' ? 'ol' : 'ul';
        while (lists.length && lists.at(-1)!.level > level) closeList();
        if (lists.length && lists.at(-1)!.level === level && lists.at(-1)!.tag !== tag) closeList();
        if (!lists.length || lists.at(-1)!.level < level) { html += `<${tag}>`; lists.push({ tag, level, open: false }); }
        const list = lists.at(-1)!; html += (list.open ? '</li>' : '') + '<li>' + content; list.open = true;
        continue;
      }
      if (!blockText(item, textOf).trim()) continue;
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
  const rows = rscRows(payload); const textOf = textResolver(rows.text);
  const page = words(pageText);
  let best: { items: Item[]; matched: number } | undefined;
  for (const items of portableTextArrays(rows)) {
    const vocabulary = words(items.map(item => item._type === 'block' ? blockText(item, textOf) : '').join(' '));
    let matched = 0; for (const word of vocabulary) if (page.has(word)) matched++;
    if (matched >= 12 && matched / vocabulary.size >= 0.6 && matched > (best?.matched ?? 0)) best = { items, matched };
  }
  if (!best || !best.items.some(item => !!imageRef(item))) return undefined;
  const article = renderPortableText(best.items, sanityProject(html, payload), textOf);
  if (title && !best.items.some(item => item._type === 'block' && item.style === 'h1')) article.html = `<h1>${esc(title)}</h1>` + article.html;
  return article;
}
