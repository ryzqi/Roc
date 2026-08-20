import { describe, expect, it, vi } from 'vitest';

import { AgentOutboxProjector } from '../../../../src/main/plugins/task/agent-outbox-projector';
import type { AgentOutboxEvent } from '../../../../src/shared/types';

describe('AgentOutboxProjector', () => {
  it('owns paging, cursor advancement, and aggregate results behind one interface', () => {
    const events = Array.from({ length: 205 }, (_, index) => deletedEvent(index + 1));
    let cursor = 0;
    const batchSizes: number[] = [];
    const projector = new AgentOutboxProjector(
      {
        listOutboxEventsAfter: ({ afterSequence, limit }) =>
          events.filter((event) => event.sequence > afterSequence).slice(0, limit)
      },
      {
        getAgentOutboxCursor: () => cursor,
        projectAgentOutboxEvents: ({ events: batch }) => {
          batchSizes.push(batch.length);
          cursor = batch.at(-1)?.sequence ?? cursor;
          return { appliedCount: batch.length, lastSequence: cursor };
        }
      },
      vi.fn()
    );

    expect(projector.project()).toEqual({ appliedCount: 205, lastSequence: 205 });
    expect(batchSizes).toEqual([100, 100, 5]);
    expect(projector.project()).toEqual({ appliedCount: 0, lastSequence: 205 });
  });

  it('contains best-effort error handling at the plugin edge', () => {
    const onError = vi.fn();
    const error = new Error('projection_failed');
    const projector = new AgentOutboxProjector(
      {
        listOutboxEventsAfter: () => {
          throw error;
        }
      },
      {
        getAgentOutboxCursor: () => 0,
        projectAgentOutboxEvents: () => ({ appliedCount: 0, lastSequence: 0 })
      },
      onError
    );

    expect(() => projector.projectBestEffort()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error);
  });
});

function deletedEvent(sequence: number): AgentOutboxEvent {
  return {
    id: `outbox-${sequence}`,
    sequence,
    eventType: 'run_deleted',
    runId: `run-${sequence}`,
    threadId: `thread-${sequence}`,
    payload: {},
    createdAt: `2026-08-21T00:${String(Math.floor(sequence / 60)).padStart(2, '0')}:${String(sequence % 60).padStart(2, '0')}.000Z`
  };
}
