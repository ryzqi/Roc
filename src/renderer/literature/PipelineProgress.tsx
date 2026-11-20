import type {PipelineStage} from './pipeline-state';

export function PipelineProgress({stages}: {stages: PipelineStage[]}): React.JSX.Element {
  return <ol aria-label="文献处理阶段" className="flex flex-wrap gap-x-4 gap-y-2 text-[length:var(--font-meta-size)]">
    {stages.map(stage => <li key={stage.id} className="flex items-center gap-2">
      <span className="text-muted">{stage.label}</span><span>{stage.state}</span>
    </li>)}
  </ol>;
}
