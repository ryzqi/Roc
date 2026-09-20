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
