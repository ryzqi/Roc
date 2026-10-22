import { MessageCircleQuestion } from 'lucide-react';
import type { ChatPendingQuestion } from '../../../shared/types';

/**
 * HITL question card (T4.4), ported from `chat/QuestionInterruptCard.tsx`.
 *
 * This card is **display only** on purpose: the legacy one was too. The candidate
 * answers are hints for what the user should type, not buttons, because the answer is
 * free text that goes through the composer and back via `chat.resumeRun`. Making them
 * clickable would imply a fixed choice set the backend does not model.
 *
 * The run is suspended until an answer arrives, so the card is a visible explanation of
 * why nothing is happening — it never offers a way to dismiss it.
 */
export function QuestionInterruptCard({ question }: { question: ChatPendingQuestion }): React.JSX.Element {
  return (
    <section
      className="my-2 rounded-card border border-[var(--st-info-line)] bg-surface px-3 py-2"
      data-testid="assistant-question-card"
    >
      <header className="mb-1 flex items-center gap-1.5 text-[var(--st-info)] text-[var(--font-micro-size)]">
        <MessageCircleQuestion size={12} aria-hidden="true" />
        等待回复
      </header>
      <p className="whitespace-pre-wrap text-ink text-[var(--font-read-size)]">{question.question}</p>
      {question.context === undefined ? null : (
        <p className="mt-1 whitespace-pre-wrap text-muted text-[var(--font-meta-size)]">{question.context}</p>
      )}
      {question.suggestedResponses === undefined || question.suggestedResponses.length === 0 ? null : (
        <>
          <p className="mt-2 text-subtle text-[var(--font-micro-size)]">可参考的回答：</p>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {question.suggestedResponses.map((response) => (
              <li key={response} className="text-muted text-[var(--font-meta-size)]">
                · {response}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
