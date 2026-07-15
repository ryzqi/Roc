import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Annotation, Command, END, START, StateGraph } from '@langchain/langgraph';
import { createDeepAgent } from 'deepagents';
import { FakeToolCallingModel, HumanMessage, tool } from 'langchain';
import { z } from 'zod';

import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { createAskUserTool } from '../../../../src/main/services/deep-agent/ask-user-tool';
import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';

const RestartState = Annotation.Root({
  result: Annotation<string>
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

    expect(readInterruptValues(interrupted)[0]).toMatchObject({
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
    await restarted.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config);

    expect(executedCommands).toEqual(['Get-Location']);
  });

  it('resumes the Roc ask_user tool after recreating the graph with the same thread', async () => {
    const config = { configurable: { thread_id: 'thread_restart_question' } };
    const first = createQuestionGraph(new RocSqliteCheckpointer(db));

    const interrupted = await first.invoke({}, config);

    expect(readInterruptValues(interrupted)).toEqual([
      {
        kind: 'question',
        question: 'Which workspace should I use?'
      }
    ]);
    expect(countCheckpoints()).toBeGreaterThan(0);

    db.close();
    db = new Database(databasePath);
    const restarted = createQuestionGraph(new RocSqliteCheckpointer(db));
    const resumed = await restarted.invoke(new Command({ resume: { answer: 'F:\\Code\\Roc' } }), config);

    expect(resumed.result).toBe('F:\\Code\\Roc');
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

function readInterruptValues(result: object): unknown[] {
  const interrupts = Reflect.get(result, '__interrupt__');
  if (!Array.isArray(interrupts)) {
    throw new Error('graph_interrupt_missing');
  }
  return interrupts.map((interruptValue) => {
    if (interruptValue === null || typeof interruptValue !== 'object') {
      throw new Error('graph_interrupt_invalid');
    }
    return Reflect.get(interruptValue, 'value');
  });
}

function countCheckpoints(): number {
  return db.prepare('SELECT COUNT(*) FROM langgraph_checkpoints').pluck().get() as number;
}
