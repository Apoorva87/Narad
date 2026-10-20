import type { PreparationService } from './preparation';
import type { SpeechService } from './speech';
import type { TutorService } from './tutor';
import { speechRequestSchema, splitSpeech } from '../shared/speech';
import { tutorAskSchema, tutorSpeechRequestSchema } from '../shared/tutor';
import { prepareInput, renameInput } from '../shared/preparation';
import { defaultSettings, settingsSchema, type Settings } from '../shared/settings';
import express, { type ErrorRequestHandler } from 'express';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { modes, parseLesson } from '../shared/lesson';
import { type LessonStore, StoreError, mediaType, slugPattern } from './store';
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
  // Every :id route accepts a folder slug or a legacy lesson/collection ID.
  const lessonSlug = (id: string) => { const slug = store.resolveId(id); if (!slug || !store.get(slug)) throw new StoreError('Analysis not found.', 404); return slug; };
  const bundleSlug = (id: string) => { const slug = store.resolveId(id); if (!slug || !store.getBundle(slug)) throw new StoreError('Source collection not found.', 404); return slug; };
  const tutoring = () => { if (!options.tutor) throw new StoreError('Contextual tutoring is not enabled in this server.',503); return options.tutor; };
  app.get('/api/lessons/:id/tutor', (req,res) => {
    const slug=lessonSlug(req.params.id);
    const mode=z.enum(modes).parse(req.query.mode);res.json(tutoring().state(slug,mode));
  });
  app.post('/api/lessons/:id/tutor/turns', (req,res) => res.status(202).json(tutoring().start(lessonSlug(req.params.id),tutorAskSchema.parse(req.body))));
  app.post('/api/tutor/turns/:id/stop', (req,res) => res.json(tutoring().stop(req.params.id)));
  app.delete('/api/tutor/turns/:id', (req,res) => {tutoring().delete(req.params.id);res.status(204).end()});
  app.post('/api/tutor/speech/render', async(req,res)=>{
    const input=tutorSpeechRequestSchema.parse(req.body);const service=tutoring();const text=service.textForSpeech(input.turnId,input.part);
    const chunk=splitSpeech(text)[input.chunk];if(!chunk)throw new StoreError('This tutor narration chunk was not found.',400);
    const controller=new AbortController();const cancel=()=>{if(!res.writableEnded)controller.abort()};res.on('close',cancel);
    try {
      const styles=store.getSettings().prompts;const bytes=await narration().renderText(chunk,input.voice,input.part==='question'?styles.hostStyle:styles.tutorStyle,controller.signal);
      if(!controller.signal.aborted){res.setHeader('Content-Type','audio/wav');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.send(bytes)}
    } catch(error) {if(!controller.signal.aborted)throw error instanceof StoreError?error:new StoreError(error instanceof Error?error.message:'Could not prepare tutor narration.',503)}
    finally {res.off('close',cancel)}
  });
  const jobs = () => { if (!preparation) throw new StoreError('Lesson preparation is not enabled in this server.', 503); return preparation; };
  app.get('/api/preparation', (_req, res) => res.json(jobs().state()));
  app.post('/api/source-bundles/:id/prepare', (req, res) => {
    if (capturing) throw new StoreError('Wait for source capture to finish before preparing a lesson.', 409);
    const { provider, familiarity } = prepareInput.parse(req.body);
    res.status(202).json(jobs().start(bundleSlug(req.params.id), provider, familiarity));
  });
  app.post('/api/preparation/:id/stop', (req, res) => res.json(jobs().stop(req.params.id)));
  let capturing = false;
  app.get('/api/source-bundles', (_req, res) => res.json(store.listBundles()));
  app.post('/api/source-bundles', async (req, res) => {
    if (capturing) throw new StoreError('Another source capture is still running. Try again when it finishes.', 409);
    capturing = true;
    try {
      const captured = await prepareSources(req.body, undefined, store.getSettings().capture); const bundle = store.saveBundle(captured.bundle, captured.blobs);
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
    const slug = bundleSlug(req.params.id);
    if (preparation?.busy(slug) || preparation?.state().jobs.some(job => job.bundleId === req.params.id && (job.status === 'running' || job.status === 'stopping'))) throw new StoreError('Stop preparation before refreshing its sources.', 409);
    const previous = store.getBundle(slug)!;
    capturing = true;
    try {
      const retried = await retrySources(previous); const bundle = store.saveBundle(retried.bundle, retried.blobs);
      res.json({ ...bundle, sources: bundle.sources.map(({ rawHtml: _raw, ...source }) => source) });
    } finally { capturing = false; }
  });
  const deleteBundle = async (id: string) => {
    if (capturing) throw new StoreError('Wait for source capture to finish before deleting.', 409);
    id = bundleSlug(id);
    if (preparation?.busy(id)) throw new StoreError('Stop preparation before deleting these sources.', 409);
    const jobs = store.deleteBundle(id);
    await preparation?.forget(jobs);
  };
  app.patch('/api/source-bundles/:id', (req, res) => {
    const bundle = store.renameBundle(req.params.id, renameInput.parse(req.body).title);
    res.json({ ...bundle, sources: bundle.sources.map(({ rawHtml: _raw, ...source }) => source) });
  });
  app.delete('/api/source-bundles/:id', async (req, res) => { await deleteBundle(req.params.id); res.status(204).end(); });
  app.get('/api/library/:slug/media/:file', (req, res) => {
    const path = store.mediaPath(req.params.slug, req.params.file);
    if (!path) throw new StoreError('Image not found.', 404);
    const type = mediaType(req.params.file);
    res.setHeader('Content-Type', type); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // SVGs and anything else that is not a plain raster image are served as downloads only.
    if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(type)) res.setHeader('Content-Disposition', 'attachment; filename="' + req.params.file + '"');
    res.send(readFileSync(path));
  });
  app.post('/api/library/:slug/reveal', (req, res) => {
    // Opening Finder only makes sense for someone sitting at this Mac, never through the reverse proxy.
    let hostname = '';
    try { hostname = new URL('http://' + req.headers.host).hostname; } catch { /* rejected below */ }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw new StoreError('Show in Finder works only on the Mac running Narad.', 403);
    const { slug } = req.params;
    if (!slugPattern.test(slug) || store.resolveId(slug) !== slug) throw new StoreError('Library item not found.', 404);
    if (!process.env.VITEST) execFile('open', [join(store.libraryRoot, slug)], () => {});
    res.status(204).end();
  });
  app.get('/api/lessons', (_req, res) => res.json(store.list()));
  app.post('/api/lessons', (req, res) => {
    const lesson = parseLesson(req.body);
    for (const asset of lesson.assets) {
      const media = asset.src.match(/^\/api\/library\/([^/]+)\/media\/([^/]+)$/);
      if (asset.src.startsWith('/api/source-assets/') || asset.src.startsWith('media/') || (media && (!store.mediaPath(media[1], media[2]) || !/^image\/(png|jpeg|webp|gif|avif|svg\+xml)$/.test(mediaType(media[2]))))) {
        throw new StoreError('Saved image ' + asset.id + ' is missing or cannot be displayed. Use its saved raster preview.', 400);
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
      const media = asset.src.match(/^\/api\/library\/([^/]+)\/media\/([^/]+)$/);
      const path = media && store.mediaPath(media[1], media[2]);
      if (!media || !path) continue;
      const type = mediaType(media[2]); const raster = /^image\/(png|jpeg|webp)$/.test(type);
      const bytes = raster ? readFileSync(path) : await sharp(readFileSync(path)).png().toBuffer();
      asset.src = 'data:' + (raster ? type : 'image/png') + ';base64,' + bytes.toString('base64');
    }
    // The source collection link is local to this library; an import elsewhere would reject it.
    res.json(parseLesson({ ...lesson, sourceBundleId: undefined }));
  });
  app.patch('/api/lessons/:id', (req, res) => {
    const slug = lessonSlug(req.params.id);
    const lesson = store.renameLesson(slug, renameInput.parse(req.body).title);
    if (lesson.id !== slug) options.tutor?.moveLesson(slug, lesson.id);
    res.json(lesson);
  });
  app.delete('/api/lessons/:id', async (req, res) => {
    // Resolved without parsing so a hand-broken lesson can still be removed. Its sources share the folder.
    const slug = store.resolveId(req.params.id);
    if (!slug || !store.list().some(item => item.id === slug)) throw new StoreError('Analysis not found.', 404);
    const bundleId = req.query.sources === 'true' && store.listBundles().some(item => item.id === slug) ? slug : undefined;
    if (bundleId && (capturing || preparation?.busy(bundleId))) throw new StoreError('Stop preparation before deleting these sources.', 409);
    store.deleteLesson(slug);
    options.tutor?.deleteLesson(slug);
    if (bundleId) await deleteBundle(bundleId);
    res.status(204).end();
  });
  app.get('/api/lessons/:id/progress', (req, res) => res.json(store.getProgress(lessonSlug(req.params.id))));
  app.put('/api/lessons/:id/progress', (req, res) => {
    const { mode, blockId } = z.object({ mode: z.enum(modes), blockId: z.string().min(1) }).parse(req.body);
    const slug = lessonSlug(req.params.id);
    store.setProgress(slug, mode, blockId);
    res.json(store.getProgress(slug));
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
