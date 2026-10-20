import { mkdirSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { addUsage, type AgentUsage, type Provider } from '../shared/preparation';
import type { AgentRunner } from './agent-runner';

export type CallRecord = { n: number; step: string; task: string; startedAt: string; durationMs: number; outcome: 'ok' | 'retried' | 'failed'; error?: string; usage?: AgentUsage };
export type CallInput = { step: 'research' | 'author' | 'review' | 'summary'; task: string; prompt: string; schema: z.ZodType; images: string[]; provider: Provider; model?: string; timeoutMs: number };

/**
 * Runs every preparation agent call the same way. Files per call in `<dir>/calls/`:
 * NNN-<step>-<task>.prompt.md (prompt), .result.json (validated value), .log (attempt summary).
 * The CLI runner also leaves its own .schema.json, .prompt.txt and .events.log under the same stem.
 */
export class CallRunner {
  private next: number;
  constructor(private dir: string, private runner: AgentRunner, private record: (call: CallRecord) => Promise<void>) {
    mkdirSync(join(dir, 'calls'), { recursive: true });
    const numbers = readdirSync(join(dir, 'calls')).map(f => /^(\d+)-/.exec(f)).filter((m): m is RegExpExecArray => !!m).map(m => Number(m[1]));
    this.next = Math.max(0, ...numbers) + 1;
  }

  async run(input: CallInput, signal: AbortSignal, onSession?: (pid: number | null) => void): Promise<unknown> {
    signal.throwIfAborted();
    const n = this.next++;
    const name = `${String(n).padStart(3, '0')}-${input.step}-${input.task.replace(/[^\w.-]+/g, '_')}`;
    const calls = join(this.dir, 'calls');
    await mkdir(calls, { recursive: true });
    const base = join(calls, name);
    await writeFile(base + '.prompt.md', input.prompt);
    const schema = z.toJSONSchema(input.schema, { target: 'draft-7' }) as Record<string, unknown>;
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const errors: string[] = [];
    let usage: AgentUsage | undefined;
    const finish = async (outcome: CallRecord['outcome'], error?: string) => {
      await writeFile(base + '.log', `${name}\nstarted ${startedAt}\noutcome ${outcome}\n${errors.map((e, i) => `attempt ${i + 1} failed: ${e}\n`).join('')}`);
      await this.record({ n, step: input.step, task: input.task, startedAt, durationMs: Date.now() - started, outcome, ...(error ? { error } : {}), ...(usage ? { usage } : {}) });
    };
    for (let attempt = 1; ; attempt++) {
      try {
        const raw = await this.runner.run({ provider: input.provider, kind: input.step, prompt: input.prompt, schema, cwd: calls, name, images: input.images, model: input.model, timeoutMs: input.timeoutMs }, signal, onSession, u => { usage = addUsage(usage, u); });
        signal.throwIfAborted();
        const value = input.schema.parse(raw);
        await writeFile(base + '.result.json', JSON.stringify(value, null, 2));
        await finish(attempt === 1 ? 'ok' : 'retried');
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        if (signal.aborted || attempt === 2) { await finish('failed', message); throw error; }
      }
    }
  }
}
