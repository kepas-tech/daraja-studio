import { useState, type ReactNode } from 'react';
import { Button } from './Button';
import { TaskCard } from './TaskCard';
import { copy } from '../copy/en';

export interface QuestionStep {
  key: string;
  question: string;
  hint?: string;
  /** May be left empty: Next reads "Skip" while the answer is empty. */
  optional?: boolean;
  /** Whether the current answer lets the person move on. */
  valid: boolean;
  /** Whether the answer is empty, for the Skip label; defaults to `!valid`. */
  empty?: boolean;
  render: () => ReactNode;
}

/**
 * One question per screen. The page keeps every value and setter; this only decides which field
 * is on screen, so the page's own review and submit paths stay exactly as they were.
 */
export function Questionnaire({ steps, onDone, onCancel, intro, footerStart, doneLabel, busy = false }: { steps: QuestionStep[]; onDone: () => void; onCancel?: () => void; intro?: ReactNode; footerStart?: ReactNode; /** The last question's button, e.g. Review or Save. */ doneLabel?: string; busy?: boolean }) {
  const [i, setI] = useState(0);
  const at = Math.min(i, steps.length - 1);
  const step = steps[at]!;
  const empty = step.empty ?? !step.valid;
  const last = at + 1 >= steps.length;
  const canGo = !busy && (step.valid || (step.optional === true && empty));
  const next = () => { if (!canGo) return; if (at + 1 >= steps.length) onDone(); else setI(at + 1); };
  const back = () => { if (at === 0) onCancel?.(); else setI(at - 1); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); next(); }}>
      <TaskCard
        intro={intro}
        footerStart={(at > 0 || onCancel) ? <Button type="button" variant="secondary" onClick={back}>{copy.questionnaire.back}</Button> : footerStart}
        footer={<Button type="submit" disabled={!canGo}>{last && doneLabel ? doneLabel : step.optional && empty ? copy.questionnaire.skip : copy.questionnaire.next}</Button>}
      >
        <p className="text-sm text-muted">{copy.questionnaire.of(at + 1, steps.length)}</p>
        <h2 className="text-xl font-semibold">{step.question}</h2>
        <div key={step.key}>{step.render()}</div>
        {step.hint && <p className="text-sm text-muted">{step.hint}</p>}
      </TaskCard>
    </form>
  );
}
