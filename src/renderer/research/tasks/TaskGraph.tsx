import type {ResearchTaskGraph} from '../../../shared/schemas/research-task-graph';
import {FormSection} from '../../shared/form-ui';
import {formatBeijingDateTime} from '../../shared/format';

const labels = {pending: '等待执行', ready: '可以执行', running: '执行中', pending_review: '等待人工审核',
  done: '已接受', failed: '失败', cancelled: '已取消', interrupted: '已中断', blocked: '已阻止'};
const reasons: Record<string, string> = {
  research_node_dependency_pending: '等待前置结果被接受', research_node_capacity_pending: '等待执行名额',
  research_node_writer_pending: '等待当前项目写入完成', research_node_review_pending: '等待人工审核',
  research_node_lease_expired: '执行授权已过期', research_task_effect_unresolved: '操作结果待核实',
  research_node_human_rejected: '人工审核未接受结果'
};

export function TaskGraph({graph}: {graph: ResearchTaskGraph}): React.JSX.Element {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  return <FormSection title="任务依赖" testId="mgmt-task-graph">
    {graph.nodes.length === 0 ? <p className="text-subtle">此任务没有阶段节点。</p> :
      <ol className="grid gap-3">
        {graph.nodes.map(node => <li key={node.id} className="grid gap-1" data-testid="mgmt-task-node">
          <div className="flex flex-wrap justify-between gap-2"><span>{node.role}</span><span>{labels[node.status]}</span></div>
          <p className="text-subtle tabular-nums">尝试 {node.attempt} / 输入版本 {node.revision} / 结果版本 {node.outputRevision}</p>
          {node.reason === null ? null : <p className="break-words text-subtle">{reasons[node.reason] ?? node.reason}</p>}
          {graph.edges.filter(edge => edge.dependent === node.id).map(edge =>
            <p key={edge.prerequisite} className="break-words text-subtle">前置：{nodes.get(edge.prerequisite)?.role ?? edge.prerequisite}</p>)}
          <details className="text-subtle">
            <summary className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">执行记录</summary>
            <div className="grid gap-1 break-all pt-2 font-mono text-[var(--font-meta-size)]">
              <p>节点 {node.id}</p><p>执行 {node.executionId}</p>
              <p>输入 {node.inputHash}</p>
              {node.lease === null ? <p>当前无执行租约</p> : <p>租约 {node.generation} / 到期 {formatBeijingDateTime(node.lease.expiresAt)}</p>}
              {node.output === null ? null : <><p>结果 {node.output.hash}</p>{node.output.artifactIds.map(id => <p key={id}>工件 {id}</p>)}</>}
            </div>
          </details>
        </li>)}
      </ol>}
  </FormSection>;
}
