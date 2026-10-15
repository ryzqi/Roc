import { useMemo, useState } from 'react';
import { FileText, Plus, Trash2 } from 'lucide-react';
import type { ResearchClaim, ResearchExportBundle, ResearchManuscript } from '../../shared/types';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { formatBeijingDateTime } from '../shared/format';
import { useWorkflow } from '../canvas/workflow/workflow-scope';
import { claimStatusLabel, exportReadiness, manuscriptBlockers } from './production-rules';
import { getExportBundle, getManuscript, listClaims, saveManuscript } from './production-store';
import {
  FieldLabel,
  InlineHint,
  IssueList,
  PanelSection,
  primaryButtonClass,
  secondaryButtonClass,
  textInputClass
} from './panel-shell';

/**
 * 正文 (P7/T7.4).
 *
 * **The manuscript is a list of sections over claims, not free prose.** `save` takes
 * `{artifactId, sections: [{title, claimIds[]}]}` with two hard rules: every section needs at
 * least one claim, and **a claim may appear in exactly one paragraph** (the schema refines on
 * duplicates). The backend then renders `latex` from the verified claims
 * (`manuscripts.assertPublishable` refuses a `supported` claim without evidence), so the editor
 * here assembles *which* claims make up *which* paragraph and shows the readiness that
 * `exportBundle` will enforce.
 *
 * Because a claim can only be used once, the picker hides claims already placed in another
 * section — offering them would let the user build a document the backend rejects.
 */

type SectionDraft = { title: string; claimIds: string[] };

