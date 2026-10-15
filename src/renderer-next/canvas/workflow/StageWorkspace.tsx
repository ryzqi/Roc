import { Database, Library } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWorkspaceScope } from '../../app/workspace-scope';
import { EmptyState } from '../../shell/EmptyState';
import { ErrorBar } from '../../shell/ErrorBar';
import {
  RESEARCH_STAGE_GROUPS,
  STAGE_GROUP_IDS,
  STAGE_TAB_IDS,
  currentArtifacts,
  currentStageState,
  latestParentRun,
  stageGroupForStage,
  stageGroupWriteAllowed,
  type ResearchStageGroupId,
  type ResearchStageTab
} from './workflow-rules';
import { indexPhaseLabel, researchStageStatusLabels } from './format';
import { ArtifactPanel } from './ArtifactPanel';
import { EvidenceClaimsPanel } from '../../production/EvidenceClaimsPanel';
import { ExperimentsPanel } from '../../production/ExperimentsPanel';
import { ExportPanel } from '../../production/ExportPanel';
import { FiguresPanel } from '../../production/FiguresPanel';
import { IdeasPanel } from '../../production/IdeasPanel';
import { LatexPanel } from '../../production/LatexPanel';
import { ManuscriptPanel } from '../../production/ManuscriptPanel';
import { PoliciesPanel } from '../../production/PoliciesPanel';
import { TemplatePanel } from '../../production/TemplatePanel';
import { StageBar } from './StageBar';
import { StageRunPanel } from './StageRunPanel';
import { useWorkflow } from './workflow-scope';

/**
 * 阶段工作区 (P6/T6.3).
 *
 * Layout per the plan: a narrow context rail (190px) + the main panel + an optional right
 * rail (200px) that carries the stage's run state and the gate sentence. Nothing here
 * *advances* the workflow — the flow buttons live on 总览's next strip (T6.3), so there is
 * exactly one place that can start, submit or cancel a stage.
 *
 * The rail lists the group's own tabs (ported grouping — R17) plus two **P6-owned** entries
 * that apply to every group: 阶段运行 (T6.4) and 工件与生产输入 (T6.5). Panels owned by later
 * phases are named as such instead of being drawn as empty shells, because a panel that
 * looks empty reads as "no data" rather than "not built yet".
 *
 * Read-only rules come from `stageGroupWriteAllowed` and never from a local condition: the
 * current group is writable while its stage is live, every other group is read-only, and the
 * settings group is always writable. That is the same predicate the stage bar renders, so the
 * two surfaces cannot disagree — and the archived project is read-only everywhere.
 */

type TabId = ResearchStageTab | 'runs' | 'artifacts' | 'claims' | 'template';

const P6_TABS: Array<{ id: TabId; label: string }> = [
  { id: 'runs', label: '阶段运行' },
  { id: 'artifacts', label: '工件与生产输入' }
];

/**
 * Panels that apply to every stage group (P7's 证据与主张 is project-wide: evidence and claims
 * are attached to the manuscript artifact, not to one stage's inputs).
 */
const P7_TABS: Array<{ id: TabId; label: string }> = [
  { id: 'claims', label: '证据与主张' },
  { id: 'template', label: '模板包' }
];

/**
 * Every `ResearchStageTab` now renders a real panel (P7 completed the set), so there is no
 * "owned by a later phase" table any more — the only tab without a dedicated surface is
 * `embedding`, whose *write* path belongs to the settings centre (B23 / MASTER v2 §7) and which
 * therefore shows the read-only summary next to the policy editor.
 */

