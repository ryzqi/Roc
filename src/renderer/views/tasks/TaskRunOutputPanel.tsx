import { MarkdownView } from '../../chat/markdown-view';
import { Row } from '../../components/Row';
import type { TaskRunOutput } from './task-run-output';

export function TaskRunOutputPanel({
  output,
  compact = false
}: {
  output: TaskRunOutput;
  compact?: boolean;
}): React.JSX.Element {
  if (compact) {
    return (
      <div className="list-rows" data-testid="task-run-output">
        <Row
          title="运行输出"
          sub={buildCompactSummary(output)}
          tag={output.status}
          tone={resolveTone(output.status)}
        />
      </div>
    );
  }

  return (
    <div className="task-run-output" data-testid="task-run-output">
      <div className="list-rows">
        <Row title="运行状态" sub={output.userInput ?? '当前没有用户输入。'} tag={output.status} tone={resolveTone(output.status)} />
      </div>
      {output.reasoning.length === 0 ? null : (
        <details className="chat-bubble-reasoning" open>
          <summary>
            <span>推理</span>
          </summary>
          <div className="reasoning-body">
            <MarkdownView text={output.reasoning} />
          </div>
        </details>
      )}
      {output.assistantMessage.length === 0 ? null : (
        <div className="task-run-output-markdown">
          <MarkdownView text={output.assistantMessage} />
        </div>
      )}
      {output.error === null ? null : (
        <div className="list-rows">
          <Row title="运行错误" sub={output.error} tag="error" tone="warn" />
        </div>
      )}
      {output.tools.length === 0 ? null : (
        <div className="list-rows">
          {output.tools.map((tool, index) => (
            <Row
              key={`${tool.name}-${tool.status}-${index}`}
              title={`工具 · ${tool.name}`}
              sub={formatUnknown(tool.data)}
              tag={tool.status}
              tone={tool.status === 'error' ? 'warn' : 'info'}
            />
          ))}
        </div>
      )}
      {output.guardrails.length === 0 ? null : (
        <div className="list-rows">
          {output.guardrails.map((guardrail, index) => (
            <div className="row run-event--guardrail" key={`${guardrail.nudgeKind}-${guardrail.toolCallId ?? index}`}>
              <div className="row-copy">
                <div className="row-title">[护栏: {guardrail.nudgeKind}]</div>
                <div className="row-sub">
                  {guardrail.content}
                  {guardrail.toolName === null ? '' : ` · ${guardrail.toolName}`}
                </div>
              </div>
              <span className="pill info">{guardrail.tier === null ? 'audit' : `tier ${guardrail.tier}`}</span>
            </div>
          ))}
        </div>
      )}
      {output.subagents.length === 0 ? null : (
        <div className="list-rows">
          {output.subagents.map((subagent, index) => (
            <Row
              key={`${subagent.name}-${subagent.status}-${index}`}
              title={`子代理 · ${subagent.name}`}
              sub={subagent.summary ?? '无摘要'}
              tag={subagent.status}
              tone={subagent.status === 'failed' ? 'warn' : 'info'}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function buildCompactSummary(output: TaskRunOutput): string {
  if (output.reasoning.length > 0 && output.assistantMessage.length > 0) {
    return `${output.reasoning}\n${output.assistantMessage}`;
  }
  if (output.assistantMessage.length > 0) {
    return output.assistantMessage;
  }
  if (output.reasoning.length > 0) {
    return output.reasoning;
  }
  if (output.error !== null) {
    return output.error;
  }
  return '当前没有运行输出。';
}

function resolveTone(status: TaskRunOutput['status']): 'ok' | 'warn' | 'info' {
  if (status === 'completed') {
    return 'ok';
  }
  if (status === 'failed') {
    return 'warn';
  }
  return 'info';
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '无';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
