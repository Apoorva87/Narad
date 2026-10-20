import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root=new URL('../',import.meta.url);
const text=(path:string)=>readFile(new URL(path,root),'utf8');
const execute=promisify(execFile);

it('isolates the agent from the Docker socket, host home, and Narad database',async()=>{
 const compose=await text('compose.yaml');
 expect(compose).not.toContain('/var/run/docker.sock');expect(compose).not.toMatch(/~\/|\/Users\/|\/home\/\$\{/);
 expect(compose).toContain('./data/preparations:/data/preparations');expect(compose).toContain('./data/tutor:/data/tutor');
 expect(compose).toContain('agent-home:/home/narad');expect(compose).toContain('read_only: true');expect(compose).toContain('no-new-privileges:true');
 expect(compose).toContain('NARAD_AGENT_SOCKET: /run/narad-agent/agent.sock');expect(compose).toContain('NARAD_TTS_URL: http://host.docker.internal:4321');
 expect(compose).toContain('agent-control:/run/narad-agent');
 const api=compose.split('\n  api:\n')[1].split('\n  agent:\n')[0];
 const agent=compose.split('\n  agent:\n')[1].split('\nvolumes:\n')[0];
 expect(api).toContain('- api-egress');expect(api).not.toContain('- agent-egress');
 expect(agent).toContain('- agent-egress');expect(agent).not.toContain('- api-egress');
 expect(agent).not.toContain('\n    ports:');expect(agent).not.toContain('\n    expose:');
});

it('builds pinned agent CLIs without putting MLX in a Linux image',async()=>{
 const dockerfile=await text('Dockerfile');
 expect(dockerfile).toContain('@openai/codex@0.163.0');expect(dockerfile).toContain('@anthropic-ai/claude-code@2.1.304');
 expect(dockerfile).toContain('ca-certificates');
 expect(dockerfile).not.toContain('mlx-audio');expect(dockerfile).not.toContain('speech/.venv');
 expect(dockerfile).toContain('ARG NARAD_UID=10001');expect(dockerfile).toContain('--uid "$NARAD_UID"');
});

it('provides start, restart, kill, status, and provider-login operations',async()=>{
 const script=await text('start.sh');
 for(const operation of ['start','restart','status'])expect(script).toMatch(new RegExp(`\\b${operation}\\)`));
 expect(script).toMatch(/kill\|stop\)/);
 expect(script).toContain('login codex|claude');expect(script).toContain('server/tts-host.ts');expect(script).toContain('--env-file');
 expect(script).toContain('login --device-auth');expect(script).toContain('auth login --claudeai');expect(script).not.toContain('setup-token');
 expect(script).toContain("ps -p \"$pid\" -o lstart=");expect(script).toContain("ps -p \"$pid\" -o command=");
 expect(script).toContain('NARAD_UID=');
});

it('keeps host data, models, credentials, and dependencies out of Docker build context',async()=>{
 const ignore=await text('.dockerignore');
 for(const path of ['data','node_modules','speech/.venv','.git','.narad'])expect(ignore).toContain(path);
});

it('reports an isolated local runtime as stopped without requiring Docker',async()=>{
 const runtime=await mkdtemp(join(tmpdir(),'narad-local-status-'));
 try{
  const {stdout}=await execute('bash',[new URL('../start_local.sh',import.meta.url).pathname,'status'],{cwd:new URL('../',import.meta.url).pathname,env:{...process.env,NARAD_LOCAL_RUNTIME_DIR:runtime}});
  expect(stdout).toContain('Local Narad: stopped');expect(stdout).toContain('API: unavailable');expect(stdout).toContain('Web: unavailable');
 }finally{await rm(runtime,{recursive:true,force:true})}
});
