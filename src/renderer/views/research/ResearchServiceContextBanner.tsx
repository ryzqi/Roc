import type { ResearchServiceContext } from './research-services';
import { researchStageLabels } from './research-workflow';

export function ResearchServiceContextBanner({
  context
}: {
  context: ResearchServiceContext | null | undefined;
}): React.JSX.Element | null {
  if (context === null || context === undefined || context.projectTitle === null) {
    return null;
  }
  const stage = context.currentStage === null ? null : researchStageLabels[context.currentStage];
  return (
    <p className="research-service-context" data-testid="research-service-context">
      当前项目 {context.projectTitle}
      {stage === null ? '' : ` · ${stage}`}
      {context.workspacePath === null ? '' : ` · ${context.workspacePath}`}
    </p>
  );
}
