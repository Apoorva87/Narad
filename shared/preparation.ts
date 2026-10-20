import { z } from 'zod';
import { familiarities } from './lesson';
export const providers = ['codex', 'claude'] as const;
export type Provider = typeof providers[number];
export const prepareActions = ['continue', 'restart'] as const;
export type PrepareAction = typeof prepareActions[number];
/** `continue` (default) reuses finished sections whose source is unchanged; `restart` archives them and starts over. */
export const prepareInput = z.object({ provider: z.enum(providers), familiarity: z.enum(familiarities).optional(), action: z.enum(prepareActions).default('continue') });
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
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'cancelled' | 'interrupted';
  stage: string; completed: number; total: number; createdAt: string; updatedAt: string;
  sections: PreparationSection[]; folder: string;
  lessonId?: string; error?: string;
  /** Tokens spent by this run's agent calls, including retried attempts. */
  usage?: AgentUsage;
};
export type PreparationState = {
  jobs: PreparationJob[];
  sessions: { jobId: string; provider: Provider; pid: number; startedAt: string }[];
  providers: { id: Provider; available: boolean }[];
};
