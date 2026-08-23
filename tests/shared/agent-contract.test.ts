import { describe, expect, it } from 'vitest';

import {
  defaultModelStateSchema,
  runExecutionSnapshotV2Schema
} from '../../src/shared/schemas/agent';
import {
  chatResumeRunRequestSchema,
  chatRunEventSchema,
  chatRunEventsReplayResultSchema,
  chatStartRunIpcRequestSchema,
  chatStartRunRequestSchema
} from '../../src/shared/schemas/chat';

describe('shared agent contracts', () => {
  it('owns the default model state shape in one strict schema', () => {
    const state = {
      status: 'ready',
      modelId: 'model-1',
      providerId: 'provider-1',
      reason: 'configured'
    };

    expect(defaultModelStateSchema.parse(state)).toEqual(state);
    expect(defaultModelStateSchema.safeParse({ ...state, source: 'legacy' }).success).toBe(false);
  });

  it('separates main-only start fields from renderer IPC input', () => {
    const request = {
      input: 'Inspect the workspace.',
      mode: 'chat',
      enabledCapabilities: { mcpServers: [], skills: [] },
      shellAllowedCommands: ['git status']
    };

    expect(chatStartRunRequestSchema.parse(request)).toEqual(request);
    expect(chatStartRunIpcRequestSchema.safeParse(request).success).toBe(false);
  });

  it('accepts JSON HITL edits and rejects undefined action arguments', () => {
    const request = {
      kind: 'approval',
      runId: 'run-1',
      threadId: 'thread-1',
      interruptId: 'interrupt-1',
      decisions: [
        {
          type: 'edit',
          editedAction: {
            name: 'run_shell_command',
            args: { command: 'git status', options: ['short'] }
          }
        }
      ]
    };

    expect(chatResumeRunRequestSchema.parse(request)).toEqual(request);
    expect(
      chatResumeRunRequestSchema.safeParse({
        ...request,
        decisions: [
          {
            type: 'edit',
            editedAction: {
              name: 'run_shell_command',
              args: { command: undefined }
            }
          }
        ]
      }).success
    ).toBe(false);
  });

  it('validates replay events instead of trusting parsed JSON', () => {
    const event = {
      type: 'run_started',
      runId: 'run-1',
      mode: 'run',
      threadId: 'thread-1',
      providerId: 'provider-1',
      modelId: 'model-1',
      createdAt: '2026-08-18T00:00:00.000Z'
    };
    const replay = {
      runId: 'run-1',
      events: [
        {
          runId: 'run-1',
          sequence: 1,
          event,
          createdAt: '2026-08-18T00:00:00.000Z'
        }
      ]
    };

    expect(chatRunEventSchema.parse(event)).toEqual(event);
    expect(chatRunEventsReplayResultSchema.parse(replay)).toEqual(replay);
    expect(
      chatRunEventsReplayResultSchema.safeParse({
        ...replay,
        events: [{ ...replay.events[0], event: { type: 'run_started', runId: 'run-1' } }]
      }).success
    ).toBe(false);
  });

  it('owns run snapshot integrity in shared schemas', () => {
    const snapshot = {
      schemaVersion: 2,
      runId: 'run-1',
      threadId: 'thread-1',
      runOrigin: 'chat',
      model: { providerId: 'provider-1', modelId: 'model-1' },
      mode: 'run',
      workspace: null,
      capabilityManifest: {
        schemaVersion: 1,
        manifestHash: 'a'.repeat(64),
        requestedCapabilities: { mcpServers: [], skills: [] },
        resolvedCapabilities: { mcpServers: [], skills: [] },
        skippedCapabilities: [],
        tools: [],
        skills: [],
        untrustedContextPolicy: 'external_content_reference_only'
      },
      budget: {
        contextBudgetTokens: null
      },
      workflowHint: null,
      explicitSkillIds: [],
      inputMessageId: 'message-1',
      dispatchKey: null
    };
    expect(runExecutionSnapshotV2Schema.parse(snapshot)).toEqual(snapshot);
  });
});
