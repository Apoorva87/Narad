import type { PreparationService } from './preparation';
import type { SpeechService } from './speech';
import type { TutorService } from './tutor';
import { enrichSpeechStyle, speechRequestSchema, splitSpeech } from '../shared/speech';
import { tutorAskSchema, tutorSpeechRequestSchema } from '../shared/tutor';
import { prepareInput, renameInput } from '../shared/preparation';
import { defaultSettings, settingsSchema, type Settings } from '../shared/settings';
import express, { type ErrorRequestHandler } from 'express';
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { modes, parseLesson } from '../shared/lesson';
import { type LessonStore, StoreError } from './store';
import { prepareSources, retrySources } from './intake';
import { allowsApiRequest, configuredWebOrigin } from './request-access';

export function createApp(store: LessonStore, preparation?: PreparationService, speech?: SpeechService, options: { webOrigin?: string; tutor?: TutorService } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const webOrigin = configuredWebOrigin(options.webOrigin);
  app.use('/api', (req, res, next) => {
    if (!allowsApiRequest({ method: req.method, host: req.headers.host, origin: req.get('Origin'), fetchSite: req.get('Sec-Fetch-Site') }, webOrigin)) {
      res.status(403).json({error: 'Use Narad from its configured web address.'}); return;
    }
    next();
  });
  app.use(express.json({ limit: '32mb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', milestone: 4 }));
  app.get('/api/settings', (_req, res) => res.json({ settings: store.getSettings(), defaults: defaultSettings }));
  app.patch('/api/settings', (req, res) => {
    // Accepts any subset of sections and fields; the merged result is validated as a whole.
    const current = store.getSettings() as unknown as Record<string, Record<string, unknown>>;
    const patch = z.record(z.string(), z.record(z.string(), z.unknown())).parse(req.body);
    const merged = Object.fromEntries(Object.entries(current).map(([section, values]) => [section, { ...values, ...(patch[section] ?? {}) }]));
    res.json({ settings: store.saveSettings(settingsSchema.parse(merged) as Settings), defaults: defaultSettings });
  });
  const narration = () => { if (!speech) throw new StoreError('Local narration is not enabled in this server.',503); return speech; };
  app.get('/api/speech', (_req,res)=>res.json(narration().status()));
  app.post('/api/speech/render', async(req,res)=>{
    const input=speechRequestSchema.parse(req.body);
    const controller=new AbortController();
    const cancel=()=>{if(!res.writableEnded)controller.abort()}; res.on('close',cancel);
    try {
      const bytes=await narration().render(input,controller.signal);
      if(!controller.signal.aborted) {
        res.setHeader('Content-Type','audio/wav');res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('Cache-Control','no-store');res.send(bytes);
      }
    }
    catch(error) { if(!controller.signal.aborted)throw error instanceof StoreError?error:new StoreError(error instanceof Error?error.message:'Could not prepare narration. Try again.',503); }
    finally {res.off('close',cancel)}
  });
  const tutoring = () => { if (!options.tutor) throw new StoreError('Contextual tutoring is not enabled in this server.',503); return options.tutor; };
  app.get('/api/lessons/:id/tutor', (req,res) => {
    if (!store.get(req.params.id)) throw new StoreError('Analysis not found.',404);
    const mode=z.enum(modes).parse(req.query.mode);res.json(tutoring().state(req.params.id,mode));
  });
  app.post('/api/lessons/:id/tutor/turns', (req,res) => res.status(202).json(tutoring().start(req.params.id,tutorAskSchema.parse(req.body))));
  app.post('/api/tutor/turns/:id/stop', (req,res) => res.json(tutoring().stop(req.params.id)));
  app.delete('/api/tutor/turns/:id', (req,res) => {tutoring().delete(req.params.id);res.status(204).end()});
  app.post('/api/tutor/speech/render', async(req,res)=>{
    const input=tutorSpeechRequestSchema.parse(req.body);const service=tutoring();const text=service.textForSpeech(input.turnId,input.part);
    const chunk=splitSpeech(text)[input.chunk];if(!chunk)throw new StoreError('This tutor narration chunk was not found.',400);
    const controller=new AbortController();const cancel=()=>{if(!res.writableEnded)controller.abort()};res.on('close',cancel);
    try {
      const styles=store.getSettings().prompts;const roleStyle=input.part==='question'?styles.hostStyle:styles.tutorStyle;
      const bytes=await narration().renderText(chunk,input.voice,enrichSpeechStyle(roleStyle,chunk),controller.signal);
      if(!controller.signal.aborted){res.setHeader('Content-Type','audio/wav');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.send(bytes)}
    } catch(error) {if(!controller.signal.aborted)throw error instanceof StoreError?error:new StoreError(error instanceof Error?error.message:'Could not prepare tutor narration.',503)}
    finally {res.off('close',cancel)}
  });
  const jobs = () => { if (!preparation) throw new StoreError('Lesson preparation is not enabled in this server.', 503); return preparation; };
  app.get('/api/preparation', (_req, res) => res.json(jobs().state()));
  app.post('/api/source-bundles/:id/prepare', (req, res) => {
    if (capturing) throw new StoreError('Wait for source capture to finish before preparing a lesson.', 409);
    const { provider, familiarity } = prepareInput.parse(req.body);
    res.status(202).json(jobs().start(req.params.id, provider, familiarity));
  });
  app.post('/api/preparation/:id/stop', (req, res) => res.json(jobs().stop(req.params.id)));
  let capturing = false;
  app.get('/api/source-bundles', (_req, res) => res.json(store.listBundles()));
  app.post('/api/source-bundles', async (req, res) => {
    if (capturing) throw new StoreError('Another source capture is still running. Try again when it finishes.', 409);
    capturing = true;
    try {
      const { bundle, blobs } = await prepareSources(req.body, undefined, store.getSettings().capture); store.saveBundle(bundle, blobs);
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
    if (preparation?.state().jobs.some(job => job.bundleId === req.params.id && (job.status === 'running' || job.status === 'stopping'))) throw new StoreError('Stop preparation before refreshing its sources.', 409);
    const previous = store.getBundle(req.params.id);
    if (!previous) throw new StoreError('Source collection not found.', 404);
    capturing = true;
    try {
      const { bundle, blobs } = await retrySources(previous); store.saveBundle(bundle, blobs);
      res.json({ ...bundle, sources: bundle.sources.map(({ rawHtml: _raw, ...source }) => source) });
    } finally { capturing = false; }
  });
  const deleteBundle = async (id: string) => {
    if (capturing) throw new StoreError('Wait for source capture to finish before deleting.', 409);
    if (preparation?.busy(id)) throw new StoreError('Stop preparation before deleting these sources.', 409);
    const jobs = store.deleteBundle(id);
    await preparation?.forget(jobs);
  };
  app.patch('/api/source-bundles/:id', (req, res) => {
    const bundle = store.renameBundle(req.params.id, renameInput.parse(req.body).title);
    res.json({ ...bundle, sources: bundle.sources.map(({ rawHtml: _raw, ...source }) => source) });
  });
  app.delete('/api/source-bundles/:id', async (req, res) => { await deleteBundle(req.params.id); res.status(204).end(); });
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
      if (asset.src.startsWith('/api/source-assets/')) {
        const saved = store.getAsset(asset.src.split('/').at(-1)!);
        if (!saved || !/^image\/(png|jpeg|webp|gif|avif)$/.test(saved.type)) throw new StoreError('Saved image ' + asset.id + ' is missing or cannot be displayed. Use its saved raster preview.', 400);
      }
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
  app.get('/api/lessons/:id/export', async (req, res) => {
    const lesson = store.get(req.params.id);
    if (!lesson) throw new StoreError('Analysis not found.', 404);
    // Saved source images live only in this library; embed them so the file imports elsewhere.
    for (const asset of lesson.assets) {
      if (!asset.src.startsWith('/api/source-assets/')) continue;
      const saved = store.getAsset(asset.src.split('/').at(-1)!);
      if (!saved) continue;
      const bytes = /^image\/(png|jpeg|webp)$/.test(saved.type) ? Buffer.from(saved.bytes) : await sharp(Buffer.from(saved.bytes)).png().toBuffer();
      asset.src = 'data:' + (/^image\/(png|jpeg|webp)$/.test(saved.type) ? saved.type : 'image/png') + ';base64,' + bytes.toString('base64');
    }
    // The source collection link is local to this library; an import elsewhere would reject it.
    res.json(parseLesson({ ...lesson, sourceBundleId: undefined }));
  });
  app.patch('/api/lessons/:id', (req, res) => res.json(store.renameLesson(req.params.id, renameInput.parse(req.body).title)));
  app.delete('/api/lessons/:id', async (req, res) => {
    const lesson = store.get(req.params.id);
    if (!lesson) throw new StoreError('Analysis not found.', 404);
    const bundleId = req.query.sources === 'true' && lesson.sourceBundleId && store.getBundle(lesson.sourceBundleId) ? lesson.sourceBundleId : undefined;
    if (bundleId && (capturing || preparation?.busy(bundleId))) throw new StoreError('Stop preparation before deleting these sources.', 409);
    store.deleteLesson(lesson.id);
    options.tutor?.deleteLesson(lesson.id);
    if (bundleId) await deleteBundle(bundleId);
    res.status(204).end();
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
