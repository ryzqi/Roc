import type {
  RocHookCommandHandler,
  RocHookCommandInput,
  RocHookCommandOutput,
  RocHookConfig,
  RocHookEventName,
  RocHookRunEvent,
  RocHookRunStatus,
  RocHookRunSummary
} from '../../../shared/types';
import { computeHookHandlerHash, createHookHandlerId, createHookRunId } from './hash';
import type { HookCommandRunner, HookCommandRunResult } from './command-runner';
import { isVirtualHookCwd } from './command-runner';
import { validateHookCommandOutputForEvent } from './schema';

type HookRuntimeConfigService = {
  loadConfig(): Promise<RocHookConfig>;
};

type HookRuntimeTrustService = {
  isTrusted(input: { handlerId: string; hash: string }): Promise<boolean>;
};

type HookRuntimeDeps = {
  configService: HookRuntimeConfigService;
  trustService: HookRuntimeTrustService;
  commandRunner: Pick<HookCommandRunner, 'run'>;
  emitEvent?: (event: RocHookRunEvent) => Promise<void> | void;
};

type SelectedHookHandler = {
  handlerId: string;
  handler: RocHookCommandHandler;
  hash: string;
};

type HookExecution = {
  selectedHandler: SelectedHookHandler;
  parentRunId: string;
  hookRunId: string;
  startedEvent: RocHookRunEvent | null;
  result: HookCommandRunResult | null;
  skippedMessage: string | null;
};

export type HookRuntimeOutcome = {
  blocked: boolean;
  blockReason: string | null;
  updatedInput: unknown | undefined;
  additionalContexts: string[];
  requestContinue: string | null;
  runs: RocHookRunSummary[];
  events: RocHookRunEvent[];
};

export class HookRuntime {
  constructor(private readonly deps: HookRuntimeDeps) {}

  async runEvent(input: RocHookCommandInput): Promise<HookRuntimeOutcome> {
    const config = await this.deps.configService.loadConfig();
    const selected = selectConfiguredHandlers(config, input);
    const executions = await Promise.all(selected.map(async (selectedHandler) => await this.executeSelectedHandler(input, selectedHandler)));
    const outcome = mergeHookExecutions(input.event, executions);
    for (const event of outcome.events) {
      if (event.type === 'hook_completed') {
        await this.emitEvent(event);
      }
    }
    return outcome;
  }

  private async executeSelectedHandler(input: RocHookCommandInput, selectedHandler: SelectedHookHandler): Promise<HookExecution> {
    const hookRunId = createHookRunId({ parentRunId: input.runId, handlerId: selectedHandler.handlerId });
    if (!selectedHandler.handler.enabled) {
      return skippedExecution({ selectedHandler, parentRunId: input.runId, hookRunId, message: 'disabled' });
    }
    let trusted: boolean;
    try {
      trusted = await this.deps.trustService.isTrusted({
        handlerId: selectedHandler.handlerId,
        hash: selectedHandler.hash
      });
    } catch (error) {
      return skippedExecution({ selectedHandler, parentRunId: input.runId, hookRunId, message: formatError(error) });
    }
    if (!trusted) {
      return skippedExecution({ selectedHandler, parentRunId: input.runId, hookRunId, message: 'review_required' });
    }

    const startedEvent = createHookRunEvent({
      type: 'hook_started',
      runId: input.runId,
      hook: createRunSummary({
        runId: hookRunId,
        handlerId: selectedHandler.handlerId,
        event: input.event,
        status: 'running',
        durationMs: null,
        message: selectedHandler.handler.statusMessage === undefined ? null : selectedHandler.handler.statusMessage
      })
    });
    await this.emitEvent(startedEvent);

    if (isVirtualHookCwd(input.cwd)) {
      return {
        selectedHandler,
        parentRunId: input.runId,
        hookRunId,
        startedEvent,
        result: failedRunResult('hook_cwd_virtual_path', 0),
        skippedMessage: null
      };
    }

    try {
      return {
        selectedHandler,
        parentRunId: input.runId,
        hookRunId,
        startedEvent,
        result: await this.deps.commandRunner.run({
          command: resolveCommand(selectedHandler.handler),
          cwd: input.cwd,
          timeoutSeconds: selectedHandler.handler.timeoutSeconds,
          input
        }),
        skippedMessage: null
      };
    } catch (error) {
      return {
        selectedHandler,
        parentRunId: input.runId,
        hookRunId,
        startedEvent,
        result: failedRunResult(formatError(error), 0),
        skippedMessage: null
      };
    }
  }

  private async emitEvent(event: RocHookRunEvent): Promise<void> {
    if (this.deps.emitEvent !== undefined) {
      await this.deps.emitEvent(event);
    }
  }
}

function selectConfiguredHandlers(config: RocHookConfig, input: RocHookCommandInput): SelectedHookHandler[] {
  const groups = config.hooks[input.event];
  if (groups === undefined) {
    return [];
  }
  const selected: SelectedHookHandler[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    const matcher = group.matcher === undefined ? null : group.matcher;
    if (!matchesEvent(input, matcher)) {
      continue;
    }
    for (const [hookIndex, handler] of group.hooks.entries()) {
      const handlerId = createHookHandlerId({ event: input.event, groupIndex, hookIndex });
      selected.push({
        handlerId,
        handler,
        hash: computeHookHandlerHash({ event: input.event, matcher, handler })
      });
    }
  }
  return selected;
}

function matchesEvent(input: RocHookCommandInput, matcher: string | null): boolean {
  if (input.event === 'UserPromptSubmit' || input.event === 'Stop') {
    return true;
  }
  if (matcher === null || matcher.length === 0 || matcher === '*') {
    return true;
  }
  try {
    return new RegExp(matcher).test(matcherValue(input));
  } catch {
    return false;
  }
}

