import { CheckCircle2, CirclePlay, LoaderCircle, XCircle } from 'lucide-react';
import type { ChatTranscriptActivityBlock } from '../transcript';
import { ActivityBlockBody, ActivityBlockShell, type ActivityTone } from './activity-shell';
import { useActivityBlockState } from './use-activity-block-state';

/**
 * Tool-call block (T4.4), ported from `chat/tool-call/ToolCallBlock.tsx` (+ its
 * `ToolDataSection`, which nothing else used, so it lives here).
 *
 * Behaviour kept verbatim: the block is only expandable when it actually carries data
 * (input / output / error), and it opens itself on failure — a failed tool call is the
 * one state where the user needs the payload without asking. Everything else stays
 * collapsed so a long run reads as a list of actions rather than a wall of JSON.
 *
 * `ToolDataSection` serialises non-strings with `JSON.stringify(…, null, 2)` because
 * tool payloads are arbitrary structured data; a raw `String(data)` would print
 * `[object Object]`, which is how these blocks used to lose information.
 *
 * ## Not ported: the reference's 「前往对应视窗」 button
 *
 * The reference's tool row can end with a jump to the canvas surface the result belongs
 * to (`onOpenWorkspaceTab(tc.targetWorkspaceTab)`). Doing that here needs the tool's
 * **scope**, and `run-capability-manifest.ts` is the only place that knows whether a tool
 * is `workspace` / `memory` / `app` — the transcript does not carry it
 * (`ChatTranscriptActivityBlock` hands this block a `name` and payloads, nothing more).
 * The two ways to close the gap are both worse than recording it:
 *
 *   1. a name→view table in this file — a second copy of the manifest's tool list, which
 *      drifts silently the first time a tool is renamed (the backend refuses to keep a
 *      duplicate of the reserved-name guard for exactly this reason);
 *   2. adding `scope` to the run/transcript contract — a backend change, so not a
 *      frontend port at all.
 *
 * A button that guessed the destination from a tool's name would send the user to the
 * wrong surface *and be believed*, which is worse than the missing button.
 */
type ToolCallBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>;

const TOOL_STATE: Record<
  ToolCallBlockModel['status'],
  { label: string; tone: ActivityTone; Icon: typeof CirclePlay }
> = {
  start: { label: '开始', tone: 'start', Icon: CirclePlay },
  progress: { label: '执行中', tone: 'progress', Icon: LoaderCircle },
  end: { label: '成功', tone: 'end', Icon: CheckCircle2 },
  error: { label: '错误', tone: 'error', Icon: XCircle }
};

export type ToolCallBlockProps = {
  block: ToolCallBlockModel;
};

export function ToolCallBlock({ block }: ToolCallBlockProps): React.JSX.Element {
  const hasInput = block.input !== null && block.input !== undefined;
  const hasOutput = block.output !== null && block.output !== undefined;
  const hasError = block.error !== null && block.error !== undefined;
  const hasData = hasInput || hasOutput || hasError;
  const { open, setOpen } = useActivityBlockState({ defaultOpen: block.status === 'error' });
  const state = TOOL_STATE[block.status];

  return (
    <ActivityBlockShell
      testId="assistant-activity-tool"
      icon={state.Icon}
      title={block.name}
      statusLabel={state.label}
      tone={state.tone}
      open={hasData && open}
      onToggle={setOpen}
      expandable={hasData}
    >
      {hasData ? (
        <ActivityBlockBody testId="assistant-tool-body">
          {hasInput ? <ToolDataSection label="输入" data={block.input} /> : null}
          {hasOutput ? <ToolDataSection label="输出" data={block.output} /> : null}
          {hasError ? <ToolDataSection label="错误" data={block.error} variant="error" /> : null}
        </ActivityBlockBody>
      ) : null}
    </ActivityBlockShell>
  );
}

export function ToolDataSection({
  label,
  data,
  variant = 'default'
}: {
  label: string;
  data: unknown;
  variant?: 'default' | 'error';
}): React.JSX.Element {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  return (
    <div className="mb-1.5 last:mb-0" data-testid={`assistant-tool-data-${label}`}>
      <div className="mb-1 text-subtle text-[var(--font-meta-size)]">{label}</div>
      <pre
        className={
          variant === 'error'
            ? 'max-h-[320px] overflow-auto whitespace-pre-wrap rounded-control border border-line bg-[var(--tool-st-error-bg)] p-2 font-mono text-[var(--tool-st-error-text)] text-[var(--font-code-size)]'
            : 'max-h-[320px] overflow-auto whitespace-pre-wrap rounded-control border border-line bg-code-surface p-2 font-mono text-[var(--code-text)] text-[var(--font-code-size)]'
        }
      >
        {text}
      </pre>
    </div>
  );
}
