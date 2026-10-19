import { afterEach, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { LessonStore } from '../server/store';
import { createApp } from '../server/app';
import { minimalLesson } from './fixture';

let store: LessonStore;
let server: Server;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  store?.close();
});
async function setup() {
  store = new LessonStore(':memory:');
  server = createApp(store).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  return 'http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0);
}
it('imports a lesson, lists it, preserves its content and prevents duplicate overwrite', async () => {
  const base = await setup();
  const send = () => fetch(base + '/api/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(minimalLesson()) });
  expect((await send()).status).toBe(201);
  expect(await (await fetch(base + '/api/lessons')).json()).toMatchObject([{ id: 'fixture', availableModes: ['walkthrough'] }]);
  expect(await (await fetch(base + '/api/lessons/fixture')).json()).toMatchObject({ title: 'A lesson' });
  expect((await send()).status).toBe(409);
});
it('rejects malformed imports without saving any part of them', async () => {
  const base = await setup();
  const response = await fetch(base + '/api/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"id":"bad"}' });
  expect(response.status).toBe(400);
  expect(await response.json()).toHaveProperty('error');
  expect(store.list()).toEqual([]);
});
it('rejects missing asset files even when the lesson references them correctly', async () => {
  const base = await setup(); const lesson = minimalLesson();
  lesson.assets.push({ id: 'gone', src: '/assets/does-not-exist.svg', alt: 'Missing', caption: 'Missing', provenance: 'teaching' });
  const response = await fetch(base + '/api/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lesson) });
  expect(response.status).toBe(400);
  expect(store.list()).toEqual([]);
});
