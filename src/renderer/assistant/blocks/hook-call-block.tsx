import { Ban, CheckCircle2, CircleOff, LoaderCircle, SkipForward } from 'lucide-react';
import type { ChatTranscriptActivityBlock } from '../transcript';
import { ActivityBlockBody, ActivityBlockShell, type ActivityTone } from './activity-shell';
import { useActivityBlockState } from './use-activity-block-state';

/**
 * Hook-call block (T4.4), ported from `chat/hook-call/HookCallBlock.tsx`.
 *
 * Kept: the five-state vocabulary (`running` / `completed` / `failed` / `blocked` /
 * `skipped`) and the metadata list. `blocked` is deliberately **not** folded into
 * `failed` — a hook that refused a tool call is the guardrail working, and showing it
 * as an error would push users to look for a bug that is not there.
 *
 * `durationMs === null` renders 运行中 rather than `0ms`, so a still-running hook does
 * not read as instant.
 */
type HookCallBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'hook_call' }>;

const HOOK_STATE: Record<
  HookCallBlockModel['status'],
  { label: string; tone: ActivityTone; Icon: typeof Ban }
> = {
  running: { label: '执行中', tone: 'progress', Icon: LoaderCircle },
  completed: { label: '完成', tone: 'end', Icon: CheckCircle2 },
  failed: { label: '失败', tone: 'error', Icon: CircleOff },
  blocked: { label: '阻止', tone: 'error', Icon: Ban },
  skipped: { label: '跳过', tone: 'start', Icon: SkipForward }
};

function formatDuration(durationMs: number | null): string {
  return durationMs === null ? '运行中' : `${durationMs}ms`;
}

export type HookCallBlockProps = {
  block: HookCallBlockModel;
};

export function HookCallBlock({ block }: HookCallBlockProps): React.JSX.Element {
  const state = HOOK_STATE[block.status];
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: block.status === 'failed' || block.status === 'blocked'
  });

  const rows: Array<{ label: string; value: string }> = [
    { label: 'command', value: block.commandDisplay },
    { label: 'handler', value: block.handlerId },
    { label: 'duration', value: formatDuration(block.durationMs) }
  ];
  if (block.message !== null) {
    rows.push({ label: 'message', value: block.message });
  }
  if (block.additionalContext !== null) {
    rows.push({ label: 'context', value: block.additionalContext });
  }
  if (block.requestContinue !== null) {
    rows.push({ label: 'request', value: block.requestContinue });
  }

  return (
    <ActivityBlockShell
      testId="assistant-activity-hook"
      icon={state.Icon}
      title={`Hook · ${block.event}`}
      statusLabel={state.label}
      tone={state.tone}
      open={open}
      onToggle={setOpen}
    >
      <ActivityBlockBody testId="assistant-hook-body">
        <dl className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <div key={row.label} className="flex gap-2">
              <dt className="w-[68px] shrink-0 text-subtle text-[var(--font-micro-size)]">{row.label}</dt>
              <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[var(--code-text)] text-[var(--font-code-size)]">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </ActivityBlockBody>
    </ActivityBlockShell>
  );
}
