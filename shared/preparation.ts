import { z } from 'zod';
import { familiarities } from './lesson';
export const providers = ['codex', 'claude'] as const;
export type Provider = typeof providers[number];
export const prepareInput = z.object({ provider: z.enum(providers), familiarity: z.enum(familiarities).optional() });
export const renameInput = z.object({ title: z.string().trim().min(1).max(180) });
export type PreparationJob = {
  id: string; bundleId: string; title: string; provider: Provider;
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  stage: string; completed: number; total: number; createdAt: string; updatedAt: string;
  lessonId?: string; error?: string;
};
export type PreparationState = {
  jobs: PreparationJob[];
  sessions: { jobId: string; provider: Provider; pid: number; startedAt: string }[];
  providers: { id: Provider; available: boolean }[];
};
