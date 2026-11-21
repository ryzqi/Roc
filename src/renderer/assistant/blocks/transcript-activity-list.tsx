import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ListChecks } from 'lucide-react';
import { reviewLinksPayload } from '../../../shared/schemas/research-review-links';
import type { ChatTranscriptActivityBlock } from '../transcript';
import { ActivityBlockShell } from './activity-shell';

type ActivityItem = { id: string; blocks: ChatTranscriptActivityBlock[] };

/** Preserve event order. Only routine successes may move behind a disclosure. */
function groupCompletedTools(blocks: ChatTranscriptActivityBlock[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  let completed: ChatTranscriptActivityBlock[] = [];
  const flush = (): void => {
    if (completed.length >= 3) {
      items.push({ id: `completed:${completed[0]!.id}`, blocks: completed });
    } else {
      items.push(...completed.map(block => ({ id: block.id, blocks: [block] })));
    }
    completed = [];
  };
  for (const block of blocks) {
    if (block.kind === 'tool_call' && block.status === 'end' && block.error == null &&
      reviewLinksPayload(block.output) === undefined) {
      completed.push(block);
    } else {
      flush();
      items.push({ id: block.id, blocks: [block] });
    }
  }
  flush();
  return items;
}

export function TranscriptActivityList({blocks, streaming, renderBlock}: {
  blocks: ChatTranscriptActivityBlock[];
  streaming: boolean;
  renderBlock: (block: ChatTranscriptActivityBlock) => ReactNode;
}): React.JSX.Element {
  // Keep the structure a reader has already seen. Grouping after streaming ends
  // would unmount focused disclosures and discard their expanded payloads.
  const [hasStreamed, setHasStreamed] = useState(streaming);
  useEffect(() => {
    if (streaming) setHasStreamed(true);
  }, [streaming]);
  const individual = streaming || hasStreamed;
  const items = useMemo(() => individual ? blocks.map(block => ({id: block.id, blocks: [block]}))
    : groupCompletedTools(blocks), [blocks, individual]);
  return <>{items.map(item => item.blocks.length === 1 ? renderBlock(item.blocks[0]!) :
    <CompletedToolGroup key={item.id} blocks={item.blocks} renderBlock={renderBlock} />)}</>;
}

function CompletedToolGroup({blocks, renderBlock}: {
  blocks: ChatTranscriptActivityBlock[];
  renderBlock: (block: ChatTranscriptActivityBlock) => ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <ActivityBlockShell testId="assistant-completed-tools" icon={ListChecks}
    title="工具执行记录" meta={`${blocks.length} 项已完成`} visualDensity="quiet"
    open={open} onToggle={setOpen}>
    <div className="flex min-w-0 flex-col gap-1 border-t-[0.5px] border-line-soft p-1">
      {blocks.map(renderBlock)}
    </div>
  </ActivityBlockShell>;
}
