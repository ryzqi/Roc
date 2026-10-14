import { lazy, Suspense } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { ChatTranscriptActivityBlock } from '../transcript';
import { ActivityBlockShell } from './activity-shell';
import { useActivityBlockState } from './use-activity-block-state';

/**
 * Guardrail block (T4.4) — the fallback for activity kinds that are not tool/reasoning/
 * hook/subagent.
 *
 * The legacy message row rendered this inline as a bare `<details>`. It is a block like
 * any other here, so it gets the same header, chevron and collapsed-by-default
 * behaviour, and it names the tier and the tool that was blocked when the backend
 * supplies them — "a guardrail fired" is not actionable without them.
 */
const StreamingMarkdownView = lazy(async () => ({
  default: (await import('./streaming-markdown-view')).StreamingMarkdownView
}));

type GuardrailBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'guardrail' }>;

export function GuardrailBlock({ block }: { block: GuardrailBlockModel }): React.JSX.Element {
  const { open, setOpen } = useActivityBlockState({ defaultOpen: false });
  const meta =
    block.toolName === null
      ? block.tier === null
        ? undefined
        : `tier ${block.tier}`
      : block.tier === null
        ? block.toolName
        : `${block.toolName} · tier ${block.tier}`;

  return (
    <ActivityBlockShell
      testId="assistant-activity-guardrail"
      icon={ShieldAlert}
      title={`护栏 · ${block.nudgeKind}`}
      meta={meta}
      tone="error"
      open={open}
      onToggle={setOpen}
    >
      <div className="border-t border-line-soft px-2 py-1.5" data-testid="assistant-guardrail-body">
        <Suspense fallback={null}>
          <StreamingMarkdownView text={block.content} isStreaming={false} />
        </Suspense>
      </div>
    </ActivityBlockShell>
  );
}
