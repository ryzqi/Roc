import type {WikiScientificExplanation as Explanation} from '../../shared/schemas/research-wiki-pages';
import type {RocClient} from '../shared/roc-client';
import {ScientificStatementReference} from './ScientificPaperKnowledge';
import {statementReferenceKey} from './scientific-wiki';

const kinds = {source_statement: '原文陈述', paraphrase: '综合解释', comparison: '条件对齐比较', inference: '模型推断'};
const support = {supported: '支持', unsupported: '不支持', uncertain: '不确定', not_checked: '未检查'};

/** Generated prose remains separate from the immutable source records and human approval. */
export function WikiScientificExplanation({client, projectId, explanation, current, sourceReady}: {
  client: RocClient; projectId: string; explanation: Explanation; current: boolean; sourceReady: boolean
}): React.JSX.Element {
  return <div className="space-y-4 py-4" data-testid="wiki-explanation">
    <p className="break-words text-xs text-subtle">{explanation.goal}</p>
    {explanation.statements.map((statement, index) => <div key={index} className="space-y-2" data-testid="wiki-explanation-statement">
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-subtle">
        <span>{kinds[statement.kind]}</span><span>未人工审核</span>
        <span>{current ? statement.validation === 'source_validated' ? '来源已核对' : '待人工核验' : '依据已改变，待更新'}</span>
      </p>
      <p className="whitespace-pre-wrap break-words leading-relaxed">{statement.text}</p>
      <p className="text-xs text-subtle">模型审核建议：{support[statement.semanticSupport]}</p>
      {sourceReady && statement.references.map((reference, ordinal) => <ScientificStatementReference
        key={`${statementReferenceKey(reference)}:${ordinal}`} client={client} projectId={projectId} statement={reference}/>)}
    </div>)}
    {explanation.unresolvedQuestions.length > 0 && <details>
      <summary className="cursor-pointer text-xs">未解决问题（{explanation.unresolvedQuestions.length}）</summary>
      <ul className="list-disc space-y-2 py-2 pl-5 text-xs">{explanation.unresolvedQuestions.map((question, index) =>
        <li key={index} className="break-words">{question}</li>)}</ul>
    </details>}
  </div>;
}
