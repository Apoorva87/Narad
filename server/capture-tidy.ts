import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

/** Article-body containers used by WordPress, Ghost, Medium-like and schema.org pages, most specific first. */
const BODY_SELECTORS = ['[itemprop="articleBody"]', '.entry-content', '.post-content', '.article-content', '.article-body', '.post-body', '.story-body', '.gh-content', '.markdown-body'];
/** Class or id words that mark page chrome rather than article content. */
const CHROME_WORD = /^(?:.*[-_])?(share|sharing|social|breadcrumbs?|related|newsletter|subscribe|comments?|tags|author|authors|byline|lang|language|languages|locale|translations?|ai-summary|toc-share|sharedaddy|jp-relatedposts)(?:[-_].*)?$/i;
/** Headings that open a section of page chrome; the heading and what follows it up to the next equal-or-higher heading go. */
const CHROME_HEADING = /^(tags|topics|about the authors?|comments?|\d+ comments?|leave a (reply|comment)|related( (posts|articles|content|resources|reading|stories))?|recommended( for you)?|more (from|like this|stories)|share( this( post| article)?)?|subscribe|sign up for .*newsletter|newsletter|ai[- ]generated summary)$/i;
const SHARE_LINK = /(twitter\.com\/intent|x\.com\/intent|facebook\.com\/shar|linkedin\.com\/shar|reddit\.com\/submit|news\.ycombinator\.com\/submitlink|pinterest\.com\/pin\/create|wa\.me\/|whatsapp:|telegram\.me\/share|t\.me\/share|^mailto:\?)/i;
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|ref_src)$/i;

/** Removes tracking parameters (utm_*, fbclid, …) from an absolute or page-relative link; anything unparsable is returned unchanged. */
export function withoutTracking(link: string, base?: string): string {
  try {
    const url = new URL(link, base);
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return link; }
}

const textLength = ($: CheerioAPI, node: Cheerio<AnyNode>) => $(node).text().replace(/\s+/g, ' ').trim().length;

/** The article body when the page marks one that holds most of the readable text; otherwise the given root. */
export function articleBody($: CheerioAPI, root: Cheerio<Element>): Cheerio<Element> {
  const total = textLength($, root);
  for (const selector of BODY_SELECTORS) {
    const best = root.find(selector).toArray().map(node => $(node)).sort((a, b) => textLength($, b) - textLength($, a))[0];
    if (best && total && textLength($, best) >= total * 0.4 && best.find('p').length >= 2) return best as Cheerio<Element>;
  }
  return root;
}

/**
 * Strips page chrome (breadcrumbs, language pickers, share bars, tag lists, author bios, comments, related posts,
 * AI-summary boxes, avatars and icons) and heading anchor links, so lessons teach only the article.
 * Nothing that holds a large share of the article text is removed, so an over-broad class name cannot empty a page.
 */
