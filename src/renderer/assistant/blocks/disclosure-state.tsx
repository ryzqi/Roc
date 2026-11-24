import {createContext, useContext, useMemo, type ReactNode} from 'react';
import type {ChatTranscriptActivityBlock, ChatTranscriptMessage, ChatTranscriptSubagentBlock} from '../transcript';

export type ActivityDisclosure = {open: boolean; revealOn: boolean; streaming: boolean; autoCloseAt: number | null};
export type ActivityDisclosureKind = 'block' | 'completed-tools';
export type MessageDisclosure = {blocks: Map<string, ActivityDisclosure>; hasStreamed: boolean};
const DisclosureContext = createContext<{state: MessageDisclosure; path: string} | null>(null);

export function MessageDisclosureProvider({state, children}: {state: MessageDisclosure; children: ReactNode}): React.JSX.Element {
  const value = useMemo(() => ({state, path: ''}), [state]);
  return <DisclosureContext.Provider value={value}>{children}</DisclosureContext.Provider>;
}

export function NestedDisclosureProvider({id, children}: {id: string; children: ReactNode}): React.JSX.Element {
  const parent = useContext(DisclosureContext);
  const value = useMemo(() => parent === null ? null : {...parent, path: `${parent.path}${JSON.stringify(id)}/`}, [parent, id]);
  return <DisclosureContext.Provider value={value}>{children}</DisclosureContext.Provider>;
}

export function useMessageDisclosure(): MessageDisclosure | null {
  return useContext(DisclosureContext)?.state ?? null;
}

export function useBlockDisclosure(key: string | undefined, kind: ActivityDisclosureKind = 'block'): {state: MessageDisclosure; key: string} | null {
  const context = useContext(DisclosureContext);
  return context === null || key === undefined ? null : {state: context.state, key: `${context.path}${JSON.stringify([kind, key])}`};
}

/** Scoped to one transcript window; no payloads or state for evicted blocks survive. */
export function retainDisclosureState(store: Map<string, MessageDisclosure>, messages: readonly ChatTranscriptMessage[]): void {
  const retained = new Set(messages.map(message => message.key));
  for (const key of store.keys()) if (!retained.has(key)) store.delete(key);
  for (const message of messages) {
    let state = store.get(message.key);
    if (state === undefined) {
      state = {blocks: new Map(), hasStreamed: message.isStreaming};
      store.set(message.key, state);
    }
    if (message.isStreaming) state.hasStreamed = true;
    const keys = new Set<string>();
    const retainBlock = (block: ChatTranscriptActivityBlock | ChatTranscriptSubagentBlock, path: string): void => {
      const key = `${path}${JSON.stringify(['block', block.id])}`;
      keys.add(key);
      const saved = state.blocks.get(key);
      if (saved === undefined) return;
      // A retry can pass through progress while its virtual row is unmounted.
      // Leave the next failure edge unconsumed until the row reveals it.
      const failed = (block.kind === 'tool_call' && block.status === 'error') ||
        (block.kind === 'hook_call' && (block.status === 'failed' || block.status === 'blocked')) ||
        (block.kind === 'subagent' && block.status === 'failed');
      if (!failed) saved.revealOn = false;
      const streaming = block.kind === 'reasoning' ? block.isStreaming :
        block.kind === 'subagent' && (block.status === 'started' || block.status === 'running');
      const autoClose = block.kind === 'reasoning' ||
        (block.kind === 'subagent' && (block.status === 'completed' || block.status === 'cancelled'));
      if (streaming || !autoClose || !saved.open) saved.autoCloseAt = null;
      else if (saved.streaming) saved.autoCloseAt = Date.now() + 1000;
      saved.streaming = streaming;
    };
    const visit = (blocks: readonly ChatTranscriptActivityBlock[], path = ''): void => {
      for (const block of blocks) {
        retainBlock(block, path);
        if (block.kind === 'tool_call') keys.add(`${path}${JSON.stringify(['completed-tools', block.id])}`);
        if (block.kind === 'subagent') {
          const nested = `${path}${JSON.stringify(block.id)}/`;
          for (const child of block.blocks) retainBlock(child, nested);
          visit(block.children, nested);
        }
      }
    };
    visit(message.blocks);
    if (message.blocks.length === 0 && message.reasoning !== null) {
      retainBlock({id: `${message.key}-reasoning`, kind: 'reasoning',
        content: message.reasoning, isStreaming: message.isStreaming}, '');
    }
    for (const key of state.blocks.keys()) if (!keys.has(key)) state.blocks.delete(key);
  }
}
