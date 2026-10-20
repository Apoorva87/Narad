import { z } from 'zod';
import { modes, type LessonBlock } from './lesson';

export const voices = ['Ryan', 'Aiden', 'Vivian', 'Serena'] as const;
export type Voice = typeof voices[number];
export const speechRequestSchema = z.object({
  lessonId: z.string().min(1).max(100), mode: z.enum(modes), blockId: z.string().min(1).max(100),
  chunk: z.number().int().min(0), voice: z.enum(voices),
});
export type SpeechRequest = z.infer<typeof speechRequestSchema>;
/** Temporary browser audio; its owner must release the object URL after use. */
export type SpeechAudio = { url: string; release(): void };
export type SpeechStatus = { state: 'not-installed' | 'idle' | 'loading' | 'ready' | 'generating' | 'error'; message?: string; model: string };
export type SpeechPreferences = { narrator: Voice; host: Voice; expert: Voice; rate: number };
export const defaultSpeechPreferences: SpeechPreferences = { narrator:'Ryan',host:'Aiden',expert:'Ryan',rate:1 };
export type SpeechPace = 'focus' | 'normal' | 'brisk';
export type SpeechSegment = { text: string; pace: SpeechPace };

function paceFor(text:string):SpeechPace {
  const focus=/\d|\b(?:defined as|means|refers to|is called|because|therefore|key point|important|constraint|limiting factor|equals?|divided by|multiplied by|squared|percent(?:age)?|milliseconds?|microseconds?|nanoseconds?|cycles?|bytes?|tokens?)\b/i;
  if(focus.test(text)||text.length>=210)return 'focus';
  if(/^(?:now|next|with that in mind)\b/i.test(text))return 'brisk';
  return 'normal';
}

/** Build deterministic sentence-sized units so the browser and server agree on chunk indexes. */
export function planSpeech(text:string):SpeechSegment[] {
  const sentences=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(text)].map(s=>s.segment.trim()).filter(Boolean);
  const segments:SpeechSegment[]=[];
  for(const sentence of sentences) {
    let rest=sentence;
    while(rest.length>480) {
      const space=rest.lastIndexOf(' ',480);const end=space>0?space:480;
      segments.push({text:rest.slice(0,end),pace:paceFor(rest.slice(0,end))});rest=rest.slice(end).trimStart();
    }
    if(!rest)continue;
    const pace=paceFor(rest);const last=segments.at(-1);
    if(last&&last.pace===pace&&last.text.length+rest.length+1<=260)last.text+=' '+rest;
    else segments.push({text:rest,pace});
  }
  return segments;
}

/** Keep the exact spoken content, only normalizing whitespace between chunks. */
export function splitSpeech(text: string): string[] {
  return planSpeech(text).map(segment=>segment.text);
}
export function voiceFor(block: LessonBlock, prefs: SpeechPreferences): Voice {
  return block.kind==='dialogue' ? prefs[block.role] : prefs.narrator;
}
export function speechStyle(block: LessonBlock, styles: { hostStyle: string; tutorStyle: string }) {
  return block.kind==='dialogue' && block.role==='host' ? styles.hostStyle : styles.tutorStyle;
}
