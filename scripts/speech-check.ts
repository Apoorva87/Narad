import { LocalSpeechWorker } from '../server/speech-worker';
import { wavDuration } from '../server/speech';
const worker=new LocalSpeechWorker();
const text='Memory bandwidth tells us how much data can move each second. It does not, by itself, tell us how quickly a model can generate a token. Think of a delivery truck: moving the ingredients is only one part of making the meal.';
try {
 for(const voice of ['Ryan','Aiden']) {
  const start=performance.now();const audio=await worker.synthesize(text,voice,'Speak as a knowledgeable, patient tutor. Warm, clear, conversational delivery, with natural pauses that make the explanation easy to follow.',new AbortController().signal);
  console.log(JSON.stringify({voice,generationSeconds:(performance.now()-start)/1000,audioSeconds:wavDuration(audio),bytes:audio.length}));
 }
} finally { await worker.close(); }
