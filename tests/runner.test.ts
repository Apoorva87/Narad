import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CallRunner, type CallRecord } from '../server/runner';
import type { AgentRequest, AgentRunner, AgentUsage } from '../server/agent-runner';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'narad-runner-')); dirs.push(d); return d; };
const schema = z.object({ ok: z.boolean() });
const input = (step: 'author' | 'review' = 'author', task = 'r0-s00-p0') => ({ step, task, prompt: 'Hello prompt', schema, images: [], provider: 'codex' as const, timeoutMs: 1000 });
const fake = (run: (r: AgentRequest, s: AbortSignal, p?: (pid: number | null) => void, u?: (usage: AgentUsage) => void) => Promise<unknown>): AgentRunner => ({ run, available: () => [] });
const setup = async (run: (r: AgentRequest, s: AbortSignal, p?: (pid: number | null) => void, u?: (usage: AgentUsage) => void) => Promise<unknown>) => { const dir = await tmp(); const records: CallRecord[] = []; return { dir, records, runner: new CallRunner(dir, fake(run), async c => { records.push(c); }) }; };

it('numbers calls and writes prompt, result and log files', async () => {
  const { dir, records, runner } = await setup(async () => ({ ok: true }));
  const signal = new AbortController().signal;
  expect(await runner.run(input('author'), signal)).toEqual({ ok: true });
  await runner.run(input('review'), signal);
  const files = await readdir(join(dir, 'calls'));
  for (const f of ['001-author-r0-s00-p0.prompt.md', '001-author-r0-s00-p0.result.json', '001-author-r0-s00-p0.log', '002-review-r0-s00-p0.prompt.md', '002-review-r0-s00-p0.result.json', '002-review-r0-s00-p0.log']) expect(files).toContain(f);
  expect(await readFile(join(dir, 'calls', '001-author-r0-s00-p0.prompt.md'), 'utf8')).toBe('Hello prompt');
  expect(JSON.parse(await readFile(join(dir, 'calls', '001-author-r0-s00-p0.result.json'), 'utf8'))).toEqual({ ok: true });
  expect(records.map(r => [r.n, r.step, r.task, r.outcome])).toEqual([[1, 'author', 'r0-s00-p0', 'ok'], [2, 'review', 'r0-s00-p0', 'ok']]);
});
it('continues numbering after the highest existing call', async () => {
  const dir = await tmp(); await mkdir(join(dir, 'calls')); await writeFile(join(dir, 'calls', '014-author-x.log'), '');
  const records: CallRecord[] = [];
  const runner = new CallRunner(dir, fake(async () => ({ ok: true })), async c => { records.push(c); });
  await runner.run(input(), new AbortController().signal);
  expect(records[0].n).toBe(15);
  expect(await readdir(join(dir, 'calls'))).toContain('015-author-r0-s00-p0.prompt.md');
});
it('retries once and records retried', async () => {
  let n = 0; const { records, runner } = await setup(async () => { if (n++ === 0) throw new Error('boom'); return { ok: true }; });
  expect(await runner.run(input(), new AbortController().signal)).toEqual({ ok: true });
  expect(n).toBe(2); expect(records).toHaveLength(1); expect(records[0].outcome).toBe('retried');
});
it('rejects with the second error and records failed', async () => {
  let n = 0; const { records, runner } = await setup(async () => { throw new Error('boom' + ++n); });
  await expect(runner.run(input(), new AbortController().signal)).rejects.toThrow('boom2');
  expect(records[0]).toMatchObject({ outcome: 'failed', error: 'boom2' });
});
it('treats schema-invalid output as a failure', async () => {
  let n = 0; const { records, runner } = await setup(async () => n++ === 0 ? { ok: 'no' } : { ok: true });
  expect(await runner.run(input(), new AbortController().signal)).toEqual({ ok: true });
  expect(records[0].outcome).toBe('retried');
  const bad = await setup(async () => ({ nope: 1 }));
  await expect(bad.runner.run(input(), new AbortController().signal)).rejects.toThrow();
  expect(bad.records[0].outcome).toBe('failed');
});
it('rejects immediately without retrying when aborted', async () => {
  let n = 0; const ac = new AbortController();
  const { records, runner } = await setup(async (_r, s) => { n++; ac.abort(); s.throwIfAborted(); return { ok: true }; });
  await expect(runner.run(input(), ac.signal)).rejects.toThrow();
  expect(n).toBe(1); expect(records[0].outcome).toBe('failed');
  n = 0; await expect(runner.run(input(), ac.signal)).rejects.toThrow(); expect(n).toBe(0);
});
it('passes cwd, name, kind and the JSON schema to the agent runner', async () => {
  const seen: AgentRequest[] = []; const { dir, runner } = await setup(async r => { seen.push(r); return { ok: true }; });
  await runner.run({ ...input('review'), model: 'm' }, new AbortController().signal);
  expect(seen[0]).toMatchObject({ kind: 'review', cwd: join(dir, 'calls'), name: '001-review-r0-s00-p0', model: 'm', timeoutMs: 1000, provider: 'codex' });
  expect((seen[0].schema as any).properties.ok).toBeDefined();
});

