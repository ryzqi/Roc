import type {z} from 'zod';
import type {researchArtifactInspectionSchema} from '../../shared/schemas/research-artifact-inspector';
import {MarkdownView} from '../assistant/blocks/markdown-view';
import {ScientificReviewView} from './ScientificReviewView';

export function ArtifactStageContent({snapshot}: {snapshot: z.infer<typeof researchArtifactInspectionSchema>}): React.JSX.Element {
  return <section className="flex flex-col gap-2" aria-label="保存的工件内容" data-testid="artifact-inspector-content">
    {snapshot.content === null ? <p className="text-muted">该工件尚无已保存的角色正文。</p> :
      <MarkdownView text={snapshot.content.output.markdown} />}
    {snapshot.scientificReview === undefined ? null : <ScientificReviewView report={snapshot.scientificReview}/>}
    {snapshot.claims.length === 0 ? null : <div className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2">
      <h2 className="font-medium text-ink">保存的主张</h2>
      {snapshot.claims.map(claim => <div key={claim.id} className="border-b-[0.5px] border-line py-2">
        <p className="break-words text-ink">{claim.content}</p>
        <p className="mt-1 text-muted">版本 {claim.version}，{claim.status === 'hypothesis' ? '假设' : claim.status === 'pending' ? '待核对' : '原保存状态：支持'}</p>
      </div>)}
    </div>}
  </section>;
}
