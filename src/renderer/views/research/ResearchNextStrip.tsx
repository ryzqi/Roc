import type { ResearchNextStripModel, ResearchStripCommand } from './research-next-strip';

export function ResearchNextStrip({
  disabled,
  model,
  onCommand
}: {
  disabled: boolean;
  model: ResearchNextStripModel;
  onCommand: (command: ResearchStripCommand) => void;
}): React.JSX.Element {
  return (
    <div className="research-next-strip" data-testid="research-next-strip">
      {model.status !== null ? <p className="research-next-strip__status" data-testid="research-next-action">{model.status}</p> : null}
      {model.summary !== null ? <p className="research-next-strip__summary" data-testid="research-next-summary">{model.summary}</p> : null}
      <div className="research-next-strip__actions">
        {model.secondary.map((button) => (
          <button
            className="ui-button ui-button--secondary"
            data-testid={button.testId}
            disabled={disabled}
            key={button.testId}
            type="button"
            onClick={() => onCommand(button.command)}
          >
            {button.label}
          </button>
        ))}
        {model.primary === null ? null : (
          <button
            className="ui-button ui-button--primary"
            data-testid={model.primary.testId}
            disabled={disabled}
            type="button"
            onClick={() => onCommand(model.primary!.command)}
          >
            <span data-testid="research-next-action">{model.primary.label}</span>
          </button>
        )}
      </div>
    </div>
  );
}