export function StageWorkspace({ stageHint }: { stageHint: string | null }): React.JSX.Element {
  const scope = useWorkspaceScope();
  const store = useWorkflow();
  const workflow = store.workflow;
  const currentGroup = workflow === null ? 'discover' : stageGroupForStage(workflow.currentStage);
  /**
   * The route's `?stage=` is the URL contract's single stage field, and it can hold either a
   * group id or a tab id (that is what `appRouteToSearch` writes: the tab only when it is not
   * the group's default). So the hint is resolved the same way the parser resolves it — tab
   * first, then group — and the group is derived from the tab it belongs to.
   */
  const requestedTab: ResearchStageTab | null =
    stageHint !== null && STAGE_TAB_IDS.has(stageHint as ResearchStageTab) ? (stageHint as ResearchStageTab) : null;
  const groupId: ResearchStageGroupId =
    requestedTab !== null
      ? (RESEARCH_STAGE_GROUPS.find((item) => item.tabs.some((entry) => entry.id === requestedTab))?.id ?? currentGroup)
      : stageHint !== null && STAGE_GROUP_IDS.has(stageHint as ResearchStageGroupId)
        ? (stageHint as ResearchStageGroupId)
        : currentGroup;
  const group = RESEARCH_STAGE_GROUPS.find((item) => item.id === groupId) ?? RESEARCH_STAGE_GROUPS[0]!;
  const [tab, setTab] = useState<TabId>(() => requestedTab ?? group.tabs[0]?.id ?? 'runs');


  // Switching groups (from the stage bar above, or a deep link) must move the panel with it — and
  // it re-reads the workflow, because the artifact-scoped panels (构思 / 正文 / 工件) depend on a
  // list that only this store owns. Same reasoning as the polling rule: ask again when the thing
  // you are looking at changes.
  const refreshWorkflow = store.refresh;
  useEffect(() => {
    setTab(requestedTab ?? group.tabs[0]?.id ?? 'runs');
    refreshWorkflow();
  }, [requestedTab, group, refreshWorkflow]);

  // Same guard order as 总览: a null workflow during a project switch is loading, not a failure.
  if (store.status === 'error') {
    return (
      <div className="flex h-full flex-col gap-2 p-4" data-testid="workflow-stage-error">
        <ErrorBar
          error={{
            level: 'page',
            message: store.error ?? '读取阶段状态失败',
            retry: store.refresh,
            actionLabel: 'research.workflow.get'
          }}
        />
      </div>
    );
  }
  if (workflow === null) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="workflow-stage-loading">
        <EmptyState tone="loading" title="正在读取阶段状态" />
      </div>
    );
  }

  const current = currentStageState(workflow);
  const isCurrent = groupId === currentGroup;
  const writeAllowed = scope.writable && stageGroupWriteAllowed(groupId, workflow.currentStage, current.status);
  const tabs: Array<{ id: TabId; label: string }> = [...group.tabs, ...P6_TABS, ...P7_TABS];
  const activeTab = tabs.some((item) => item.id === tab) ? tab : (tabs[0]?.id ?? 'runs');
  const latest = latestParentRun(store.runs, workflow);
  const stageArtifacts = currentArtifacts(store.artifacts, workflow);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflow-stage-workspace" data-group={groupId}>
      <StageBar
        stages={workflow.stages}
        currentStage={workflow.currentStage}
        currentGroup={currentGroup}
        selectedGroup={groupId}
        projectWritable={scope.writable}
        onSelectGroup={(groupId) => {
          // 项目设置组是**阶段工作区的一个组**（里面有「嵌入配置」与「阶段模型」两个 tab），
          // 不是设置中心弹窗。P6 时这里指向 `openSettings()`，因为那一组还没有面板；P7 加了面板
          // 之后那条映射就等于把两个真面板藏起来（只能手改 URL 到达）——探针实测发现。
          // 设置中心仍然从窗口头部与面板内的「打开设置中心」进入。
          scope.openStage(groupId);
        }}
      />
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <h1 className="text-ink text-[var(--font-h2-size)]" data-testid="workflow-stage-workspace-title">
          {group.label}
        </h1>
        <span className="text-subtle text-[var(--font-meta-size)]" data-testid="workflow-stage-workspace-current">
          当前阶段：{workflow.currentStage} · {researchStageStatusLabels[current.status]}
        </span>
        {isCurrent ? (
          <span className="rounded-control bg-accent-soft px-1.5 py-0.5 text-[var(--font-micro-size)] text-[var(--st-info)]">
            当前阶段组
          </span>
        ) : (
          <span
            className="rounded-control border border-line px-1.5 py-0.5 text-[var(--font-micro-size)] text-subtle"
            data-testid="workflow-stage-workspace-readonly"
          >
            只读：非当前阶段组
          </span>
        )}
        {writeAllowed ? null : (
          <span className="text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="workflow-stage-workspace-write-state">
            {scope.writable ? '该阶段组当前不可写' : '项目已归档，仅可阅读'}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="阶段面板"
          className="flex w-[190px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-2"
          data-testid="workflow-stage-tabs"
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === activeTab ? 'true' : undefined}
              data-testid={`workflow-stage-tab-${item.id}`}
              onClick={() => setTab(item.id)}
              className={[
                'rounded-control px-2 py-1 text-left',
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                item.id === activeTab
                  ? 'bg-[var(--overlay-active)] text-ink'
                  : 'text-muted hover:bg-[var(--overlay-hover)] hover:text-ink'
              ].join(' ')}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            data-testid="workflow-stage-open-literature"
            onClick={() => scope.openView('literature')}
            className="mt-1 rounded-control px-2 py-1 text-left text-muted hover:bg-[var(--overlay-hover)] hover:text-ink"
          >
            打开文献中心
          </button>
          <button
            type="button"
            data-testid="workflow-stage-open-settings"
            onClick={scope.openSettings}
            className="rounded-control px-2 py-1 text-left text-muted hover:bg-[var(--overlay-hover)] hover:text-ink"
          >
            打开设置中心
          </button>
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-3">
          <MainPanel tab={activeTab} groupId={groupId} writeAllowed={writeAllowed} />
        </div>

        <aside
          className="hidden w-[200px] shrink-0 flex-col gap-2 overflow-y-auto border-l border-line p-3 xl:flex"
          aria-label="阶段运行摘要"
          data-testid="workflow-stage-rail"
        >
          <span className="text-subtle text-[var(--font-micro-size)]">当前阶段运行</span>
          {latest === null ? (
            <p className="text-muted text-[var(--font-meta-size)]">还没有运行记录。</p>
          ) : (
            <div className="flex flex-col gap-0.5 text-[var(--font-meta-size)]">
              <span className="text-ink">{latest.status}</span>
              <span className="text-subtle">角色 {latest.role}</span>
              <span className="text-subtle">
                产物 {stageArtifacts.length} · 索引 {indexPhaseLabel(store.indexStatus)}
              </span>
            </div>
          )}
          {current.lastError === null ? null : (
            <p className="text-[var(--st-bad)] text-[var(--font-micro-size)]" data-testid="workflow-stage-rail-error">
              {current.lastError}
            </p>
          )}
          <p className="text-subtle text-[var(--font-micro-size)]">
            流程动作在总览的「下一步」里：阶段工作区只读，避免两处都能推进阶段。
          </p>
        </aside>
      </div>
    </div>
  );
}

