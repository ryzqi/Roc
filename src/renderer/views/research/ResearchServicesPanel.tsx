import type { ResearchServiceEntry } from './research-services';
import { researchStageLabels } from './research-workflow';

export function ResearchServicesPanel({
  onOpenService,
  services
}: {
  onOpenService: (service: ResearchServiceEntry) => void;
  services: ResearchServiceEntry[];
}): React.JSX.Element {
  return (
    <section className="research-services" data-testid="research-services">
      <div className="research-section-label">科研服务</div>
      <div className="research-service-list">
        {services.map((service) => (
          <button
            className="research-service-row"
            data-status={service.status}
            data-testid={`research-service-${service.id}`}
            key={service.id}
            type="button"
            onClick={() => onOpenService(service)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                return;
              }
              const buttons = [...event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.research-service-row') ?? []];
              const index = buttons.indexOf(event.currentTarget);
              const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)];
              if (next === undefined) {
                return;
              }
              event.preventDefault();
              next.focus();
            }}
          >
            <strong>{service.label}</strong>
            <span>{service.description}</span>
            <em>{service.statusLabel}{service.stage === null ? '' : ` · ${researchStageLabels[service.stage]}`}</em>
          </button>
        ))}
      </div>
    </section>
  );
}
