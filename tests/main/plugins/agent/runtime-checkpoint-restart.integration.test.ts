import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Annotation, Command, END, START, StateGraph } from '@langchain/langgraph';
import { createDeepAgent } from 'deepagents';
import { FakeToolCallingModel, HumanMessage, tool } from 'langchain';
import { z } from 'zod';

import { applyAgentDatabaseSchema as applyAgentPluginSchema } from '../../../../src/main/infrastructure/database-schemas';
import { createAskUserTool } from '../../../../src/main/services/deep-agent/ask-user-tool';
import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';

const RestartState = Annotation.Root({
  result: Annotation<string>
});

const MultipleInterruptState = Annotation.Root({
  firstAnswer: Annotation<string>,
  secondAnswer: Annotation<string>
});

let db: Database.Database;
let databasePath: string;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-checkpoint-restart-'));
  databasePath = join(tempDir, 'agent.db');
  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  applyAgentPluginSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { force: true, recursive: true });
});

describe('RocSqliteCheckpointer restart integration', () => {
  it('resumes an approval interrupt after recreating the graph with the same thread', async () => {
    const config = { configurable: { thread_id: 'thread_restart_approval' } };
    const executedCommands: string[] = [];
    const first = createApprovalAgent({
      checkpointer: new RocSqliteCheckpointer(db),
      executedCommands,
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: 'run_shell_command',
              args: { command: 'Get-Location' },
              id: 'call_restart_approval'
            }
          ],
          []
        ]
      })
    });

    const interrupted = await first.invoke({
      messages: [new HumanMessage('Run Get-Location.')]
    }, config);

    const approvalInterrupts = readInterrupts(interrupted);
    expect(approvalInterrupts[0]?.value).toMatchObject({
      actionRequests: [
        {
          name: 'run_shell_command',
          args: { command: 'Get-Location' }
        }
      ],
      reviewConfigs: [
        {
          actionName: 'run_shell_command',
          allowedDecisions: ['approve']
        }
      ]
    });
    expect(countCheckpoints()).toBeGreaterThan(0);

    db.close();
    db = new Database(databasePath);
    const restarted = createApprovalAgent({
      checkpointer: new RocSqliteCheckpointer(db),
      executedCommands,
      model: new FakeToolCallingModel({
        index: 1,
        toolCalls: [
          [
            {
              name: 'run_shell_command',
              args: { command: 'Get-Location' },
              id: 'call_restart_approval'
            }
          ],
          []
        ]
      })
    });
    const approvalInterruptId = requireInterruptId(approvalInterrupts[0]);
    await restarted.invoke(
      new Command({ resume: { [approvalInterruptId]: { decisions: [{ type: 'approve' }] } } }),
      config
    );

    expect(executedCommands).toEqual(['Get-Location']);
  });

  it('resumes the Roc ask_user tool after recreating the graph with the same thread', async () => {
    const config = { configurable: { thread_id: 'thread_restart_question' } };
    const first = createQuestionGraph(new RocSqliteCheckpointer(db));

    const interrupted = await first.invoke({}, config);

    const questionInterrupts = readInterrupts(interrupted);
    expect(questionInterrupts.map((interruptValue) => interruptValue.value)).toEqual([
      {
        kind: 'question',
        question: 'Which workspace should I use?'
      }
    ]);
    expect(countCheckpoints()).toBeGreaterThan(0);

    db.close();
    db = new Database(databasePath);
    const restarted = createQuestionGraph(new RocSqliteCheckpointer(db));
    const questionInterruptId = requireInterruptId(questionInterrupts[0]);
    const resumed = await restarted.invoke(
      new Command({ resume: { [questionInterruptId]: { answer: 'F:\\Code\\Roc' } } }),
      config
    );

    expect(resumed.result).toBe('F:\\Code\\Roc');
  });

  it('resumes multiple parallel ask_user interrupts by id after recreating the graph', async () => {
    const config = { configurable: { thread_id: 'thread_restart_multiple_questions' } };
    const first = createMultipleQuestionGraph(new RocSqliteCheckpointer(db));

    const interrupted = await first.invoke({}, config);
    const interrupts = readInterrupts(interrupted);

    expect(interrupts.map((interruptValue) => interruptValue.value)).toEqual(
      expect.arrayContaining([
        { kind: 'question', question: 'First workspace?' },
        { kind: 'question', question: 'Second workspace?' }
      ])
    );
    expect(interrupts).toHaveLength(2);
    expect(countCheckpoints()).toBeGreaterThan(0);

    const resumeByInterruptId = Object.fromEntries(
      interrupts.map((interruptValue) => {
        const question = readQuestion(interruptValue.value);
        return [interruptValue.id, { answer: `${question} answered` }];
      })
    );
    db.close();
    db = new Database(databasePath);
    const restarted = createMultipleQuestionGraph(new RocSqliteCheckpointer(db));
    const resumed = await restarted.invoke(new Command({ resume: resumeByInterruptId }), config);

    expect([resumed.firstAnswer, resumed.secondAnswer]).toEqual(
      expect.arrayContaining(['First workspace? answered', 'Second workspace? answered'])
    );
  });

  it('resumes multiple DeepAgent ask_user tool calls by id after restart', async () => {
    const config = { configurable: { thread_id: 'thread_restart_deep_agent_questions' } };
    const toolCalls = [
      [
        {
          name: 'ask_user',
          args: { question: 'Primary workspace?' },
          id: 'call_primary_workspace'
        },
        {
          name: 'ask_user',
          args: { question: 'Fallback workspace?' },
          id: 'call_fallback_workspace'
        }
      ],
      []
    ];
    const first = createMultipleQuestionAgent(
      new RocSqliteCheckpointer(db),
      new FakeToolCallingModel({ toolCalls })
    );

    const interrupted = await first.invoke(
      { messages: [new HumanMessage('Ask for both workspace choices.')] },
      config
    );
    const interrupts = readInterrupts(interrupted);

    expect(interrupts).toHaveLength(2);
    expect(interrupts.map((interruptValue) => interruptValue.value)).toEqual(
      expect.arrayContaining([
        { kind: 'question', question: 'Primary workspace?' },
        { kind: 'question', question: 'Fallback workspace?' }
      ])
    );

    const resumeByInterruptId = Object.fromEntries(
      interrupts.map((interruptValue) => [interruptValue.id, { answer: `${readQuestion(interruptValue.value)} answered` }])
    );
    db.close();
    db = new Database(databasePath);
    const restarted = createMultipleQuestionAgent(
      new RocSqliteCheckpointer(db),
      new FakeToolCallingModel({ index: 1, toolCalls })
    );
    const resumed = await restarted.invoke(new Command({ resume: resumeByInterruptId }), config);

    expect(Reflect.get(resumed, '__interrupt__')).toBeUndefined();
  });
});

