import express, { type ErrorRequestHandler } from 'express';
import { pathToFileURL } from 'node:url';
import { z, ZodError } from 'zod';
import type { SpeechEngine } from './speech';
import { LocalSpeechWorker } from './speech-worker';
import { speechEngines, voices } from '../shared/speech';

const synthesisSchema=z.object({text:z.string().min(1).max(20_000),voice:z.enum(voices),style:z.string().min(1).max(20_000),engine:z.enum(speechEngines).optional()}).strict();
const preferredEngine=z.enum(speechEngines).optional().catch(undefined);
function authorized(header:string|undefined,token:string){return Boolean(token)&&header===`Bearer ${token}`}

export function createTtsHost(engine:SpeechEngine,token:string){
  if(!token)throw new Error('The speech host requires a token.');
  const app=express();app.disable('x-powered-by');app.use(express.json({limit:'128kb'}));
  app.use((req,res,next)=>{if(!authorized(req.get('Authorization'),token)){res.status(401).json({error:'Speech host authorization failed.'});return}next()});
  app.get('/health',(req,res)=>{const status=engine.status(preferredEngine.parse(req.query.engine));res.json({...status,model:engine.model})});
  app.post('/synthesize',async(req,res,next)=>{
    try{const input=synthesisSchema.parse(req.body);const controller=new AbortController();const cancel=()=>{if(!res.writableEnded)controller.abort()};res.on('close',cancel);
      try{const bytes=await engine.synthesize(input.text,input.voice,input.style,controller.signal,input.engine);if(!controller.signal.aborted){res.setHeader('Content-Type','audio/wav');res.setHeader('Cache-Control','no-store');res.send(bytes)}}finally{res.off('close',cancel)}
    }catch(error){next(error)}
  });
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{if(res.headersSent)return;if(error instanceof ZodError)res.status(400).json({error:'Speech request is invalid.'});else res.status(503).json({error:error instanceof Error?error.message:'Speech generation failed.'})};app.use(errors);return app;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const token=process.env.NARAD_TTS_TOKEN;if(!token)throw new Error('NARAD_TTS_TOKEN is required.');
  const engine=new LocalSpeechWorker(),port=Number(process.env.NARAD_TTS_PORT??4321),host=process.env.NARAD_TTS_BIND_HOST??'0.0.0.0';
  const server=createTtsHost(engine,token).listen(port,host,()=>console.log(`Narad macOS speech host: http://${host}:${port}`));
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await engine.close();server.close(()=>process.exit(0))};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
