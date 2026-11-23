import type {PipelineStage} from './pipeline-state';

export function PipelineProgress({stages, selected, onSelect}: {
  stages: PipelineStage[]; selected?: PipelineStage['id'] | null; onSelect: (stage: PipelineStage['id']) => void
}): React.JSX.Element {
  return <ol aria-label="文献处理阶段" className="flex flex-wrap gap-x-1 gap-y-1 text-[length:var(--font-meta-size)]">
    {stages.map((stage, index) => <li key={stage.id} className="flex min-w-0 items-center gap-1">
      {index === 0 ? null : <span aria-hidden="true" className="h-px w-3 shrink-0 bg-line"/>}
      <button type="button" data-testid={`pipeline-stage-${stage.id}`} aria-pressed={selected === stage.id}
        onClick={() => onSelect(stage.id)}
        className="flex min-h-7 flex-wrap items-center gap-x-2 rounded-control px-2 py-1 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] aria-pressed:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring">
        <span className="text-muted">{stage.label}</span><span>{stage.state}</span>
      </button>
    </li>)}
  </ol>;
}
