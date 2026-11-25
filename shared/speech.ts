import { z } from 'zod';
import { modes, type LessonBlock } from './lesson';

export const voices = ['Ryan', 'Aiden', 'Vivian', 'Serena'] as const;
export type Voice = typeof voices[number];
/** Local voice models. Voice names are shared, so a lesson keeps its narrator, host and tutor when the model changes. */
export const speechEngines = ['breeze', 'qwen'] as const;
export type SpeechEngineId = typeof speechEngines[number];
export const speechEngineLabels: Record<SpeechEngineId, string> = { breeze: 'Breeze TTS 2 (most expressive)', qwen: 'Qwen3-TTS (faster, smaller)' };
export const speechRequestSchema = z.object({
  lessonId: z.string().min(1).max(100), mode: z.enum(modes), blockId: z.string().min(1).max(100),
  chunk: z.number().int().min(0), voice: z.enum(voices),
  /** A check question's explanation, spoken after the learner answers. Absent for the passage itself. */
  part: z.literal('explanation').optional(),
});
/** The text a narration request speaks: the passage, or a check question's explanation. */
export function spokenPart(block: LessonBlock, part?: 'explanation'): string | undefined {
  if (!part) return block.spokenText;
  return block.kind === 'quiz' ? block.explanationSpoken : undefined;
}
export type SpeechRequest = z.infer<typeof speechRequestSchema>;
/** Temporary browser audio; its owner must release the object URL after use. */
export type SpeechAudio = { url: string; release(): void };
export type SpeechStatus = { state: 'not-installed' | 'idle' | 'loading' | 'ready' | 'generating' | 'error'; message?: string; model: string };
export type SpeechPreferences = { narrator: Voice; host: Voice; expert: Voice; rate: number };
export const defaultSpeechPreferences: SpeechPreferences = { narrator:'Ryan',host:'Aiden',expert:'Ryan',rate:1 };
export type SpeechPace = 'focus' | 'normal' | 'brisk';
export type SpeechSegment = { text: string; pace: SpeechPace };

const definitionPattern=/\b(?:defined as|means|refers to|is called|is the term for)\b/i;
const contrastPattern=/\b(?:however|but|whereas|while|in contrast|rather than|unlike|on the other hand)\b/i;
const conclusionPattern=/\b(?:therefore|thus|consequently|as a result|this means|the key point|limiting factor)\b/i;

function paceFor(text:string):SpeechPace {
  const focus=/\d|\b(?:defined as|means|refers to|is called|because|therefore|key point|important|constraint|limiting factor|equals?|divided by|multiplied by|squared|percent(?:age)?|milliseconds?|microseconds?|nanoseconds?|cycles?|bytes?|tokens?)\b/i;
  if(focus.test(text)||text.length>=210)return 'focus';
  if(/^(?:now|next|with that in mind)\b/i.test(text))return 'brisk';
  return 'normal';
}

/** Prefer punctuation chosen by the author over an arbitrary character boundary. */
function breathGroups(sentence:string):string[] {
  if(sentence.length<=260)return[sentence];
  const groups=sentence.match(/[^;:\u2014]+(?:[;:\u2014]|$)/g)?.map(part=>part.trim()).filter(Boolean)??[];
  return groups.length>1&&groups.every(group=>group.length<=480)?groups:[sentence];
}

/** Build deterministic sentence-sized units so the browser and server agree on chunk indexes. */
export function planSpeech(text:string):SpeechSegment[] {
  const sentences=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(text)].map(s=>s.segment.trim()).filter(Boolean);
  const segments:SpeechSegment[]=[];
  for(const sentence of sentences) {
    for(const group of breathGroups(sentence)) {
      let rest=group;
      while(rest.length>480) {
        const space=rest.lastIndexOf(' ',480);const end=space>0?space:480;
        segments.push({text:rest.slice(0,end),pace:paceFor(rest.slice(0,end))});rest=rest.slice(end).trimStart();
      }
      if(!rest)continue;
      const pace=paceFor(rest);const last=segments.at(-1);
      if(last&&last.pace===pace&&last.text.length+rest.length+1<=260)last.text+=' '+rest;
      else segments.push({text:rest,pace});
    }
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
function passageDirection(text:string):string {
  const directions:string[]=[];
  if(definitionPattern.test(text))directions.push('Treat this as a definition: settle slightly before the defining phrase, then deliver it clearly and precisely.');
  if(contrastPattern.test(text))directions.push('Make the contrast audible with restrained emphasis on the words or clauses that differ.');
  if(conclusionPattern.test(text))directions.push('Treat the conclusion as the destination of the reasoning: allow a small pause before it and land the final claim cleanly.');
  if(/\b(?:because|causes?|leads? to|results? in|so that|due to)\b/i.test(text))directions.push('Make the causal sequence easy to follow, emphasizing the cause and its consequence rather than every word equally.');
  const terms=[
    ...(text.match(/\b\d+(?:\.\d+)?\s*(?:[A-Z]{1,6}|percent|milliseconds?|microseconds?|nanoseconds?|seconds?|minutes?|hours?|bytes?|bits?|tokens?|cycles?)(?:\s+per\s+[A-Za-z]+)?\b/g)??[]),
    ...(text.match(/\b[A-Z]{2,6}\b/g)??[]),
  ].filter((term,index,all)=>all.indexOf(term)===index).slice(0,6);
  if(terms.length)directions.push(`Pronounce technical terms, quantities, and units carefully and consistently. Preserve these written expressions exactly in meaning: ${terms.map(term=>'“'+term+'”').join(', ')}.`);
  directions.push('Keep the expression natural and restrained: vary emphasis and pauses enough to guide attention, without sounding theatrical or turning every sentence into a dramatic performance.');
  return directions.join(' ');
}
export function enrichSpeechStyle(style:string,text:string) {
  return `${style} ${passageDirection(text)}`.trim();
}
export function speechStyle(block: LessonBlock, styles: { hostStyle: string; tutorStyle: string }, text='') {
  const roleStyle=block.kind==='dialogue' && block.role==='host' ? styles.hostStyle : styles.tutorStyle;
  return enrichSpeechStyle(roleStyle,text);
}
