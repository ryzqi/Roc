import {useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {experimentLabels} from '../artifacts/ClaimExperimentEditor';
import type {ClaimComparison} from '../../shared/schemas/research-claim-comparison';

const outcomes = {condition_difference: '条件差异，不能直接认定矛盾', undetermined: '信息不足，不可判定',
  comparable: '条件可比，仍需核查原文', conflict_candidate: '冲突候选，待人工审核'};
export function ClaimComparisonPanel({client, projectId}: {client: RocClient; projectId: string}): React.JSX.Element {
  const [opened, setOpened] = useState(false), [leftId, setLeft] = useState(''), [rightId, setRight] = useState('');
  const [result, setResult] = useState<ClaimComparison | null>(null);
  const claims = useAsyncResource(opened ? `compare:${projectId}` : null, () => client.api.research.listClaims({projectId}),
    {label: '读取比较主张'});
  const compare = useAsyncAction(() => {
    const left = claims.data?.find(claim => claim.id === leftId), right = claims.data?.find(claim => claim.id === rightId);
    if (!left || !right) throw new Error('请选择两个主张');
    return client.api.research.compareClaims({projectId, leftClaimId: leftId, rightClaimId: rightId,
      expectedLeftVersion: left.version, expectedRightVersion: right.version});
  }, {label: '比较实验条件'});
  return <details onToggle={event => {if (event.currentTarget.open) setOpened(true);}} data-testid="wiki-claim-comparison">
    <summary className="cursor-pointer">跨论文主张比较</summary>
    <p className="my-2 text-xs text-muted">比较依赖原始 Evidence。结果是未审核候选；确认关系请回到工件的人工审核入口。</p>
    <div className="flex flex-wrap gap-2">
      {(['left', 'right'] as const).map(side => <label key={side} className="flex min-w-0 flex-1 flex-col gap-1">
        {side === 'left' ? '主张 A' : '主张 B'}
        <select className={formInputClass} value={side === 'left' ? leftId : rightId} disabled={compare.pending}
          onChange={event => {setResult(null); (side === 'left' ? setLeft : setRight)(event.target.value);}}>
          <option value="">选择主张</option>{claims.data?.map(claim => <option key={claim.id} value={claim.id}>{claim.content.slice(0, 100)}</option>)}
        </select>
      </label>)}
      <button className={`${formSecondaryButtonClass} self-end`} disabled={!leftId || !rightId || leftId === rightId || compare.pending}
        onClick={async () => {setResult(null); const outcome = await compare.run(); if (outcome.ok) setResult(outcome.data);}}>比较条件</button>
    </div>
    {(claims.error || compare.error) && <p role="alert">{claims.error ?? compare.error}</p>}
    {result && <div className="mt-2">
      <p role="status">{outcomes[result.outcome]}</p>
      <table className="my-2 w-full table-fixed text-left text-xs"><thead><tr><th>字段</th><th>主张 A</th><th>主张 B</th></tr></thead>
        <tbody>{(Object.keys(experimentLabels) as Array<keyof typeof experimentLabels>).map(key => <tr key={key} className="border-t-[0.5px] border-line">
          <th className="py-1 align-top font-normal">{experimentLabels[key]}</th>
          <td className="break-words align-top">{result.left.experiment[key]}</td><td className="break-words align-top">{result.right.experiment[key]}</td>
        </tr>)}</tbody></table>
      {result.missing.length > 0 && <p>缺失字段：{result.missing.join('、')}</p>}
      <p className="break-all text-xs text-muted">原始证据 A：{result.left.evidenceIds.join('、') || 'unknown'}；B：{result.right.evidenceIds.join('、') || 'unknown'}</p>
    </div>}
  </details>;
}
