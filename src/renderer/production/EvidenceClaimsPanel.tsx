import { useMemo, useState } from 'react';
import { BookMarked, FlaskConical, FileText, Quote } from 'lucide-react';
import type { ResearchClaim, ResearchEvidence } from '../../shared/types';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { ErrorBar } from '../shell/ErrorBar';
import { formatBeijingDateTime } from '../shared/format';
import { useWorkflow } from '../canvas/workflow/workflow-scope';
import { claimStatusLabel, claimSupportRows } from './production-rules';
import {
  createClaim,
  getClaimHistory,
  getEvidenceExperimentSource,
  listClaims,
  listEvidence,
  updateClaim
} from './production-store';
import {
  FieldLabel,
  InlineHint,
  IssueList,
  PanelSection,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
  textAreaClass,
  textInputClass
} from './panel-shell';

/**
 * 证据与主张 (P7/T7.6).
 *
 * Three contract facts decide this panel's shape:
 *
 *  1. **Evidence can only be captured from a chunk** (`research.evidence.capture` takes
 *     `{projectId, chunkId}` — B15/F16). So this panel does not offer a free-text capture form;
 *     it lists what exists and points at the two surfaces that *do* have a chunk id (RAG
 *     retrieval hits, and the library reader's capture entry).
 *  2. **`research.experiment.evidenceSource` returns a file locator**, so "打开来源" for
 *     experiment-backed evidence means locating the run file, not the run record.
 *  3. **A `supported` claim must have real evidence ids** (`evidence.assertSupported`), so the
 *     editor marks `supported` + no ids as its own blocker and never sends it.
 *
 * The claim list is grouped by support (`claimSupportRows`), which is also what the export's
 * 「没有证据的主张不能进入导出」 gate reuses — one rule, two surfaces.
 */

type ClaimDraft = {
  id: string | null;
  artifactId: string;
  subjectType: ResearchClaim['subjectType'];
  content: string;
  status: ResearchClaim['status'];
  evidenceIds: string[];
  expectedVersion: number;
};

