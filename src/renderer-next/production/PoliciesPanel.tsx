import { useEffect, useMemo, useState } from 'react';
import { Settings2 } from 'lucide-react';
import type { ResearchStagePolicy } from '../../shared/types';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { ErrorBar } from '../shell/ErrorBar';
import { formatBeijingDateTime } from '../shared/format';
import { useWorkflow } from '../canvas/workflow/workflow-scope';
import { researchStageLabels } from '../canvas/workflow/format';
import { policyChanged } from './production-rules';
import { listEmbeddingConfigs, saveStagePolicy, getSettings } from './production-store';
import {
  FieldLabel,
  InlineHint,
  KeyValue,
  PanelSection,
  primaryButtonClass,
  selectClass,
  textInputClass
} from './panel-shell';

/**
 * 阶段模型策略 (T7.8) 与嵌入配置摘要 (T7.9).
 *
 * Two decisions are baked into this panel, both from earlier phases' rulings rather than from
 * the P7 task text:
 *
 *  1. **Policies are edited here** (the project's 项目设置 group is the authority for this
 *     project's stages). `savePolicy` takes the *whole* policy object, so the editor loads the
 *     current one and sends it back with the changed fields — never a partial patch.
 *  2. **The embedding configuration is read-only here.** P0/P5 fixed the settings centre as the
 *     single source of truth for index/embedding configuration (MASTER v2 §7; capability-matrix
 *     §7 files `research.embedding.save` under P8), and `saveEmbeddingConfig` requires a
 *     **plaintext apiKey** (B23), which must not enter renderer state. So this panel shows the
 *     effective config and links to the settings centre instead of growing a second writer.
 */

