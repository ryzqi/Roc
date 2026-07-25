import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import type { ChatRunEvent } from '../../../../src/shared/types';

let db: Database.Database;
let events: RocEventEnvelope[];

const eventBus: RocEventBus = {
  publish: async (event) => {
    events.push(event);
  },
  subscribe: () => () => {}
};

const modelFactory: AgentModelFactoryAdapter = {
  createDefaultModelHandle: async () => ({
    modelId: 'openai:gpt-4.1',
    providerId: 'openai'
  }),
  createModelHandleByProviderAndModel: async ({ providerId, modelId }) => ({
    modelId,
    providerId
  })
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyAgentPluginSchema(db);
  events = [];
});

afterEach(() => {
  db.close();
});

describe('AgentPluginRuntime multiple interrupts', () => {
  it('persists every pending interrupt and resumes each one by interrupt id', async () => {
    const repository = new AgentSessionRepository(db);
    const resumePayloads: unknown[] = [];
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          if (input.resumePayload === undefined) {
            yield interrupted(input.run.id, input.run.threadId, 'interrupt-approval', approvalPayload());
            yield interrupted(input.run.id, input.run.threadId, 'interrupt-question', {
              kind: 'question',
              question: 'Which workspace should I use?'
            });
            return;
          }
          resumePayloads.push(input.resumePayload);
          if ('interrupt-approval' in input.resumePayload && !('interrupt-question' in input.resumePayload)) {
            yield interrupted(input.run.id, input.run.threadId, 'interrupt-question', {
              kind: 'question',
              question: 'Which workspace should I use?'
            });
            return;
          }
          yield textBlock(input.run.id, 'Both responses accepted.');
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const started = await runtime.startRun({
      enabledCapabilities: { mcpServers: [], skills: [] },
      input: 'Run parallel review tasks.',
      mode: 'task'
    });
    const threadId = requireThreadId(started.threadId);
    await waitFor(() => runEvents('run_interrupted').length === 2);

    expect(repository.getPendingInterrupts(started.runId).interrupts.map((interrupt) => interrupt.interruptId)).toEqual([
      'interrupt-approval',
      'interrupt-question'
    ]);

    await runtime.resumeRun({
      kind: 'approval',
      runId: started.runId,
      threadId,
      interruptId: 'interrupt-approval',
      decisions: [{ type: 'approve' }]
    });
    await waitFor(() => runEvents('run_interrupted').length === 3);

    expect(repository.getRun(started.runId).status).toBe('waiting_user');
    expect(repository.getPendingInterrupts(started.runId).interrupts.map((interrupt) => interrupt.interruptId)).toEqual([
      'interrupt-question'
    ]);

    await runtime.resumeRun({
      kind: 'question',
      runId: started.runId,
      threadId,
      interruptId: 'interrupt-question',
      answer: 'F:\\Code\\Roc'
    });
    await waitFor(() => runEvents('run_completed').length === 1);

    expect(resumePayloads).toEqual([
      {
        'interrupt-approval': {
          decisions: [{ type: 'approve' }]
        }
      },
      {
        'interrupt-approval': {
          decisions: [{ type: 'approve' }]
        },
        'interrupt-question': {
          answer: 'F:\\Code\\Roc'
        }
      }
    ]);
    expect(repository.getRun(started.runId).status).toBe('completed');
    expect(repository.getPendingInterrupts(started.runId).interrupts).toEqual([]);
  });

  it('keeps waiting projection when resume executor dispatch rejects', async () => {
    const repository = new AgentSessionRepository(db);
    const firstRuntime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield interrupted(input.run.id, input.run.threadId, 'interrupt-dispatch', approvalPayload());
        }
      },
      eventBus,
      modelFactory,
      repository
    });
    const started = await firstRuntime.startRun({
      enabledCapabilities: { mcpServers: [], skills: [] },
      input: 'Review before dispatch.',
      mode: 'task'
    });
    const threadId = requireThreadId(started.threadId);
    await waitFor(() => runEvents('run_interrupted').length === 1);

    const rebuiltRuntime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async () => {
          throw new Error('resume_dispatch_failed');
        }
      },
      eventBus,
      modelFactory,
      repository: new AgentSessionRepository(db)
    });

    await expect(
      rebuiltRuntime.resumeRun({
        kind: 'approval',
        runId: started.runId,
        threadId,
        interruptId: 'interrupt-dispatch',
        decisions: [{ type: 'approve' }]
      })
    ).rejects.toThrow('resume_dispatch_failed');
    expect(repository.getRun(started.runId).status).toBe('waiting_user');
    expect(repository.getPendingInterrupts(started.runId).interrupts).toMatchObject([
      { interruptId: 'interrupt-dispatch' }
    ]);
  });

  it('treats a resume stream failure after dispatch as a run failure', async () => {
    const repository = new AgentSessionRepository(db);
    const firstRuntime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield interrupted(input.run.id, input.run.threadId, 'interrupt-stream-dispatch', approvalPayload());
        }
      },
      eventBus,
      modelFactory,
      repository
    });
    const started = await firstRuntime.startRun({
      enabledCapabilities: { mcpServers: [], skills: [] },
      input: 'Review before stream dispatch.',
      mode: 'task'
    });
    const threadId = requireThreadId(started.threadId);
    await waitFor(() => runEvents('run_interrupted').length === 1);

    const rebuiltRuntime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* () {
          throw new Error('resume_stream_dispatch_failed');
        }
      },
      eventBus,
      modelFactory,
      repository: new AgentSessionRepository(db)
    });

    await expect(
      rebuiltRuntime.resumeRun({
        kind: 'approval',
        runId: started.runId,
        threadId,
        interruptId: 'interrupt-stream-dispatch',
        decisions: [{ type: 'approve' }]
      })
    ).resolves.toMatchObject({ runId: started.runId });
    await waitFor(() => runEvents('run_failed').length === 1);
    expect(repository.getRun(started.runId).status).toBe('failed');
    expect(repository.getPendingInterrupts(started.runId).interrupts).toEqual([]);
  });

  it('rolls back waiting projection when resume audit commit fails before stream consumption', async () => {
    const repository = new AgentSessionRepository(db);
    const firstRuntime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield interrupted(input.run.id, input.run.threadId, 'interrupt-audit-commit', {
            kind: 'question',
            question: 'Which workspace should be recorded?'
          });
        }
      },
      eventBus,
      modelFactory,
      repository
    });
    const started = await firstRuntime.startRun({
      enabledCapabilities: { mcpServers: [], skills: [] },
      input: 'Record an answer atomically.',
      mode: 'task'
    });
    const threadId = requireThreadId(started.threadId);
    await waitFor(() => runEvents('run_interrupted').length === 1);
    db.exec(`
      CREATE TRIGGER fail_runtime_resume_question_session_message
      BEFORE INSERT ON session_messages
      BEGIN
        SELECT RAISE(ABORT, 'runtime_resume_audit_commit_failed');
      END;
    `);
    const rebuiltRuntime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          yield textBlock(input.run.id, 'Resume dispatched.');
        }
      },
      eventBus,
      modelFactory,
      repository: new AgentSessionRepository(db)
    });

    await expect(
      rebuiltRuntime.resumeRun({
        kind: 'question',
        runId: started.runId,
        threadId,
        interruptId: 'interrupt-audit-commit',
        answer: 'F:\\Code\\Roc'
      })
    ).rejects.toThrow('runtime_resume_audit_commit_failed');
    expect(repository.getRun(started.runId).status).toBe('waiting_user');
    expect(repository.getPendingInterrupts(started.runId).interrupts).toMatchObject([
      { interruptId: 'interrupt-audit-commit' }
    ]);
    expect(runEvents('run_resumed')).toHaveLength(0);
  });

  it('preserves the remaining projection when a second resume races after the first dispatch claim', async () => {
    const repository = new AgentSessionRepository(db);
    const firstResumeGate: { release: (() => void) | null } = { release: null };
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          if (input.resumePayload === undefined) {
            yield interrupted(input.run.id, input.run.threadId, 'interrupt-approval', approvalPayload());
            yield interrupted(input.run.id, input.run.threadId, 'interrupt-question', {
              kind: 'question',
              question: 'Which workspace should I use?'
            });
            return;
          }
          await new Promise<void>((resolve) => {
            firstResumeGate.release = resolve;
          });
          yield textBlock(input.run.id, 'First resume completed.');
        }
      },
      eventBus,
      modelFactory,
      repository
    });
    const started = await runtime.startRun({
      enabledCapabilities: { mcpServers: [], skills: [] },
      input: 'Resolve both pending requests.',
      mode: 'task'
    });
    const threadId = requireThreadId(started.threadId);
    await waitFor(() => runEvents('run_interrupted').length === 2);

    await runtime.resumeRun({
      kind: 'approval',
      runId: started.runId,
      threadId,
      interruptId: 'interrupt-approval',
      decisions: [{ type: 'approve' }]
    });
    await waitFor(() => firstResumeGate.release !== null);

    await expect(
      runtime.resumeRun({
        kind: 'question',
        runId: started.runId,
        threadId,
        interruptId: 'interrupt-question',
        answer: 'F:\\Code\\Roc'
      })
    ).rejects.toThrow('chat_resume_run_not_waiting_user');
    expect(repository.getPendingInterrupts(started.runId).interrupts).toEqual([
      expect.objectContaining({ interruptId: 'interrupt-question' })
    ]);

    if (firstResumeGate.release === null) {
      throw new Error('first_resume_release_missing');
    }
    firstResumeGate.release();
    await waitFor(() => runEvents('run_completed').length === 1);
  });
});

