import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { LessonStore } from '../server/store';
import { prepareSources, retrySources } from '../server/intake';
import { sourceInputSchema } from '../shared/sources';

const dirs: string[] = []; const stores: LessonStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
describe('mixed source intake', () => {
  it('retains text and image bytes after reopening, separate from generated lessons', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();
    const { bundle, blobs } = await prepareSources({ title: 'My idea', text: 'Explain this chart. The value is 3.14.', images: [{ name: 'chart.png', data: 'data:image/png;base64,' + png.toString('base64') }] });
    const dir = mkdtempSync(join(tmpdir(), 'narad-source-')); dirs.push(dir); const path = join(dir, 'test.sqlite');
    const store = new LessonStore(path); stores.push(store); store.saveBundle(bundle, blobs); store.close();
    const reopened = new LessonStore(path); stores.push(reopened);
    expect(reopened.getBundle(bundle.id)?.sources[0].markdown).toContain('3.14');
    expect(reopened.listBundles()[0]).toMatchObject({ title: 'My idea', sourceCount: 2, visualCount: 1 });
    const file = reopened.getBundle(bundle.id)!.sources[1].assets[0].src!.split('/').at(-1)!;
    expect(readFileSync(reopened.mediaPath(reopened.resolveId(bundle.id)!, file)!)).toEqual(png);
    expect(reopened.list()).toEqual([]);
  });
  it('retains unsuccessful links and distinguishes partial capture from success', async () => {
    const { bundle } = await prepareSources({ text: 'Study https://example.com/one and https://example.com/two', images: [] }, async url => {
      if (url.endsWith('/two')) throw new Error('Source unavailable');
      return { bytes: Buffer.from('<article><h1>First source</h1><p>42 units.</p></article>'), url, type: 'text/html' };
    });
    expect(bundle.status).toBe('needs-review');
    expect(bundle.sources.filter(source => source.kind === 'article')).toHaveLength(2);
    expect(bundle.sources.at(-1)?.warnings).toEqual([{ kind: 'blocking', message: 'Source unavailable' }]);
  });
  it('rejects empty submissions and unsupported image input', () => {
    expect(sourceInputSchema.safeParse({ text: '  ' }).success).toBe(false);
    expect(sourceInputSchema.safeParse({ images: [{ name: 'bad.svg', data: 'data:image/svg+xml;base64,AAAA' }] }).success).toBe(false);
  });
  it('retries failed articles without duplicating the collection or losing notes', async () => {
    const { bundle } = await prepareSources({ text: 'Explain https://example.com/' }, async () => { throw new Error('Offline'); });
    const { bundle: retried } = await retrySources(bundle, async url => ({ url, type: 'text/html', bytes: Buffer.from('<article><h1>Now available</h1><p>42</p></article>') }));
    expect(retried.id).toBe(bundle.id);
    expect(retried.status).toBe('captured');
    expect(retried.sources[0]).toEqual(bundle.sources[0]);
    expect(retried.sources[1].markdown).toContain('42');
    const store = new LessonStore(':memory:'); stores.push(store);
    store.saveBundle(bundle, []); store.saveBundle(retried, []);
    expect(store.listBundles()).toHaveLength(1);
    expect(store.getBundle(bundle.id)?.status).toBe('captured');
  });
});
