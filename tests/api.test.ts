import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { get, request, type Server } from 'node:http';
import { LessonStore } from '../server/store';
import { createApp } from '../server/app';
import { TutorStore } from '../server/tutor-store';
import { TutorService } from '../server/tutor';
import type { PreparationService } from '../server/preparation';
import { readFileSync } from 'node:fs';
import { minimalLesson } from './fixture';
import { prepareSources } from '../server/intake';
import { assetBlob } from '../server/capture';
import type { SourceBundle } from '../shared/sources';

let store: LessonStore;
let server: Server;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  store?.close();
});
async function setup(webOrigin?: string) {
  store = new LessonStore(':memory:');
  server = createApp(store, undefined, undefined, { webOrigin }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  return 'http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0);
}
/** Saves a one-source collection whose single visual is `bytes`; returns its slug and served image path. */
function savedVisual(bytes: Buffer, type: string, title = 'Bundle', alt = 'Diagram') {
  const blob = assetBlob(bytes, type);
  const bundle: SourceBundle = { id: 'bundle', title, createdAt: new Date().toISOString(), text: '', status: 'captured', sources: [{ id: 's', title: 'S', kind: 'image', markdown: '', warnings: [], inventory: { images: 1, inlineSvg: 0, tables: 0, savedVisuals: 1 }, assets: [{ id: 'a', kind: 'image', alt, caption: '', src: '/api/source-assets/' + blob.id, originalSrc: '/api/source-assets/' + blob.id }] }] };
  const saved = store.saveBundle(bundle, [blob]);
  return { slug: saved.id, src: saved.sources[0].assets[0].src! };
}
async function requestStatus(base: string, method: string, path: string, headers: Record<string, string>, body?: string) {
  const target = new URL(base);
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, method, path, headers }, response => {
      response.resume(); resolve(response.statusCode);
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
it('imports a lesson, lists it, preserves its content and prevents duplicate overwrite', async () => {
  const base = await setup();
  const send = () => fetch(base + '/api/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(minimalLesson()) });
  expect((await send()).status).toBe(201);
  expect(await (await fetch(base + '/api/lessons')).json()).toMatchObject([{ id: 'a-lesson', availableModes: ['walkthrough'] }]);
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
it('links a prepared lesson to its captured source and validates saved visual references', async () => {
  const base = await setup();
  const { bundle } = await prepareSources({ title: 'Captured source', text: 'A source to teach.' });
  const saved = store.saveBundle(bundle, []);
  const { src } = savedVisual(Buffer.from('saved-image'), 'image/png', 'Other source');
  const lesson = minimalLesson(); lesson.sourceBundleId = bundle.id;
  lesson.assets = [{ id: 'source-asset-0', src, alt: 'Source diagram', caption: 'Original diagram', provenance: 'source', kind: 'image' }];
  const response = await fetch(base + '/api/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lesson) });
  expect(response.status).toBe(201);
  expect(await (await fetch(base + '/api/source-bundles/' + bundle.id)).json()).toMatchObject({ lessonId: saved.id });
  expect(await (await fetch(base + '/api/source-bundles')).json()).toContainEqual(expect.objectContaining({ lessonId: saved.id }));
  expect(await (await fetch(base + '/api/lessons')).json()).toMatchObject([{ sourceBundleId: saved.id }]);
  // The image now lives in the lesson's own folder.
  expect((await response.json()).assets[0].src).toMatch(new RegExp('^/api/library/' + saved.id + '/media/'));
});
it('rejects missing captured assets and nonexistent source collections', async () => {
  const base = await setup();
  const lesson = minimalLesson();
  lesson.assets = [{ id: 'missing', src: '/api/library/nothing-here/media/01-fig-01-x.png', alt: 'Missing', caption: 'Missing', provenance: 'source' }];
  const send = () => fetch(base + '/api/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lesson) });
  expect((await send()).status).toBe(400);
  lesson.assets = []; lesson.sourceBundleId = 'nonexistent-source';
  expect((await send()).status).toBe(400);
  expect(store.list()).toEqual([]);
});
it('rejects browser cross-origin writes and untrusted Host headers',async()=>{
 const base=await setup();
 const cross=await fetch(base+'/api/source-bundles',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example'},body:JSON.stringify({text:'unexpected'})});
 expect(cross.status).toBe(403);expect(store.listBundles()).toEqual([]);
 const status=await new Promise<number|undefined>((resolve,reject)=>get(base+'/api/lessons',{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode)}).on('error',reject));
 expect(status).toBe(403);
});
it('reports preparation unavailable when no job service was supplied',async()=>{
 const base=await setup();expect((await fetch(base+'/api/preparation')).status).toBe(503);
});
it('rejects writes from a different local app origin',async()=>{
 const base=await setup();expect((await fetch(base+'/api/source-bundles',{method:'POST',headers:{Origin:'http://127.0.0.1:9999','Content-Type':'application/json'},body:JSON.stringify({text:'Cross-origin request'})})).status).toBe(403);
});
it('accepts only the exact configured HTTPS reverse-proxy origin', async () => {
  const origin = 'https://narad.example-tailnet.ts.net';
  const base = await setup(origin);
  expect(await requestStatus(base, 'GET', '/api/lessons', { Host: 'narad.example-tailnet.ts.net' })).toBe(200);
  expect(await requestStatus(base, 'POST', '/api/source-bundles', {
    Host: 'narad.example-tailnet.ts.net', Origin: origin, 'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json',
  }, JSON.stringify({ text: 'A lesson' }))).toBe(201);
  expect(await requestStatus(base, 'GET', '/api/lessons', { Host: 'other.example-tailnet.ts.net' })).toBe(403);
  expect(await requestStatus(base, 'POST', '/api/source-bundles', {
    Host: 'narad.example-tailnet.ts.net', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site',
    'Content-Type': 'application/json',
  }, JSON.stringify({ text: 'A lesson' }))).toBe(403);
});
it('exports prepared lessons with saved source images embedded so they import on another Mac', async () => {
  const base = await setup(); const lesson = minimalLesson();
  const sharp = (await import('sharp')).default;
  const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } }).gif().toBuffer();
  const { src } = savedVisual(gif, 'image/gif');
  lesson.assets = [{ id: 'diagram', src, alt: 'Diagram', caption: 'Diagram', provenance: 'source', kind: 'image' }];
  lesson.sourceBundleId = 'bundle';
  store.insert(lesson);
  const exported = await (await fetch(base + '/api/lessons/fixture/export')).json();
  expect(exported.assets[0].src).toMatch(/^data:image\/png;base64,/);
  expect(exported).not.toHaveProperty('sourceBundleId');
  const other = new LessonStore(':memory:');
  try { expect(other.insert({ ...exported, id: 'copied' }).assets[0].src).toBe(exported.assets[0].src); } finally { other.close(); }
});

it('renames and permanently deletes lessons, their sources, and unused saved images', async () => {
  const base = await setup(); const lesson = minimalLesson();
  const { slug } = savedVisual(Buffer.from('only-used-here'), 'image/png', 'Old');
  lesson.sourceBundleId = 'bundle'; store.insert(lesson); store.setProgress('fixture', 'walkthrough', 'block-a');
  const patch = (path: string, title: string) => fetch(base + path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  expect((await (await patch('/api/lessons/fixture', 'Renamed lesson')).json()).title).toBe('Renamed lesson');
  expect((await (await patch('/api/source-bundles/bundle', 'Renamed sources')).json()).title).toBe('Renamed sources');
  expect((await patch('/api/lessons/fixture', '  ')).status).toBe(400);
  expect(store.list()[0].title).toBe('Renamed lesson');
  expect((await fetch(base + '/api/lessons/fixture?sources=true', { method: 'DELETE' })).status).toBe(204);
  expect(store.get('fixture')).toBeUndefined();
  expect(store.getBundle('bundle')).toBeUndefined();
  expect(store.getProgress('fixture').positions).toEqual({});
  expect(store.resolveId(slug)).toBeUndefined();
  expect(existsSync(join(store.libraryRoot, slug))).toBe(false);
  expect((await fetch(base + '/api/lessons/fixture', { method: 'DELETE' })).status).toBe(404);
});
it('keeps a lesson\'s images when only its source collection is deleted, and remembers deleted samples', async () => {
  await setup(); const lesson = minimalLesson();
  const { slug, src } = savedVisual(Buffer.from('shared-image'), 'image/png', 'B');
  lesson.isSample = true; lesson.sourceBundleId = 'bundle';
  lesson.assets = [{ id: 'diagram', src, alt: 'D', caption: 'D', provenance: 'source', kind: 'image' }];
  store.insert(lesson);
  const file = src.split('/').at(-1)!;
  store.deleteBundle('bundle');
  expect(store.getBundle(slug)).toBeUndefined();
  expect(store.mediaPath(slug, file)).toBeDefined();
  store.deleteLesson('fixture');
  expect(store.isDeletedSample('fixture')).toBe(true);
  expect(store.mediaPath(slug, file)).toBeUndefined();
});
it('reads and partially updates settings, rejecting invalid prompts without saving', async () => {
  const base = await setup();
  const patch = (body: unknown) => fetch(base + '/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const initial = await (await fetch(base + '/api/settings')).json();
  expect(initial.settings).toEqual(initial.defaults);
  const saved = await (await patch({ voice: { rate: 1.25 }, lessons: { hostName: 'Priya' } })).json();
  expect(saved.settings.voice).toMatchObject({ rate: 1.25, narrator: 'Ryan' });
  expect(saved.settings.lessons.hostName).toBe('Priya');
  const rejected = await patch({ prompts: { review: 'Looks fine?' } });
  expect(rejected.status).toBe(400);
  expect((await rejected.json()).details.join(' ')).toMatch(/\{\{source\}\}/);
  expect(store.getSettings().prompts.review).toBe(initial.defaults.prompts.review);
});
it('applies capture limits from settings', async () => {
  const base = await setup();
  store.saveSettings({ ...store.getSettings(), capture: { maxLinks: 4, maxImages: 1 }, research: { maxLinks: 2 } });
  const response = await fetch(base + '/api/source-bundles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: Array.from({ length: 5 }, (_, i) => 'https://example.com/' + i).join('\n') }) });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatch(/up to 4 links/);
});
it('serves library media with strict names and limits reveal to this Mac', async () => {
  const origin = 'https://narad.example-tailnet.ts.net';
  const base = await setup(origin);
  const { slug, src } = savedVisual(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'Media test', 'x');
  expect(src).toBe('/api/library/media-test/media/01-fig-01-x.svg');
  for (const path of ['/api/library/' + slug + '/media/../../narad.sqlite', '/api/library/' + slug + '/media/%2e%2e%2fnarad.sqlite', '/api/library/' + slug + '/media/.hidden', '/api/library/Media-Test/media/01-fig-01-x.svg', '/api/library/' + slug + '/media/missing.png'])
    expect(await requestStatus(base, 'GET', path, {}), path).toBe(404);
  const response = await fetch(base + src);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toMatch(/^attachment/);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  expect(await requestStatus(base, 'POST', '/api/library/' + slug + '/reveal', { Host: 'narad.example-tailnet.ts.net', Origin: origin, 'Sec-Fetch-Site': 'same-origin' })).toBe(403);
  expect(await requestStatus(base, 'POST', '/api/library/' + slug + '/reveal', {})).toBe(204);
  expect(await requestStatus(base, 'POST', '/api/library/nothing-here/reveal', {})).toBe(404);
});
it('resolves legacy IDs in lesson routes', async () => {
  const base = await setup(); store.insert(minimalLesson());
  expect((await (await fetch(base + '/api/lessons/fixture')).json()).id).toBe('a-lesson');
  expect((await fetch(base + '/api/lessons/fixture/progress', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'walkthrough', blockId: 'block-b' }) })).status).toBe(200);
  expect(store.getProgress('a-lesson').positions).toEqual({ walkthrough: 'block-b' });
});
it('refuses to publish a second lesson into an occupied collection folder', async () => {
  const base = await setup();
  const { slug } = savedVisual(Buffer.from('img'), 'image/png', 'Occupied');
  store.insert({ ...minimalLesson(), sourceBundleId: slug });
  const before = readFileSync(join(store.libraryRoot, slug, 'lesson.json'), 'utf8');
  const response = await fetch(base + '/api/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...minimalLesson(), id: 'second', title: 'Second', sourceBundleId: slug }) });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toBe('This collection already has a lesson. Delete it or prepare a new version.');
  expect(readFileSync(join(store.libraryRoot, slug, 'lesson.json'), 'utf8')).toBe(before);
});
it('moves reading positions and tutor threads with either rename, and refuses renames while preparing', async () => {
  let busy = false;
  const preparation = { busy: () => busy } as unknown as PreparationService;
  const turns = new TutorStore(':memory:');
  const tutor = new TutorService(store = new LessonStore(':memory:'), turns, store.libraryRoot, { available: () => [], run: async () => ({}) });
  server = createApp(store, preparation, undefined, { tutor }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    const { slug } = savedVisual(Buffer.from('img'), 'image/png', 'Sources');
    store.insert({ ...minimalLesson(), sourceBundleId: slug });
    store.setProgress(slug, 'walkthrough', 'block-b');
    const now = new Date().toISOString();
    turns.save({ id: 't1', lessonId: slug, mode: 'walkthrough', sectionId: 'second', blockId: 'block-b', question: 'Why?', provider: 'codex', scope: 'lesson', status: 'ready', stage: 'Answer ready', createdAt: now, updatedAt: now } as any);
    const patch = (path: string, title: string) => fetch(base + path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    const renamed = await (await patch('/api/source-bundles/' + slug, 'Renamed sources')).json();
    expect(renamed.id).toBe('renamed-sources');
    expect(store.getProgress('renamed-sources').positions).toEqual({ walkthrough: 'block-b' });
    expect(turns.list('renamed-sources').map(turn => turn.id)).toEqual(['t1']);
    const lesson = await (await patch('/api/lessons/renamed-sources', 'Renamed lesson')).json();
    expect(lesson.id).toBe('renamed-lesson');
    expect(store.getProgress('renamed-lesson').positions).toEqual({ walkthrough: 'block-b' });
    expect(turns.list('renamed-lesson').map(turn => ({ id: turn.id, lessonId: turn.lessonId }))).toEqual([{ id: 't1', lessonId: 'renamed-lesson' }]);
    busy = true;
    for (const path of ['/api/lessons/renamed-lesson', '/api/source-bundles/renamed-lesson']) {
      const refused = await patch(path, 'Blocked');
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toBe('Stop preparation before renaming.');
    }
    expect(store.resolveId('blocked')).toBeUndefined();
  } finally { turns.close(); }
});
