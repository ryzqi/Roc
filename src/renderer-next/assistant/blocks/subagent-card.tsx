import { lazy, Suspense } from 'react';
import { CheckCircle2, CirclePlay, LoaderCircle, XCircle } from 'lucide-react';
import type { ChatTranscriptActivityBlock, ChatTranscriptSubagentBlock } from '../transcript';
import { ActivityBlockShell, type ActivityTone } from './activity-shell';
import { useActivityBlockState } from './use-activity-block-state';
import { ReasoningBlock } from './reasoning-block';
import { ToolCallBlock } from './tool-call-block';

/**
 * Subagent card (T4.4), ported from `chat/subagent/SubagentActivityCard.tsx`.
 *
 * This is the block that proves the "reuse the reducer, don't rewrite the renderer"
 * decision (ADR-M04) was right: a subagent run nests text, reasoning, tool calls and
 * **other subagents** inside one card, and the tree shape comes from
 * `assistant/subagent-tree.ts` plus this recursion.
 *
 * Kept as-is:
 *   - the streaming behaviour (auto-open while `started`/`running`, auto-close a second
 *     after `completed`/`cancelled`, open on `failed`) — the same policy as reasoning;
 *   - the meta chips (`execution`, tool count, child count, reasoning) so a collapsed
 *     card still says what happened inside it;
 *   - lazy `StreamingMarkdownView`, which keeps `streamdown` out of the eager graph.
 *
 * Changed: legacy CSS classes → Tailwind + tokens, the header row now comes from the
 * shared `ActivityBlockShell`, and nesting is expressed by a left border + indent
 * instead of a `--nested` modifier class.
 */
const StreamingMarkdownView = lazy(async () => ({
  default: (await import('./streaming-markdown-view')).StreamingMarkdownView
}));

type SubagentBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>;

const SUBAGENT_STATE: Record<
  SubagentBlockModel['status'],
  { label: string; tone: ActivityTone; Icon: typeof CirclePlay }
> = {
  started: { label: '开始', tone: 'start', Icon: CirclePlay },
  running: { label: '运行中', tone: 'progress', Icon: LoaderCircle },
  completed: { label: '完成', tone: 'end', Icon: CheckCircle2 },
  failed: { label: '失败', tone: 'error', Icon: XCircle },
  cancelled: { label: '已取消', tone: 'neutral', Icon: XCircle }
};

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
    return (
      <Suspense key={block.id} fallback={null}>
        <StreamingMarkdownView text={block.content} isStreaming={isStreaming} />
      </Suspense>
    );
  }
  if (block.kind === 'reasoning') {
    return <ReasoningBlock key={block.id} id={block.id} content={block.content} isStreaming={block.isStreaming} />;
  }
  return <ToolCallBlock key={block.id} block={block} />;
}

export type SubagentActivityCardProps = {
  block: SubagentBlockModel;
  depth?: number;
};

export function SubagentActivityCard({ block, depth = 0 }: SubagentActivityCardProps): React.JSX.Element {
  const isStreaming = block.status === 'started' || block.status === 'running';
  const metaChips = buildMetaChips(block);
  const hasBody = block.error !== null || block.summary !== null || block.blocks.length > 0 || block.children.length > 0;
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: block.status === 'failed',
    forceOpenWhileStreaming: true,
    isStreaming,
    autoCloseDelayMs: block.status === 'completed' || block.status === 'cancelled' ? 1000 : undefined
  });
  const state = SUBAGENT_STATE[block.status];

  return (
    <div className={depth > 0 ? 'ml-2 border-l border-line-soft pl-1.5' : ''}>
      <ActivityBlockShell
        testId="assistant-activity-subagent"
        icon={state.Icon}
        title={`Subagent · ${block.identity.name}`}
        statusLabel={state.label}
        meta={block.identity.execution}
        tone={state.tone}
        open={hasBody && open}
        onToggle={setOpen}
        expandable={hasBody}
      >
        {hasBody ? (
          <div className="border-t border-line-soft px-2 py-1.5" data-testid="assistant-subagent-body">
            {metaChips.length === 0 ? null : (
              <div className="mb-1.5 flex flex-wrap gap-1" aria-label="子代理元信息">
                {metaChips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded-control bg-[var(--overlay-hover)] px-1.5 py-0.5 text-subtle text-[var(--font-micro-size)]"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            )}
            {block.error === null ? null : (
              <pre className="mb-1.5 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-control bg-[var(--tool-st-error-bg)] px-2 py-1 font-mono text-[var(--tool-st-error-text)] text-[var(--font-code-size)]">
                {block.error}
              </pre>
            )}
            {block.summary === null ? null : (
              <p className="mb-1 text-muted text-[var(--font-meta-size)]">{block.summary}</p>
            )}
            {block.blocks.map((child) => renderSubagentBlock(child, isStreaming))}
            {block.children.map((child) => (
              <div key={child.id} data-testid="assistant-subagent-child">
                <SubagentActivityCard block={child} depth={depth + 1} />
              </div>
            ))}
          </div>
        ) : null}
      </ActivityBlockShell>
    </div>
  );
}
