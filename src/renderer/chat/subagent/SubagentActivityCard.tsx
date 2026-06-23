import { Bot, CheckCircle2, ChevronDown, CirclePlay, LoaderCircle, XCircle } from 'lucide-react';
import type { ChatTranscriptActivityBlock, ChatTranscriptSubagentBlock } from '../../chat-transcript';
import { ActivityBlockShell } from '../activity-block/ActivityBlockShell';
import { useActivityBlockState } from '../activity-block/use-activity-block-state';
import { ReasoningBlock } from '../reasoning/ReasoningBlock';
import { StreamingMarkdownView } from '../streaming-markdown-view';
import { ToolCallView } from '../tool-call-view';

type SubagentBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>;

type SubagentActivityCardProps = {
  block: SubagentBlockModel;
  depth?: number;
};

const STATUS_LABEL = {
  started: '开始',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消'
} satisfies Record<SubagentBlockModel['status'], string>;

function SubagentStatusIcon({ status }: { status: SubagentBlockModel['status'] }): React.JSX.Element {
  if (status === 'started') {
    return <CirclePlay aria-hidden="true" size={13} strokeWidth={2.4} />;
  }
  if (status === 'running') {
    return <LoaderCircle aria-hidden="true" size={13} strokeWidth={2.4} />;
  }
  if (status === 'completed') {
    return <CheckCircle2 aria-hidden="true" size={13} strokeWidth={2.4} />;
  }
  return <XCircle aria-hidden="true" size={13} strokeWidth={2.4} />;
}

function countToolBlocks(blocks: readonly ChatTranscriptSubagentBlock[]): number {
  return blocks.filter((block) => block.kind === 'tool_call').length;
}

function hasReasoningBlock(blocks: readonly ChatTranscriptSubagentBlock[]): boolean {
  return blocks.some((block) => block.kind === 'reasoning');
}

function buildMetaChips(block: SubagentBlockModel): string[] {
  const chips: string[] = [block.identity.execution];
  const toolCount = countToolBlocks(block.blocks);
  if (toolCount > 0) {
    chips.push(`${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`);
  }
  const childCount = block.children.length;
  if (childCount > 0) {
    chips.push(`${childCount} ${childCount === 1 ? 'child' : 'children'}`);
  }
  if (hasReasoningBlock(block.blocks)) {
    chips.push('reasoning');
  }
  return chips;
}

function renderSubagentBlock(block: ChatTranscriptSubagentBlock, isStreaming: boolean): React.JSX.Element {
  if (block.kind === 'text') {
    return <StreamingMarkdownView key={block.id} text={block.content} isStreaming={isStreaming} />;
  }
  if (block.kind === 'reasoning') {
    return <ReasoningBlock key={block.id} id={block.id} content={block.content} isStreaming={block.isStreaming} />;
  }
  return <ToolCallView key={block.id} block={block} />;
}

export function SubagentActivityCard({ block, depth = 0 }: SubagentActivityCardProps): React.JSX.Element {
  const isNested = depth > 0;
  const isStreaming = block.status === 'started' || block.status === 'running';
  const metaChips = buildMetaChips(block);
  const hasBody =
    block.error !== null ||
    block.summary !== null ||
    block.blocks.length > 0 ||
    block.children.length > 0;
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: block.status === 'failed'
  });
  const className = [
    'subagent-card',
    `subagent-card--${block.status}`,
    isNested ? 'subagent-card--nested' : ''
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  return (
    <ActivityBlockShell
      className={className}
      dataTestId="chat-activity-subagent"
      open={hasBody && open}
      onToggle={setOpen}
      header={
        <summary className="subagent-card__header">
          <span className="subagent-card__icon">
            <SubagentStatusIcon status={block.status} />
          </span>
          <span className="subagent-card__title">
            <Bot aria-hidden="true" size={13} strokeWidth={2.4} />
            <span>{`Subagent · ${block.identity.name}`}</span>
          </span>
          <span className={`subagent-card__badge subagent-card__badge--${block.status}`}>
            {STATUS_LABEL[block.status]}
          </span>
          {hasBody ? <ChevronDown className="subagent-card__expand" aria-hidden="true" size={14} strokeWidth={2.2} /> : null}
        </summary>
      }
    >
      {metaChips.length === 0 ? null : (
        <div className="subagent-card__meta" aria-label="子代理元信息">
          {metaChips.map((chip) => (
            <span key={chip} className="subagent-card__chip">
              {chip}
            </span>
          ))}
        </div>
      )}
      {hasBody ? (
        <div className="subagent-card__body">
          {block.error === null ? null : <pre className="subagent-card__error">{block.error}</pre>}
          {block.summary === null ? null : <p className="subagent-card__summary">{block.summary}</p>}
          {block.blocks.map((child) => renderSubagentBlock(child, isStreaming))}
          {block.children.map((child) => (
            <div key={child.id} className="subagent-card__child" data-testid="chat-activity-subagent-child">
              <SubagentActivityCard block={child} depth={depth + 1} />
            </div>
          ))}
        </div>
      ) : null}
    </ActivityBlockShell>
  );
}