function matcherValue(input: RocHookCommandInput): string {
  if (input.event === 'PreToolUse' || input.event === 'PostToolUse') {
    return input.payload.toolName;
  }
  if (input.event === 'SessionStart') {
    return input.payload.source;
  }
  if (input.event === 'SessionEnd') {
    return input.payload.status;
  }
  return '';
}

function mergeHookExecutions(event: RocHookEventName, executions: HookExecution[]): HookRuntimeOutcome {
  let blocked = false;
  let blockReason: string | null = null;
  let updatedInput: unknown | undefined;
  let requestContinue: string | null = null;
  const additionalContexts: string[] = [];
  const runs: RocHookRunSummary[] = [];
  const events: RocHookRunEvent[] = [];

  for (const execution of executions) {
    const processed = processExecution(event, execution);
    runs.push(processed.summary);
    if (execution.startedEvent !== null) {
      events.push(execution.startedEvent);
    }
    events.push(createHookRunEvent({ type: 'hook_completed', runId: execution.parentRunId, hook: processed.summary }));
    if (processed.blocked && !blocked) {
      blocked = true;
      blockReason = processed.blockReason;
    }
    if (processed.output?.action === 'replace_input') {
      updatedInput = processed.output.updatedInput;
    }
    if (processed.output?.action === 'add_context' && typeof processed.output.additionalContext === 'string') {
      additionalContexts.push(processed.output.additionalContext);
    }
    if (processed.output?.action === 'request_continue') {
      requestContinue = processed.output.message === undefined ? 'Continue after hook request.' : processed.output.message;
    }
  }

  return {
    blocked,
    blockReason,
    updatedInput,
    additionalContexts,
    requestContinue,
    runs,
    events
  };
}

function processExecution(
  event: RocHookEventName,
  execution: HookExecution
): {
  summary: RocHookRunSummary;
  blocked: boolean;
  blockReason: string | null;
  output: RocHookCommandOutput | null;
} {
  if (execution.result === null) {
    return {
      summary: createRunSummary({
        runId: execution.hookRunId,
        handlerId: execution.selectedHandler.handlerId,
        event,
        status: 'skipped',
        durationMs: 0,
        message: execution.skippedMessage
      }),
      blocked: false,
      blockReason: null,
      output: null
    };
  }
  if (execution.result.status === 'failed') {
    return failedExecutionToProcessed(event, execution, execution.result.error, execution.result.durationMs);
  }
  let output: RocHookCommandOutput;
  try {
    output = validateHookCommandOutputForEvent(event, execution.result.output);
  } catch (error) {
    return failedExecutionToProcessed(event, execution, formatError(error), execution.result.durationMs);
  }

  if (output.action === 'block') {
    const reason = output.message === undefined ? 'Blocked by hook.' : output.message;
    return {
      summary: createRunSummary({
        runId: execution.hookRunId,
        handlerId: execution.selectedHandler.handlerId,
        event,
        status: 'blocked',
        durationMs: execution.result.durationMs,
        message: reason
      }),
      blocked: true,
      blockReason: reason,
      output
    };
  }

  return {
    summary: createRunSummary({
      runId: execution.hookRunId,
      handlerId: execution.selectedHandler.handlerId,
      event,
      status: 'completed',
      durationMs: execution.result.durationMs,
      message: output.message === undefined ? null : output.message
    }),
    blocked: false,
    blockReason: null,
    output
  };
}

function failedExecutionToProcessed(
  event: RocHookEventName,
  execution: HookExecution,
  error: string,
  durationMs: number
): {
  summary: RocHookRunSummary;
  blocked: boolean;
  blockReason: string | null;
  output: null;
} {
  const blocked = failureBlocksEvent(event, execution.selectedHandler.handler.failureMode);
  return {
    summary: createRunSummary({
      runId: execution.hookRunId,
      handlerId: execution.selectedHandler.handlerId,
      event,
      status: blocked ? 'blocked' : 'failed',
      durationMs,
      message: error
    }),
    blocked,
    blockReason: blocked ? error : null,
    output: null
  };
}

function failureBlocksEvent(event: RocHookEventName, failureMode: RocHookCommandHandler['failureMode']): boolean {
  return failureMode === 'block' && event !== 'SessionEnd';
}

function resolveCommand(handler: RocHookCommandHandler): string {
  if (process.platform === 'win32' && handler.commandWindows !== undefined) {
    return handler.commandWindows;
  }
  return handler.command;
}

function skippedExecution(input: { selectedHandler: SelectedHookHandler; parentRunId: string; hookRunId: string; message: string }): HookExecution {
  return {
    selectedHandler: input.selectedHandler,
    parentRunId: input.parentRunId,
    hookRunId: input.hookRunId,
    startedEvent: null,
    result: null,
    skippedMessage: input.message
  };
}

function failedRunResult(error: string, durationMs: number): HookCommandRunResult {
  return {
    status: 'failed',
    durationMs,
    stdout: '',
    stderr: '',
    error
  };
}

function createRunSummary(input: {
  runId: string;
  handlerId: string;
  event: RocHookEventName;
  status: RocHookRunStatus;
  durationMs: number | null;
  message: string | null;
}): RocHookRunSummary {
  return {
    runId: input.runId,
    handlerId: input.handlerId,
    event: input.event,
    status: input.status,
    durationMs: input.durationMs,
    message: input.message
  };
}

function createHookRunEvent(input: { type: RocHookRunEvent['type']; runId: string; hook: RocHookRunSummary }): RocHookRunEvent {
  if (input.type === 'hook_started') {
    return {
      type: 'hook_started',
      runId: input.runId,
      hook: input.hook
    };
  }
  return {
    type: 'hook_completed',
    runId: input.runId,
    hook: input.hook
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