/**
 * The stage's own policy and the review cycle (T6.4: 「`research.workflow.policies` /
 * `reviewCycle` / `role`：阶段模型与审稿循环的读取（编辑在 P7/P8）」).
 *
 * Read-only on purpose — the write path (`savePolicy`) is P7/P8's, and showing the effective
 * tier/model/limits is exactly what an operator needs before starting a run that will honour
 * them. Without this the policies `research.workflow.policies` returns were fetched and dropped,
 * which is worse than not fetching them: it looks like the stage has no configuration.
 */
function StagePolicyFacts(): React.JSX.Element {
  const store = useWorkflow();
  const policy = store.policies.find((entry) => entry.stage === store.workflow?.currentStage) ?? null;
  const cycle = store.reviewCycle;
  return (
    <section className="flex flex-col gap-1 rounded-card border border-line bg-surface px-3 py-2" data-testid="workflow-stage-policy">
      <span className="text-subtle text-[var(--font-micro-size)]">
        阶段策略（research.workflow.policies / reviewCycle，编辑在 P7/P8）
      </span>
      {policy === null ? (
        <p className="text-muted text-[var(--font-meta-size)]" role="status">
          后端没有返回本阶段的策略记录。
        </p>
      ) : (
        <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-[var(--font-micro-size)]">
          <div className="flex gap-1.5">
            <dt className="text-subtle">档位</dt>
            <dd className="text-ink" data-testid="workflow-stage-policy-tier">
              {policy.tier}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-subtle">模型</dt>
            <dd className="text-ink" data-testid="workflow-stage-policy-model">
              {policy.model.kind === 'app_default' ? '应用默认' : `${policy.model.providerId}:${policy.model.modelId}`}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-subtle">步数上限</dt>
            <dd className="text-ink">{policy.maxSteps}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-subtle">超时</dt>
            <dd className="text-ink">{Math.round(policy.timeoutMs / 1000)} 秒</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-subtle">角色</dt>
            <dd className="text-ink">{store.role?.role ?? '未读取'}</dd>
          </div>
        </dl>
      )}
      {cycle === null ? null : (
        <p className="text-muted text-[var(--font-micro-size)]" data-testid="workflow-review-cycle">
          审稿循环：{cycle.status} · 第 {cycle.revisionRound + 1} 轮 · 稿件 {cycle.manuscriptArtifactId}
        </p>
      )}
    </section>
  );
}

