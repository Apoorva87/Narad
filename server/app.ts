import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { modes, parseLesson } from '../shared/lesson';
import { type LessonStore, StoreError } from './store';

export function createApp(store: LessonStore) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '12mb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', milestone: 1 }));
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
      res.status(400).json({ error: 'The lesson could not be imported.', details: error.issues.map(issue => (issue.path.join('.') || 'Lesson') + ': ' + issue.message).slice(0, 8) });
    } else if (error instanceof StoreError) {
      res.status(error.status).json({ error: error.message });
    } else if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'This file is not valid JSON.' });
    } else if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'This lesson is larger than the 12 MB import limit.' });
    } else {
      console.error(error);
      res.status(500).json({ error: 'Could not complete the request. Check the local server and try again.' });
    }
  };
  app.use(onError);
  return app;
}
