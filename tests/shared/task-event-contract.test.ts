import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { taskEventSchema } from '../../src/shared/schemas/task-event';

const baseEvent = {
  id: 'event-1',
  threadId: 'thread-1',
  runId: 'run-1',
  createdAt: '2026-08-17T12:00:00.000Z'
} as const;

describe('task event contract', () => {
  it('parses persisted transcript payloads through one discriminated contract', () => {
    const events = [
      {
        ...baseEvent,
        type: 'message',
        payload: {
          role: 'user',
          content: 'hello',
          enabledCapabilities: { mcpServers: ['filesystem'], skills: ['review'] }
        }
      },
      {
        ...baseEvent,
        type: 'message',
        payload: {
          role: 'assistant',
          content: 'done',
          providerId: 'openai',
          modelId: 'gpt-4.1'
        }
      },
      {
        ...baseEvent,
        type: 'assistant_block',
        payload: {
          kind: 'tool_call',
          blockId: 'block-1',
          callId: 'call-1',
          name: 'read_file',
          phase: 'end',
          output: { bytes: 4 }
        }
      },
      {
        ...baseEvent,
        type: 'hook_completed',
        payload: {
          runId: 'hook-1',
          handlerId: 'PostToolUse:0:0',
          event: 'PostToolUse',
          status: 'completed',
          durationMs: 12,
          message: 'done',
          additionalContext: null,
          requestContinue: null,
          commandDisplay: 'node hook.js'
        }
      },
      {
        ...baseEvent,
        type: 'subagent_event',
        payload: {
          sequence: 1,
          identity: {
            subagentId: 'subagent-1',
            parentSubagentId: null,
            name: 'research',
            depth: 0,
            path: ['research#0'],
            execution: 'sync',
            taskInput: 'read docs'
          },
          event: { kind: 'started' }
        }
      }
    ];

    expect(events.map((event) => taskEventSchema.parse(event))).toEqual(events);
  });

  it('rejects malformed payloads instead of treating them as unknown records', () => {
    expect(() =>
      taskEventSchema.parse({
        ...baseEvent,
        type: 'message',
        payload: { role: 'system', content: 'hidden' }
      })
    ).toThrow();
    expect(() =>
      taskEventSchema.parse({
        ...baseEvent,
        type: 'message',
        payload: {
          role: 'user',
          content: 'hello',
          enabledCapabilities: { mcpServers: [''], skills: [] }
        }
      })
    ).toThrow();
    expect(() =>
      taskEventSchema.parse({
        ...baseEvent,
        type: 'hook_completed',
        payload: {
          runId: 'hook-1',
          handlerId: 'PostToolUse:0:0',
          event: 'PostToolUse',
          status: 'completed',
          durationMs: 12,
          message: 'done',
          commandDisplay: 'node hook.js'
        }
      })
    ).toThrow();
    expect(() =>
      taskEventSchema.parse({
        ...baseEvent,
        type: 'subagent_event',
        payload: {
          sequence: 1,
          identity: {
            subagentId: 'subagent-1',
            parentSubagentId: null,
            name: 'research',
            depth: 'zero',
            path: ['research#0'],
            execution: 'sync',
            taskInput: 'read docs'
          },
          event: { kind: 'started' }
        }
      })
    ).toThrow();
    expect(() =>
      taskEventSchema.parse({
        ...baseEvent,
        type: 'approval_requested',
        payload: {
          interruptId: 'interrupt-1',
          actionRequests: [{}],
          reviewConfigs: []
        }
      })
    ).toThrow();
  });

  it('keeps renderer transcript projection free of parallel duck-typed payload guards', () => {
    const source = readFileSync('src/renderer/chat-transcript.ts', 'utf8');
    const chatViewSource = readFileSync('src/renderer/chat/chat-view.tsx', 'utf8');

    expect(source).not.toContain('Reflect.get');
    expect(chatViewSource).not.toContain('Reflect.get');
  });
});
