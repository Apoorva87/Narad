import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { modes, parseLesson } from '../shared/lesson';
import { type LessonStore, StoreError } from './store';
import { prepareSources, retrySources } from './intake';

export function createApp(store: LessonStore) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32mb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', milestone: 1 }));
  let capturing = false;
  app.get('/api/source-bundles', (_req, res) => res.json(store.listBundles()));
  app.post('/api/source-bundles', async (req, res) => {
    if (capturing) throw new StoreError('Another source capture is still running. Try again when it finishes.', 409);
    capturing = true;
    try {
      const { bundle, blobs } = await prepareSources(req.body); store.saveBundle(bundle, blobs);
      res.status(201).json({ ...bundle, sources: bundle.sources.map(({ rawHtml: _raw, ...source }) => source) });
    } finally { capturing = false; }
  });
  app.get('/api/source-bundles/:id', (req, res) => {
    const bundle = store.getBundle(req.params.id);
    if (!bundle) throw new StoreError('Source collection not found.', 404);
    res.json({ ...bundle, sources: bundle.sources.map(({ rawHtml: _raw, ...source }) => source) });
  });
  app.post('/api/source-bundles/:id/retry', async (req, res) => {
    if (capturing) throw new StoreError('Another source capture is still running. Try again when it finishes.', 409);
    const previous = store.getBundle(req.params.id);
    if (!previous) throw new StoreError('Source collection not found.', 404);
    capturing = true;
    try {
      const { bundle, blobs } = await retrySources(previous); store.saveBundle(bundle, blobs);
      res.json({ ...bundle, sources: bundle.sources.map(({ rawHtml: _raw, ...source }) => source) });
    } finally { capturing = false; }
  });
  app.get('/api/source-assets/:id', (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.id)) throw new StoreError('Image not found.', 404);
    const asset = store.getAsset(req.params.id);
    if (!asset) throw new StoreError('Image not found.', 404);
    res.setHeader('Content-Type', asset.type); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (asset.type === 'image/svg+xml') res.setHeader('Content-Disposition', 'attachment; filename="source.svg"');
    res.send(Buffer.from(asset.bytes));
  });
  app.get('/api/lessons', (_req, res) => res.json(store.list()));
  app.post('/api/lessons', (req, res) => {
    const lesson = parseLesson(req.body);
    for (const asset of lesson.assets) {
      if (asset.src.startsWith('/assets/') && !existsSync(resolve('public', '.' + asset.src))) {
        throw new StoreError('Image ' + asset.id + ' is missing. Embed the image as PNG, JPEG, or WebP before importing.', 400);
      }
    }
    res.status(201).json(store.insert(lesson));
  });
  app.get('/api/lessons/:id', (req, res) => {
    const lesson = store.get(req.params.id);
    if (!lesson) throw new StoreError('Analysis not found.', 404);
    res.json(lesson);
  });
  app.get('/api/lessons/:id/progress', (req, res) => {
    if (!store.get(req.params.id)) throw new StoreError('Analysis not found.', 404);
    res.json(store.getProgress(req.params.id));
  });
  app.put('/api/lessons/:id/progress', (req, res) => {
    const { mode, blockId } = z.object({ mode: z.enum(modes), blockId: z.string().min(1) }).parse(req.body);
    store.setProgress(req.params.id, mode, blockId);
    res.json(store.getProgress(req.params.id));
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use(express.static(resolve('dist')));
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: 'Check the supplied content.', details: error.issues.map(issue => (issue.path.join('.') || 'Content') + ': ' + issue.message).slice(0, 8) });
    } else if (error instanceof StoreError) {
      res.status(error.status).json({ error: error.message });
    } else if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'This file is not valid JSON.' });
    } else if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'This request is larger than the 32 MB limit. Use fewer or smaller images.' });
    } else {
      console.error(error);
      res.status(500).json({ error: 'Could not complete the request. Check the local server and try again.' });
    }
  };
  app.use(onError);
  return app;
}
