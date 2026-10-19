import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app';
import { LessonStore } from './store';
import samples from '../content/samples.json';

const dataDir = resolve(process.env.NARAD_DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });
const store = new LessonStore(resolve(dataDir, 'narad.sqlite'));
for (const sample of samples) if (!store.get(sample.id)) store.insert(sample);
const port = Number(process.env.NARAD_PORT || 4318);
const server = createApp(store).listen(port, '127.0.0.1', () => console.log('Narad API: http://127.0.0.1:' + port));
server.on('error', error => { console.error('Could not start Narad:', error.message); store.close(); process.exit(1); });
function shutdown() { server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
