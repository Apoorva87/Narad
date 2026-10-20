import { expect, it } from 'vitest';
import { buildNarrationItems } from '../src/lib/narration-items';
import { minimalLesson } from './fixture';
import type { TutorTurn } from '../shared/tutor';

it('narrates ready replies only when their passage thread is expanded',()=>{
 const turn: TutorTurn={id:'t1',lessonId:'fixture',mode:'walkthrough',sectionId:'first',blockId:'block-a',question:'Why?',provider:'codex',scope:'lesson',status:'ready',stage:'Answer ready',createdAt:'x',updatedAt:'x',answer:{blocks:[{kind:'text',markdown:'Because.',spokenText:'Because.'}],citations:[],suggestedFollowUps:[]}};
 const lesson=minimalLesson();const prefs={narrator:'Ryan',host:'Aiden',expert:'Vivian',rate:1} as const;
 const collapsed=buildNarrationItems(lesson,'walkthrough',prefs,{});const expanded=buildNarrationItems(lesson,'walkthrough',prefs,{'block-a':[turn]});
 expect(collapsed.some(item=>item.tutor)).toBe(false);
 expect(expanded.filter(item=>item.tutor).map(item=>[item.tutor!.part,item.voice])).toEqual([['question','Aiden'],['answer','Vivian']]);
 expect(expanded.findIndex(item=>item.tutor?.part==='question')).toBeGreaterThan(expanded.findIndex(item=>item.blockId==='block-a'));
});
