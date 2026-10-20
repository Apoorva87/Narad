import { PreparationService } from './preparation';
import { SpeechService } from './speech';
import { LocalSpeechWorker } from './speech-worker';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app';
import { LessonStore } from './store';
import { TutorStore } from './tutor-store';
import { TutorService } from './tutor';
import { cliRunner } from './agent-runner';
import samples from '../content/samples.json';

const dataDir = resolve(process.env.NARAD_DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });
const store = new LessonStore(resolve(dataDir, 'narad.sqlite'), resolve(dataDir, 'library'));
const tutorStore = new TutorStore(resolve(dataDir, 'tutor.sqlite'));
// Samples become ordinary folders; their bundled images are copied in so each folder stands alone.
for (const sample of samples) {
  if (store.resolveId(sample.id) || store.isDeletedSample(sample.id)) continue;
  const media: Record<string, Buffer> = {};
  const assets = sample.assets.map(asset => {
    const file = asset.src.match(/^\/assets\/([a-zA-Z0-9_-]+\.[a-z]+)$/)?.[1];
    if (!file) return asset;
    media[file] = readFileSync(resolve('public', 'assets', file));
    return { ...asset, src: 'media/' + file };
  });
  store.insert({ ...sample, assets }, media);
}
const port = Number(process.env.NARAD_PORT || 4318);
const preparation = new PreparationService(store, dataDir);
const speech = new SpeechService(store,new LocalSpeechWorker());
const tutor = new TutorService(store,tutorStore,dataDir,cliRunner);
const server = createApp(store, preparation, speech, { webOrigin: process.env.NARAD_WEB_ORIGIN, tutor }).listen(port, '127.0.0.1', () => console.log('Narad API: http://127.0.0.1:' + port));
server.on('error', error => { console.error('Could not start Narad:', error.message); tutorStore.close(); store.close(); process.exit(1); });
let stopping = false;
async function shutdown() { if (stopping) return; stopping = true; await Promise.all([preparation.shutdown(),speech.close(),tutor.shutdown()]); server.close(() => { tutorStore.close(); store.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