function interrupted(
  runId: string,
  threadId: string,
  interruptId: string,
  payload: Extract<ChatRunEvent, { type: 'run_interrupted' }>['payload']
): ChatRunEvent {
  return {
    type: 'run_interrupted',
    runId,
    threadId,
    interruptId,
    payload
  };
}

function approvalPayload(): Extract<ChatRunEvent, { type: 'run_interrupted' }>['payload'] {
  return {
    kind: 'approval',
    request: {
      actionRequests: [{ name: 'run_shell_command', args: { command: 'git status' } }],
      reviewConfigs: [{ actionName: 'run_shell_command', allowedDecisions: ['approve'] }]
    }
  };
}

function textBlock(runId: string, text: string): ChatRunEvent {
  return {
    type: 'assistant_block',
    runId,
    block: {
      kind: 'text',
      blockId: `text-${runId}`,
      phase: 'delta',
      text
    }
  };
}

function runEvents(type: ChatRunEvent['type']): ChatRunEvent[] {
  return events
    .filter((event) => event.type === 'agent.chat.run-event')
    .map((event) => event.payload)
    .filter((payload): payload is ChatRunEvent => typeof payload === 'object' && payload !== null && Reflect.get(payload, 'type') === type);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('expected_runtime_state_not_reached');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function requireThreadId(threadId: string | null): string {
  if (threadId === null) {
    throw new Error('expected_thread_id');
  }
  return threadId;
}
