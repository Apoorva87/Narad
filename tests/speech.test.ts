import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as speech from '../shared/speech';
const { splitSpeech } = speech;
import { SpeechService } from '../server/speech';
import { LessonStore } from '../server/store';
import samples from '../content/samples.json';
import { createApp } from '../server/app';

const dirs: string[] = [], stores: LessonStore[] = [];
afterEach(async () => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) await rm(d, {recursive:true,force:true}); });
function wav() { const b=Buffer.alloc(48044); b.write('RIFF'); b.writeUInt32LE(b.length-8,4); b.write('WAVEfmt ',8); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(24000,24); b.writeUInt32LE(48000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(48000,40); return b; }
async function setup(generate: (text:string,voice:string,style:string,signal:AbortSignal)=>Promise<Buffer> = async () => wav()) {
 const dir=await mkdtemp(join(tmpdir(),'narad-speech-')); dirs.push(dir);
 const store=new LessonStore(join(dir,'db')); stores.push(store); const lesson=store.insert(samples[0]);
 const service=new SpeechService(store,{model:'test-model',status:()=>({state:'ready' as const}),synthesize:generate,close:async()=>{}});
 const mode='walkthrough' as const; const block=lesson.modes[mode]!.sections[0].blocks[0];
 return {service,store,dir,request:{lessonId:lesson.id,mode,blockId:block.id,chunk:0,voice:'Ryan' as const},block};
}
it('splits long narration without losing or reordering words, preserving decimals',()=>{
 const text='A delay of 1.25 milliseconds is small. '+('A longer explanation follows, with all its details intact. '.repeat(35));
 const chunks=splitSpeech(text); expect(chunks.length).toBeGreaterThan(2); expect(chunks.every(c=>c.length<=480)).toBe(true);
 expect(chunks.join(' ').replace(/\s+/g,' ').trim()).toBe(text.replace(/\s+/g,' ').trim()); expect(chunks[0]).toContain('1.25');
 expect(splitSpeech('x'.repeat(1001)).join('')).toBe('x'.repeat(1001));
});
it('plans paragraph parts with restrained focus and transition pacing',()=>{
 const planSpeech=(speech as typeof speech & {planSpeech?:(text:string)=>{text:string;pace:string}[]}).planSpeech;
 const text='Now let us move to the next step. Bandwidth is defined as the amount of data transferred each second. The scheduler sends work to each core.';
 expect(planSpeech?.(text)).toEqual([
  {text:'Now let us move to the next step.',pace:'brisk'},
  {text:'Bandwidth is defined as the amount of data transferred each second.',pace:'focus'},
  {text:'The scheduler sends work to each core.',pace:'normal'},
 ]);
 expect(planSpeech?.(text).map(part=>part.text).join(' ')).toBe(text);
});
it('splits a dense sentence at semantic breath boundaries without changing its words',()=>{
 const first='The controller measures incoming work, compares it with the available capacity, accounts for every active queue, and estimates how long each request has already waited';
 const second='it then assigns the next request to the least constrained worker, records the decision, and repeats the calculation when capacity changes.';
 const text=first+'; '+second;
 const parts=speech.planSpeech(text);
 expect(parts.map(part=>part.text)).toEqual([first+';',second]);
 expect(parts.map(part=>part.text).join(' ')).toBe(text);
});
it('adds restrained passage-specific prosody and pronunciation guidance to the saved role style',async()=>{
 const {block}=await setup();
 const styles={hostStyle:'BASE HOST',tutorStyle:'BASE TUTOR'};
 const definition=speech.speechStyle(block,styles,'Bandwidth is defined as 40 GB per second.');
 expect(definition).toContain('BASE TUTOR');
 expect(definition).toMatch(/definition/i);
 expect(definition).toMatch(/40 GB per second/i);
 expect(definition).toMatch(/restrained|natural/i);
 const contrast=speech.speechStyle(block,styles,'However, latency falls while throughput remains unchanged.');
 expect(contrast).toMatch(/contrast/i);
 const conclusion=speech.speechStyle(block,styles,'Therefore, the queue is the limiting factor.');
 expect(conclusion).toMatch(/conclusion/i);
});
it('can enrich standalone tutor replies with the same passage-aware delivery',()=>{
 const enrich=(speech as typeof speech & {enrichSpeechStyle?:(style:string,text:string)=>string}).enrichSpeechStyle;
 expect(enrich).toBeTypeOf('function');
 expect(enrich?.('BASE REPLY','However, CPU latency remains 12 milliseconds.')).toMatch(/BASE REPLY.*contrast.*12 milliseconds/is);
});
it('generates saved spoken text on demand and never creates audio files, including on replay',async()=>{
 const calls:{text:string,voice:string}[]=[]; const {service,request,block,dir}=await setup(async(text,voice)=>{calls.push({text,voice});return wav()});
 const before=await readdir(dir);
 const first=await service.render(request,new AbortController().signal); const second=await service.render(request,new AbortController().signal);
 expect(first).toEqual(wav()); expect(second).toEqual(wav());
 await service.render({...request,voice:'Aiden'},new AbortController().signal);
 expect(calls).toEqual(['Ryan','Ryan','Aiden'].map(voice=>({text:splitSpeech(block.spokenText)[0],voice})));
 expect(await readdir(dir)).toEqual(before);
});
it('rejects missing blocks, invalid chunk indices, and arbitrary voices before inference',async()=>{
 let calls=0; const {service,request}=await setup(async()=>{calls++;return wav()}); const signal=new AbortController().signal;
 await expect(service.render({...request,blockId:'missing'},signal)).rejects.toThrow();
 await expect(service.render({...request,chunk:999},signal)).rejects.toThrow();
 await expect(service.render({...request,voice:'unknown' as any},signal)).rejects.toThrow(); expect(calls).toBe(0);
});
it('does not publish cancelled audio even when synthesis finishes late',async()=>{
 let release!:(b:Buffer)=>void; const {service,request,dir}=await setup(()=>new Promise(r=>release=r)); const c=new AbortController();
 const pending=service.render(request,c.signal); const rejected=expect(pending).rejects.toThrow(/abort/i);
 await expect.poll(()=>!!release).toBe(true); c.abort(); release(wav()); await rejected;
 expect((await readdir(dir)).filter(x=>x==='audio'||x.endsWith('.wav'))).toEqual([]);
});
it('a failed or invalid audio response is retryable',async()=>{
 let attempts=0; const {service,request}=await setup(async()=>++attempts===1?Buffer.from('bad audio'):wav());
 await expect(service.render(request,new AbortController().signal)).rejects.toThrow(/audio/i);
 expect(await service.render(request,new AbortController().signal)).toEqual(wav()); expect(attempts).toBe(2);
});
it('shutdown rejects queued work and discards late active output without restarting inference',async()=>{
 let release!:(b:Buffer)=>void;let calls=0;const {service,request,dir}=await setup(()=>{calls++;return new Promise(r=>release=r)});
 const first=service.render(request,new AbortController().signal);const second=service.render({...request,voice:'Aiden'},new AbortController().signal);
 const firstRejected=expect(first).rejects.toThrow(/shutting down/i),secondRejected=expect(second).rejects.toThrow(/shutting down/i);
 await expect.poll(()=>!!release).toBe(true);const closing=service.close();release(wav());await Promise.all([closing,firstRejected,secondRejected]);
 expect(calls).toBe(1);expect((await readdir(dir)).filter(x=>x==='audio'||x.endsWith('.wav'))).toEqual([]);
});
it('returns ephemeral audio directly over HTTP with no-store and no saved-audio endpoint',async()=>{
 const {service,store,request}=await setup();const server=createApp(store,undefined,service).listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address() as {port:number};const base='http://127.0.0.1:'+address.port;
 try {
  const response=await fetch(base+'/api/speech/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('audio/wav');expect(response.headers.get('cache-control')).toBe('no-store');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(wav());
  const missing=await fetch(base+'/api/speech/audio/'+'a'.repeat(64));expect(missing.status).toBe(404);await missing.text();
 } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();}
});
