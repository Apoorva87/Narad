import { z } from 'zod';

export const modes = ['summary', 'walkthrough', 'dialogue'] as const;
export type Mode = typeof modes[number];
export const modeLabels: Record<Mode, string> = {
  summary: 'Quick summary', walkthrough: 'Detailed walkthrough', dialogue: 'Tutor dialogue',
};
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/, 'Use a short ID with letters, numbers, hyphens or underscores.');
const text = z.string().trim().min(1);
const reference = z.object({ sourceId: id, locator: text });
const common = {
  id, markdown: text, spokenText: text,
  references: z.array(reference),
  origin: z.enum(['source', 'teaching']),
};
const blockSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('text') }),
  z.object({ ...common, kind: z.literal('equation'), latex: text }),
  z.object({ ...common, kind: z.literal('figure'), assetId: id }),
  z.object({ ...common, kind: z.literal('callout'), title: text }),
  z.object({ ...common, kind: z.literal('dialogue'), speaker: text, role: z.enum(['host', 'expert']) }),
]);
const sourceSchema = z.object({
  id, title: text, kind: z.enum(['note', 'article', 'paper']),
  content: text, locators: z.array(text).min(1),
  url: z.url().refine(value => /^https?:\/\//i.test(value), 'Source links must use HTTP or HTTPS.').optional(),
});
export function isSafeAsset(src: string) {
  return /^\/assets\/[a-zA-Z0-9_-]+\.(svg|png|webp|jpg|jpeg)$/.test(src)
    || /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(src);
}
const assetSchema = z.object({
  id, src: text.refine(isSafeAsset, 'Use a bundled /assets/ image or an embedded PNG, JPEG, or WebP.'),
  alt: text, caption: text, provenance: z.enum(['source', 'teaching']),
});
const sectionSchema = z.object({ id, title: text, description: text.optional(), blocks: z.array(blockSchema).min(1) });
const modeSchema = z.object({ title: text, sections: z.array(sectionSchema).min(1) });
export const lessonSchema = z.object({
  version: z.literal(1), id, title: text.max(200), description: text.max(1000), topic: text.max(80),
  createdAt: z.iso.datetime(), isSample: z.boolean().default(false),
  familiarity: z.enum(['foundational', 'some-background', 'advanced']),
  sources: z.array(sourceSchema).min(1), assets: z.array(assetSchema),
  modes: z.object({ summary: modeSchema.optional(), walkthrough: modeSchema.optional(), dialogue: modeSchema.optional() }),
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
    }
  }
});

export type Lesson = z.infer<typeof lessonSchema>;
export type LessonBlock = z.infer<typeof blockSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type LessonSummary = Pick<Lesson, 'id' | 'title' | 'description' | 'topic' | 'createdAt' | 'isSample' | 'familiarity'> & {
  availableModes: Mode[]; sourceCount: number; blockCount: number;
};
export type Progress = { lastMode: Mode | null; positions: Partial<Record<Mode, string>> };
export function parseLesson(input: unknown): Lesson { return lessonSchema.parse(input); }
