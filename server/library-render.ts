import { modes, type Lesson, type LessonBlock } from '../shared/lesson';
import type { CapturedSource } from '../shared/sources';

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

export function renderCredits(item: { title: string; sources: CapturedSource[]; lesson?: Lesson }): string {
  const lines = [`# Credits: ${item.title}`, ''];
  for (const source of item.sources) {
    lines.push(`## ${source.title}`, '', source.url ? `Source: ${source.url}` : `Source: ${source.kind === 'note' ? 'your notes' : 'your upload'}`);
    for (const asset of source.assets) if (asset.originalUrl) lines.push(`- ${asset.caption || asset.alt}: ${asset.originalUrl}`);
    lines.push('');
  }
  const cited = item.lesson?.sources.filter(source => source.url && !item.sources.some(captured => captured.url === source.url)) ?? [];
  if (cited.length) lines.push('## Also cited in the lesson', '', ...cited.map(source => `- ${source.title}: ${source.url}`), '');
  if (lines.length === 2) lines.push('No external sources.', '');
  return lines.join('\n');
}
