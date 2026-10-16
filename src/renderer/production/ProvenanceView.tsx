import { useMemo, useState } from 'react';
import { Beaker, FileText, GitBranch, Quote, Workflow } from 'lucide-react';
import type { ResearchProvenance } from '../../shared/types';
import { useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { formatBeijingDateTime } from '../shared/format';
import { KeyValue, PanelSection } from '../production/panel-shell';

/**
 * 溯源 (P7/T7.x) — read-only, from `research.provenance.list`.
 *
 * The record is the contract's own shape: a *subject* (claim / paragraph / figure / experiment /
 * artifact) backed by a *source* (literature / file / experiment / model_run / workflow_event)
 * with an optional locator and excerpt. The panel therefore groups by subject and shows the
 * source chain — it does not invent a graph, and it does not try to open things the route
 * contract cannot reach: 「打开来源」 only navigates for the two source kinds the canvas actually
 * has (literature → 文献中心, experiment/model_run → 阶段工作区).
 *
 * `addProvenance` (the write side) stays unexposed in the UI: every provenance link a user would
 * create is already written by the backend when evidence is captured or a claim is made, and an
 * "add a link" form would let someone attach a source that does not exist.
 */

const SOURCE_LABELS: Record<ResearchProvenance['sourceType'], string> = {
  literature: '文献',
  file: '文件',
  experiment: '实验运行',
  model_run: '模型运行',
  workflow_event: '流程事件'
};

const SUBJECT_LABELS: Record<ResearchProvenance['subjectType'], string> = {
  claim: '主张',
  paragraph: '段落',
  figure_claim: '图稿主张',
  figure: '图稿',
  experiment: '实验',
  artifact: '工件'
};

export function ProvenanceView(): React.JSX.Element {
  const scope = useWorkspaceScope();
  const projectId = scope.projectId ?? '';
  const resource = useAsyncResource<ResearchProvenance[]>(
    scope.projectId === null ? null : `provenance:${scope.projectId}`,
    () => scope.client.api.research.listProvenance({ projectId }),
    { label: '读取溯源' }
  );
  const [selected, setSelected] = useState<string | null>(null);

  const groups = useMemo(() => {
    const bySubject = new Map<string, ResearchProvenance[]>();
    for (const record of resource.data ?? []) {
      const key = `${record.subjectType}:${record.subjectId}`;
      const list = bySubject.get(key);
      if (list === undefined) {
        bySubject.set(key, [record]);
        continue;
      }
      list.push(record);
    }
    return [...bySubject.entries()];
  }, [resource.data]);

  if (scope.projectId === null) {
    return <p className="p-4 text-muted text-[var(--font-meta-size)]">未进入项目。</p>;
  }

  if (resource.status === 'error') {
    return (
      <div className="flex h-full flex-col gap-2 p-4" data-testid="provenance-view">
        <ErrorBar error={{ level: 'page', message: resource.error ?? '读取溯源失败', retry: resource.reload }} />
      </div>
    );
  }

  if ((resource.data ?? []).length === 0) {
    return (
      <div className="flex h-full flex-col justify-center" data-testid="provenance-view">
        <EmptyState
          icon={GitBranch}
          title="还没有溯源记录"
          description="溯源记录由后端在捕获证据、主张与运行产物时写入；这里只读展示「谁支撑了谁」。"
          testId="provenance-empty"
        />
      </div>
    );
  }

  const detail = (resource.data ?? []).find((record) => record.id === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4" data-testid="provenance-view">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-ink text-[var(--font-h2-size)]">溯源</h1>
        <span className="text-subtle text-[var(--font-meta-size)]">
          {(resource.data ?? []).length} 条记录 · {groups.length} 个主体（research.provenance.list）
        </span>
        <button
          type="button"
          data-testid="provenance-refresh"
          onClick={resource.reload}
          className="ml-auto h-[var(--control-height-compact)] rounded-control border border-line px-2 text-muted text-[var(--font-meta-size)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          刷新
        </button>
      </header>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <ol className="flex flex-col gap-2" data-testid="provenance-subject-list">
          {groups.map(([key, records]) => {
            const first = records[0];
            if (first === undefined) {
              return null;
            }
            return (
              <li key={key} className="rounded-card border border-line bg-surface px-3 py-2">
                <header className="flex flex-wrap items-center gap-2">
                  <SubjectIcon subject={first.subjectType} />
                  <span className="text-ink text-[var(--font-meta-size)]">
                    {SUBJECT_LABELS[first.subjectType]}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-subtle text-[var(--font-micro-size)]" title={first.subjectId}>
                    {first.subjectId}
                  </span>
                  <span className="text-subtle text-[var(--font-micro-size)]">{records.length} 条来源</span>
                </header>
                <ul className="mt-1 flex flex-col gap-0.5" data-testid={`provenance-sources-${first.subjectId}`}>
                  {records.map((record) => (
                    <li key={record.id} className="flex flex-wrap items-center gap-2 text-[var(--font-meta-size)]">
                      <Quote size={10} aria-hidden="true" className="text-subtle" />
                      <span className="text-muted">{SOURCE_LABELS[record.sourceType]}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-subtle text-[var(--font-micro-size)]" title={record.sourceId}>
                        {record.sourceId}
                      </span>
                      {record.locator === null ? null : <span className="text-subtle">{record.locator}</span>}
                      <span className="text-subtle text-[var(--font-micro-size)]">{formatBeijingDateTime(record.createdAt)}</span>
                      <button
                        type="button"
                        data-testid={`provenance-select-${record.id}`}
                        onClick={() => setSelected(record.id)}
                        className="rounded-control border border-line px-1.5 py-0.5 text-muted text-[var(--font-micro-size)] hover:text-ink active:bg-[var(--overlay-active)]"
                      >
                        详情
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>

        <aside className="flex flex-col gap-2" data-testid="provenance-detail">
          {detail === null ? (
            <PanelSection title="来源详情" hint="选择一条来源" testId="provenance-detail-empty">
              <p className="text-muted text-[var(--font-meta-size)]">左侧任一条来源的「详情」会显示原文片段与定位。</p>
            </PanelSection>
          ) : (
            <PanelSection
              title="来源详情"
              hint="research.provenance.list"
              testId="provenance-detail-record"
              action={{ label: '关闭', onClick: () => setSelected(null), testId: 'provenance-detail-close' }}
            >
              <dl className="flex flex-col gap-0.5">
                <KeyValue label="主体" value={`${SUBJECT_LABELS[detail.subjectType]} · ${detail.subjectId}`} />
                <KeyValue label="工件" value={detail.artifactId ?? '—'} />
                <KeyValue label="来源" value={`${SOURCE_LABELS[detail.sourceType]} · ${detail.sourceId}`} />
                <KeyValue label="定位" value={detail.locator ?? '—'} />
                <KeyValue label="时间" value={formatBeijingDateTime(detail.createdAt)} />
              </dl>
              {detail.excerpt === null ? (
                <p className="text-muted text-[var(--font-meta-size)]">这条来源没有摘录。</p>
              ) : (
                <p className="whitespace-pre-wrap rounded-control bg-bg-soft px-2 py-1 text-ink text-[var(--font-meta-size)]">
                  {detail.excerpt}
                </p>
              )}
              <SourceActions sourceType={detail.sourceType} sourceId={detail.sourceId} />
            </PanelSection>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Only the two navigable kinds get a button; the rest would be a dead affordance. */
function SourceActions({
  sourceType,
  sourceId
}: {
  sourceType: ResearchProvenance['sourceType'];
  sourceId: string;
}): React.JSX.Element | null {
  const scope = useWorkspaceScope();
  if (sourceType === 'literature') {
    return (
      <button
        type="button"
        data-testid="provenance-open-literature"
        onClick={() => scope.openView('literature')}
        className="self-start rounded-control border border-line px-2 py-1 text-muted text-[var(--font-meta-size)] hover:text-ink active:bg-[var(--overlay-active)]"
      >
        打开文献中心
      </button>
    );
  }
  if (sourceType === 'experiment' || sourceType === 'model_run') {
    return (
      <button
        type="button"
        data-testid="provenance-open-stage"
        onClick={() => scope.openStage('experiment')}
        className="self-start rounded-control border border-line px-2 py-1 text-muted text-[var(--font-meta-size)] hover:text-ink active:bg-[var(--overlay-active)]"
      >
        打开实验与检查阶段
      </button>
    );
  }
  return (
    <p className="font-mono text-subtle text-[var(--font-micro-size)]" data-testid="provenance-source-id">
      来源不可直接打开：{sourceType} · {sourceId}
    </p>
  );
}

function SubjectIcon({ subject }: { subject: ResearchProvenance['subjectType'] }): React.JSX.Element {
  if (subject === 'experiment') {
    return <Beaker size={12} aria-hidden="true" className="text-[var(--st-info)]" />;
  }
  if (subject === 'artifact' || subject === 'figure' || subject === 'figure_claim') {
    return <FileText size={12} aria-hidden="true" className="text-[var(--st-info)]" />;
  }
  return <Workflow size={12} aria-hidden="true" className="text-[var(--st-info)]" />;
}
