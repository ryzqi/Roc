import { Lock } from 'lucide-react';
import type { ResearchStageState } from '../../../shared/types';
import { researchStageLabels, researchStageStatusLabels } from './format';
import {
  RESEARCH_STAGE_GROUPS,
  isCurrentStageGroup,
  stageGroupWriteAllowed,
  type ResearchStageGroupId
} from './workflow-rules';

/**
 * The stage bar (P6/T6.2), in the new shell's visual language.
 *
 * Six groups over eleven stages, ported from `research-stage-groups.ts` — the grouping is
 * a product fact, not a layout choice (R17).
 *
 * Three visual rules carry the semantics:
 *
 *   1. **One accent stripe, on the current group only.** MASTER v2 §4 treats the accent
 *      stripe as "this is where you are"; a bar where every step is highlighted says
 *      nothing.
 *   2. **Read-only groups are inert-looking, with the reason in text.** Colour alone may
 *      never carry state (AGENTS.md), so a group that cannot be written to also gets a
 *      lock icon and an explicit 「只读」 note rather than just a dimmer label.
 *   3. **The settings group is never read-only** — configuration is always reachable
 *      (T6.3), which is exactly why `stageGroupWriteAllowed` special-cases it.
 *
 * Selection is a button, not a link: the canvas view and the stage group live in the URL
 * and only the shell writes it (ADR-M05), so this reports the intent upward.
 */

export type StageBarProps = {
  stages: readonly ResearchStageState[];
  currentStage: ResearchStageState['stage'];
  currentGroup: ResearchStageGroupId;
  selectedGroup: ResearchStageGroupId;
  onSelectGroup: (groupId: ResearchStageGroupId) => void;
  /** Archived projects are read-only, so every group reads as read-only. */
  projectWritable: boolean;
};

export function StageBar({
  stages,
  currentStage,
  currentGroup,
  selectedGroup,
  onSelectGroup,
  projectWritable
}: StageBarProps): React.JSX.Element {
  return (
    <nav
      aria-label="研究阶段"
      data-testid="workflow-stage-bar"
      data-current-group={currentGroup}
      className="flex flex-wrap items-stretch gap-1 border-b border-line bg-bg-soft px-2 py-1.5"
    >
      {RESEARCH_STAGE_GROUPS.map((group) => {
        const isCurrent = isCurrentStageGroup(group.id, currentStage);
        const groupStages = stages.filter((stage) => group.stages.includes(stage.stage));
        const settled = groupStages.filter((stage) => stage.status === 'completed').length;
        const status = groupStages.find((stage) => stage.stage === currentStage);
        const writeAllowed =
          projectWritable && stageGroupWriteAllowed(group.id, currentStage, status?.status);
        const readOnlyNote =
          group.id === 'settings'
            ? '项目设置始终可写'
            : writeAllowed
              ? null
              : isCurrent
                ? '当前阶段已结束或未开放，暂不可写'
                : '非当前阶段：只读';
        const selected = group.id === selectedGroup;
        return (
          <button
            key={group.id}
            type="button"
            data-testid={`workflow-stage-group-${group.id}`}
            data-current={isCurrent ? 'true' : 'false'}
            data-readonly={writeAllowed ? 'false' : 'true'}
            data-selected={selected ? 'true' : 'false'}
            aria-current={isCurrent ? 'step' : undefined}
            onClick={() => onSelectGroup(group.id)}
            className={[
              'relative flex min-w-0 flex-col items-start gap-0.5 rounded-control border px-2.5 py-1 text-left transition-colors duration-[var(--duration-fast)]',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              selected
                ? 'border-line-strong bg-surface'
                : 'border-transparent hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]',
              isCurrent ? 'pl-3.5' : '',
              writeAllowed ? '' : 'opacity-70'
            ].join(' ')}
          >
            {isCurrent ? (
              <span
                aria-hidden="true"
                className="absolute top-1 bottom-1 left-1 w-[var(--stripe-width)] rounded-full bg-accent"
              />
            ) : null}
            <span className="flex items-center gap-1">
              <span className={isCurrent ? 'text-ink' : 'text-muted'}>{group.label}</span>
              {writeAllowed ? null : <Lock size={10} aria-hidden="true" className="text-subtle" />}
            </span>
            <span className="flex items-center gap-1.5 text-[var(--font-micro-size)] text-subtle">
              {isCurrent ? <span className="text-accent">当前阶段</span> : null}
              <span>{groupStages.length === 0 ? '配置' : `${settled}/${groupStages.length}`}</span>
              {status === undefined ? null : <span>{researchStageStatusLabels[status.status]}</span>}
            </span>
            {readOnlyNote === null ? null : (
              <span className="text-[var(--font-micro-size)] text-subtle">{readOnlyNote}</span>
            )}
            {groupStages.length === 0 ? null : (
              <span className="text-[var(--font-micro-size)] text-subtle">
                {groupStages.map((stage) => researchStageLabels[stage.stage]).join(' · ')}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
