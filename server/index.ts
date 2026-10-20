import { PreparationService } from './preparation';
import { SpeechService } from './speech';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app';
import { LessonStore } from './store';
import { TutorStore } from './tutor-store';
import { TutorService } from './tutor';
import { createRuntimeServices } from './runtime-services';
import samples from '../content/samples.json';

const dataDir = resolve(process.env.NARAD_DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });
const store = new LessonStore(resolve(dataDir, 'narad.sqlite'));
const tutorStore = new TutorStore(resolve(dataDir, 'tutor.sqlite'));
for (const sample of samples) if (!store.get(sample.id) && !store.isDeletedSample(sample.id)) store.insert(sample);
const port = Number(process.env.NARAD_PORT || 4318);
const runtime=createRuntimeServices();
const preparation = new PreparationService(store, dataDir, runtime.agent);
const speech = new SpeechService(store,runtime.speech);
const tutor = new TutorService(store,tutorStore,dataDir,runtime.agent);
const server = createApp(store, preparation, speech, { webOrigin: process.env.NARAD_WEB_ORIGIN, tutor }).listen(port, runtime.bindHost, () => console.log('Narad API: http://'+runtime.bindHost+':' + port));
server.on('error', error => { console.error('Could not start Narad:', error.message); tutorStore.close(); store.close(); process.exit(1); });
let stopping = false;
async function shutdown() { if (stopping) return; stopping = true; await Promise.all([preparation.shutdown(),speech.close(),tutor.shutdown()]); server.close(() => { tutorStore.close(); store.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
