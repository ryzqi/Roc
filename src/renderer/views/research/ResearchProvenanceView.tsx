import type { ResearchArtifact, ResearchEvidence, ResearchProvenance, ResearchStageRun } from '../../../shared/types';
import { artifactStatusLabel, formatResearchTime, researchRunStatusLabels, researchStageLabels } from './research-workflow';
import { usePagedItems } from './research-list-page';

const SOURCE_LABELS: Record<ResearchProvenance['sourceType'], string> = {
  literature: '文献',
  file: '文件',
  experiment: '实验',
  model_run: '模型运行',
  workflow_event: '工作流事件'
};

export function ResearchProvenanceView({
  artifacts,
  evidence,
  onSelectArtifact,
  onBackToOverview,
  provenance,
  runs,
  selectedArtifactId
}: {
  artifacts: ResearchArtifact[];
  evidence: ResearchEvidence[];
  onSelectArtifact: (artifactId: string) => void;
  onBackToOverview?: () => void;
  provenance: ResearchProvenance[];
  runs: ResearchStageRun[];
  selectedArtifactId: string | null;
}): React.JSX.Element {
  const selected = artifacts.find((item) => item.id === selectedArtifactId) ?? artifacts[0] ?? null;
  const links = selected === null ? [] : provenance.filter((entry) => entry.artifactId === selected.id || entry.subjectId === selected.id);
  const relatedEvidence = selected === null
    ? []
    : evidence.filter((item) => links.some((entry) => entry.sourceId === item.id || entry.subjectId === item.id));
  const relatedRuns = selected === null
    ? []
    : runs.filter((run) => run.outputArtifactIds.includes(selected.id) || run.inputArtifactIds.includes(selected.id) || links.some((entry) => entry.sourceId === run.id));
  const artifactPage = usePagedItems(artifacts, artifacts.length.toString());
  return (
    <section className="research-provenance-view" data-testid="research-provenance-view">
      <aside className="research-projects" aria-label="产物">
        <div className="research-section-label">产物</div>
        {artifactPage.visible.map((artifact) => (
          <button
            className={artifact.id === selected?.id ? 'research-project-row research-project-row--active' : 'research-project-row'}
            key={artifact.id}
            type="button"
            onClick={() => onSelectArtifact(artifact.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                return;
              }
              const buttons = [...event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.research-project-row') ?? []];
              const index = buttons.indexOf(event.currentTarget);
              const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)];
              if (next === undefined) {
                return;
              }
              event.preventDefault();
              next.focus();
              next.click();
            }}
          >
            <span className="research-project-row-title">{artifact.title}</span>
            <span className="research-project-row-meta">{researchStageLabels[artifact.stage]} · {artifactStatusLabel(artifact.status)}</span>
          </button>
        ))}
        {artifactPage.remaining === 0 ? null : (
          <button className="ui-button ui-button--secondary" data-testid="research-provenance-more" type="button" onClick={artifactPage.showMore}>
            继续加载产物（剩余 {artifactPage.remaining}）
          </button>
        )}
      </aside>
      {selected === null ? <div className="research-empty-inline" role="status">当前项目还没有产物。</div> : (
        <div className="research-shell-canvas">
          <div className="research-tool-heading">
            <h2 data-testid="research-provenance-title">{selected.title}</h2>
            {onBackToOverview === undefined ? null : (
              <button className="ui-button ui-button--secondary" data-testid="research-provenance-back" type="button" onClick={onBackToOverview}>返回总览</button>
            )}
          </div>
          <p className="research-rail-item">{researchStageLabels[selected.stage]} · {artifactStatusLabel(selected.status)} · {formatResearchTime(selected.updatedAt)}</p>
          <div className="research-section-label">来源</div>
          {links.length === 0 ? (
            <p className="research-empty-inline" data-testid="research-provenance-missing" role="status">未建立来源。不能把该产物标记为已验证。</p>
          ) : (
            <ul className="research-artifact-list" data-testid="research-provenance-links">
              {links.map((entry) => (
                <li className="research-timeline-item" key={entry.id}>
                  <span>{SOURCE_LABELS[entry.sourceType]}</span>
                  <strong>{entry.sourceId}{entry.locator === null ? '' : ` · ${entry.locator}`}</strong>
                  <time>{entry.excerpt ?? formatResearchTime(entry.createdAt)}</time>
                </li>
              ))}
            </ul>
          )}
          <div className="research-section-label">证据</div>
          {relatedEvidence.length === 0 ? <p className="research-empty-inline">没有关联证据片段。</p> : relatedEvidence.map((item) => (
            <p className="research-rail-item" key={item.id}>{item.title} · {item.locator}</p>
          ))}
          <div className="research-section-label">运行</div>
          {relatedRuns.length === 0 ? <p className="research-empty-inline">没有关联运行记录。</p> : relatedRuns.map((run) => (
            <p className="research-rail-item" key={run.id}>{researchStageLabels[run.stage]} · {researchRunStatusLabels[run.status]} · {run.role}</p>
          ))}
        </div>
      )}
    </section>
  );
}