function createQuestionGraph(checkpointer: RocSqliteCheckpointer) {
  const askUser = createAskUserTool();
  return new StateGraph(RestartState)
    .addNode('question', async () => ({
      result: await askUser.invoke({
        question: 'Which workspace should I use?'
      })
    }))
    .addEdge(START, 'question')
    .addEdge('question', END)
    .compile({ checkpointer });
}

function createMultipleQuestionGraph(checkpointer: RocSqliteCheckpointer) {
  const askUser = createAskUserTool();
  return new StateGraph(MultipleInterruptState)
    .addNode('first-question', async () => ({
      firstAnswer: await askUser.invoke({ question: 'First workspace?' })
    }))
    .addNode('second-question', async () => ({
      secondAnswer: await askUser.invoke({ question: 'Second workspace?' })
    }))
    .addEdge(START, 'first-question')
    .addEdge(START, 'second-question')
    .addEdge('first-question', END)
    .addEdge('second-question', END)
    .compile({ checkpointer });
}

function createMultipleQuestionAgent(checkpointer: RocSqliteCheckpointer, model: FakeToolCallingModel) {
  return createDeepAgent({
    checkpointer,
    model,
    tools: [createAskUserTool()]
  });
}

function createApprovalAgent(input: {
  checkpointer: RocSqliteCheckpointer;
  executedCommands: string[];
  model: FakeToolCallingModel;
}) {
  const commandTool = tool(
    async ({ command }) => {
      input.executedCommands.push(command);
      return 'command_completed';
    },
    {
      name: 'run_shell_command',
      description: 'Run a PowerShell command.',
      schema: z.object({ command: z.string() })
    }
  );
  return createDeepAgent({
    checkpointer: input.checkpointer,
    interruptOn: {
      run_shell_command: {
        allowedDecisions: ['approve']
      }
    },
    model: input.model,
    tools: [commandTool]
  });
}

function readInterrupts(result: object): Array<{ id: string; value: unknown }> {
  const interrupts = Reflect.get(result, '__interrupt__');
  if (!Array.isArray(interrupts)) {
    throw new Error('graph_interrupt_missing');
  }
  return interrupts.map((interruptValue) => {
    if (interruptValue === null || typeof interruptValue !== 'object') {
      throw new Error('graph_interrupt_invalid');
    }
    const id = Reflect.get(interruptValue, 'id');
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('graph_interrupt_id_invalid');
    }
    return {
      id,
      value: Reflect.get(interruptValue, 'value')
    };
  });
}

function requireInterruptId(interruptValue: { id: string; value: unknown } | undefined): string {
  if (interruptValue === undefined) {
    throw new Error('graph_interrupt_missing');
  }
  return interruptValue.id;
}

function readQuestion(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    throw new Error('graph_interrupt_question_invalid');
  }
  const question = Reflect.get(value, 'question');
  if (typeof question !== 'string') {
    throw new Error('graph_interrupt_question_invalid');
  }
  return question;
}

function countCheckpoints(): number {
  return db.prepare('SELECT COUNT(*) FROM langgraph_checkpoints').pluck().get() as number;
}
