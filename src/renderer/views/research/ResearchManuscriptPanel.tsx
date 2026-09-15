import { Send } from 'lucide-react';

import type { ResearchArtifact, ResearchClaim, ResearchEvidence, ResearchManuscript } from '../../../shared/types';

export type ResearchManuscriptDraft = {
  content: string;
  status: ResearchClaim['status'];
  evidenceIds: string[];
  sectionTitle: string;
  selectedClaimIds: string[];
};

export const emptyManuscriptDraft: ResearchManuscriptDraft = {
  content: '',
  status: 'hypothesis',
  evidenceIds: [],
  sectionTitle: 'Results',
  selectedClaimIds: []
};

const statusLabels: Record<ResearchClaim['status'], string> = {
  supported: '已支持',
  hypothesis: '假设',
  pending: '待验证'
};

export function ResearchManuscriptPanel({
  artifacts,
  claims,
  draft,
  evidence,
  manuscript,
  onChange,
  onCreate,
  onCreateClaim,
  onSave,
  onSelect,
  selectedArtifactId,
  working
}: {
  artifacts: ResearchArtifact[];
  claims: ResearchClaim[];
  draft: ResearchManuscriptDraft;
  evidence: ResearchEvidence[];
  manuscript: ResearchManuscript | null;
  onChange: (draft: ResearchManuscriptDraft) => void;
  onCreate: () => void;
  onCreateClaim: () => void;
  onSave: () => void;
  onSelect: (artifactId: string) => void;
  selectedArtifactId: string | null;
  working: boolean;
}): React.JSX.Element {
  const manuscripts = artifacts.filter((artifact) => artifact.kind === 'manuscript');
  return (
    <section className="research-tool-panel" data-testid="research-manuscript-panel">
      <div className="research-tool-heading">
        <div>
          <div className="research-section-label">Manuscript</div>
          <h2>主张与正文</h2>
          <p>把证据绑定到段落主张，保存后生成可审核的 LaTeX 正文。</p>
        </div>
        <button className="action-button action-button--primary" disabled={working} type="button" data-testid="research-manuscript-create" onClick={onCreate}>新建正文</button>
      </div>
      <div className="research-library-layout">
        <div className="research-literature-list" data-testid="research-manuscript-list">
          {manuscripts.length === 0 ? <div className="research-loading">还没有正文。先新建一份，再写入主张。</div> : manuscripts.map((artifact) => (
            <button className={artifact.id === selectedArtifactId ? 'research-literature-row research-library-row--active' : 'research-literature-row'} key={artifact.id} type="button" onClick={() => onSelect(artifact.id)}>
              <strong>{artifact.title}</strong>
              <span>{artifact.status === 'approved' ? '已批准' : artifact.status === 'superseded' ? '已替换' : '草稿'}</span>
            </button>
          ))}
        </div>
        {selectedArtifactId === null ? <div className="research-loading">选择一份正文开始编辑。</div> : (
          <form className="research-idea-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
            <label>
              主张内容
              <textarea data-testid="research-claim-content" spellCheck={true} value={draft.content} onChange={(event) => onChange({ ...draft, content: event.target.value })} rows={4} />
            </label>
            <label>
              状态
              <select data-testid="research-claim-status" value={draft.status} onChange={(event) => onChange({ ...draft, status: event.target.value as ResearchClaim['status'] })}>
                <option value="supported">已支持</option>
                <option value="hypothesis">假设</option>
                <option value="pending">待验证</option>
              </select>
            </label>
            <label>
              证据
              <select data-testid="research-claim-evidence" multiple size={4} value={draft.evidenceIds} onChange={(event) => onChange({ ...draft, evidenceIds: Array.from(event.target.selectedOptions, (option) => option.value) })}>
                {evidence.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.locator}</option>)}
              </select>
            </label>
            <div className="research-form-actions">
              <button className="action-button" disabled={working || draft.content.trim().length === 0} type="button" data-testid="research-claim-create" onClick={onCreateClaim}>添加主张</button>
            </div>
            <div className="research-literature-list" data-testid="research-claim-list">
              {claims.length === 0 ? <div className="research-loading">还没有主张。</div> : claims.map((claim) => (
                <label className="research-literature-row" key={claim.id}>
                  <input type="checkbox" data-testid={`research-claim-toggle-${claim.id}`} checked={draft.selectedClaimIds.includes(claim.id)} onChange={() => onChange(toggleClaim(draft, claim.id))} />
                  <strong>{claim.content}</strong>
                  <span>{statusLabels[claim.status]}</span>
                </label>
              ))}
            </div>
            <label>
              章节标题
              <input data-testid="research-manuscript-section" value={draft.sectionTitle} onChange={(event) => onChange({ ...draft, sectionTitle: event.target.value })} />
            </label>
            <div className="research-form-actions">
              <button className="action-button action-button--primary" disabled={working || draft.sectionTitle.trim().length === 0 || draft.selectedClaimIds.length === 0} type="submit" data-testid="research-manuscript-save">
                <Send aria-hidden="true" size={15} />
                保存正文
              </button>
            </div>
            {manuscript === null ? null : <pre className="research-reader-content" data-testid="research-manuscript-latex">{manuscript.latex}</pre>}
          </form>
        )}
      </div>
    </section>
  );
}

function toggleClaim(draft: ResearchManuscriptDraft, claimId: string): ResearchManuscriptDraft {
  return {
    ...draft,
    selectedClaimIds: draft.selectedClaimIds.includes(claimId)
      ? draft.selectedClaimIds.filter((id) => id !== claimId)
      : [...draft.selectedClaimIds, claimId]
  };
}
