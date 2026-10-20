import { afterEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import { LessonStore } from '../server/store';
import { createApp } from '../server/app';

const repo = resolve('.');
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'narad-skills-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('install-skills.sh', () => {
  it('installs separate Codex and Claude skills pointing at this checkout, and uninstalls them', () => {
    const codex = temp(), claude = temp();
    const env = { ...process.env, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude };
    execFileSync('bash', ['scripts/install-skills.sh'], { env });
    const codexSkill = readFileSync(join(codex, 'skills/narad-prepare/SKILL.md'), 'utf8');
    const claudeSkill = readFileSync(join(claude, 'skills/narad-prepare/SKILL.md'), 'utf8');
    for (const skill of [codexSkill, claudeSkill]) {
      expect(skill).toMatch(/^---\nname: narad-prepare\n/);
      expect(skill).toContain(`cd "${repo}"`);
      expect(skill).not.toContain('{{');
    }
    expect(codexSkill).toContain('prepare <slug> codex');
    expect(claudeSkill).toContain('prepare <slug> claude');
    execFileSync('bash', ['scripts/install-skills.sh', '--uninstall'], { env });
    expect(existsSync(join(codex, 'skills/narad-prepare'))).toBe(false);
    expect(existsSync(join(claude, 'skills/narad-prepare'))).toBe(false);
  });
  it('installs for one tool when asked', () => {
    const codex = temp(), claude = temp();
    execFileSync('bash', ['scripts/install-skills.sh', '--claude'], { env: { ...process.env, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude } });
    expect(existsSync(join(claude, 'skills/narad-prepare/SKILL.md'))).toBe(true);
    expect(existsSync(join(codex, 'skills/narad-prepare'))).toBe(false);
  });
});

describe('scripts/narad.ts', () => {
  let server: Server | undefined; let store: LessonStore | undefined;
  afterEach(async () => { if (server) await new Promise<void>(done => server!.close(() => done())); store?.close(); server = undefined; store = undefined; });
  const run = (args: string[], api: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/narad.ts', ...args], { env: { ...process.env, NARAD_API_URL: api } });

  it('saves sources at the chosen level and reports the slug and next step', async () => {
    store = new LessonStore(':memory:');
    server = createApp(store).listen(0, '127.0.0.1');
    await new Promise<void>(done => server!.once('listening', () => done()));
    const api = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const input = join(temp(), 'input.json');
    writeFileSync(input, JSON.stringify({ title: 'Sparse autoencoders', text: 'Explain sparse autoencoders for interpretability.' }));
    const { stdout } = await run(['add', input, '--level', 'advanced'], api);
    expect(stdout).toContain('Saved "Sparse autoencoders" as sparse-autoencoders');
    expect(stdout).toContain('prepare sparse-autoencoders codex');
    expect(store.getBundle('sparse-autoencoders')?.familiarity).toBe('advanced');
  });
  it('explains how to start Narad when the server is unreachable', async () => {
    await expect(run(['status'], 'http://127.0.0.1:9')).rejects.toMatchObject({ stderr: expect.stringContaining('./start.sh start') });
  });
  it('rejects an unknown level before calling the server', async () => {
    await expect(run(['prepare', 'x', 'codex', '--level', 'expert'], 'http://127.0.0.1:9')).rejects.toMatchObject({ stderr: expect.stringContaining('Level must be one of') });
  });
});
