import { Send } from 'lucide-react';

import type { ResearchArtifact, ResearchExportExecution, ResearchFigurePublication } from '../../../shared/types';

export function ResearchProductionPanel({
  destinationPath,
  exports,
  figures,
  manuscripts,
  onChangeDestination,
  onChangeTitle,
  onPrepareExport,
  onPublishExport,
  onToggleFigure,
  onWriteExport,
  selectedFigureIds,
  title,
  working,
  readOnly = false
}: {
  destinationPath: string;
  exports: ResearchExportExecution[];
  figures: ResearchFigurePublication[];
  manuscripts: ResearchArtifact[];
  onChangeDestination: (value: string) => void;
  onChangeTitle: (value: string) => void;
  onPrepareExport: () => void;
  onPublishExport: (exportId: string) => void;
  onToggleFigure: (figureId: string) => void;
  onWriteExport: (exportId: string) => void;
  selectedFigureIds: string[];
  title: string;
  working: boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const manuscript = manuscripts.find((item) => item.status === 'approved') ?? manuscripts[0] ?? null;
  const writeBlocked = working || readOnly;
  return (
    <section className="research-tool-panel" data-testid="research-production-panel">
      <div className="research-tool-heading">
        <div>
          <div className="research-section-label">Figures & Export</div>
          <h2>图稿与导出</h2>
          <p>选择已发布图稿和批准正文，准备最终 ZIP，审核后再保存到新文件。</p>
        </div>
      </div>
      <div className="research-library-layout">
        <div className="research-literature-list" data-testid="research-figure-list">
          {figures.length === 0 ? <div className="research-loading">还没有已发布图稿。</div> : figures.map((figure) => (
            <label className="research-literature-row" key={figure.id}>
              <input type="checkbox" data-testid={`research-figure-toggle-${figure.id}`} checked={selectedFigureIds.includes(figure.id)} onChange={() => onToggleFigure(figure.id)} />
              <strong>{figure.title}</strong>
              <span>{figure.status === 'approved' ? '已批准' : figure.status === 'superseded' ? '已替换' : '已渲染'}</span>
            </label>
          ))}
        </div>
        <form className="research-idea-form" onSubmit={(event) => { event.preventDefault(); onPrepareExport(); }}>
          <p data-testid="research-export-manuscript">{manuscript === null ? '需要一份已批准正文才能准备导出。' : `正文：${manuscript.title}`}</p>
          <label>
            导出标题
            <input data-testid="research-export-title" value={title} onChange={(event) => onChangeTitle(event.target.value)} />
          </label>
          <button className="action-button action-button--primary" disabled={writeBlocked || manuscript === null || title.trim().length === 0} type="submit" data-testid="research-export-prepare">
            <Send aria-hidden="true" size={15} />
            准备导出
          </button>
        </form>
      </div>
      <div className="research-literature-list" data-testid="research-export-list">
        {exports.length === 0 ? <div className="research-loading">还没有导出作业。</div> : exports.map((record) => (
          <article className="research-literature-row" key={record.id}>
            <div className="research-literature-source">{record.status} · {record.approval}</div>
            <h3>{record.request.title}</h3>
            {record.error === null ? null : <p>{record.error}</p>}
            <div className="research-stage-actions">
              {record.status === 'ready' && record.approval === 'unpublished' ? (
                <button className="action-button" type="button" data-testid={`research-export-publish-${record.id}`} disabled={writeBlocked} onClick={() => onPublishExport(record.id)}>发布审核</button>
              ) : null}
              {record.approval === 'approved' ? (
                <>
                  <input data-testid={`research-export-destination-${record.id}`} value={destinationPath} onChange={(event) => onChangeDestination(event.target.value)} placeholder="/absolute/path/paper.zip" />
                  <button className="action-button action-button--primary" type="button" data-testid={`research-export-write-${record.id}`} disabled={writeBlocked || destinationPath.trim().length === 0} onClick={() => onWriteExport(record.id)}>保存 ZIP</button>
                </>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
