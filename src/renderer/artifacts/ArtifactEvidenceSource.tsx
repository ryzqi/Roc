import {lazy, Suspense, useState} from 'react';
import type {ResearchInspectedEvidence} from '../../shared/schemas/research-evidence-source';
import type {RocClient} from '../shared/roc-client';
import {formSecondaryButtonClass} from '../shared/form-ui';

const SourceMigrations = lazy(async () => ({default: (await import('./ArtifactSourceMigrations')).ArtifactSourceMigrations}));

export function ArtifactEvidenceSource({client, source, canDecide}: {
  client: RocClient; source: ResearchInspectedEvidence; canDecide: boolean
}): React.JSX.Element {
  const [showMigrations, setShowMigrations] = useState(false);
  const evidence = source.evidence;
  return <details data-reading-key={`evidence:${evidence.id}`} className="border-b-[0.5px] border-line py-2 [&::details-content]:overflow-clip!">
    <summary data-reading-key={`evidence-summary:${evidence.id}`} className="cursor-pointer break-words text-ink">{evidence.title}
      <span className="ml-2 text-muted">{source.referenceStatus === 'superseded' ? '旧定位已失效' : '已保存的来源片段'}</span>
    </summary>
    <p className="mt-2 break-words text-muted">{evidence.locator}</p>
    <blockquote className="mt-1 whitespace-pre-wrap break-words text-ink">{evidence.excerpt}</blockquote>
    {source.invalidatedAt === null ? null : <p className="text-muted">失效时间 {source.invalidatedAt}</p>}
    <p className="break-all text-muted">来源版本 {evidence.sourceVersion}</p>
    <p className="break-all font-mono text-[var(--font-meta-size)] text-muted">SHA-256 {evidence.contentHash}</p>
    {source.referenceStatus !== 'superseded' || source.sourceLocator === null ? null : <>
      <button type="button" className={`${formSecondaryButtonClass} mt-2 border-[0.5px]`}
        aria-expanded={showMigrations} data-testid={`artifact-source-migrations-toggle-${evidence.id}`}
        data-reading-key={`source-migrations-toggle:${evidence.id}`} onClick={() => setShowMigrations(open => !open)}>
        {showMigrations ? '收起定位候选' : '查看定位候选'}
      </button>
      {!showMigrations ? null : <Suspense fallback={<p role="status">正在加载定位候选…</p>}>
        <SourceMigrations client={client} projectId={evidence.projectId} evidenceId={evidence.id} canDecide={canDecide}/>
      </Suspense>}
    </>}
  </details>;
}
