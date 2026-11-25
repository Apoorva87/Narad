import { useEffect, useState } from 'react';
import { PencilLine } from 'lucide-react';
import type { LessonBlock } from '../../shared/lesson';
import { Markdown } from './Markdown';

type Steps = Extract<LessonBlock, { kind: 'steps' }>;

/** A problem worked by hand. Steps stay hidden so the reader can try first; narration reaching the block shows them all. */
export function StepsBlock({ block, revealAll = false }: { block: Steps; revealAll?: boolean }) {
  const [shown, setShown] = useState(0);
  const total = block.steps.length;
  useEffect(() => { if (revealAll) setShown(total + 1); }, [revealAll, total]);
  const done = shown > total;
  return <div className="worked" role="group" aria-label={'Worked example: ' + block.title}>
    <div className="worked-heading"><PencilLine size={16} /><strong>Work it by hand</strong><span>{block.title}</span></div>
    <Markdown>{block.markdown}</Markdown>
    {shown === 0 && <p className="worked-prompt">Try it yourself first, then check each step.</p>}
    <ol className="worked-steps">{block.steps.slice(0, shown).map((step, index) => <li key={index}><span className="worked-number">{index + 1}</span><Markdown>{step.markdown}</Markdown></li>)}</ol>
    {done && <div className="worked-result" role="status"><strong>Result</strong><Markdown>{block.result}</Markdown></div>}
    <div className="worked-actions">
      {!done && <button className="secondary-button" onClick={() => setShown(shown + 1)}>{shown === 0 ? 'Show the first step' : shown < total ? `Show step ${shown + 1} of ${total}` : 'Show the result'}</button>}
      {!done && <button className="text-link" onClick={() => setShown(total + 1)}>Show all</button>}
      {done && <button className="text-link" onClick={() => setShown(0)}>Hide the steps</button>}
    </div>
  </div>;
}