export function EvidenceClaimsPanel({ writeAllowed }: { writeAllowed?: boolean }): React.JSX.Element {
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

  const evidence = useAsyncResource<ResearchEvidence[]>(
    scope.projectId === null ? null : `evidence:${scope.projectId}`,
    () => listEvidence(scope.client, projectId),
    { label: '读取证据' }
  );
  const claims = useAsyncResource<ResearchClaim[]>(
    scope.projectId === null ? null : `claims:${scope.projectId}`,
    () => listClaims(scope.client, { projectId }),
    { label: '读取主张' }
  );

  const [draft, setDraft] = useState<ClaimDraft | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [sourceNote, setSourceNote] = useState<string | null>(null);

  const saveClaim = useAsyncAction(
    async (input: ClaimDraft) =>
      input.id === null
        ? createClaim(scope.client, {
            projectId,
            artifactId: input.artifactId,
            subjectType: input.subjectType,
            content: input.content,
            status: input.status,
            evidenceIds: input.evidenceIds
          })
        : updateClaim(scope.client, {
            id: input.id,
            content: input.content,
            status: input.status,
            evidenceIds: input.evidenceIds,
            expectedVersion: input.expectedVersion
          }),
    { label: '保存主张' }
  );

  const history = useAsyncResource<ResearchClaim[]>(
    historyFor === null ? null : `claim-history:${historyFor}`,
    () => getClaimHistory(scope.client, historyFor ?? ''),
    { label: '读取主张历史' }
  );

  const rows = useMemo(
    () => claimSupportRows(claims.data ?? [], evidence.data ?? []),
    [claims.data, evidence.data]
  );

  const manuscriptArtifact = useMemo(
    () =>
      (workflow.artifacts ?? []).find((artifact) => artifact.kind === 'manuscript') ??
      null,
    [workflow.artifacts]
  );

  if (scope.projectId === null) {
    return <InlineHint text="未进入项目。" />;
  }

  const saveIssues = draft === null ? [] : claimDraftIssues(draft);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-testid="production-evidence-claims">
      <PanelSection
        title="证据"
        hint="research.evidence.list（捕获只能从检索命中发起：research.evidence.capture 需要 chunkId）"
        testId="production-evidence"
        action={{
          label: '刷新',
          onClick: () => evidence.reload(),
          busy: evidence.status === 'loading',
          testId: 'production-evidence-refresh'
        }}
      >
        {evidence.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: evidence.error ?? '读取证据失败', retry: evidence.reload }} />
        ) : null}
        {(evidence.data ?? []).length === 0 ? (
          <InlineHint text="还没有证据：在文献中心的 RAG 命中上「捕获为证据」后会出现在这里。" testId="production-evidence-empty" />
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="production-evidence-list">
            {(evidence.data ?? []).map((item) => (
              <li key={item.id} className="flex flex-col gap-0.5 rounded-card border border-line bg-bg-soft px-2 py-1.5">
                <span className="flex items-center gap-1.5 text-[var(--font-meta-size)]">
                  {item.sourceType === 'experiment' ? (
                    <FlaskConical size={11} aria-hidden="true" className="text-[var(--st-info)]" />
                  ) : item.sourceType === 'file' ? (
                    <FileText size={11} aria-hidden="true" className="text-[var(--st-info)]" />
                  ) : (
                    <BookMarked size={11} aria-hidden="true" className="text-[var(--st-info)]" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-ink" title={item.excerpt}>
                    {item.excerpt.slice(0, 120)}
                  </span>
                  <span className="shrink-0 text-subtle">{item.sourceType}</span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-[var(--font-micro-size)] text-subtle">
                  <span className="font-mono">{item.locator}</span>
                  <span>{formatBeijingDateTime(item.createdAt)}</span>
                  {item.sourceType !== 'experiment' ? null : (
                    <button
                      type="button"
                      data-testid={`production-evidence-source-${item.id}`}
                      className={secondaryButtonClass}
                      onClick={() => {
                        void getEvidenceExperimentSource(scope.client, { projectId, evidenceId: item.id }).then((result) => {
                          setSourceNote(
                            result.ok
                              ? result.data === null
                                ? '后端没有给出这条证据的来源文件。'
                                : `来源文件：${result.data.area}/${result.data.path}（运行 ${result.data.runId}）`
                              : result.error.message
                          );
                        });
                      }}
                    >
                      打开来源
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {sourceNote === null ? null : (
          <p className="font-mono text-muted text-[var(--font-micro-size)]" data-testid="production-evidence-source-note">
            {sourceNote}
          </p>
        )}
      </PanelSection>

      <PanelSection
        title="主张"
        hint="research.claims.list（supported 必须有真实证据 id）"
        testId="production-claims"
        action={{
          label: '新建主张',
          onClick: () =>
            setDraft({
              id: null,
              artifactId: manuscriptArtifact?.id ?? '',
              subjectType: 'claim',
              content: '',
              status: 'hypothesis',
              evidenceIds: [],
              expectedVersion: 1
            }),
          // 「可以写」= 项目未归档 **且** 当前阶段组可写（`canWrite`）。原来只判断「有没有正文工件」，
          // 于是归档项目的「新建主张」仍然可点（评审 P1）。
          disabled: manuscriptArtifact === null || !canWrite,
          testId: 'production-claims-new'
        }}
      >
        {canWrite ? null : (
          <p className="text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="production-claims-readonly" role="note">
            只读：项目已归档或当前阶段组不可写 —— 主张的新增与修改已停用。
          </p>
        )}
        {manuscriptArtifact === null ? (
          <InlineHint text="本项目还没有正文工件：主张必须挂在正文工件上，先让写作阶段产出正文。" testId="production-claims-no-artifact" />
        ) : (
          <p className="text-subtle text-[var(--font-micro-size)]" data-testid="production-claims-artifact">
            目标正文工件：{manuscriptArtifact.title}
          </p>
        )}
        {claims.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: claims.error ?? '读取主张失败', retry: claims.reload }} />
        ) : null}
        {rows.length === 0 ? (
          <InlineHint text="还没有主张。主张由写作阶段或助手产出，也可以在这里手工新建。" testId="production-claims-empty" />
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="production-claim-list">
            {rows.map((row) => (
              <li key={row.claim.id} className="flex flex-col gap-1 rounded-card border border-line bg-bg-soft px-2 py-1.5">
                <span className="flex items-start gap-1.5 text-[var(--font-meta-size)]">
                  <Quote size={11} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-info)]" />
                  <span className="min-w-0 flex-1 text-ink">{row.claim.content}</span>
                  <span className="shrink-0 text-subtle">
                    {claimStatusLabel(row.claim.status)} · v{row.claim.version}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5 text-[var(--font-micro-size)]">
                  {row.evidence.length === 0 ? (
                    <span className="text-[var(--st-warn)]">无证据引用</span>
                  ) : (
                    row.evidence.map((item) => (
                      <span key={item.id} className="rounded-control bg-[var(--overlay-hover)] px-1.5 py-0.5 text-muted" title={item.excerpt}>
                        {item.locator.slice(0, 40)}
                      </span>
                    ))
                  )}
                  {row.missingEvidence ? (
                    <span className="text-[var(--st-bad)]">supported 但缺证据（后端会拒）</span>
                  ) : null}
                  <button
                    type="button"
                    data-testid={`production-claim-edit-${row.claim.id}`}
                    className={secondaryButtonClass}
                    onClick={() =>
                      setDraft({
                        id: row.claim.id,
                        artifactId: row.claim.artifactId,
                        subjectType: row.claim.subjectType,
                        content: row.claim.content,
                        status: row.claim.status,
                        evidenceIds: [...row.claim.evidenceIds],
                        expectedVersion: row.claim.version
                      })
                    }
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    data-testid={`production-claim-history-${row.claim.id}`}
                    className={secondaryButtonClass}
                    onClick={() => setHistoryFor(row.claim.id)}
                  >
                    历史
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      {draft === null ? null : (
        <PanelSection
          title={draft.id === null ? '新建主张' : '编辑主张'}
          hint={draft.id === null ? 'research.claims.create' : 'research.claims.update（乐观并发：expectedVersion）'}
          testId="production-claim-editor"
        >
          <label className="flex flex-col gap-0.5">
            <FieldLabel text="主张内容（不能为空）" />
            <textarea
              data-testid="production-claim-content"
              value={draft.content}
              rows={3}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              className={textAreaClass}
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex w-[160px] flex-col gap-0.5">
              <FieldLabel text="状态" />
              <select
                data-testid="production-claim-status"
                value={draft.status}
                onChange={(event) => setDraft({ ...draft, status: event.target.value as ResearchClaim['status'] })}
                className={selectClass}
              >
                <option value="pending">待验证</option>
                <option value="hypothesis">假设</option>
                <option value="supported">有证据支持</option>
              </select>
            </label>
            <label className="flex w-[160px] flex-col gap-0.5">
              <FieldLabel text="主体类型" />
              <select
                data-testid="production-claim-subject"
                value={draft.subjectType}
                onChange={(event) => setDraft({ ...draft, subjectType: event.target.value as ResearchClaim['subjectType'] })}
                className={selectClass}
              >
                <option value="claim">claim</option>
                <option value="paragraph">paragraph</option>
                <option value="figure">figure</option>
              </select>
            </label>
            {draft.id === null ? null : (
              <label className="flex w-[220px] flex-col gap-0.5">
                <FieldLabel text="证据 id（逗号分隔）" />
                <input
                  data-testid="production-claim-evidence"
                  value={draft.evidenceIds.join(',')}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      evidenceIds: event.target.value
                        .split(',')
                        .map((part) => part.trim())
                        .filter((part) => part.length > 0)
                    })
                  }
                  className={textInputClass}
                />
              </label>
            )}
          </div>
          {draft.id === null ? (
            <InlineHint text="新建时先不引用证据：保存后再用「编辑」补 evidenceIds（避免把不存在的 id 发给后端）。" />
          ) : null}
          <IssueList issues={saveIssues} testId="production-claim-issues" />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="production-claim-save"
              disabled={!canWrite || saveClaim.pending || saveIssues.length > 0}
              onClick={() => {
                void saveClaim.run(draft).then((saved) => {
                  if (saved !== null) {
                    setDraft(null);
                    claims.reload();
                  }
                });
              }}
              className={primaryButtonClass}
            >
              保存主张
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
          {saveClaim.error === null ? null : <InlineHint text={saveClaim.error} testId="production-claim-error" />}
        </PanelSection>
      )}

      {historyFor === null ? null : (
        <PanelSection
          title="主张历史"
          hint="research.claims.history（只读）"
          testId="production-claim-history"
          action={{ label: '关闭', onClick: () => setHistoryFor(null), testId: 'production-claim-history-close' }}
        >
          {history.status === 'error' ? (
            <ErrorBar error={{ level: 'page', message: history.error ?? '读取历史失败', retry: history.reload }} />
          ) : null}
          {(history.data ?? []).length === 0 ? (
            <InlineHint text="没有历史版本。" />
          ) : (
            <ol className="flex flex-col gap-1" data-testid="production-claim-history-list">
              {(history.data ?? []).map((version) => (
                <li key={`${version.id}-${version.version}`} className="flex items-start gap-2 text-[var(--font-meta-size)]">
                  <span className="shrink-0 font-mono text-subtle">v{version.version}</span>
                  <span className="min-w-0 flex-1 text-muted">{version.content}</span>
                  <span className="shrink-0 text-subtle">{claimStatusLabel(version.status)}</span>
                  <span className="shrink-0 text-subtle">{formatBeijingDateTime(version.updatedAt)}</span>
                </li>
              ))}
            </ol>
          )}
        </PanelSection>
      )}
    </div>
  );
}

/** `supported` needs ids; the rest are free. Backend says `research_claim_evidence_required`. */
export function claimDraftIssues(draft: {
  content: string;
  status: ResearchClaim['status'];
  evidenceIds: string[];
}): Array<{ message: string; reference: string | null }> {
  const issues: Array<{ message: string; reference: string | null }> = [];
  if (draft.content.trim().length === 0) {
    issues.push({ message: '主张内容不能为空', reference: 'content' });
  }
  if (draft.status === 'supported' && draft.evidenceIds.length === 0) {
    issues.push({ message: '「有证据支持」必须引用至少一条真实证据 id', reference: 'evidenceIds' });
  }
  return issues;
}