function MainPanel({
  tab,
  groupId,
  writeAllowed
}: {
  tab: TabId;
  groupId: ResearchStageGroupId;
  writeAllowed: boolean;
}): React.JSX.Element {
  const store = useWorkflow();

  if (tab === 'artifacts') {
    return <ArtifactPanel groupId={groupId} />;
  }
  if (tab === 'claims') {
    return <EvidenceClaimsPanel />;
  }
  if (tab === 'ideas') {
    return <IdeasPanel />;
  }
  if (tab === 'manuscript') {
    return <ManuscriptPanel />;
  }
  if (tab === 'policies') {
    return <PoliciesPanel />;
  }
  if (tab === 'experiments') {
    return <ExperimentsPanel />;
  }
  if (tab === 'figures') {
    return <FiguresPanel />;
  }
  if (tab === 'production') {
    return <ExportPanel />;
  }
  if (tab === 'template') {
    return <TemplatePanel />;
  }
  if (tab === 'editor') {
    // 文稿：工作区里的 .tex/.bib 真文件编辑（编译在下面的模板面板里）。
    return <LatexPanel />;
  }
  if (tab === 'runs') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <section className="flex flex-col gap-1 rounded-card border border-line bg-surface px-3 py-2.5">
          <label htmlFor="workflow-stage-instruction" className="text-subtle text-[var(--font-micro-size)]">
            阶段指令（可选）
          </label>
          <textarea
            id="workflow-stage-instruction"
            data-testid="workflow-stage-instruction"
            value={store.instruction}
            disabled={!writeAllowed}
            rows={3}
            placeholder={
              writeAllowed
                ? '留空就用项目研究目标作为本次阶段运行的指令。'
                : '非当前阶段组不可写：阶段指令只在当前阶段组可编辑。'
            }
            onChange={(event) => store.setInstruction(event.target.value)}
            className="w-full resize-y rounded-control border border-line bg-bg px-2 py-1 text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
          <p className="text-subtle text-[var(--font-micro-size)]">
            这段文字会在总览点主操作时作为 instruction 发给 research.workflow.startRun。
          </p>
        </section>
        <StagePolicyFacts />
        <section className="flex flex-col gap-1.5">
          <span className="text-subtle text-[var(--font-micro-size)]">
            运行历史（research.workflow.listRuns，最多 50 条）
          </span>
          <StageRunPanel
            runs={store.runs}
            artifactTitles={
              new Map(store.artifacts.map((artifact) => [artifact.id, artifact.title]))
            }
          />
        </section>
      </div>
    );
  }
  if (tab === 'library' || tab === 'knowledge') {
    return (
      <section className="flex flex-col gap-2" data-testid="workflow-stage-literature-panel">
        <p className="flex items-center gap-1.5 text-ink">
          <Library size={13} aria-hidden="true" />
          {tab === 'library' ? '文献库' : '知识库'}
        </p>
        <p className="text-muted text-[var(--font-meta-size)]">
          文献库、阅读、RAG 与知识库（含图谱）都在文献中心里，共用同一个库与同一次选择。
          这里只报告本项目的索引状态，不重复造一份列表。
        </p>
        <dl className="flex flex-col gap-0.5 text-[var(--font-meta-size)]">
          <div className="flex gap-2">
            <dt className="text-subtle">索引阶段</dt>
            <dd className="text-ink" data-testid="workflow-stage-index-phase">
              {indexPhaseLabel(store.indexStatus)}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-subtle">文件</dt>
            <dd className="text-ink">
              {store.indexStatus === null
                ? (store.indexUnavailableReason ?? '未读取')
                : `共 ${store.indexStatus.counts.total} · 就绪 ${store.indexStatus.counts.ready} · 排队 ${store.indexStatus.counts.queued} · 失败 ${store.indexStatus.counts.failed}`}
            </dd>
          </div>
        </dl>
      </section>
    );
  }
  if (tab === 'embedding') {
    // Read-only: `research.embedding.save` needs a plaintext key (B23) and the settings centre
    // owns index configuration (MASTER v2 §7). The summary lives with the policy editor so the
    // settings group has one "project configuration" surface.
    return <PoliciesPanel />;
  }
  // Defence in depth: the `TabId` union is covered above, so this is only reachable if a tab is
  // added without a panel. It names the tab instead of rendering an empty shell.
  return (
    <EmptyState
      icon={Database}
      title={`${tab}（没有面板）`}
      description={`「${groupId}」的 ${tab} 标签没有对应面板：这是接线缺口，不是空数据。`}
      testId={`workflow-stage-panel-missing-${tab}`}
    />
  );
}
