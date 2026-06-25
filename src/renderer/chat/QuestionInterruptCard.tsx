import type { ChatPendingQuestion } from '../../shared/types';

type QuestionInterruptCardProps = {
  question: ChatPendingQuestion;
};

export function QuestionInterruptCard({ question }: QuestionInterruptCardProps): React.JSX.Element {
  return (
    <div className="chat-question-card" data-testid="chat-question-card">
      <header className="chat-question-card__head">等待回复</header>
      <p className="chat-question-card__question">{question.question}</p>
      {question.context === undefined ? null : <p className="chat-question-card__context">{question.context}</p>}
      {question.suggestedResponses === undefined || question.suggestedResponses.length === 0 ? null : (
        <ul className="chat-question-card__suggestions">
          {question.suggestedResponses.map((response) => (
            <li key={response}>{response}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
