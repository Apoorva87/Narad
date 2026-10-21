import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
 expect(compose).toContain('./data/library:/data/library');expect(compose).toContain('NARAD_AGENT_ROOTS: /data/library,/data/preparations,/data/tutor');expect(compose).toContain('./data/preparations:/data/preparations');expect(compose).toContain('./data/tutor:/data/tutor');
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
 expect(script).toContain('tts_healthy()');
 expect(script).toContain('nohup node --import tsx');
 expect(script).toContain('pgrep -P "$pid"');
 expect(script).toContain('if tts_running; then');
 expect(script).toContain('macOS TTS: responding (state:');
 expect(script).toContain('process running (PID $pid), but health check failed');
 expect(script).toContain('stop_tts\n  fi');
 expect(script).toMatch(/start_all\(\)[\s\S]*?ensure_runtime;start_tts/);
 expect(script).toMatch(/kill_all\(\)[\s\S]*?stop_tts/);
 expect(script).toContain('start) start_all ;;');
 expect(script).toContain('restart) kill_all; start_all ;;');
 expect(script).toContain('kill|stop) kill_all; ensure_runtime; show_status');
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

it('starts Narad behind private Tailscale Serve using this machine exact HTTPS origin',async()=>{
 const source=new URL('../start_tailscale.sh',import.meta.url);
 expect(existsSync(source)).toBe(true);
 if(!existsSync(source))return;
 const sandbox=await mkdtemp(join(tmpdir(),'narad-tailscale-'));
 try{
  const bin=join(sandbox,'bin');await mkdir(bin,{recursive:true});
  await writeFile(join(sandbox,'start_tailscale.sh'),await readFile(source),{mode:0o755});
  const log=join(sandbox,'calls.log');
  await writeFile(join(bin,'tailscale'),`#!/bin/bash
printf 'tailscale %s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  'status --json') printf '{"Self":{"DNSName":"narad.example.ts.net."}}\\n' ;;
esac
`,{mode:0o755});
  await writeFile(join(bin,'open'),`#!/bin/bash
printf 'open %s\\n' "$*" >> "$CALL_LOG"
`,{mode:0o755});
  await writeFile(join(bin,'curl'),`#!/bin/bash
printf '{"status":"ok"}'
`,{mode:0o755});
  await writeFile(join(sandbox,'start.sh'),`#!/bin/bash
if [[ "$1" == status ]]; then
 mkdir -p .narad
 printf 'NARAD_AGENT_TOKEN=private-agent\\nNARAD_TTS_TOKEN=private-tts\\n' > .narad/compose.env
else
 source .narad/compose.env
 printf 'narad %s origin=%s\\n' "$*" "$NARAD_WEB_ORIGIN" >> "$CALL_LOG"
fi
`,{mode:0o755});
  const {stdout}=await execute('bash',[join(sandbox,'start_tailscale.sh')],{cwd:sandbox,env:{...process.env,PATH:`${bin}:${process.env.PATH}`,CALL_LOG:log}});
  const calls=await readFile(log,'utf8');
  const runtimeConfig=await readFile(join(sandbox,'.narad','compose.env'),'utf8');
  expect(calls).toContain('tailscale up');
  expect(calls).toContain('narad start origin=https://narad.example.ts.net');
  expect(calls).toContain('tailscale serve --bg 4318');
  expect(calls).not.toContain('funnel');
  expect(runtimeConfig).toContain('NARAD_WEB_ORIGIN=https://narad.example.ts.net');
  expect(runtimeConfig).toContain('NARAD_AGENT_TOKEN=private-agent');
  expect(stdout).toContain('https://narad.example.ts.net');
 }finally{await rm(sandbox,{recursive:true,force:true})}
});
