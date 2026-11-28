import { z } from 'zod';
import { familiarities } from './lesson';
export const providers = ['codex', 'claude'] as const;
export type Provider = typeof providers[number];
export const prepareActions = ['continue', 'restart'] as const;
export type PrepareAction = typeof prepareActions[number];
/** `continue` (default) reuses finished sections whose source is unchanged; `restart` archives them and starts over. */
export const prepareInput = z.object({ provider: z.enum(providers), familiarity: z.enum(familiarities).optional(), action: z.enum(prepareActions).default('continue'), /** Topic-only lessons: draw an outline and wait for the learner's picks before researching. Off keeps today's one-shot research. */ steer: z.boolean().default(false) });
/** How much of a topic the lesson should cover. */
export const steerChoices = ['deeper', 'summary', 'skip'] as const;
export type SteerChoice = typeof steerChoices[number];
export const steerMaxDepth = 3;
/** Most topics one outline may hold, all levels together. */
export const steerMaxTopics = 40;
/** One card in the outline. Ids are assigned by the server (`t1`, `t1-2`), never by the agent. `depth` 1 is a top-level topic. */
export type SteerTopic = { id: string; parentId?: string; depth: number; title: string; blurb: string; choice: SteerChoice; note?: string; children?: string[]; links?: string[] };
/** `preparation/steering.json`. `choosing` while the learner picks; `confirmed` once they asked for the lesson. Topics are a flat list in display order; a topic's children follow `children`/`parentId`. */
export type SteeringPlan = {
  status: 'choosing' | 'confirmed'; focus?: string; topics: SteerTopic[];
  /** `wanted` is the link count before trimming to `total`; `planned` is what research will actually fetch (`planned < wanted` means the cap is trimming). */
  budget: { total: number; planned: number; wanted: number };
  /** Increases on every write to steering.json, so the page can ignore a stale copy that arrives after its own save. */
  rev: number;
};
/** Learner edits: unknown topic ids are rejected; only choice and note change, never structure. */
export const steerPatchInput = z.object({ focus: z.string().trim().max(500).optional(), topics: z.array(z.object({ id: z.string().min(1).max(40), choice: z.enum(steerChoices).optional(), note: z.string().trim().max(300).optional() })).max(steerMaxTopics).optional() });
export type SteerPatch = z.infer<typeof steerPatchInput>;
export const steerExpandInput = z.object({ topicId: z.string().min(1).max(40) });
/** Remove a topic's sub-topics (back to a single card, choice Summary). Only while awaiting input. */
export const steerCollapseInput = z.object({ topicId: z.string().min(1).max(40) });
export const steerConfirmInput = z.object({ patch: steerPatchInput.optional(), /** Accept the agent's default picks (every topic Summary) without editing. */ suggested: z.boolean().optional() });
export const renameInput = z.object({ title: z.string().trim().min(1).max(180) });
/** Tokens (and cost, when the agent reports it) spent by one or more agent calls. */
export type AgentUsage = { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number; /** True when a provider reports only its coordinator, not child agents. */ partial?: boolean };
export function addUsage(total: AgentUsage | undefined, more: AgentUsage | undefined): AgentUsage | undefined {
  if (!more) return total;
  if (!total) return { ...more };
  const sum: AgentUsage = { inputTokens: total.inputTokens + more.inputTokens, outputTokens: total.outputTokens + more.outputTokens };
  if (total.cachedTokens !== undefined || more.cachedTokens !== undefined) sum.cachedTokens = (total.cachedTokens ?? 0) + (more.cachedTokens ?? 0);
  if (total.costUsd !== undefined || more.costUsd !== undefined) sum.costUsd = (total.costUsd ?? 0) + (more.costUsd ?? 0);
  if (total.partial || more.partial) sum.partial = true;
  return sum;
}
export type PreparationSection = { task: string; title: string; state: string; durationMs?: number; error?: string };
/** One item's latest preparation run, read from its folder's `preparation/progress.json`. `id`, `bundleId` and `slug` are the folder name. */
export type PreparationJob = {
  id: string; bundleId: string; slug: string; title: string; provider: Provider;
  status: 'queued' | 'running' | 'stopping' | 'awaiting-input' | 'completed' | 'failed' | 'stopped' | 'cancelled' | 'interrupted';
  /** 1-based place in the waiting queue, and the queue's length, while status is `queued`. */
  queuePosition?: number; queueLength?: number;
  stage: string; completed: number; total: number; createdAt: string; updatedAt: string;
  sections: PreparationSection[]; folder: string;
  lessonId?: string; error?: string;
  /** True when this run was started with "Steer the research" (kept even after capture adds articles to the bundle). */
  steer?: boolean;
  /** The outline, present while `awaiting-input` and while its topics are being expanded. */
  steering?: SteeringPlan;
  /** Tokens spent by this run's agent calls, including retried attempts. */
  usage?: AgentUsage;
};
export type PreparationState = {
  jobs: PreparationJob[];
  /** Every live agent process across all running lessons; `slug` (= `jobId`) names the lesson it works for. */
  sessions: { jobId: string; slug: string; provider: Provider; pid: number; startedAt: string }[];
  providers: { id: Provider; available: boolean }[];
};
