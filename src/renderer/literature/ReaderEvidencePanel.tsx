import {useState} from 'react';
import {formButtonClass} from '../shared/form-ui';
import {useWorkspaceScope} from '../app/workspace-scope';
import type {LiteratureStore} from './use-literature-store';

/** Displays the shared inspected evidence snapshot; no evidence is inferred from selected text. */
export function ReaderEvidencePanel({literature}: {literature: LiteratureStore}): React.JSX.Element {
  const scope = useWorkspaceScope();
  const [shown, setShown] = useState(20);
  const itemId = literature.selected?.id;
  const snapshot = literature.wikiSnapshot;
  const sourceIds = new Set(snapshot?.papers.filter(paper => paper.libraryItemId === itemId).map(paper => paper.evidenceId));
  const sources = snapshot?.sources.filter(source => source.evidence.sourceId === itemId || sourceIds.has(source.evidence.id)) ?? [];
  return <section className="reading-inspector-scroll" aria-label="当前文献证据" data-testid="reader-evidence">
    {literature.derivedStatus === 'loading' && snapshot === null ? <p role="status">正在读取证据…</p> : null}
    {literature.derivedError ? <div><p role="alert">{literature.derivedError}</p>
      <button type="button" className={formButtonClass} onClick={literature.reloadDerived}>重试读取证据</button></div> : null}
    {sources.length === 0 && literature.derivedStatus === 'ready' ? <p className="text-muted">当前文献尚无已保存证据</p> : null}
    <ul className="reading-evidence-list">{sources.slice(0, shown).map(source => <li key={source.evidence.id}>
      <p className="font-medium">{source.evidence.title}</p>
      <p className="text-muted">{source.evidence.locator}</p>
      <p className={source.referenceStatus === 'superseded' ? 'text-[var(--st-warn)]' : 'text-muted'}>
        {source.referenceStatus === 'superseded' ? '来源已失效，保留历史摘录' : '已记录来源'}
      </p>
      <blockquote>{source.evidence.excerpt}</blockquote>
      {source.sourceLocator ? <button type="button" className={formButtonClass}
        data-testid={`reader-evidence-open-${source.evidence.id}`} onClick={() => scope.openLiterature({
          kind: 'reader', libraryItemId: itemId ?? null, parseId: source.sourceLocator!.parseId,
          locator: source.sourceLocator!.rawLocator, text: source.evidence.excerpt
        })}>{source.referenceStatus === 'superseded' ? '查看历史原文' : '定位原文'}</button>
        : <p className="text-muted">未记录解析位置</p>}
    </li>)}</ul>
    {sources.length > shown ? <button type="button" className={formButtonClass} onClick={() => setShown(value => value + 20)}>显示更多证据</button> : null}
  </section>;
}
