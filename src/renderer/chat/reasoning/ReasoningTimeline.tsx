import { MarkdownView } from '../markdown-view';
import { getStepTypeColor, getStepTypeLabel, type ReasoningStep } from './reasoning-parser';

type ReasoningTimelineProps = {
  steps: ReasoningStep[];
};

export function ReasoningTimeline({ steps }: ReasoningTimelineProps): React.JSX.Element {
  return (
    <div className="reasoning-timeline">
      {steps.map((step) => {
        const color = getStepTypeColor(step.type);
        return (
          <div className="reasoning-step" data-type={step.type} key={step.id}>
            <div className="step-marker" style={{ background: color }} aria-hidden="true" />
            <div className="step-content">
              <div className="step-header">
                <span className="step-type-label" style={{ color }}>
                  {getStepTypeLabel(step.type)}
                </span>
                <span className="step-line-number">#{step.lineNumber}</span>
              </div>
              <div className="step-body">
                <MarkdownView text={step.content} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
