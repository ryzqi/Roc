import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle, PauseCircle, Settings2 } from 'lucide-react';
import type { ResearchServiceEntry, ResearchServiceStatus } from './research-services';
import { researchStageLabels } from './research-workflow';

const STATUS_ICON: Record<ResearchServiceStatus, typeof CircleCheck> = {
  available: CircleCheck,
  needs_setup: Settings2,
  running: LoaderCircle,
  blocked: PauseCircle,
  failed: CircleAlert,
  disabled: CircleDashed
};

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
            <span className="research-service-status" data-status={service.status}>
              {(() => {
                const Icon = STATUS_ICON[service.status];
                return <Icon aria-hidden="true" size={14} />;
              })()}
              <em>{service.statusLabel}</em>
            </span>
            <strong>{service.label}</strong>
            <span>{service.description}</span>
            {service.stage === null ? null : <em>{researchStageLabels[service.stage]}</em>}
          </button>
        ))}
      </div>
    </section>
  );
}
