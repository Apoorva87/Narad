import { z } from 'zod';
import { modes } from './lesson';
import { providers } from './preparation';
import { voices } from './speech';

const spoken = z.string().trim().min(1).max(12_000);
const markdown = z.string().trim().min(1).max(20_000);
const textBlock = z.object({ kind: z.literal('text'), markdown, spokenText: spoken }).strict();
const equationBlock = z.object({ kind: z.literal('equation'), latex: z.string().trim().min(1).max(4_000), markdown, spokenText: spoken }).strict();
const existingFigureBlock = z.object({ kind: z.literal('existing-figure'), assetId: z.string().min(1).max(160), markdown, spokenText: spoken }).strict();
const diagramBlock = z.object({
  kind: z.literal('diagram'), title: z.string().trim().min(1).max(160), caption: z.string().trim().min(1).max(600), spokenText: spoken,
  nodes: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().trim().min(1).max(120) }).strict()).min(2).max(12),
  edges: z.array(z.object({ from: z.string().min(1).max(40), to: z.string().min(1).max(40), label: z.string().trim().max(80).nullable() }).strict()).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.nodes.map(node => node.id));
  for (const [index, edge] of value.edges.entries()) for (const key of ['from', 'to'] as const)
    if (!ids.has(edge[key])) ctx.addIssue({ code: 'custom', path: ['edges', index, key], message: 'Diagram edges must reference an existing node.' });
});
const plotBlock = z.object({
  kind: z.literal('plot'), title: z.string().trim().min(1).max(160), caption: z.string().trim().min(1).max(600), spokenText: spoken,
  xLabel: z.string().trim().min(1).max(80), yLabel: z.string().trim().min(1).max(80),
  series: z.array(z.object({ label: z.string().trim().min(1).max(80), points: z.array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict()).min(2).max(80) }).strict()).min(1).max(6),
}).strict();

export const tutorAnswerBlockSchema = z.union([textBlock, equationBlock, existingFigureBlock, diagramBlock, plotBlock]);
export const tutorCitationSchema = z.object({
  title: z.string().trim().min(1).max(240), url: z.url().nullable(), sourceId: z.string().min(1).max(160).nullable(), locator: z.string().max(240).nullable(),
}).strict().refine(value => value.url || value.sourceId, 'A citation needs a source ID or URL.');
export const tutorAnswerSchema = z.object({
  blocks: z.array(tutorAnswerBlockSchema).min(1).max(20),
  citations: z.array(tutorCitationSchema).max(20),
  suggestedFollowUps: z.array(z.string().trim().min(1).max(240)).max(4),
}).strict();

export const tutorAskSchema = z.object({
  mode: z.enum(modes), sectionId: z.string().min(1).max(100), blockId: z.string().min(1).max(100),
  question: z.string().trim().min(1, 'Enter a question first.').max(4_000), provider: z.enum(providers), scope: z.enum(['lesson', 'research']),
}).strict();
export const tutorSpeechRequestSchema = z.object({
  turnId: z.string().min(1).max(100), part: z.enum(['question', 'answer']), chunk: z.number().int().min(0), voice: z.enum(voices),
}).strict();

export type TutorAnswer = z.infer<typeof tutorAnswerSchema>;
export type TutorAnswerBlock = z.infer<typeof tutorAnswerBlockSchema>;
export type TutorAsk = z.infer<typeof tutorAskSchema>;
export type TutorScope = TutorAsk['scope'];
export type TutorStatus = 'queued' | 'reading' | 'answering' | 'ready' | 'failed' | 'cancelled';
export type TutorTurn = TutorAsk & {
  id: string; lessonId: string; status: TutorStatus; stage: string; createdAt: string; updatedAt: string;
  answer?: TutorAnswer; error?: string;
};
export type TutorThread = { lessonId: string; mode: TutorAsk['mode']; sectionId: string; blockId: string; turns: TutorTurn[] };
export type TutorState = { providers: { id: TutorAsk['provider']; available: boolean }[]; activeTurnId?: string; threads: TutorThread[] };

export function groupTutorThreads(turns: TutorTurn[]): TutorThread[] {
  const grouped = new Map<string, TutorThread>();
  for (const turn of turns) {
    const key = [turn.lessonId, turn.mode, turn.sectionId, turn.blockId].join('\u0000');
    const thread = grouped.get(key) ?? { lessonId: turn.lessonId, mode: turn.mode, sectionId: turn.sectionId, blockId: turn.blockId, turns: [] };
    thread.turns.push(turn); grouped.set(key, thread);
  }
  return [...grouped.values()];
}