export function tidyArticle($: CheerioAPI, root: Cheerio<Element>, base: string): void {
  const total = Math.max(1, textLength($, root));
  const small = (node: Cheerio<AnyNode>) => textLength($, node) < total * 0.25 && !$(node).find('h1').length;
  root.find('aside, footer, [role="navigation"], [role="complementary"], [role="contentinfo"], [role="banner"], select').filter((_i, node) => small($(node))).remove();
  root.find('header').filter((_i, node) => !$(node).find('h1').length && small($(node))).remove();
  root.find('[class], [id]').filter((_i, node) => {
    const words = [...($(node).attr('class') ?? '').split(/\s+/), $(node).attr('id') ?? ''].filter(Boolean);
    return words.some(word => CHROME_WORD.test(word)) && small($(node));
  }).remove();
  // Headings' "link to this section" anchors (empty or a lone symbol) are page furniture, not part of the title.
  root.find('h1 a, h2 a, h3 a, h4 a, h5 a, h6 a').filter((_i, node) => {
    const anchor = $(node); const label = anchor.text().trim(); const href = anchor.attr('href') ?? '';
    return (!label || /^[#¶§🔗]$/u.test(label)) && (href.startsWith('#') || /anchor/i.test(anchor.attr('class') ?? '') || href.includes('#'));
  }).remove();
  // Share bars: lists whose items are mostly share links, then any remaining share links.
  root.find('ul, ol').filter((_i, node) => {
    const items = $(node).children('li'); if (!items.length) return false;
    return items.filter((_j, item) => $(item).find('a').toArray().some(a => SHARE_LINK.test($(a).attr('href') ?? '')) || textLength($, $(item)) <= 1).length >= items.length / 2
      && items.filter((_j, item) => $(item).find('a').toArray().some(a => SHARE_LINK.test($(a).attr('href') ?? ''))).length > 0;
  }).remove();
  root.find('a[href]').filter((_i, node) => SHARE_LINK.test($(node).attr('href') ?? '')).remove();
  // Links to the page's own comment thread ("Discuss (0)").
  root.find('a[href*="#"]').filter((_i, node) => /#[\w-]*comment/i.test($(node).attr('href') ?? '') && textLength($, $(node)) < 40).remove();
  // Sections opened by a chrome heading. A heading that opens its own container takes the container with it.
  root.find('h2, h3, h4, h5, h6, summary').filter((_i, node) => CHROME_HEADING.test($(node).text().replace(/\s+/g, ' ').trim())).each((_i, node) => {
    let heading: Cheerio<AnyNode> = $(node); if (!heading.closest(root).length) return;
    const holder = heading.closest('details');
    if (holder.length && holder.closest(root).length && small(holder)) { holder.remove(); return; }
    // Step out of wrappers that hold only the heading, e.g. <div class="title"><h2>Related content</h2></div>.
    while (!heading.parent().is(root) && textLength($, heading.parent()) === textLength($, heading) && !heading.parent().find('figure, table').length) heading = heading.parent();
    const parent = heading.parent();
    if (!parent.is(root) && parent.children().first().is(heading) && small(parent)) { parent.remove(); return; }
    // Otherwise the section runs to the next sibling that is, or holds, a heading of the same or higher level.
    const level = Number(node.tagName.slice(1)) || 6;
    const stop = Array.from({ length: level }, (_unused, i) => 'h' + (i + 1)).join(', ');
    const following = heading.nextAll().toArray(); const end = following.findIndex(sibling => $(sibling).is(stop) || $(sibling).find(stop).length > 0);
    const section = $(end < 0 ? following : following.slice(0, end));
    if (small(section)) { section.remove(); heading.remove(); }
  });
  // Decorative images: avatars, emoji and icons, and anything drawn at icon size.
  const tiny = (node: Cheerio<AnyNode>) => { const w = Number($(node).attr('width')), h = Number($(node).attr('height')); return w > 0 && h > 0 && w <= 48 && h <= 48; };
  root.find('img').filter((_i, node) => {
    const image = $(node); const words = (image.attr('class') ?? '').split(/\s+/);
    return words.some(word => /^(avatar|gravatar|emoji|wp-smiley|icon)([-_]|$)/i.test(word)) || /^(avatar|author photo|profile photo)/i.test(image.attr('alt') ?? '') || tiny(image);
  }).remove();
  root.find('svg').filter((_i, node) => {
    const svg = $(node); if (svg.parents('svg, mjx-container').length || /em$/.test(svg.attr('width') ?? '')) return false;
    // Small inline diagrams and equations are content: only icons marked as decorative, or drawn inside a link, go.
    return tiny(svg) && (svg.attr('aria-hidden') === 'true' || svg.parents('a').length > 0);
  }).remove();
  // Short text before the title (category links, language names, breadcrumbs that had no telling class).
  const title = root.find('h1').first();
  for (let node: Cheerio<AnyNode> = title; title.length && node.length && !node.is(root); node = node.parent()) {
    node.prevAll().filter((_i, sibling) => !$(sibling).find('img, svg, picture, figure, video, iframe, table').length && !['img', 'svg', 'figure', 'picture', 'video', 'table'].includes((sibling as Element).tagName) && textLength($, $(sibling)) < 300).remove();
  }
  root.find('a[href]').each((_i, node) => { const anchor = $(node); anchor.attr('href', withoutTracking(anchor.attr('href')!, base)); });
}
