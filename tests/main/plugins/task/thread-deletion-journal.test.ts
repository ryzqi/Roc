import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema, applyTaskDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryContract } from '../../../../src/main/plugins/agent/agent-task-history-contract';
import { ThreadDeletionJournal } from '../../../../src/main/plugins/task/thread-deletion-journal';

let db: Database.Database;
let agentDb: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  agentDb = new Database(':memory:');
  applyAgentDatabaseSchema(agentDb);
  applyTaskDatabaseSchema(db);
});

afterEach(() => {
  agentDb.close();
  db.close();
});

describe('ThreadDeletionJournal', () => {
  it('persists one pending record and advances through explicit states', () => {
    const journal = createJournal(() => '2026-07-10T01:00:00.000Z');

    expect(journal.ensurePending('thread-1')).toMatchObject({
      threadId: 'thread-1',
      state: 'pending',
      attemptCount: 0,
      lastError: null,
      createdAt: '2026-07-10T01:00:00.000Z'
    });
    expect(journal.ensurePending('thread-1').createdAt).toBe('2026-07-10T01:00:00.000Z');

    journal.recordFailure('thread-1', new Error('agent delete failed'));
    expect(journal.require('thread-1')).toMatchObject({
      state: 'pending',
      attemptCount: 1,
      lastError: 'agent delete failed'
    });

    journal.markAgentDeleted('thread-1');
    expect(journal.require('thread-1')).toMatchObject({ state: 'agent_deleted', lastError: null });
    journal.markCompleteInCurrentTransaction('thread-1');
    expect(journal.require('thread-1')).toMatchObject({
      state: 'complete',
      completedAt: '2026-07-10T01:00:00.000Z'
    });
    expect(journal.listIncomplete()).toEqual([]);
    expect(journal.listHiddenThreadIds()).toEqual(new Set(['thread-1']));
  });

  it('rejects pending to complete and complete to agent-deleted transitions', () => {
    const journal = createJournal();
    journal.ensurePending('thread-1');

    expect(() => journal.markCompleteInCurrentTransaction('thread-1')).toThrow(
      'thread_deletion_transition_invalid:agent_deleted_to_complete'
    );

    journal.markAgentDeleted('thread-1');
    journal.markCompleteInCurrentTransaction('thread-1');

    expect(() => journal.markAgentDeleted('thread-1')).toThrow(
      'thread_deletion_transition_invalid:pending_to_agent_deleted'
    );
  });

  it('keeps complete records idempotent and permanently hidden', () => {
    const journal = createJournal();
    journal.ensurePending('thread-1');
    journal.markAgentDeleted('thread-1');
    journal.markCompleteInCurrentTransaction('thread-1');

    expect(journal.ensurePending('thread-1').state).toBe('complete');
    expect(journal.find('missing-thread')).toBeNull();
    expect(journal.listIncomplete()).toEqual([]);
    expect(journal.listHiddenThreadIds()).toEqual(new Set(['thread-1']));
  });
});

function createJournal(now?: () => string): ThreadDeletionJournal {
  return new ThreadDeletionJournal({
    agentHistory: new AgentTaskHistoryContract(agentDb),
    db,
    ...(now === undefined ? {} : { now })
  });
}