export function PoliciesPanel({ writeAllowed }: { writeAllowed?: boolean }): React.JSX.Element {
  /**
   * Whether this panel may write.
   *
   * The stage workspace decides it (`scope.writable && stageGroupWriteAllowed(...)`) and passes it
   * down, because the *stage-group* half of the rule exists only in the renderer: the backend
   * refuses artifact writes for a non-current stage (`requireEditableStage`) but happily starts an
   * experiment run or a template compile, so a panel that gated on the archived flag alone would
   * offer live buttons behind a 「只读：非当前阶段组」 badge. `undefined` keeps the route-rendered
   * case (the `latex` view) working with the project-level predicate.
   */
  const scope = useWorkspaceScope();
  const canWrite = writeAllowed ?? scope.writable;
  const workflow = useWorkflow();
  const projectId = scope.projectId ?? '';
  const currentStage = workflow.workflow?.currentStage ?? null;

  const [selectedStage, setSelectedStage] = useState<ResearchStagePolicy['stage'] | null>(currentStage);
  useEffect(() => {
    setSelectedStage(currentStage);
  }, [currentStage]);

  const policy = useMemo(
    () => workflow.policies.find((entry) => entry.stage === selectedStage) ?? null,
    [workflow.policies, selectedStage]
  );

  const settings = useAsyncResource(
    'production-settings',
    () => getSettings(scope.client),
    { label: '读取模型设置' }
  );
  const embeddings = useAsyncResource(
    'production-embeddings',
    () => listEmbeddingConfigs(scope.client),
    { label: '读取嵌入配置' }
  );

  /** Local edit state, reset whenever the selected policy changes. */
  const [draft, setDraft] = useState<ResearchStagePolicy | null>(null);
  useEffect(() => {
    setDraft(policy === null ? null : { ...policy });
  }, [policy]);

  const save = useAsyncAction((next: ResearchStagePolicy) => saveStagePolicy(scope.client, next), {
    label: '保存阶段策略'
  });

  if (scope.projectId === null || selectedStage === null) {
    return <InlineHint text="未进入项目。" />;
  }

  const modelOptions = (settings.data?.providers ?? []).flatMap((provider) =>
    provider.models
      .filter((model) => model.enabled)
      .map((model) => ({ key: `${provider.id}:${model.id}`, label: `${model.displayName} · ${provider.name}` }))
  );
  const currentModelKey =
    draft?.model.kind === 'model' ? `${draft.model.providerId}:${draft.model.modelId}` : '';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-testid="production-policies">
      <PanelSection
        title="阶段模型策略"
        hint="research.workflow.policies / savePolicy（整对象保存）"
        testId="production-policy-editor"
      >
        <label className="flex w-[220px] flex-col gap-0.5">
          <FieldLabel text="阶段" />
          <select
            data-testid="production-policy-stage"
            value={selectedStage}
            onChange={(event) => setSelectedStage(event.target.value as ResearchStagePolicy['stage'])}
            className={selectClass}
          >
            {(workflow.workflow?.stages ?? []).map((stage) => (
              <option key={stage.stage} value={stage.stage}>
                {researchStageLabels[stage.stage]}
                {stage.stage === currentStage ? '（当前）' : ''}
              </option>
            ))}
          </select>
        </label>

        {draft === null ? (
          <InlineHint text="后端没有返回这个阶段的策略记录。" testId="production-policy-missing" />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex w-[150px] flex-col gap-0.5">
                <FieldLabel text="档位" />
                <select
                  data-testid="production-policy-tier"
                  value={draft.tier}
                  disabled={!canWrite}
                  onChange={(event) => setDraft({ ...draft, tier: event.target.value as ResearchStagePolicy['tier'] })}
                  className={selectClass}
                >
                  <option value="fast">fast</option>
                  <option value="balanced">balanced</option>
                  <option value="deep">deep</option>
                </select>
              </label>
              <label className="flex min-w-[240px] flex-1 flex-col gap-0.5">
                <FieldLabel text="模型（应用默认或指定）" />
                <select
                  data-testid="production-policy-model"
                  value={currentModelKey}
                  disabled={!canWrite}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === '') {
                      setDraft({ ...draft, model: { kind: 'app_default' } });
                      return;
                    }
                    const [providerId, ...rest] = value.split(':');
                    setDraft({ ...draft, model: { kind: 'model', providerId: providerId ?? '', modelId: rest.join(':') } });
                  }}
                  className={selectClass}
                >
                  <option value="">应用默认模型</option>
                  {modelOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex w-[130px] flex-col gap-0.5">
                <FieldLabel text="步数上限 (2–100)" />
                <input
                  type="number"
                  min={2}
                  max={100}
                  data-testid="production-policy-steps"
                  value={draft.maxSteps}
                  disabled={!canWrite}
                  onChange={(event) => setDraft({ ...draft, maxSteps: Number(event.target.value) })}
                  className={textInputClass}
                />
              </label>
              <label className="flex w-[150px] flex-col gap-0.5">
                <FieldLabel text="超时毫秒 (1s–600s)" />
                <input
                  type="number"
                  min={1000}
                  max={600000}
                  step={1000}
                  data-testid="production-policy-timeout"
                  value={draft.timeoutMs}
                  disabled={!canWrite}
                  onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })}
                  className={textInputClass}
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="production-policy-save"
                disabled={!canWrite || save.pending || policy === null || !policyChanged(draft, policy)}
                onClick={() => {
                  void save.run(draft).then((saved) => {
                    if (saved !== null) {
                      workflow.refresh();
                    }
                  });
                }}
                className={primaryButtonClass}
              >
                保存策略
              </button>
              {policy !== null && policyChanged(draft, policy) ? null : (
                <span className="text-subtle text-[var(--font-micro-size)]">没有改动</span>
              )}
            </div>
            {save.error === null ? null : <InlineHint text={save.error} testId="production-policy-error" />}
          </>
        )}
      </PanelSection>

      <PanelSection title="审稿循环" hint="research.workflow.reviewCycle（只读）" testId="production-review-cycle">
        {workflow.reviewCycle === null ? (
          <InlineHint text="本项目还没有审稿循环（进入审稿阶段后才有）。" />
        ) : (
          <dl className="flex flex-col gap-0.5">
            <KeyValue label="状态" value={workflow.reviewCycle.status} />
            <KeyValue label="轮次" value={`第 ${workflow.reviewCycle.revisionRound + 1} 轮`} />
            <KeyValue label="稿件工件" value={workflow.reviewCycle.manuscriptArtifactId} />
            <KeyValue label="来源工件" value={workflow.reviewCycle.originArtifactId} />
            <KeyValue label="审稿意见" value={`${workflow.reviewCycle.reportArtifactIds.length} 份`} />
            <KeyValue label="更新于" value={formatBeijingDateTime(workflow.reviewCycle.updatedAt)} />
          </dl>
        )}
      </PanelSection>

      <PanelSection
        title="嵌入配置（只读摘要）"
        hint="research.embedding.list（写入在设置中心：唯一真理源 + 密钥不进 renderer）"
        testId="production-embedding"
        action={{ label: '打开设置中心', onClick: scope.openSettings, testId: 'production-embedding-open-settings' }}
      >
        {embeddings.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: embeddings.error ?? '读取嵌入配置失败', retry: embeddings.reload }} />
        ) : null}
        {(embeddings.data ?? []).length === 0 ? (
          <InlineHint text="还没有嵌入配置：在设置中心「向量与 RAG」里添加。" testId="production-embedding-empty" />
        ) : (
          <ul className="flex flex-col gap-1" data-testid="production-embedding-list">
            {(embeddings.data ?? []).map((config) => (
              <li key={config.id} className="flex flex-wrap items-center gap-2 text-[var(--font-meta-size)]">
                <Settings2 size={11} aria-hidden="true" className="text-[var(--st-info)]" />
                <span className="text-ink">{config.name}</span>
                <span className="font-mono text-muted">{config.model}</span>
                <span className="text-subtle">{config.dimensions} 维</span>
                <span className="text-subtle">{config.enabled ? '已启用' : '未启用'}</span>
                <span className="text-subtle">{config.keyConfigured ? '密钥已配置' : '缺密钥'}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-subtle text-[var(--font-micro-size)]">
          research.embedding.save 需要明文 apiKey（后端任务单 B23），所以这里不收集密钥，只显示生效配置。
        </p>
      </PanelSection>
    </div>
  );
}
