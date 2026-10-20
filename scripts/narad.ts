import { readFile } from 'node:fs/promises';

/** Command-line access to a running Narad server, used by the narad-prepare agent skills. */
const usage = `Usage: node --import tsx scripts/narad.ts <command>
  add <input.json> [--level foundational|some-background|advanced]   Save sources; prints the item slug
  prepare <slug> [codex|claude] [--level <level>] [--restart]           Start or continue preparing a lesson (queues if all slots are busy)
  status [<slug>]                                                      Preparation runs (all, or one item)
  stop <slug>                                                          Stop that item's preparation, or remove it from the queue
  link <slug>                                                          Reader address for a prepared lesson
Add --json to any command for the raw API response.
Environment: NARAD_API_URL (default http://127.0.0.1:4318), NARAD_WEB_URL (default: same as the API).`;

const levels = ['foundational', 'some-background', 'advanced'];
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((value, i) => !value.startsWith('--') && !(i > 0 && ['--level'].includes(args[i - 1])));
const [command, target, provider = 'codex'] = positional;
const api = (process.env.NARAD_API_URL ?? 'http://127.0.0.1:4318').replace(/\/$/, '');
const web = (process.env.NARAD_WEB_URL ?? api).replace(/\/$/, '');
const level = option('--level');
if (level && !levels.includes(level)) fail('Level must be one of: ' + levels.join(', '));

function fail(message: string): never { console.error(message); process.exit(1); }
async function call(path: string, init?: { method?: string; body?: unknown }) {
  let response: Response;
  try {
    response = await fetch(api + path, { method: init?.method ?? 'GET', headers: init?.body ? { 'Content-Type': 'application/json' } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined });
  } catch { fail('Narad is not reachable at ' + api + '. Start it with ./start.sh start (Docker) or ./start_local.sh start.'); }
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) fail([result.error ?? 'Request failed: HTTP ' + response.status, ...(result.details ?? [])].join('\n'));
  return result;
}
const tokens = (n?: number) => n === undefined ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
type Job = { slug: string; title: string; status: string; queuePosition?: number; queueLength?: number; stage: string; completed: number; total: number; provider: string; folder: string; lessonId?: string; error?: string;
  sections?: { task: string; title: string; state: string; error?: string }[]; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number } };
function describe(job: Job, detailed: boolean) {
  const state = job.status === 'queued' && job.queuePosition ? `queued (position ${job.queuePosition} of ${job.queueLength ?? job.queuePosition})` : job.status;
  const lines = [`${job.title}  [${job.slug}]`, `  ${state} · ${job.completed}/${job.total} sections · ${job.provider} · ${job.stage}`];
  if (job.usage) lines.push(`  tokens: ${tokens(job.usage.inputTokens)} in · ${tokens(job.usage.outputTokens)} out${job.usage.cachedTokens ? ` (cached ${tokens(job.usage.cachedTokens)})` : ''}${job.usage.costUsd !== undefined ? ` · $${job.usage.costUsd.toFixed(2)}` : ''}`);
  if (job.error) lines.push('  error: ' + job.error);
  if (job.lessonId) lines.push('  lesson: ' + web + '/#lesson/' + job.slug);
  lines.push('  folder: ' + job.folder);
  if (detailed) for (const section of job.sections ?? []) lines.push(`    ${section.state.padEnd(9)} ${section.title}${section.error ? ' — ' + section.error : ''}`);
  if (['interrupted', 'stopped', 'failed', 'cancelled'].includes(job.status)) lines.push(`  To continue: node --import tsx scripts/narad.ts prepare ${job.slug} ${job.provider}`);
  return lines.join('\n');
}

switch (command) {
  case 'add': {
    if (!target) fail('Usage: add <input.json> [--level <level>]');
    let input: Record<string, unknown>;
    try { input = JSON.parse(await readFile(target, 'utf8')); } catch { fail('Could not read JSON from ' + target); }
    const bundle = await call('/api/source-bundles', { method: 'POST', body: level ? { ...input, familiarity: level } : input });
    if (flag('--json')) { console.log(JSON.stringify(bundle, null, 2)); break; }
    console.log(`Saved "${bundle.title}" as ${bundle.id} (${bundle.status}).`);
    for (const source of bundle.sources ?? []) for (const warning of source.warnings ?? [])
      console.log(`  ${warning.kind === 'blocking' ? 'BLOCKING' : 'note'}: ${source.title}: ${warning.message}`);
    console.log(bundle.status === 'captured' ? `Next: node --import tsx scripts/narad.ts prepare ${bundle.id} codex` : 'Blocking capture issues must be fixed (retry the source in the app) before preparing.');
    break;
  }
  case 'prepare': {
    if (!target || !['codex', 'claude'].includes(provider)) fail('Usage: prepare <slug> [codex|claude] [--level <level>] [--restart]');
    const job = await call('/api/source-bundles/' + encodeURIComponent(target) + '/prepare', { method: 'POST', body: { provider, ...(level ? { familiarity: level } : {}), action: flag('--restart') ? 'restart' : 'continue' } });
    const headline = job.status === 'queued' ? `Queued (position ${job.queuePosition ?? '?'}). It starts automatically when a slot frees up.`
      : job.status === 'running' || job.status === 'stopping' ? `Preparation ${flag('--restart') ? 'restarted' : 'started (finished sections are reused)'}.` : `Preparation is ${job.status}.`;
    console.log(flag('--json') ? JSON.stringify(job, null, 2) : headline + '\n' + describe(job, false));
    break;
  }
  case 'status': {
    const state = await call('/api/preparation');
    const jobs: Job[] = target ? state.jobs.filter((job: Job) => job.slug === target) : state.jobs;
    if (flag('--json')) { console.log(JSON.stringify(target ? jobs : state, null, 2)); break; }
    if (!jobs.length) { console.log(target ? 'No preparation runs for ' + target : 'No preparation runs yet.'); break; }
    const running = state.jobs.filter((job: Job) => job.status === 'running' || job.status === 'stopping').length, queued = state.jobs.filter((job: Job) => job.status === 'queued').length;
    console.log(`${running} preparing · ${queued} queued · ${state.sessions.length} live agent session(s).\n` + jobs.map(job => describe(job, !!target)).join('\n\n'));
    break;
  }
  case 'stop': {
    if (!target) fail('Usage: stop <slug>');
    const job = await call('/api/preparation/' + encodeURIComponent(target) + '/stop', { method: 'POST' });
    const headline = job.status === 'stopping' ? 'Stopping. Finished sections are kept.' : job.status === 'stopped' || job.status === 'completed' ? 'Not running; removed from the queue if it was waiting. Finished sections are kept.' : 'Preparation is ' + job.status + '.';
    console.log(flag('--json') ? JSON.stringify(job, null, 2) : headline + '\n' + describe(job, false));
    break;
  }
  case 'link': {
    if (!target) fail('Usage: link <slug>');
    const lesson = await call('/api/lessons/' + encodeURIComponent(target));
    console.log(web + '/#lesson/' + lesson.id);
    break;
  }
  default:
    console.log(usage); process.exit(command ? 1 : 0);
}