it('adds up usage across retried attempts and records it on the call', async () => {
  let n = 0;
  const { records, runner } = await setup(async (_r, _s, _p, onUsage) => { onUsage?.({ inputTokens: 10, outputTokens: 2, cachedTokens: 4, partial: true }); onUsage?.({ inputTokens: 5, outputTokens: 1, costUsd: 0.25 }); return n++ === 0 ? { nope: 1 } : { ok: true }; });
  await runner.run(input(), new AbortController().signal);
  expect(records[0].outcome).toBe('retried');
  expect(records[0].usage).toEqual({ inputTokens: 30, outputTokens: 6, cachedTokens: 8, costUsd: 0.5, partial: true });
});
it('records no usage when the runner reports none', async () => {
  const { records, runner } = await setup(async () => ({ ok: true }));
  await runner.run(input(), new AbortController().signal);
  expect(records[0].usage).toBeUndefined();
});
it('formats the usage line with cost only when known', async () => {
  const { usageLine } = await import('../src/components/PreparationPanel');
  expect(usageLine({ inputTokens: 1_200_000, outputTokens: 84_000, cachedTokens: 900_000, costUsd: 3.41 })).toBe('Tokens: 1.2M in · 84k out (cached 900k) · $3.41');
  expect(usageLine({ inputTokens: 900, outputTokens: 12 })).toBe('Tokens: 900 in · 12 out');
  expect(usageLine({ inputTokens: 900, outputTokens: 12, partial: true })).toBe('Tokens: 900 in · 12 out · coordinator only; subagent tokens not reported');
});
it('retries resource exhaustion up to four times with pauses, and stops waiting when cancelled', async () => {
  const exhausted = 'Agent failed. failed to spawn thread: Os { code: 11, kind: WouldBlock, message: "Resource temporarily unavailable" }';
  let n = 0; const dir = await tmp(); const records: CallRecord[] = [];
  const runner = new CallRunner(dir, fake(async () => { if (++n < 4) throw new Error(exhausted); return { ok: true }; }), async c => { records.push(c); }, [1, 1, 1]);
  expect(await runner.run(input(), new AbortController().signal)).toEqual({ ok: true });
  expect(n).toBe(4); expect(records[0].outcome).toBe('retried');
  n = 0; const failing = new CallRunner(dir, fake(async () => { n++; throw new Error(exhausted); }), async c => { records.push(c); }, [1, 1, 1]);
  await expect(failing.run(input(), new AbortController().signal)).rejects.toThrow(/Resource temporarily unavailable/); expect(n).toBe(4);
  const ac = new AbortController(); n = 0;
  const slow = new CallRunner(dir, fake(async () => { n++; setTimeout(() => ac.abort(), 5); throw new Error(exhausted); }), async c => { records.push(c); }, [60_000]);
  const started = Date.now(); await expect(slow.run(input(), ac.signal)).rejects.toThrow(); expect(Date.now() - started).toBeLessThan(5_000); expect(n).toBe(1);
  expect(records.at(-1)?.outcome).toBe('failed');
});