export function ManuscriptPanel(): React.JSX.Element {
  const scope = useWorkspaceScope();
  const workflow = useWorkflow();
  const artifact = useMemo(
    () => (workflow.artifacts ?? []).find((item) => item.kind === 'manuscript') ?? null,
    [workflow.artifacts]
  );
  const projectId = scope.projectId ?? '';

  const manuscript = useAsyncResource<ResearchManuscript | null>(
    artifact === null ? null : `manuscript:${artifact.id}`,
    () => getManuscript(scope.client, artifact?.id ?? ''),
    { label: '读取正文' }
  );
  const bundle = useAsyncResource<ResearchExportBundle>(
    artifact === null ? null : `bundle:${artifact.id}`,
    () => getExportBundle(scope.client, { projectId, artifactId: artifact?.id ?? '' }),
    { label: '读取导出清单' }
  );
  const claims = useAsyncResource<ResearchClaim[]>(
    scope.projectId === null ? null : `claims:${scope.projectId}`,
    () => listClaims(scope.client, { projectId }),
    { label: '读取主张' }
  );

  const [drafts, setDrafts] = useState<SectionDraft[] | null>(null);
  const save = useAsyncAction(
    (sections: SectionDraft[]) =>
      saveManuscript(scope.client, {
        artifactId: artifact?.id ?? '',
        sections: sections.map((section) => ({ title: section.title, claimIds: section.claimIds }))
      }),
    { label: '保存正文' }
  );

  const loaded = manuscript.data ?? null;
  const current: SectionDraft[] = drafts ?? (loaded === null ? [] : loaded.sections.map((section) => ({ ...section })));
  const claimById = useMemo(() => new Map((claims.data ?? []).map((claim) => [claim.id, claim])), [claims.data]);
  const readiness = exportReadiness(bundle.data ?? null);

  if (artifact === null) {
    return (
      <div className="flex h-full flex-col justify-center" data-testid="production-manuscript">
        <EmptyState
          icon={FileText}
          title="本阶段还没有正文工件"
          description="正文挂在写作阶段的 manuscript 工件上。先让写作阶段产出一份正文，再来这里编排段落。"
          testId="production-manuscript-empty"
        />
      </div>
    );
  }

  const blockers = manuscriptBlockers(current);

  const usedElsewhere = (exceptIndex: number): Set<string> =>
    new Set(current.flatMap((section, index) => (index === exceptIndex ? [] : section.claimIds)));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-testid="production-manuscript">
      <PanelSection
        title="段落编排"
        hint={loaded === null ? '还没有保存过正文' : `更新于 ${formatBeijingDateTime(loaded.updatedAt)}`}
        testId="production-manuscript-sections"
        action={{ label: '刷新', onClick: manuscript.reload, busy: manuscript.status === 'loading', testId: 'production-manuscript-refresh' }}
      >
        {manuscript.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: manuscript.error ?? '读取正文失败', retry: manuscript.reload }} />
        ) : null}
        {claims.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: claims.error ?? '读取主张失败', retry: claims.reload }} />
        ) : null}
        {loaded === null ? (
          <InlineHint text="空正文：段落标题 + 引用主张（后端会用已核实的主张渲染 latex）。" testId="production-manuscript-new" />
        ) : null}

        <ol className="flex flex-col gap-2" data-testid="production-manuscript-section-list">
          {current.map((section, index) => (
            <li key={`section-${index}`} className="flex flex-col gap-1 rounded-card border border-line bg-bg-soft px-2 py-1.5">
              <div className="flex items-center gap-2">
                <FieldLabel text={`段落 ${index + 1}`} />
                <input
                  data-testid={`production-manuscript-title-${index}`}
                  value={section.title}
                  disabled={!scope.writable}
                  onChange={(event) => {
                    const next = [...current];
                    next[index] = { ...section, title: event.target.value };
                    setDrafts(next);
                  }}
                  className={textInputClass}
                />
                <button
                  type="button"
                  data-testid={`production-manuscript-remove-${index}`}
                  className={secondaryButtonClass}
                  disabled={!scope.writable}
                  onClick={() => setDrafts(current.filter((_, position) => position !== index))}
                >
                  <Trash2 size={11} aria-hidden="true" />
                  移除
                </button>
              </div>
              <div className="flex flex-wrap gap-1" data-testid={`production-manuscript-claims-${index}`}>
                {(claims.data ?? []).map((claim) => {
                  const checked = section.claimIds.includes(claim.id);
                  const takenByOther = !checked && usedElsewhere(index).has(claim.id);
                  return (
                    <label
                      key={claim.id}
                      title={claim.content}
                      className={[
                        'flex max-w-[320px] items-center gap-1.5 rounded-control border px-1.5 py-0.5 text-[var(--font-micro-size)]',
                        takenByOther ? 'border-line text-subtle opacity-60' : 'border-line text-muted'
                      ].join(' ')}
                    >
                      <input
                        type="checkbox"
                        data-testid={`production-manuscript-claim-${index}-${claim.id}`}
                        checked={checked}
                        disabled={takenByOther || !scope.writable}
                        onChange={(event) => {
                          const next = [...current];
                          const ids = event.target.checked
                            ? [...section.claimIds, claim.id]
                            : section.claimIds.filter((id) => id !== claim.id);
                          next[index] = { ...section, claimIds: ids };
                          setDrafts(next);
                        }}
                      />
                      <span className="min-w-0 truncate">{claim.content}</span>
                      <span className="shrink-0 text-subtle">{claimStatusLabel(claim.status)}</span>
                    </label>
                  );
                })}
              </div>
              {section.claimIds.length === 0 ? null : (
                <span className="text-subtle text-[var(--font-micro-size)]">
                  {section.claimIds
                    .map((id) => claimById.get(id)?.content.slice(0, 40) ?? id)
                    .join(' / ')}
                </span>
              )}
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="production-manuscript-add-section"
            disabled={!scope.writable || current.length >= 100}
            onClick={() => setDrafts([...current, { title: `段落 ${current.length + 1}`, claimIds: [] }])}
            className={secondaryButtonClass}
          >
            <Plus size={11} aria-hidden="true" />
            添加段落
          </button>
          <button
            type="button"
            data-testid="production-manuscript-save"
            disabled={!scope.writable || save.pending || blockers.length > 0}
            onClick={() => {
              void save.run(current).then((saved) => {
                if (saved !== null) {
                  setDrafts(null);
                  manuscript.reload();
                  bundle.reload();
                }
              });
            }}
            className={primaryButtonClass}
          >
            保存正文
          </button>
        </div>
        <IssueList issues={blockers} testId="production-manuscript-issues" />
        {save.error === null ? null : <InlineHint text={save.error} testId="production-manuscript-save-error" />}
      </PanelSection>

      <PanelSection
        title="导出就绪度"
        hint="research.manuscript.exportBundle（缺证据的主张不能进入导出）"
        testId="production-manuscript-bundle"
      >
        {bundle.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: bundle.error ?? '读取导出清单失败', retry: bundle.reload }} />
        ) : null}
        {bundle.data === null ? (
          <InlineHint text="还没有可用的导出清单。" />
        ) : (
          <>
            <p className="text-[var(--font-meta-size)]" data-testid="production-manuscript-bundle-counts">
              段落 {bundle.data.manuscript.sections.length} · 主张 {bundle.data.claims.length} · 证据{' '}
              {bundle.data.evidence.length} · 生成于 {formatBeijingDateTime(bundle.data.generatedAt)}
            </p>
            <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap rounded-control bg-code-surface px-2 py-1 font-mono text-[var(--code-text)] text-[var(--font-code-size)]">
              {bundle.data.manuscript.latex}
            </pre>
            {readiness.ready ? (
              <p className="text-[var(--st-ok)] text-[var(--font-meta-size)]" data-testid="production-manuscript-bundle-ready">
                可以进入导出：每条 supported 主张都有证据。
              </p>
            ) : (
              <IssueList issues={readiness.issues} testId="production-manuscript-bundle-issues" />
            )}
          </>
        )}
      </PanelSection>
    </div>
  );
}
