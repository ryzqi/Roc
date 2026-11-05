import {createContext, useContext} from 'react';
import {researchReviewLinksSchema, reviewLinksPayload} from '../../../shared/schemas/research-review-links';
import type {OpenReviewInspector} from '../../artifacts/artifact-interactions';

const Context = createContext<{projectId: string | null; open: OpenReviewInspector} | null>(null);
export const ReviewLinkActionsProvider = Context.Provider;

export function ReviewLinkActions({output}: {output: unknown}): React.JSX.Element | null {
  const scope = useContext(Context);
  const payload = reviewLinksPayload(output);
  if (payload === undefined) return null;
  const links = researchReviewLinksSchema.safeParse(payload);
  if (!links.success) return <p role="alert" className="text-[var(--st-warn)]">综述回执链接无效，无法打开。</p>;
  if (scope === null) throw new Error('review_link_scope_missing');
  return <ul className="flex flex-col gap-1" data-testid="assistant-review-links">
    {links.data.map(link => <li key={JSON.stringify([link.projectId, link.target])}>
      <button type="button" data-testid="assistant-review-link" disabled={link.projectId !== scope.projectId}
        className="break-words text-left text-ink underline decoration-line underline-offset-2 hover:decoration-current disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onClick={() => scope.open({...link, mode: 'readonly'})}>{link.title}</button>
      {link.projectId === scope.projectId ? null : <p className="text-muted">回执属于其他项目。</p>}
    </li>)}
  </ul>;
}
