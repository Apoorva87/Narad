import { modes, type Lesson, type LessonBlock } from '../shared/lesson';
import type { CapturedSource, Credit } from '../shared/sources';

function block(lesson: Lesson, item: LessonBlock): string {
  switch (item.kind) {
    case 'equation': return `$$\n${item.latex}\n$$\n\n${item.markdown}`;
    case 'figure': {
      const asset = lesson.assets.find(candidate => candidate.id === item.assetId);
      return (asset ? `![${asset.alt}](${asset.src})\n\n*${asset.caption}*\n\n` : '') + item.markdown;
    }
    case 'callout': return `> **${item.title}**\n>\n> ${item.markdown.replace(/\n/g, '\n> ')}`;
    case 'dialogue': return `**${item.speaker}:** ${item.markdown}`;
    default: return item.markdown;
  }
}

/** A readable copy of the lesson: the walkthrough when present, otherwise its first mode. */
export function renderLessonMarkdown(lesson: Lesson): string {
  const mode = lesson.modes.walkthrough ?? lesson.modes[modes.find(name => lesson.modes[name])!]!;
  const sections = mode.sections.map(section => [`## ${section.title}`, ...(section.description ? [section.description] : []), ...section.blocks.map(item => block(lesson, item))].join('\n\n'));
  return [`# ${lesson.title}`, lesson.description, ...sections].join('\n\n') + '\n';
}

type Creditable = { kind?: string; src?: string; alt: string; caption: string; credit?: Credit; video?: { url: string }; originalUrl?: string };
const fileName = (asset: Creditable) => {
  const from = asset.src ?? asset.video?.url ?? asset.credit?.mediaUrl ?? '';
  if (from.startsWith('data:')) return '';
  return decodeURIComponent(from.split(/[?#]/)[0].split('/').pop() ?? '');
};
function entry(asset: Creditable): string {
  const credit = asset.credit;
  const name = fileName(asset);
  const caption = credit?.caption || asset.caption || asset.alt;
  const parts = [credit?.creditLine, credit?.license && `Licence: ${credit.license}`, (credit?.mediaUrl ?? asset.originalUrl) && `Media: ${credit?.mediaUrl ?? asset.originalUrl}`,
    credit?.pageUrl && `Page: ${credit.pageUrl}`].filter(Boolean);
  return `- ${asset.kind === 'video' ? 'Video ' : ''}${name ? `\`${name}\`` : '(embedded)'}${caption ? `: ${caption}` : ''}${parts.length ? ` — ${parts.join('. ')}` : ''}`;
}

/**
 * CREDITS.md: every captured image, video and upload, grouped by the page it came from, from each asset's credit (file name,
 * caption, credit line, licence, media URL, page link). Lesson images not among the sources (for example from an older
 * capture) are listed under their own page; links the lesson cites without media follow at the end.
 */
export function renderCredits(item: { title: string; sources: CapturedSource[]; lesson?: Lesson }): string {
  const lines = [`# Credits: ${item.title}`, ''];
  const listed = new Set<string>();
  const key = (asset: Creditable) => fileName(asset) || asset.credit?.mediaUrl || asset.originalUrl || '';
  for (const source of item.sources) {
    lines.push(`## ${source.title}`, '', source.url ? `Source: ${source.url}` : `Source: ${source.kind === 'note' ? 'your notes' : 'your upload'}`);
    const assets = source.assets.filter(asset => !asset.error);
    if (assets.length) lines.push('');
    for (const asset of assets) { lines.push(entry(asset)); const k = key(asset); if (k) listed.add(k); }
    lines.push('');
  }
  const pages = new Map<string, { title: string; url: string; entries: string[] }>();
  for (const asset of item.lesson?.assets ?? []) {
    if (!asset.credit) continue;
    const k = key(asset);
    if (k && listed.has(k)) continue;
    if (k) listed.add(k);
    const id = asset.credit.pageUrl || asset.credit.pageTitle;
    const page = pages.get(id) ?? { title: asset.credit.pageTitle || asset.credit.pageUrl || 'Lesson images', url: asset.credit.pageUrl, entries: [] };
    page.entries.push(entry(asset)); pages.set(id, page);
  }
  for (const page of pages.values()) lines.push(`## ${page.title}`, '', ...(page.url ? [`Source: ${page.url}`, ''] : []), ...page.entries, '');
  const cited = item.lesson?.sources.filter(source => source.url && !item.sources.some(captured => captured.url === source.url) && !pages.has(source.url)) ?? [];
  if (cited.length) lines.push('## Also cited in the lesson', '', ...cited.map(source => `- ${source.title}: ${source.url}`), '');
  if (lines.length === 2) lines.push('No external sources.', '');
  return lines.join('\n');
}
