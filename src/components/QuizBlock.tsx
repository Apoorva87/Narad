import { Check, CircleHelp, RotateCcw, X } from 'lucide-react';
import type { LessonBlock } from '../../shared/lesson';
import { Markdown } from './Markdown';

/** `choice` is the option the learner picked; `revealed` is set when narration explains an unanswered question. */
export type QuizState = { choice?: number; revealed?: boolean };
type Quiz = Extract<LessonBlock, { kind: 'quiz' }>;

export function QuizBlock({ block, state = {}, onAnswer, onRetry }: { block: Quiz; state?: QuizState; onAnswer: (choice: number) => void; onRetry: () => void }) {
  const answered = state.choice !== undefined;
  const done = answered || !!state.revealed;
  const correct = state.choice === block.answer;
  const letter = (index: number) => String.fromCharCode(65 + index);
  return <div className="quiz" role="group" aria-label="Check your understanding">
    <div className="quiz-heading"><CircleHelp size={17} /><strong>Check your understanding</strong></div>
    <Markdown>{block.markdown}</Markdown>
    <ol className="quiz-options">{block.options.map((option, index) => {
      const mark = !done ? '' : index === block.answer ? ' quiz-correct' : index === state.choice ? ' quiz-wrong' : ' quiz-dim';
      return <li key={index}><button className={'quiz-option' + mark} disabled={done} aria-pressed={state.choice === index} onClick={() => onAnswer(index)}>
        <span className="quiz-letter">{done && index === block.answer ? <Check size={14} /> : done && index === state.choice ? <X size={14} /> : letter(index)}</span><span>{option}</span>
      </button></li>;
    })}</ol>
    {done && <div className={'quiz-feedback' + (answered ? (correct ? ' quiz-right' : ' quiz-missed') : '')} role="status">
      <strong>{!answered ? 'The answer is ' + letter(block.answer) + '.' : correct ? 'Correct.' : 'Not quite — the answer is ' + letter(block.answer) + '.'}</strong>
      <Markdown>{block.explanation}</Markdown>
      <button className="text-link quiz-retry" onClick={onRetry}><RotateCcw size={13} />Try again</button>
    </div>}
  </div>;
}
