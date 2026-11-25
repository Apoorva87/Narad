import { z } from 'zod';

export const modes = ['summary', 'walkthrough', 'dialogue', 'course'] as const;
export type Mode = typeof modes[number];
export const modeLabels: Record<Mode, string> = {
  summary: 'Quick summary', walkthrough: 'Detailed walkthrough', dialogue: 'Tutor dialogue', course: 'Course',
};
export const familiarities = ['foundational', 'some-background', 'advanced'] as const;
export type Familiarity = typeof familiarities[number];
export const familiarityLabels: Record<Familiarity, string> = { foundational: 'Foundational', 'some-background': 'Some background', advanced: 'Advanced' };
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/, 'Use a short ID with letters, numbers, hyphens or underscores.');
const text = z.string().trim().min(1);
const reference = z.object({ sourceId: id, locator: text });
const common = {
  id, markdown: text, spokenText: text,
  references: z.array(reference),
  origin: z.enum(['source', 'teaching']),
};
/** A teaching diagram drawn by Narad from named boxes and labelled arrows; the agent never supplies drawing code. */
export const diagramShape = {
  nodes: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().trim().min(1).max(120) })).min(2).max(8),
  edges: z.array(z.object({ from: z.string().min(1).max(40), to: z.string().min(1).max(40), label: z.string().trim().max(80).nullable() })).min(1).max(12),
};
/** Problems that make a diagram undrawable: an arrow to a box that does not exist, a repeated box, or a box nothing connects to. */
export function diagramIssues(diagram: { nodes: { id: string }[]; edges: { from: string; to: string }[] }): string[] {
  const ids = diagram.nodes.map(node => node.id); const known = new Set(ids); const issues: string[] = [];
  if (known.size !== ids.length) issues.push('Diagram box IDs must be unique.');
  for (const edge of diagram.edges) {
    for (const end of [edge.from, edge.to]) if (!known.has(end)) issues.push('Diagram arrow refers to a missing box: ' + end + '.');
    if (edge.from === edge.to) issues.push('Diagram arrow starts and ends at the same box: ' + edge.from + '.');
  }
  for (const id of known) if (!diagram.edges.some(edge => edge.from === id || edge.to === id)) issues.push('Diagram box has no arrow: ' + id + '.');
  return issues;
}
const blockSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('text') }),
  z.object({ ...common, kind: z.literal('equation'), latex: text }),
  z.object({ ...common, kind: z.literal('figure'), assetId: id }),
  z.object({ ...common, kind: z.literal('callout'), title: text }),
  z.object({ ...common, kind: z.literal('dialogue'), speaker: text, role: z.enum(['host', 'expert']) }),
  // `markdown` is the caption shown under the drawing.
  z.object({ ...common, kind: z.literal('diagram'), title: text, ...diagramShape }),
  // A problem worked by hand. `markdown` states the problem; the reader can reveal one step at a time. `spokenText` speaks the problem, every step and the result.
  z.object({ ...common, kind: z.literal('steps'), title: text, steps: z.array(z.object({ markdown: text })).min(2).max(8), result: text }),
  // `markdown`/`spokenText` ask the question; narration waits for an answer before it speaks the explanation.
  z.object({ ...common, kind: z.literal('quiz'), options: z.array(text).min(2).max(5), answer: z.number().int().min(0), explanation: text, explanationSpoken: text }),
]);
const sourceSchema = z.object({
  id, title: text, kind: z.enum(['note', 'article', 'paper']),
  content: text, locators: z.array(text).min(1),
  url: z.url().refine(value => /^https?:\/\//i.test(value), 'Source links must use HTTP or HTTPS.').optional(),
});
export function isSafeAsset(src: string) {
  return /^\/assets\/[a-zA-Z0-9_-]+\.(svg|png|webp|jpg|jpeg)$/.test(src)
    || /^\/api\/source-assets\/[a-f0-9]{64}$/.test(src)
    // Library media: relative inside lesson.json, served form over the API.
    || /^(\/api\/library\/[a-z0-9][a-z0-9-]{0,99}\/)?media\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(src)
    || /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(src);
}
export const creditSchema = z.object({
  pageTitle: z.string(), pageUrl: z.string(), mediaUrl: z.string().optional(), caption: z.string().optional(),
  creditLine: z.string().max(300).optional(), license: z.string().optional(), capturedAt: z.string(),
});
const httpsUrl = z.url().refine(value => value.startsWith('https://'), 'Use an https link.');
/** Videos stream from their source: embeds are limited to privacy-enhanced YouTube, Vimeo's player, or the original https file. */
export const videoSchema = z.object({ provider: z.enum(['youtube', 'vimeo', 'file']), url: httpsUrl, embedUrl: httpsUrl }).superRefine((video, ctx) => {
  if (!URL.canParse(video.embedUrl)) { ctx.addIssue({ code: 'custom', message: 'This video embed is not a valid link.', path: ['embedUrl'] }); return; }
  const host = new URL(video.embedUrl).hostname;
  const ok = video.provider === 'youtube' ? host === 'www.youtube-nocookie.com'
    : video.provider === 'vimeo' ? host === 'player.vimeo.com' : video.embedUrl === video.url;
  if (!ok) ctx.addIssue({ code: 'custom', message: 'This video embed is not from an allowed streaming host.', path: ['embedUrl'] });
});
const assetSchema = z.object({
  id, src: text.refine(isSafeAsset, 'Use a saved local image, a bundled /assets/ image, or an embedded PNG, JPEG, or WebP.'),
  alt: text, caption: text, provenance: z.enum(['source', 'teaching']),
  kind: z.enum(['image', 'inline-svg', 'video']).optional(), widthEm: z.number().positive().max(100).optional(),
  credit: creditSchema.optional(), video: videoSchema.optional(),
}).superRefine((asset, ctx) => {
  if ((asset.kind === 'video') !== (asset.video !== undefined)) ctx.addIssue({ code: 'custom', message: 'A video asset needs video details, and only video assets have them.', path: ['video'] });
});
const sectionSchema = z.object({ id, title: text, description: text.optional(), blocks: z.array(blockSchema).min(1) });
const modeSchema = z.object({ title: text, sections: z.array(sectionSchema).min(1) });
export const lessonSchema = z.object({
  version: z.literal(1), id, title: text.max(200), description: text.max(1000), topic: text.max(80),
  createdAt: z.iso.datetime(), isSample: z.boolean().default(false),
  sourceBundleId: id.optional(),
  familiarity: z.enum(familiarities),
  sources: z.array(sourceSchema).min(1), assets: z.array(assetSchema),
  modes: z.object({ summary: modeSchema.optional(), walkthrough: modeSchema.optional(), dialogue: modeSchema.optional(), course: modeSchema.optional() }),
}).superRefine((lesson, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const unique = (values: string[], name: string) => {
    if (new Set(values).size !== values.length) issue('Duplicate ' + name + ' IDs.');
  };
  unique(lesson.sources.map(s => s.id), 'source');
  unique(lesson.assets.map(a => a.id), 'asset');
  if (!modes.some(mode => lesson.modes[mode])) issue('Prepare at least one learning mode.');
  for (const mode of modes) {
    const content = lesson.modes[mode];
    if (!content) continue;
    unique(content.sections.map(s => s.id), mode + ' section');
    unique(content.sections.flatMap(s => s.blocks.map(b => b.id)), mode + ' block');
    for (const section of content.sections) for (const block of section.blocks) {
      if (block.origin === 'source' && !block.references.length) issue('Block ' + block.id + ' needs a source reference.');
      for (const ref of block.references) {
        const source = lesson.sources.find(s => s.id === ref.sourceId);
        if (!source) issue('Block ' + block.id + ' references missing source ' + ref.sourceId + '.');
        else if (!source.locators.includes(ref.locator)) issue('Block ' + block.id + ' references missing location ' + ref.locator + '.');
      }
      if (block.kind === 'figure' && !lesson.assets.some(a => a.id === block.assetId)) issue('Block ' + block.id + ' references missing image ' + block.assetId + '.');
      if (block.kind === 'quiz' && block.answer >= block.options.length) issue('Block ' + block.id + ' marks an answer that is not among its options.');
      if (block.kind === 'diagram') for (const problem of diagramIssues(block)) issue('Block ' + block.id + ': ' + problem);
    }
  }
});

export type Lesson = z.infer<typeof lessonSchema>;
export type LessonBlock = z.infer<typeof blockSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type LessonSummary = Pick<Lesson, 'id' | 'title' | 'description' | 'topic' | 'createdAt' | 'isSample' | 'familiarity' | 'sourceBundleId'> & {
  availableModes: Mode[]; sourceCount: number; blockCount: number;
  /** Why the item's files could not be read (for example after a hand edit). */
  broken?: string;
};
export type Progress = { lastMode: Mode | null; positions: Partial<Record<Mode, string>> };
export function parseLesson(input: unknown): Lesson { return lessonSchema.parse(input); }
