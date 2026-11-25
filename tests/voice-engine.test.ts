import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import samples from '../content/samples.json';
import { RemoteSpeechWorker } from '../server/remote-speech-worker';
import { SpeechService, type SpeechEngine } from '../server/speech';
import { LessonStore } from '../server/store';
import { createTtsHost } from '../server/tts-host';
import { defaultSettings, resolveSettings } from '../shared/settings';
import type { SpeechEngineId } from '../shared/speech';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
function wav() { const b = Buffer.alloc(48044); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(48000, 40); return b; }
/** A voice engine that records which model it was asked for and reports that model's name. */
function recorder() {
  const asked: (SpeechEngineId | undefined)[] = [];
  const engine: SpeechEngine = { model: 'none yet', status(preferred) { asked.push(preferred); engine.model = 'model:' + preferred; return { state: 'idle' }; },
    async synthesize(_text, _voice, _style, _signal, preferred) { asked.push(preferred); engine.model = 'model:' + preferred; return wav(); }, async close() {} };
  return { asked, engine };
}

it('speaks with Breeze by default and with Qwen once that is chosen in Settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'narad-voice-')); const store = new LessonStore(join(dir, 'db'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }), () => store.close());
  const lesson = store.insert(samples[0]); const block = lesson.modes.walkthrough!.sections[0].blocks[0];
  const { asked, engine } = recorder(); const service = new SpeechService(store, engine);
  const request = { lessonId: lesson.id, mode: 'walkthrough' as const, blockId: block.id, chunk: 0, voice: 'Ryan' as const };
  expect(defaultSettings.voice.engine).toBe('breeze');
  expect(service.status()).toEqual({ state: 'idle', model: 'model:breeze' });
  await service.render(request, new AbortController().signal);
  store.saveSettings({ ...defaultSettings, voice: { ...defaultSettings.voice, engine: 'qwen' } });
  await service.render(request, new AbortController().signal);
  expect(service.status().model).toBe('model:qwen');
  expect(asked).toEqual(['breeze', 'breeze', 'qwen', 'qwen']);
});

it('keeps voices saved before the voice model setting existed and rejects an unknown model', () => {
  expect(resolveSettings({ voice: { narrator: 'Vivian', rate: 1.25 } }).voice).toEqual({ engine: 'breeze', narrator: 'Vivian', host: 'Aiden', expert: 'Ryan', rate: 1.25 });
  expect(resolveSettings({ voice: { engine: 'other' } }).voice.engine).toBe('breeze');
});

it('carries the chosen voice model to the macOS voice host and reports the model the host is using', async () => {
  const { asked, engine } = recorder();
  const server = createTtsHost(engine, 'secret').listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const remote = new RemoteSpeechWorker('http://127.0.0.1:' + (server.address() as AddressInfo).port, 'secret', 'Local voice', 60_000);
  cleanup.push(() => new Promise(resolve => server.close(resolve)), () => remote.close());
  await remote.synthesize('Hello.', 'Ryan', 'Calm.', new AbortController().signal, 'qwen');
  expect(asked.at(-1)).toBe('qwen');
  remote.status('breeze');
  await expect.poll(() => remote.model).toBe('model:breeze');
  const bad = await fetch('http://127.0.0.1:' + (server.address() as AddressInfo).port + '/synthesize', { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hi', voice: 'Ryan', style: 'Calm', engine: 'other' }) });
  expect(bad.status).toBe(400);
});
