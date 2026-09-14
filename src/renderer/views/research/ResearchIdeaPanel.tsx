import { Send } from 'lucide-react';

import type { ResearchArtifact, ResearchEvidence, ResearchIdeaCanvas, ResearchIdeaCanvasSaveRequest } from '../../../shared/types';

const fieldLabels: Record<ResearchIdeaCanvasSaveRequest['fields'][number]['key'], string> = {
  problem: '问题',
  hypothesis: '假设',
  novelty: '新颖性',
  supportingEvidence: '支持证据',
  counterevidence: '反证',
  experiment: '实验',
  risks: '风险'
};

const fieldKeys = ['problem', 'hypothesis', 'novelty', 'supportingEvidence', 'counterevidence', 'experiment', 'risks'] as const;

export function emptyIdeaDraft(artifactId: string): ResearchIdeaCanvasSaveRequest {
  const fields = fieldKeys.map((key) => ({
    key, content: '', status: key === 'supportingEvidence' || key === 'problem' ? 'pending' as const : 'hypothesis' as const, evidenceIds: [] as string[]
  }));
  return {
    artifactId, expectedVersion: null, problem: '', hypothesis: '', novelty: '', supportingEvidence: '', counterevidence: '',
    experiment: '', risks: '', priority: 'medium', rationale: '', fields
  };
}

export function canvasToDraft(canvas: ResearchIdeaCanvas): ResearchIdeaCanvasSaveRequest {
  return {
    artifactId: canvas.artifactId, expectedVersion: canvas.version, problem: canvas.problem, hypothesis: canvas.hypothesis,
    novelty: canvas.novelty, supportingEvidence: canvas.supportingEvidence, counterevidence: canvas.counterevidence,
    experiment: canvas.experiment, risks: canvas.risks, priority: canvas.priority, rationale: canvas.rationale, fields: canvas.fields
  };
}

export function ResearchIdeaPanel({
  artifacts,
  canvas,
  draft,
  evidence,
  onChange,
  onCreate,
  onPromote,
  onSave,
  onSelect,
  selectedArtifactId,
  working
}: {
  artifacts: ResearchArtifact[];
  canvas: ResearchIdeaCanvas | null;
  draft: ResearchIdeaCanvasSaveRequest | null;
  evidence: ResearchEvidence[];
  onChange: (draft: ResearchIdeaCanvasSaveRequest) => void;
  onCreate: () => void;
  onPromote: () => void;
  onSave: () => void;
  onSelect: (artifactId: string) => void;
  selectedArtifactId: string | null;
  working: boolean;
}): React.JSX.Element {
  const canvases = artifacts.filter((artifact) => artifact.kind === 'idea_canvas');
  return (
    <section className="research-tool-panel" data-testid="research-idea-panel">
      <div className="research-tool-heading">
        <div>
          <div className="research-section-label">Idea Canvas</div>
          <h2>构思画布</h2>
          <p>分别记录问题、假设、新颖性、证据、实验和风险。已批准版本可晋升为新项目。</p>
        </div>
        <button className="action-button action-button--primary" disabled={working} type="button" data-testid="research-idea-create" onClick={onCreate}>新建画布</button>
      </div>
      <div className="research-library-layout">
        <div className="research-literature-list" data-testid="research-idea-list">
          {canvases.length === 0 ? <div className="research-loading">还没有 Idea Canvas。先新建或让构思角色生成一份。</div> : canvases.map((artifact) => (
            <button className={artifact.id === selectedArtifactId ? 'research-literature-row research-library-row--active' : 'research-literature-row'} key={artifact.id} type="button" onClick={() => onSelect(artifact.id)}>
              <strong>{artifact.title}</strong>
              <span>{artifact.status === 'approved' ? '已批准' : artifact.status === 'superseded' ? '已替换' : '草稿'}</span>
            </button>
          ))}
        </div>
        {draft === null ? <div className="research-loading">选择一份画布开始编辑。</div> : (
          <form className="research-idea-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
            {fieldKeys.map((key, index) => {
              const field = draft.fields[index]!;
              return (
                <label key={key}>
                  {fieldLabels[key]}
                  <textarea data-testid={`research-idea-field-${key}`} value={field.content} onChange={(event) => onChange(updateField(draft, key, event.target.value))} rows={key === 'counterevidence' ? 2 : 3} />
                  <span>
                    <select value={field.status} onChange={(event) => onChange(updateFieldStatus(draft, key, event.target.value as typeof field.status))}>
                      <option value="supported">已支持</option>
                      <option value="hypothesis">假设</option>
                      <option value="pending">待验证</option>
                    </select>
                    <select multiple size={3} value={field.evidenceIds} onChange={(event) => onChange(updateFieldEvidence(draft, key, Array.from(event.target.selectedOptions, (option) => option.value)))}>
                      {evidence.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.locator}</option>)}
                    </select>
                  </span>
                </label>
              );
            })}
            <label>
              优先级
              <select data-testid="research-idea-priority" value={draft.priority} onChange={(event) => onChange({ ...draft, priority: event.target.value as ResearchIdeaCanvasSaveRequest['priority'] })}>
                <option value="high">高</option>
                <option value="medium">中</option>
                <option value="low">低</option>
              </select>
            </label>
            <label>
              优先级依据
              <textarea data-testid="research-idea-rationale" value={draft.rationale} onChange={(event) => onChange({ ...draft, rationale: event.target.value })} rows={2} />
            </label>
            <div className="research-form-actions">
              <button className="action-button action-button--primary" disabled={working} type="submit" data-testid="research-idea-save">
                <Send aria-hidden="true" size={15} />
                保存画布
              </button>
              <button className="action-button" disabled={working || canvas?.artifactId !== draft.artifactId} type="button" data-testid="research-idea-promote" onClick={onPromote}>晋升为项目</button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

function updateField(draft: ResearchIdeaCanvasSaveRequest, key: ResearchIdeaCanvasSaveRequest['fields'][number]['key'], content: string): ResearchIdeaCanvasSaveRequest {
  const fields = draft.fields.map((field) => field.key === key ? { ...field, content } : field);
  return { ...draft, [key]: content, fields };
}

function updateFieldStatus(draft: ResearchIdeaCanvasSaveRequest, key: ResearchIdeaCanvasSaveRequest['fields'][number]['key'], status: ResearchIdeaCanvasSaveRequest['fields'][number]['status']): ResearchIdeaCanvasSaveRequest {
  return { ...draft, fields: draft.fields.map((field) => field.key === key ? { ...field, status } : field) };
}

function updateFieldEvidence(draft: ResearchIdeaCanvasSaveRequest, key: ResearchIdeaCanvasSaveRequest['fields'][number]['key'], evidenceIds: string[]): ResearchIdeaCanvasSaveRequest {
  return { ...draft, fields: draft.fields.map((field) => field.key === key ? { ...field, evidenceIds } : field) };
}
