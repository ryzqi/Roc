import type { z } from 'zod';

import { chatRunEventSchema } from '../schemas/chat';
import {
  rocHookConfigSchema,
  rocHookConfigSnapshotSchema,
  rocHookEventNameSchema,
  settingsSaveHookConfigRequestSchema,
  settingsTrustHookRequestSchema
} from '../schemas/ipc-memory-settings';
import { hookRunSummarySchema } from '../schemas/task-event';

export const rocHookEventNames = rocHookEventNameSchema.options;

export type RocHookEventName = z.infer<typeof rocHookEventNameSchema>;
export type RocHookConfig = z.infer<typeof rocHookConfigSchema>;
export type RocHookMatcherGroup = NonNullable<RocHookConfig['hooks'][RocHookEventName]>[number];
export type RocHookCommandHandler = RocHookMatcherGroup['hooks'][number];
export type RocHookFailureMode = RocHookCommandHandler['failureMode'];
export type RocHookHandlerType = RocHookCommandHandler['type'];
export type RocHookConfigSnapshot = z.infer<typeof rocHookConfigSnapshotSchema>;
export type RocHookConfiguredHandlerSnapshot = RocHookConfigSnapshot['handlers'][number];
export type RocHookTrustState = RocHookConfiguredHandlerSnapshot['trustState'];

export const emptyRocHookConfigSnapshot: RocHookConfigSnapshot = {
  configPath: '',
  exists: false,
  config: {
    schemaVersion: 1,
    hooks: {}
  },
  handlers: [],
  validationErrors: []
};

export type RocHookTrustRequest = z.infer<typeof settingsTrustHookRequestSchema>;
export type RocHookSaveConfigRequest = z.infer<typeof settingsSaveHookConfigRequestSchema>;
export type RocHookRunSummary = z.infer<typeof hookRunSummarySchema>;
export type RocHookRunStatus = RocHookRunSummary['status'];
export type RocHookRunEvent = Extract<
  z.infer<typeof chatRunEventSchema>,
  { type: 'hook_started' | 'hook_completed' }
>;

export type RocHookSessionSource = 'chat' | 'background_task';

export type RocHookSessionEndStatus = 'completed' | 'failed' | 'cancelled';

export type RocHookCommandInputPayload =
  | {
      event: 'SessionStart';
      payload: {
        source: RocHookSessionSource;
        modelId: string;
        workflowHint: string | null;
      };
    }
  | {
      event: 'UserPromptSubmit';
      payload: {
        prompt: string;
      };
    }
  | {
      event: 'PreToolUse';
      payload: {
        toolName: string;
        toolCallId: string;
        toolInput: unknown;
      };
    }
  | {
      event: 'PostToolUse';
      payload: {
        toolName: string;
        toolCallId: string;
        toolInput: unknown;
        toolOutput: unknown;
      };
    }
  | {
      event: 'Stop';
      payload: {
        lastAssistantMessage: string | null;
        visibleOutput: boolean;
      };
    }
  | {
      event: 'SessionEnd';
      payload: {
        status: RocHookSessionEndStatus;
        error: string | null;
      };
    };

export type RocHookCommandInput = {
  schemaVersion: 1;
  runId: string;
  threadId: string | null;
  workspacePath: string | null;
  cwd: string;
  triggeredAt: string;
} & RocHookCommandInputPayload;

export type RocHookCommandOutputAction = 'continue' | 'block' | 'replace_input' | 'add_context' | 'request_continue';

export type RocHookCommandOutput = {
  action: RocHookCommandOutputAction;
  message?: string;
  updatedInput?: unknown;
  additionalContext?: string;
};
