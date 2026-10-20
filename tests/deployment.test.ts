import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const root=new URL('../',import.meta.url);
const text=(path:string)=>readFile(new URL(path,root),'utf8');

it('isolates the agent from the Docker socket, host home, and Narad database',async()=>{
 const compose=await text('compose.yaml');
 expect(compose).not.toContain('/var/run/docker.sock');expect(compose).not.toMatch(/~\/|\/Users\/|\/home\/\$\{/);
 expect(compose).toContain('./data/preparations:/data/preparations');expect(compose).toContain('./data/tutor:/data/tutor');
 expect(compose).toContain('agent-home:/home/narad');expect(compose).toContain('read_only: true');expect(compose).toContain('no-new-privileges:true');
 expect(compose).toContain('NARAD_AGENT_URL: http://agent:4320');expect(compose).toContain('NARAD_TTS_URL: http://host.docker.internal:4321');
 const agent=compose.split('\n  agent:\n')[1].split('\nvolumes:\n')[0];expect(agent).not.toContain('\n    ports:');
});

it('builds pinned agent CLIs without putting MLX in a Linux image',async()=>{
 const dockerfile=await text('Dockerfile');
 expect(dockerfile).toContain('@openai/codex@0.163.0');expect(dockerfile).toContain('@anthropic-ai/claude-code@2.1.304');
 expect(dockerfile).not.toContain('mlx-audio');expect(dockerfile).not.toContain('speech/.venv');
});

it('provides start, restart, kill, status, and provider-login operations',async()=>{
 const script=await text('start.sh');
 for(const operation of ['start','restart','status'])expect(script).toMatch(new RegExp(`\\b${operation}\\)`));
 expect(script).toMatch(/kill\|stop\)/);
 expect(script).toContain('login codex|claude');expect(script).toContain('server/tts-host.ts');expect(script).toContain('--env-file');
});

it('keeps host data, models, credentials, and dependencies out of Docker build context',async()=>{
 const ignore=await text('.dockerignore');
 for(const path of ['data','node_modules','speech/.venv','.git','.narad'])expect(ignore).toContain(path);
});
