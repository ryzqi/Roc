export const rocHookEventNames = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'] as const;

export type RocHookEventName = (typeof rocHookEventNames)[number];

export type RocHookFailureMode = 'continue' | 'block';

export type RocHookHandlerType = 'command';

export type RocHookCommandHandler = {
  type: 'command';
  command: string;
  commandWindows?: string;
  timeoutSeconds: number;
  statusMessage?: string;
  enabled: boolean;
  failureMode: RocHookFailureMode;
};

export type RocHookMatcherGroup = {
  matcher?: string;
  hooks: RocHookCommandHandler[];
};

export type RocHookConfig = {
  schemaVersion: 1;
  hooks: Partial<Record<RocHookEventName, RocHookMatcherGroup[]>>;
};

export type RocHookTrustState = 'trusted' | 'review_required' | 'disabled' | 'invalid';

export type RocHookConfiguredHandlerSnapshot = {
  id: string;
  event: RocHookEventName;
  matcher: string | null;
  command: string;
  commandWindows: string | null;
  timeoutSeconds: number;
  statusMessage: string | null;
  enabled: boolean;
  failureMode: RocHookFailureMode;
  hash: string;
  trustState: RocHookTrustState;
  validationError: string | null;
  lastRun: RocHookRunSummary | null;
};

export type RocHookConfigSnapshot = {
  configPath: string;
  exists: boolean;
  config: RocHookConfig;
  handlers: RocHookConfiguredHandlerSnapshot[];
  validationErrors: string[];
};

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

export type RocHookTrustRequest = {
  handlerId: string;
  hash: string;
};

export type RocHookSaveConfigRequest = {
  config: RocHookConfig;
};

export type RocHookRunStatus = 'skipped' | 'running' | 'completed' | 'failed' | 'blocked';

export type RocHookRunSummary = {
  runId: string;
  handlerId: string;
  event: RocHookEventName;
  status: RocHookRunStatus;
  durationMs: number | null;
  message: string | null;
};

export type RocHookRunEvent =
  | {
      type: 'hook_started';
      runId: string;
      hook: RocHookRunSummary;
    }
  | {
      type: 'hook_completed';
      runId: string;
      hook: RocHookRunSummary;
    };

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
