import type { Lesson, Mode } from '../../shared/lesson';
import { flattenBlocks } from '../../shared/navigation';
import { planSpeech, voiceFor, type SpeechPreferences } from '../../shared/speech';
import type { TutorTurn } from '../../shared/tutor';
import type { NarrationItem } from './narration';

export function buildNarrationItems(lesson:Lesson,mode:Mode,prefs:SpeechPreferences,replies:Record<string,TutorTurn[]>):NarrationItem[] {
  return flattenBlocks(lesson,mode).flatMap(({block})=>{
    const lessonItems=planSpeech(block.spokenText).map((segment,chunk)=>({lessonId:lesson.id,mode,blockId:block.id,chunk,voice:voiceFor(block,prefs),pace:segment.pace}));
    const replyItems=(replies[block.id]??[]).flatMap(turn=>{
      if(!turn.answer)return[];
      const question=planSpeech(turn.question).map((segment,chunk)=>({lessonId:lesson.id,mode,blockId:block.id,chunk,voice:prefs.host,pace:segment.pace,tutor:{turnId:turn.id,part:'question' as const}}));
      const answerText=turn.answer.blocks.map(item=>item.spokenText).join(' ');
      const answer=planSpeech(answerText).map((segment,chunk)=>({lessonId:lesson.id,mode,blockId:block.id,chunk,voice:prefs.expert,pace:segment.pace,tutor:{turnId:turn.id,part:'answer' as const}}));
      return [...question,...answer];
    });
    return [...lessonItems,...replyItems];
  });
}
