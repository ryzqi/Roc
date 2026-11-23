import {useId, useState} from 'react';
import {ChevronDown} from 'lucide-react';
import type {ResearchKnowledgeSearchHit} from '../../shared/types';
import {useViewSelected} from '../shared/view-activity';

/** A source index for the current retrieval; it never assigns scientific support. */
export function RagEvidenceSidebar({hits, selectedId, onSelect}: {
  hits: readonly ResearchKnowledgeSearchHit[];
  selectedId: string | null;
  onSelect: (hit: ResearchKnowledgeSearchHit) => void;
}): React.JSX.Element {
  const id = useId();
  const selected = useViewSelected();
  const [open, setOpen] = useState(false);
  return <aside className="rag-evidence-sidebar" aria-label="检索证据" data-testid="rag-evidence-sidebar" data-open={open}>
    <h3 className="rag-evidence-heading">证据目录 <span>{hits.length} 条</span></h3>
    <button type="button" className="rag-evidence-toggle rag-button" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>证据目录（{hits.length} 条）<ChevronDown size={14} aria-hidden="true"/></button>
    <div id={id} className="rag-evidence-list">
      <p className="rag-evidence-status">检索命中，支持关系待核验</p>
      <ol>{selected ? hits.map((hit, index) => <li key={hit.chunkId}>
        <button type="button" className="rag-evidence-link" aria-current={selectedId === hit.chunkId ? 'true' : undefined}
          data-testid={`rag-evidence-${hit.chunkId}`} onClick={() => {setOpen(false); onSelect(hit);}}>
          <span className="rag-evidence-title"><span className="tabular-nums">{index + 1}.</span> {hit.title}</span>
          <span className="rag-evidence-location">{hit.locator?.replace(/^page:(\d+)$/u, '第 $1 页') ?? '未提供页码'}</span>
          <span className="rag-evidence-excerpt">{hit.content}</span>
        </button>
      </li>) : null}</ol>
    </div>
  </aside>;
}
