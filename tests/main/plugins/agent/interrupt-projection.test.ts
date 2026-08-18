import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentInterruptProjection,
  normalizeChatInterruptPayload,
  type PendingInterrupt
} from '../../../../src/main/plugins/agent/interrupt-projection';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';

let db: Database.Database;
let projection: AgentInterruptProjection;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentPluginSchema(db);
  projection = new AgentInterruptProjection(db);
});

afterEach(() => {
  db.close();
});

describe('AgentInterruptProjection', () => {
  it('records, reads, and consumes pending interrupts through its interface', () => {
    seedRun('run-1', 'thread-1');
    const interrupts: PendingInterrupt[] = [
      {
        interruptId: 'interrupt-approval',
        payload: {
          kind: 'approval',
          request: {
            actionRequests: [{ name: 'run_shell_command', args: { command: 'git status' } }],
            reviewConfigs: [{ actionName: 'run_shell_command', allowedDecisions: ['approve', 'reject'] }]
          }
        }
      },
      {
        interruptId: 'interrupt-question',
        payload: { kind: 'question', question: 'Which workspace?' }
      }
    ];

    projection.record({ runId: 'run-1', threadId: 'thread-1', interrupts });

    expect(projection.readPending({ runId: 'run-1', threadId: 'thread-1' })).toEqual({
      runId: 'run-1',
      threadId: 'thread-1',
      interrupts
    });

    projection.consume({ runId: 'run-1', interruptId: 'interrupt-approval' });

    expect(projection.readPending({ runId: 'run-1', threadId: 'thread-1' }).interrupts).toEqual([
      interrupts[1]
    ]);
  });

  it('recovers unanswered interrupts from the latest checkpoint', () => {
    seedRun('run-2', 'thread-2');
    seedCheckpoint('thread-2', [
      { id: 'interrupt-answered', value: { kind: 'question', question: 'Answered?' } },
      { id: 'interrupt-pending', value: { kind: 'question', question: 'Pending?' } }
    ]);

    expect(
      projection.recoverFromCheckpoint({
        runId: 'run-2',
        threadId: 'thread-2',
        answeredInterruptIds: new Set(['interrupt-answered'])
      })
    ).toEqual([
      {
        interruptId: 'interrupt-pending',
        payload: { kind: 'question', question: 'Pending?' }
      }
    ]);
    expect(projection.readPending({ runId: 'run-2', threadId: 'thread-2' }).interrupts).toEqual([
      {
        interruptId: 'interrupt-pending',
        payload: { kind: 'question', question: 'Pending?' }
      }
    ]);
  });

  it('does not overwrite a corrupt persisted projection during checkpoint recovery', () => {
    seedRun('run-3', 'thread-3');
    projection.record({
      runId: 'run-3',
      threadId: 'thread-3',
      interrupts: [{ interruptId: 'interrupt-corrupt', payload: { kind: 'question', question: 'Continue?' } }]
    });
    db.prepare('UPDATE agent_pending_interrupts SET payload_json = ? WHERE run_id = ?')
      .run('{"kind":"approval"}', 'run-3');
    seedCheckpoint('thread-3', [
      { id: 'interrupt-corrupt', value: { kind: 'question', question: 'Continue?' } }
    ]);

    expect(() =>
      projection.recoverFromCheckpoint({
        runId: 'run-3',
        threadId: 'thread-3',
        answeredInterruptIds: new Set()
      })
    ).toThrow('agent_pending_interrupt_payload_invalid');
    expect(() => projection.readPending({ runId: 'run-3', threadId: 'thread-3' }))
      .toThrow('agent_pending_interrupt_payload_invalid');
  });

  it('rejects invalid question fields and unrelated properties', () => {
    expect(() =>
      normalizeChatInterruptPayload({ kind: 'question', question: 'Continue?', context: null })
    ).toThrow('agent_interrupt_payload_invalid');
    expect(() =>
      normalizeChatInterruptPayload({ kind: 'question', question: 'Continue?', suggestedResponses: [1] })
    ).toThrow('agent_interrupt_payload_invalid');
    expect(() =>
      normalizeChatInterruptPayload({ kind: 'question', question: 'Continue?', ignored: true })
    ).toThrow('agent_interrupt_payload_invalid');
  });
});

function seedRun(runId: string, threadId: string): void {
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    threadId,
    'chat',
    'Interrupt projection test',
    'Test interrupt projection behavior',
    'active',
    '2026-08-17T00:00:00.000Z',
    '2026-08-17T00:00:00.000Z'
  );
  db.prepare(
    `INSERT INTO agent_runs
     (id, thread_id, run_number, user_input, status, started_at, enabled_capabilities_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    threadId,
    1,
    'Test interrupt projection',
    'waiting_user',
    '2026-08-17T00:00:00.000Z',
    '{"mcpServers":[],"skills":[]}'
  );
}

function seedCheckpoint(
  threadId: string,
  interrupts: ReadonlyArray<{ id: string; value: unknown }>
): void {
  db.prepare(
    `INSERT INTO langgraph_checkpoints
     (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type, checkpoint_blob, metadata_type, metadata_blob, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    threadId,
    '',
    'checkpoint-latest',
    null,
    'json',
    Buffer.from('{}'),
    'json',
    Buffer.from('{}'),
    '2026-08-17T00:00:00.000Z'
  );
  const insert = db.prepare(
    `INSERT INTO langgraph_checkpoint_writes
     (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value_blob, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [index, interrupt] of interrupts.entries()) {
    insert.run(
      threadId,
      '',
      'checkpoint-latest',
      `task-${index}`,
      -3,
      '__interrupt__',
      'json',
      Buffer.from(JSON.stringify(interrupt)),
      '2026-08-17T00:00:00.000Z'
    );
  }
}
