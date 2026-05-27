import { describe, expect, it } from 'vitest';
import { createEmptyChatRunState, type ChatRunState } from '../../src/renderer/chat-run-state';
import { buildTaskRunOutput } from '../../src/renderer/views/tasks/task-run-output';
import type { TaskDetail } from '../../src/shared/types';

function createDetail(): TaskDetail {
  return {
    threadId: 'thread-1',
    taskId: 'bg-1',
    lastRunId: 'run-1',
    schedulerRegistered: true,
    thread: {
      id: 'thread-1',
      kind: 'background',
      title: '整理工作区变更',
      goal: '整理工作区变更',
      status: 'completed',
      createdAt: '2026-05-16T07:00:00.000Z',
      updatedAt: '2026-05-16T07:05:00.000Z'
    },
    backgroundTask: {
      id: 'bg-1',
      threadId: 'thread-1',
      runId: 'run-1',
      goal: '整理工作区变更',
      status: 'running',
      scheduled: false,
      triggerType: 'manual',
      triggerDescription: '手动触发',
      nextRunAt: null,
      cronExpression: null,
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: ['pnpm test'],
      forbiddenActions: ['git push'],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations',
      riskLevel: 'medium',
      requiresConfirmation: false,
      lastRunAt: '2026-05-16T07:05:00.000Z',
      lastRunStatus: 'success',
      runCount: 1,
      createdAt: '2026-05-16T07:00:00.000Z',
      updatedAt: '2026-05-16T07:05:00.000Z',
      enabledCapabilities: null
    },
    runHistory: [
      {
        id: 'run-1',
        threadId: 'thread-1',
        runNumber: 1,
        userInput: '整理工作区变更',
        status: 'completed',
        startedAt: '2026-05-16T07:04:00.000Z',
        endedAt: '2026-05-16T07:05:00.000Z',
        modelId: 'kimi-k2',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      }
    ],
    recentEvents: [
      {
        id: 'event-error-other-run',
        threadId: 'thread-1',
        runId: 'run-0',
        type: 'error',
        payload: {
          message: '旧运行错误'
        },
        createdAt: '2026-05-16T07:00:10.000Z'
      },
      {
        id: 'event-message-delta',
        threadId: 'thread-1',
        runId: 'run-1',
        type: 'message_delta',
        payload: {
          role: 'assistant',
          delta: '部分答案'
        },
        createdAt: '2026-05-16T07:04:10.000Z'
      },
      {
        id: 'event-reasoning-delta',
        threadId: 'thread-1',
        runId: 'run-1',
        type: 'reasoning_delta',
        payload: {
          delta: '第一步推理'
        },
        createdAt: '2026-05-16T07:04:20.000Z'
      },
      {
        id: 'event-tool-call',
        threadId: 'thread-1',
        runId: 'run-1',
        type: 'tool_call',
        payload: {
          name: 'execute_agent',
          status: 'end',
          output: '命令已完成'
        },
        createdAt: '2026-05-16T07:04:30.000Z'
      },
      {
        id: 'event-agent-execute',
        threadId: 'thread-1',
        runId: 'run-1',
        type: 'agent_execute',
        payload: {
          command: 'pnpm test',
          exitCode: 0,
          output: '测试已通过',
          outputTruncated: false
        },
        createdAt: '2026-05-16T07:04:35.000Z'
      },
      {
        id: 'event-subagent-started',
        threadId: 'thread-1',
        runId: 'run-1',
        type: 'subagent_started',
        payload: {
          name: 'planner',
          summary: '整理计划'
        },
        createdAt: '2026-05-16T07:04:40.000Z'
      },
      {
        id: 'event-subagent-completed',
        threadId: 'thread-1',
        runId: 'run-1',
        type: 'subagent_completed',
        payload: {
          name: 'planner',
          summary: '整理计划'
        },
        createdAt: '2026-05-16T07:04:50.000Z'
      },
      {
        id: 'event-message-final',
        threadId: 'thread-1',
        runId: 'run-1',
        type: 'message',
        payload: {
          role: 'assistant',
          content: '最终答案',
          providerId: 'nvidia',
          modelId: 'kimi-k2'
        },
        createdAt: '2026-05-16T07:05:00.000Z'
      }
    ]
  };
}

function createLiveRun(): ChatRunState {
  return {
    ...createEmptyChatRunState(),
    runId: 'run-1',
    mode: 'task',
    threadId: 'thread-1',
    createdAt: '2026-05-16T07:04:00.000Z',
    status: 'running',
    assistantMessage: '正在流式输出',
    reasoning: '实时推理',
    toolEvents: [
      {
        name: 'execute_agent',
        event: 'progress',
        data: '仍在执行'
      }
    ],
    subagents: [
      {
        subagent: 'planner',
        status: 'started',
        summary: '实时计划'
      }
    ]
  };
}

describe('buildTaskRunOutput', () => {
  it('builds output from persisted task events for the latest run', () => {
    const output = buildTaskRunOutput({
      detail: createDetail(),
      liveRun: null
    });
    if (output === null) {
      throw new Error('Expected task run output.');
    }

    expect(output).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      userInput: '整理工作区变更',
      assistantMessage: '最终答案',
      reasoning: '第一步推理',
      error: null
    });
    expect(output.tools).toEqual([
      {
        name: 'execute_agent',
        status: 'end',
        data: '命令已完成'
      },
      {
        name: 'pnpm test',
        status: 'exit 0',
        data: '测试已通过'
      }
    ]);
    expect(output.subagents).toEqual([
      {
        name: 'planner',
        status: 'started',
        summary: '整理计划'
      },
      {
        name: 'planner',
        status: 'completed',
        summary: '整理计划'
      }
    ]);
  });

  it('prefers live task run state while the selected run is still running', () => {
    const output = buildTaskRunOutput({
      detail: createDetail(),
      liveRun: createLiveRun()
    });
    if (output === null) {
      throw new Error('Expected task run output.');
    }

    expect(output).toMatchObject({
      runId: 'run-1',
      status: 'running',
      assistantMessage: '正在流式输出',
      reasoning: '实时推理',
      error: null
    });
    expect(output.tools).toEqual([
      {
        name: 'execute_agent',
        status: 'progress',
        data: '仍在执行'
      }
    ]);
    expect(output.subagents).toEqual([
      {
        name: 'planner',
        status: 'started',
        summary: '实时计划'
      }
    ]);
  });
});
