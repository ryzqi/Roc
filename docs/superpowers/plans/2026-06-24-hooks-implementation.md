# Roc Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build user-configurable global command hooks for Roc from `%USERPROFILE%\.roc\hooks.json`, with settings UI management, hash trust, DeepAgents middleware integration, and lifecycle events for chat and background task runs.

**Architecture:** Use shared hook protocol types, main-process hook services, and a LangChain middleware adapter. Run-level events use the agent runtime/executor boundary; tool-loop events use `createMiddleware` in `buildDeepAgent()`. Hook commands run through a Roc-owned process runner and never through the agent `run_shell_command` tool.

**Tech Stack:** TypeScript ESM, Electron main/preload/renderer, React 19, Zod, LangChain `createMiddleware`, DeepAgents `createDeepAgent`, Vitest.

## Global Constraints

- Configuration source is `%USERPROFILE%\.roc\hooks.json`.
- Hooks apply globally to chat runs and background task runs across all workspaces.
- First version supports only `type: "command"` handlers.
- Supported events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and `SessionEnd`.
- Hook commands use real Windows cwd paths and never use DeepAgents virtual `/workspace/...` paths.
- Hook commands do not execute through the agent `run_shell_command` tool.
- Trust is stored outside `hooks.json` and is keyed by handler hash.
- `statusMessage` does not affect the trust hash.
- `SessionEnd` is best-effort and cannot change final run status.
- Preserve existing Roc DeepAgents tools, memory, skills, workspace binding, and `interruptOn` behavior.
- Keep unrelated existing worktree changes untouched; stage only files belonging to the current task.

---

## File Structure

Create these focused modules:

- `src/shared/types/hooks.ts`: shared hook config, snapshot, trust, run event, command input, and command output types.
- `src/main/services/hooks/schema.ts`: Zod validation for hook config and command outputs.
- `src/main/services/hooks/hash.ts`: canonical hash computation for configured handlers.
- `src/main/services/hooks/config-service.ts`: read/write `%USERPROFILE%\.roc\hooks.json`.
- `src/main/services/hooks/trust-service.ts`: read/write trusted handler hashes.
- `src/main/services/hooks/command-runner.ts`: spawn hook commands with stdin JSON, timeout, output capture, and truncation.
- `src/main/services/hooks/runtime.ts`: select handlers, apply matcher rules, execute trusted command hooks, merge outcomes.
- `src/main/services/hooks/middleware.ts`: LangChain middleware adapter for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`.
- `src/main/services/hooks/index.ts`: exports for the hook service package.
- `src/renderer/settings/sections/hooks-section.tsx`: settings UI section for hooks.

Modify these existing files:

- `src/shared/types/index.ts`: export hook types.
- `src/shared/types/chat.ts`: add hook runtime events to `ChatRunEvent`.
- `src/shared/types/settings.ts`: add hook snapshot and settings request/result types.
- `src/shared/ipc.ts`: expose hook settings APIs.
- `src/shared/ipc-schema.json`: add hook settings channels, then regenerate IPC.
- `src/main/services/paths.ts`: ensure `%USERPROFILE%\.roc` already exists; add no new root unless needed by hook services.
- `src/main/main-kernel-bootstrap.ts`: construct hook services and pass them to the agent executor and settings IPC.
- `src/main/ipc/settings-ipc.ts`: register hook config/trust handlers.
- `src/main/services/deep-agent/agent-builder.ts`: accept optional hook middleware and preserve guardrail ordering.
- `src/main/plugins/agent/deep-agent-executor.ts`: invoke hook runtime for session/user/tool lifecycle and pass middleware into `buildDeepAgent()`.
- `src/main/plugins/agent/runtime.ts`: emit best-effort `SessionEnd` for completed, failed, and cancelled runs.
- `src/renderer/settings/index.tsx`: render hooks section and wire handlers.
- `src/renderer/settings/settings-save-model.ts`: include hook snapshot in loaded settings state.
- `src/renderer/loaded-state.ts`: include hook settings snapshot if required by current settings state shape.

Add tests:

- `tests/main/services/hooks/schema.test.ts`
- `tests/main/services/hooks/hash.test.ts`
- `tests/main/services/hooks/config-service.test.ts`
- `tests/main/services/hooks/trust-service.test.ts`
- `tests/main/services/hooks/command-runner.test.ts`
- `tests/main/services/hooks/runtime.test.ts`
- `tests/main/services/hooks/middleware.test.ts`
- `tests/main/plugins/agent/deep-agent-executor-hooks.test.ts`
- `tests/main/plugins/agent/runtime-hooks.test.ts`
- `tests/main/settings-ipc-hooks.test.ts`
- `tests/renderer/settings-hooks-section.test.tsx`

---

### Task 1: Shared Hook Protocol Types And Schema

**Files:**
- Create: `src/shared/types/hooks.ts`
- Modify: `src/shared/types/index.ts`
- Modify: `src/shared/types/chat.ts`
- Modify: `src/shared/types/settings.ts`
- Create: `src/main/services/hooks/schema.ts`
- Test: `tests/main/services/hooks/schema.test.ts`

**Interfaces:**
- Produces: `RocHookEventName`, `RocHookConfig`, `RocHookConfigSnapshot`, `RocHookCommandInput`, `RocHookCommandOutput`, `RocHookRunEvent`, `HookConfigSchema`, `HookCommandOutputSchema`.
- Consumes: Existing `ChatRunEvent`, `SettingsSnapshot`, and `SettingsSaveRequest`.

- [ ] **Step 1: Write schema tests first**

Create `tests/main/services/hooks/schema.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { HookCommandOutputSchema, HookConfigSchema } from '../../../../src/main/services/hooks/schema';

describe('HookConfigSchema', () => {
  it('normalizes command hook defaults', () => {
    const parsed = HookConfigSchema.parse({
      schemaVersion: 1,
      hooks: {
        PreToolUse: [
          {
            matcher: '^run_shell_command$',
            hooks: [
              {
                type: 'command',
                command: 'powershell -NoProfile -File C:\\Users\\me\\.roc\\hooks\\check.ps1'
              }
            ]
          }
        ]
      }
    });

    expect(parsed.hooks.PreToolUse?.[0]?.hooks[0]).toMatchObject({
      type: 'command',
      timeoutSeconds: 30,
      enabled: true,
      failureMode: 'continue'
    });
  });

  it('rejects unsupported handler types', () => {
    expect(() =>
      HookConfigSchema.parse({
        schemaVersion: 1,
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'prompt',
                  prompt: 'not supported'
                }
              ]
            }
          ]
        }
      })
    ).toThrow();
  });

  it('rejects invalid timeout values', () => {
    expect(() =>
      HookConfigSchema.parse({
        schemaVersion: 1,
        hooks: {
          SessionStart: [
            {
              matcher: 'chat',
              hooks: [
                {
                  type: 'command',
                  command: 'node hook.js',
                  timeoutSeconds: 601
                }
              ]
            }
          ]
        }
      })
    ).toThrow();
  });
});

describe('HookCommandOutputSchema', () => {
  it('parses add_context output', () => {
    expect(
      HookCommandOutputSchema.parse({
        action: 'add_context',
        message: 'context added',
        additionalContext: 'Use safer shell commands.'
      })
    ).toEqual({
      action: 'add_context',
      message: 'context added',
      additionalContext: 'Use safer shell commands.'
    });
  });

  it('rejects invalid action', () => {
    expect(() => HookCommandOutputSchema.parse({ action: 'pause' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/main/services/hooks/schema.test.ts`

Expected: FAIL because `src/main/services/hooks/schema.ts` does not exist.

- [ ] **Step 3: Add shared hook types**

Create `src/shared/types/hooks.ts`:

```typescript
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
  handlers: RocHookConfiguredHandlerSnapshot[];
  validationErrors: string[];
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
```

Modify `src/shared/types/index.ts`:

```typescript
export * from './common';
export * from './app';
export * from './workspace';
export * from './git';
export * from './rtk';
export * from './terminal';
export * from './memory';
export * from './mcp';
export * from './skill';
export * from './settings';
export * from './agent';
export * from './chat';
export * from './task';
export * from './diagnostics';
export * from './performance';
export * from './metrics';
export * from './shell';
export * from './provider-config';
export * from './hooks';
```

Modify `src/shared/types/chat.ts` to import `RocHookRunEvent` and add it to `ChatRunEvent`:

```typescript
import type { AsyncTaskStatus } from 'deepagents';
import type { HITLRequest, HITLResponse } from 'langchain';
import type { EnabledCapabilities } from './agent';
import type { RocHookRunEvent } from './hooks';
```

Add this union member before `run_completed`:

```typescript
  | RocHookRunEvent
```

Modify `src/shared/types/settings.ts` imports:

```typescript
import type { RocHookConfigSnapshot, RocHookSaveConfigRequest, RocHookTrustRequest } from './hooks';
```

Add `hooks: RocHookConfigSnapshot;` to `SettingsSnapshot` and export request aliases:

```typescript
export type SettingsSnapshot = {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
  hooks: RocHookConfigSnapshot;
  hostIntegration: HostIntegrationStatus;
};

export type SettingsSaveHookConfigRequest = RocHookSaveConfigRequest;

export type SettingsTrustHookRequest = RocHookTrustRequest;
```

- [ ] **Step 4: Add Zod schemas**

Create `src/main/services/hooks/schema.ts`:

```typescript
import { z } from 'zod';
import {
  rocHookEventNames,
  type RocHookCommandOutput,
  type RocHookConfig
} from '../../../shared/types';

const HookFailureModeSchema = z.enum(['continue', 'block']);

const CommandHandlerSchema = z.object({
  type: z.literal('command'),
  command: z.string().trim().min(1),
  commandWindows: z.string().trim().min(1).optional(),
  timeoutSeconds: z.number().int().min(1).max(600).default(30),
  statusMessage: z.string().trim().min(1).optional(),
  enabled: z.boolean().default(true),
  failureMode: HookFailureModeSchema.default('continue')
});

const MatcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(CommandHandlerSchema).min(1)
});

const HooksRecordSchema = z.object(
  Object.fromEntries(rocHookEventNames.map((eventName) => [eventName, z.array(MatcherGroupSchema).optional()])) as Record<
    (typeof rocHookEventNames)[number],
    z.ZodOptional<z.ZodArray<typeof MatcherGroupSchema>>
  >
);

export const HookConfigSchema: z.ZodType<RocHookConfig> = z.object({
  schemaVersion: z.literal(1),
  hooks: HooksRecordSchema
});

export const EmptyHookConfig: RocHookConfig = {
  schemaVersion: 1,
  hooks: {}
};

export const HookCommandOutputSchema: z.ZodType<RocHookCommandOutput> = z.object({
  action: z.enum(['continue', 'block', 'replace_input', 'add_context', 'request_continue']),
  message: z.string().min(1).optional(),
  updatedInput: z.unknown().optional(),
  additionalContext: z.string().min(1).optional()
});
```

- [ ] **Step 5: Run schema tests**

Run: `pnpm test -- tests/main/services/hooks/schema.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/shared/types/hooks.ts src/shared/types/index.ts src/shared/types/chat.ts src/shared/types/settings.ts src/main/services/hooks/schema.ts tests/main/services/hooks/schema.test.ts
git commit -m "feat: add hook protocol schema"
```

---

### Task 2: Hook Config And Trust Services

**Files:**
- Create: `src/main/services/hooks/hash.ts`
- Create: `src/main/services/hooks/config-service.ts`
- Create: `src/main/services/hooks/trust-service.ts`
- Create: `src/main/services/hooks/index.ts`
- Test: `tests/main/services/hooks/hash.test.ts`
- Test: `tests/main/services/hooks/config-service.test.ts`
- Test: `tests/main/services/hooks/trust-service.test.ts`

**Interfaces:**
- Consumes: `RocPaths`, `HookConfigSchema`, `RocHookConfig`, `RocHookConfiguredHandlerSnapshot`.
- Produces: `computeHookHandlerHash()`, `createHookHandlerId()`, `createHookRunId()`, `HookConfigService`, `HookTrustService`.

- [ ] **Step 1: Write hash tests**

Create `tests/main/services/hooks/hash.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { computeHookHandlerHash } from '../../../../src/main/services/hooks/hash';

describe('computeHookHandlerHash', () => {
  it('changes when command changes', () => {
    const first = computeHookHandlerHash({
      event: 'PreToolUse',
      matcher: '^run_shell_command$',
      handler: {
        type: 'command',
        command: 'node first.js',
        timeoutSeconds: 30,
        enabled: true,
        failureMode: 'continue'
      }
    });
    const second = computeHookHandlerHash({
      event: 'PreToolUse',
      matcher: '^run_shell_command$',
      handler: {
        type: 'command',
        command: 'node second.js',
        timeoutSeconds: 30,
        enabled: true,
        failureMode: 'continue'
      }
    });

    expect(first).not.toEqual(second);
  });

  it('ignores statusMessage', () => {
    const base = {
      event: 'Stop' as const,
      matcher: null,
      handler: {
        type: 'command' as const,
        command: 'node stop.js',
        timeoutSeconds: 30,
        enabled: true,
        failureMode: 'continue' as const
      }
    };

    expect(computeHookHandlerHash(base)).toEqual(
      computeHookHandlerHash({
        ...base,
        handler: {
          ...base.handler,
          statusMessage: 'Changed display text'
        }
      })
    );
  });
});
```

- [ ] **Step 2: Write config and trust tests**

Create `tests/main/services/hooks/config-service.test.ts`:

```typescript
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HookConfigService } from '../../../../src/main/services/hooks/config-service';
import { RocPaths } from '../../../../src/main/services/paths';

describe('HookConfigService', () => {
  it('returns an empty config when hooks.json does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const service = new HookConfigService(new RocPaths(root));

    const snapshot = await service.loadConfigSnapshot();

    expect(snapshot.exists).toBe(false);
    expect(snapshot.validationErrors).toEqual([]);
    expect(snapshot.handlers).toEqual([]);
  });

  it('writes hooks.json under the Roc root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const service = new HookConfigService(new RocPaths(root));

    await service.saveConfig({
      schemaVersion: 1,
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node prompt.js',
                timeoutSeconds: 30,
                enabled: true,
                failureMode: 'continue'
              }
            ]
          }
        ]
      }
    });

    expect(JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                command: 'node prompt.js'
              }
            ]
          }
        ]
      }
    });
  });
});
```

Create `tests/main/services/hooks/trust-service.test.ts`:

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HookTrustService } from '../../../../src/main/services/hooks/trust-service';
import { RocPaths } from '../../../../src/main/services/paths';

describe('HookTrustService', () => {
  it('trusts and verifies handler hashes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const service = new HookTrustService(new RocPaths(root));

    await service.trust({ handlerId: 'PreToolUse:0:0', hash: 'abc123' });

    expect(await service.isTrusted({ handlerId: 'PreToolUse:0:0', hash: 'abc123' })).toBe(true);
    expect(await service.isTrusted({ handlerId: 'PreToolUse:0:0', hash: 'changed' })).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `pnpm test -- tests/main/services/hooks/hash.test.ts tests/main/services/hooks/config-service.test.ts tests/main/services/hooks/trust-service.test.ts`

Expected: FAIL because service modules do not exist.

- [ ] **Step 4: Implement hash helpers**

Create `src/main/services/hooks/hash.ts`:

```typescript
import { createHash } from 'node:crypto';
import type { RocHookCommandHandler, RocHookEventName } from '../../../shared/types';

type HashInput = {
  event: RocHookEventName;
  matcher: string | null;
  handler: RocHookCommandHandler;
};

export function computeHookHandlerHash(input: HashInput): string {
  const canonical = {
    event: input.event,
    matcher: input.matcher,
    type: input.handler.type,
    command: input.handler.command,
    commandWindows: input.handler.commandWindows === undefined ? null : input.handler.commandWindows,
    timeoutSeconds: input.handler.timeoutSeconds,
    failureMode: input.handler.failureMode
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function createHookHandlerId(input: { event: RocHookEventName; groupIndex: number; hookIndex: number }): string {
  return `${input.event}:${input.groupIndex}:${input.hookIndex}`;
}

export function createHookRunId(input: { parentRunId: string; handlerId: string }): string {
  return `${input.parentRunId}:hook:${input.handlerId}`;
}
```

- [ ] **Step 5: Implement config service**

Create `src/main/services/hooks/config-service.ts`:

```typescript
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RocHookConfig,
  RocHookConfigSnapshot,
  RocHookConfiguredHandlerSnapshot
} from '../../../shared/types';
import type { RocPaths } from '../paths';
import { EmptyHookConfig, HookConfigSchema } from './schema';
import { computeHookHandlerHash, createHookHandlerId } from './hash';

export class HookConfigService {
  constructor(private readonly paths: RocPaths) {}

  getConfigPath(): string {
    return join(this.paths.root, 'hooks.json');
  }

  async loadConfig(): Promise<RocHookConfig> {
    const configPath = this.getConfigPath();
    if (!existsSync(configPath)) {
      return EmptyHookConfig;
    }
    const raw = await readFile(configPath, 'utf8');
    return HookConfigSchema.parse(JSON.parse(raw));
  }

  async loadConfigSnapshot(): Promise<RocHookConfigSnapshot> {
    const configPath = this.getConfigPath();
    if (!existsSync(configPath)) {
      return {
        configPath,
        exists: false,
        handlers: [],
        validationErrors: []
      };
    }
    try {
      return {
        configPath,
        exists: true,
        handlers: buildHandlerSnapshots(await this.loadConfig()),
        validationErrors: []
      };
    } catch (error) {
      return {
        configPath,
        exists: true,
        handlers: [],
        validationErrors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  async saveConfig(config: RocHookConfig): Promise<RocHookConfigSnapshot> {
    const parsed = HookConfigSchema.parse(config);
    await mkdir(this.paths.root, { recursive: true });
    await writeFile(this.getConfigPath(), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return await this.loadConfigSnapshot();
  }
}

export function buildHandlerSnapshots(config: RocHookConfig): RocHookConfiguredHandlerSnapshot[] {
  const snapshots: RocHookConfiguredHandlerSnapshot[] = [];
  for (const [event, groups] of Object.entries(config.hooks)) {
    const typedEvent = event as keyof RocHookConfig['hooks'];
    groups?.forEach((group, groupIndex) => {
      group.hooks.forEach((handler, hookIndex) => {
        const matcher = group.matcher === undefined ? null : group.matcher;
        const id = createHookHandlerId({ event: typedEvent, groupIndex, hookIndex });
        snapshots.push({
          id,
          event: typedEvent,
          matcher,
          command: handler.command,
          commandWindows: handler.commandWindows === undefined ? null : handler.commandWindows,
          timeoutSeconds: handler.timeoutSeconds,
          statusMessage: handler.statusMessage === undefined ? null : handler.statusMessage,
          enabled: handler.enabled,
          failureMode: handler.failureMode,
          hash: computeHookHandlerHash({ event: typedEvent, matcher, handler }),
          trustState: handler.enabled ? 'review_required' : 'disabled',
          validationError: null,
          lastRun: null
        });
      });
    });
  }
  return snapshots;
}
```

- [ ] **Step 6: Implement trust service and exports**

Create `src/main/services/hooks/trust-service.ts`:

```typescript
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RocHookTrustRequest } from '../../../shared/types';
import type { RocPaths } from '../paths';

type TrustDocument = {
  schemaVersion: 1;
  trusted: Record<string, string>;
};

const emptyTrustDocument: TrustDocument = {
  schemaVersion: 1,
  trusted: {}
};

export class HookTrustService {
  constructor(private readonly paths: RocPaths) {}

  getTrustPath(): string {
    return join(this.paths.configDir, 'hooks-trust.json');
  }

  async trust(request: RocHookTrustRequest): Promise<void> {
    const document = await this.readTrustDocument();
    document.trusted[request.handlerId] = request.hash;
    await this.writeTrustDocument(document);
  }

  async isTrusted(request: RocHookTrustRequest): Promise<boolean> {
    const document = await this.readTrustDocument();
    return document.trusted[request.handlerId] === request.hash;
  }

  private async readTrustDocument(): Promise<TrustDocument> {
    const trustPath = this.getTrustPath();
    if (!existsSync(trustPath)) {
      return structuredClone(emptyTrustDocument);
    }
    const parsed = JSON.parse(await readFile(trustPath, 'utf8')) as TrustDocument;
    if (parsed.schemaVersion !== 1 || parsed.trusted === null || typeof parsed.trusted !== 'object') {
      throw new Error('hooks_trust_document_invalid');
    }
    return parsed;
  }

  private async writeTrustDocument(document: TrustDocument): Promise<void> {
    await mkdir(this.paths.configDir, { recursive: true });
    await writeFile(this.getTrustPath(), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  }
}
```

Create `src/main/services/hooks/index.ts`:

```typescript
export * from './schema';
export * from './hash';
export * from './config-service';
export * from './trust-service';
```

- [ ] **Step 7: Run tests**

Run: `pnpm test -- tests/main/services/hooks/hash.test.ts tests/main/services/hooks/config-service.test.ts tests/main/services/hooks/trust-service.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```powershell
git add src/main/services/hooks/hash.ts src/main/services/hooks/config-service.ts src/main/services/hooks/trust-service.ts src/main/services/hooks/index.ts tests/main/services/hooks/hash.test.ts tests/main/services/hooks/config-service.test.ts tests/main/services/hooks/trust-service.test.ts
git commit -m "feat: add hook config trust services"
```

---

### Task 3: Hook Command Runner And Runtime

**Files:**
- Create: `src/main/services/hooks/command-runner.ts`
- Create: `src/main/services/hooks/runtime.ts`
- Modify: `src/main/services/hooks/index.ts`
- Test: `tests/main/services/hooks/command-runner.test.ts`
- Test: `tests/main/services/hooks/runtime.test.ts`

**Interfaces:**
- Consumes: `HookConfigService`, `HookTrustService`, `HookCommandOutputSchema`.
- Produces: `HookCommandRunner.run()`, `HookRuntime.runEvent()`, `HookRuntimeOutcome`.

- [ ] **Step 1: Write command runner tests**

Create `tests/main/services/hooks/command-runner.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HookCommandRunner } from '../../../../src/main/services/hooks/command-runner';

describe('HookCommandRunner', () => {
  it('passes JSON input on stdin and parses stdout JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const script = join(dir, 'hook.cjs');
    writeFileSync(
      script,
      [
        'let input = "";',
        'process.stdin.on("data", chunk => input += chunk);',
        'process.stdin.on("end", () => {',
        '  const parsed = JSON.parse(input);',
        '  process.stdout.write(JSON.stringify({ action: "add_context", additionalContext: parsed.event }));',
        '});'
      ].join('\n')
    );

    const result = await new HookCommandRunner().run({
      command: `node "${script}"`,
      cwd: dir,
      timeoutSeconds: 5,
      input: {
        schemaVersion: 1,
        event: 'UserPromptSubmit',
        runId: 'run_1',
        threadId: 'thread_1',
        workspacePath: dir,
        cwd: dir,
        triggeredAt: '2026-06-24T10:00:00.000Z',
        payload: { prompt: 'hello' }
      }
    });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ action: 'add_context', additionalContext: 'UserPromptSubmit' });
  });

  it('reports invalid JSON output as failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roc-hooks-'));
    const script = join(dir, 'hook.cjs');
    writeFileSync(script, 'process.stdout.write("not json");');

    const result = await new HookCommandRunner().run({
      command: `node "${script}"`,
      cwd: dir,
      timeoutSeconds: 5,
      input: {
        schemaVersion: 1,
        event: 'Stop',
        runId: 'run_1',
        threadId: 'thread_1',
        workspacePath: dir,
        cwd: dir,
        triggeredAt: '2026-06-24T10:00:00.000Z',
        payload: { lastAssistantMessage: null, visibleOutput: false }
      }
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('hook_output_json_invalid');
  });
});
```

- [ ] **Step 2: Write runtime tests**

Create `tests/main/services/hooks/runtime.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { HookRuntime } from '../../../../src/main/services/hooks/runtime';
import type { RocHookCommandInput } from '../../../../src/shared/types';

function input(event: RocHookCommandInput['event'], payload: RocHookCommandInput['payload']): RocHookCommandInput {
  return {
    schemaVersion: 1,
    event,
    runId: 'run_1',
    threadId: 'thread_1',
    workspacePath: 'F:\\Code\\Roc',
    cwd: 'F:\\Code\\Roc',
    triggeredAt: '2026-06-24T10:00:00.000Z',
    payload
  } as RocHookCommandInput;
}

describe('HookRuntime', () => {
  it('skips untrusted handlers', async () => {
    const runtime = new HookRuntime({
      configService: {
        loadConfig: vi.fn(async () => ({
          schemaVersion: 1,
          hooks: {
            PreToolUse: [
              {
                matcher: '^run_shell_command$',
                hooks: [{ type: 'command', command: 'node hook.js', timeoutSeconds: 30, enabled: true, failureMode: 'continue' }]
              }
            ]
          }
        }))
      },
      trustService: {
        isTrusted: vi.fn(async () => false)
      },
      commandRunner: {
        run: vi.fn()
      }
    });

    const outcome = await runtime.runEvent(input('PreToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {} }));

    expect(outcome.blocked).toBe(false);
    expect(outcome.runs[0]?.status).toBe('skipped');
  });

  it('blocks when a trusted PreToolUse hook returns block', async () => {
    const runtime = new HookRuntime({
      configService: {
        loadConfig: vi.fn(async () => ({
          schemaVersion: 1,
          hooks: {
            PreToolUse: [
              {
                matcher: '^run_shell_command$',
                hooks: [{ type: 'command', command: 'node hook.js', timeoutSeconds: 30, enabled: true, failureMode: 'continue' }]
              }
            ]
          }
        }))
      },
      trustService: {
        isTrusted: vi.fn(async () => true)
      },
      commandRunner: {
        run: vi.fn(async () => ({
          status: 'completed',
          durationMs: 3,
          stdout: '{"action":"block","message":"blocked"}',
          stderr: '',
          output: { action: 'block', message: 'blocked' }
        }))
      }
    });

    const outcome = await runtime.runEvent(input('PreToolUse', { toolName: 'run_shell_command', toolCallId: 'call_1', toolInput: {} }));

    expect(outcome.blocked).toBe(true);
    expect(outcome.blockReason).toBe('blocked');
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `pnpm test -- tests/main/services/hooks/command-runner.test.ts tests/main/services/hooks/runtime.test.ts`

Expected: FAIL because runner and runtime modules do not exist.

- [ ] **Step 4: Implement command runner**

Create `src/main/services/hooks/command-runner.ts`:

```typescript
import { spawn } from 'node:child_process';
import type { RocHookCommandInput, RocHookCommandOutput } from '../../../shared/types';
import { HookCommandOutputSchema } from './schema';

const MAX_OUTPUT_BYTES = 64 * 1024;

export type HookCommandRunRequest = {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  input: RocHookCommandInput;
};

export type HookCommandRunResult =
  | {
      status: 'completed';
      durationMs: number;
      stdout: string;
      stderr: string;
      output: RocHookCommandOutput;
    }
  | {
      status: 'failed';
      durationMs: number;
      stdout: string;
      stderr: string;
      error: string;
    };

export class HookCommandRunner {
  async run(request: HookCommandRunRequest): Promise<HookCommandRunResult> {
    const startedAt = Date.now();
    return await new Promise<HookCommandRunResult>((resolve) => {
      const child = spawn(request.command, {
        cwd: request.cwd,
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        resolve({
          status: 'failed',
          durationMs: Date.now() - startedAt,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          error: 'hook_command_timeout'
        });
      }, request.timeoutSeconds * 1000);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = truncateOutput(stdout + chunk.toString('utf8'));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = truncateOutput(stderr + chunk.toString('utf8'));
      });
      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({
          status: 'failed',
          durationMs: Date.now() - startedAt,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          error: error.message
        });
      });
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const trimmedStdout = stdout.trim();
        if (code !== 0) {
          resolve({
            status: 'failed',
            durationMs: Date.now() - startedAt,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
            error: `hook_command_exit_${code === null ? 'unknown' : code}`
          });
          return;
        }
        if (trimmedStdout.length === 0) {
          resolve({
            status: 'completed',
            durationMs: Date.now() - startedAt,
            stdout: '',
            stderr: truncateOutput(stderr),
            output: { action: 'continue' }
          });
          return;
        }
        try {
          resolve({
            status: 'completed',
            durationMs: Date.now() - startedAt,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
            output: HookCommandOutputSchema.parse(JSON.parse(trimmedStdout))
          });
        } catch (error) {
          resolve({
            status: 'failed',
            durationMs: Date.now() - startedAt,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
            error: `hook_output_json_invalid: ${error instanceof Error ? error.message : String(error)}`
          });
        }
      });
      child.stdin.end(JSON.stringify(request.input));
    });
  }
}

function truncateOutput(value: string): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= MAX_OUTPUT_BYTES) {
    return value;
  }
  return `${buffer.subarray(0, MAX_OUTPUT_BYTES).toString('utf8')}\n[truncated]`;
}
```

- [ ] **Step 5: Implement runtime**

Create `src/main/services/hooks/runtime.ts`:

```typescript
import type {
  RocHookCommandInput,
  RocHookCommandOutput,
  RocHookConfig,
  RocHookEventName,
  RocHookRunSummary
} from '../../../shared/types';
import { computeHookHandlerHash, createHookHandlerId, createHookRunId } from './hash';
import type { HookCommandRunner, HookCommandRunResult } from './command-runner';

type HookRuntimeConfigService = {
  loadConfig(): Promise<RocHookConfig>;
};

type HookRuntimeTrustService = {
  isTrusted(input: { handlerId: string; hash: string }): Promise<boolean>;
};

export type HookRuntimeOutcome = {
  blocked: boolean;
  blockReason: string | null;
  updatedInput: unknown | undefined;
  additionalContexts: string[];
  requestContinue: string | null;
  runs: RocHookRunSummary[];
};

export class HookRuntime {
  constructor(
    private readonly deps: {
      configService: HookRuntimeConfigService;
      trustService: HookRuntimeTrustService;
      commandRunner: Pick<HookCommandRunner, 'run'>;
    }
  ) {}

  async runEvent(input: RocHookCommandInput): Promise<HookRuntimeOutcome> {
    const config = await this.deps.configService.loadConfig();
    const selected = selectConfiguredHandlers(config, input);
    const executions = await Promise.all(
      selected.map(async (selectedHandler) => {
        const trusted = await this.deps.trustService.isTrusted({
          handlerId: selectedHandler.handlerId,
          hash: selectedHandler.hash
        });
        if (!selectedHandler.handler.enabled || !trusted) {
          return {
            selectedHandler,
            hookRunId: createHookRunId({ parentRunId: input.runId, handlerId: selectedHandler.handlerId }),
            result: null
          };
        }
        const command = process.platform === 'win32' && selectedHandler.handler.commandWindows !== undefined
          ? selectedHandler.handler.commandWindows
          : selectedHandler.handler.command;
        return {
          selectedHandler,
          hookRunId: createHookRunId({ parentRunId: input.runId, handlerId: selectedHandler.handlerId }),
          result: await this.deps.commandRunner.run({
            command,
            cwd: input.cwd,
            timeoutSeconds: selectedHandler.handler.timeoutSeconds,
            input
          })
        };
      })
    );

    return mergeHookExecutions(input.event, executions);
  }
}

function selectConfiguredHandlers(config: RocHookConfig, input: RocHookCommandInput) {
  const groups = config.hooks[input.event] ?? [];
  return groups.flatMap((group, groupIndex) =>
    group.hooks.flatMap((handler, hookIndex) => {
      const matcher = group.matcher === undefined ? null : group.matcher;
      if (!matchesEvent(input, matcher)) {
        return [];
      }
      const handlerId = createHookHandlerId({ event: input.event, groupIndex, hookIndex });
      return [
        {
          handlerId,
          handler,
          hash: computeHookHandlerHash({ event: input.event, matcher, handler })
        }
      ];
    })
  );
}

function matchesEvent(input: RocHookCommandInput, matcher: string | null): boolean {
  if (matcher === null || matcher.length === 0 || matcher === '*') {
    return true;
  }
  if (input.event === 'UserPromptSubmit' || input.event === 'Stop') {
    return true;
  }
  const value = matcherValue(input);
  return new RegExp(matcher).test(value);
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

function mergeHookExecutions(
  event: RocHookEventName,
  executions: Array<{
    selectedHandler: { handlerId: string };
    hookRunId: string;
    result: HookCommandRunResult | null;
  }>
): HookRuntimeOutcome {
  let blocked = false;
  let blockReason: string | null = null;
  let updatedInput: unknown | undefined;
  let requestContinue: string | null = null;
  const additionalContexts: string[] = [];
  const runs: RocHookRunSummary[] = [];

  for (const execution of executions) {
    if (execution.result === null) {
      runs.push({
        runId: execution.hookRunId,
        handlerId: execution.selectedHandler.handlerId,
        event,
        status: 'skipped',
        durationMs: 0,
        message: null
      });
      continue;
    }
    if (execution.result.status === 'failed') {
      runs.push({
        runId: execution.hookRunId,
        handlerId: execution.selectedHandler.handlerId,
        event,
        status: 'failed',
        durationMs: execution.result.durationMs,
        message: execution.result.error
      });
      continue;
    }
    const output = execution.result.output;
    runs.push({
      runId: execution.hookRunId,
      handlerId: execution.selectedHandler.handlerId,
      event,
      status: output.action === 'block' ? 'blocked' : 'completed',
      durationMs: execution.result.durationMs,
      message: output.message === undefined ? null : output.message
    });
    if (output.action === 'block') {
      blocked = true;
      blockReason = output.message === undefined ? 'Blocked by hook.' : output.message;
    }
    if (output.action === 'replace_input') {
      updatedInput = output.updatedInput;
    }
    if (output.action === 'add_context' && typeof output.additionalContext === 'string') {
      additionalContexts.push(output.additionalContext);
    }
    if (output.action === 'request_continue') {
      requestContinue = output.message === undefined ? 'Continue after hook request.' : output.message;
    }
  }

  return {
    blocked,
    blockReason,
    updatedInput,
    additionalContexts,
    requestContinue,
    runs
  };
}
```

- [ ] **Step 6: Export modules**

Modify `src/main/services/hooks/index.ts`:

```typescript
export * from './schema';
export * from './hash';
export * from './config-service';
export * from './trust-service';
export * from './command-runner';
export * from './runtime';
```

- [ ] **Step 7: Run tests**

Run: `pnpm test -- tests/main/services/hooks/command-runner.test.ts tests/main/services/hooks/runtime.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```powershell
git add src/main/services/hooks/command-runner.ts src/main/services/hooks/runtime.ts src/main/services/hooks/index.ts tests/main/services/hooks/command-runner.test.ts tests/main/services/hooks/runtime.test.ts
git commit -m "feat: add hook runtime executor"
```

---

### Task 4: DeepAgents Hook Middleware

**Files:**
- Create: `src/main/services/hooks/middleware.ts`
- Modify: `src/main/services/hooks/index.ts`
- Modify: `src/main/services/deep-agent/agent-builder.ts`
- Test: `tests/main/services/hooks/middleware.test.ts`
- Test: `tests/main/deep-agent-build-wiring.test.ts`

**Interfaces:**
- Consumes: `HookRuntime.runEvent()`.
- Produces: `createRocHookMiddleware()`.
- Modifies: `DeepAgentBuildInput` gains `hookRuntime?: HookRuntime` and `runMetadata`.

- [ ] **Step 1: Write middleware tests**

Create `tests/main/services/hooks/middleware.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { createRocHookMiddleware } from '../../../../src/main/services/hooks/middleware';

describe('createRocHookMiddleware', () => {
  it('blocks PreToolUse with a ToolMessage error', async () => {
    const middleware = createRocHookMiddleware({
      hookRuntime: {
        runEvent: vi.fn(async () => ({
          blocked: true,
          blockReason: 'blocked by hook',
          updatedInput: undefined,
          additionalContexts: [],
          requestContinue: null,
          runs: []
        }))
      },
      runContext: {
        runId: 'run_1',
        threadId: 'thread_1',
        workspacePath: 'F:\\Code\\Roc',
        cwd: 'F:\\Code\\Roc',
        source: 'chat',
        modelId: 'model_1',
        workflowHint: null
      },
      emitHookEvent: vi.fn()
    });

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call_1',
          name: 'run_shell_command',
          args: { command: 'dir' }
        }
      } as never,
      async () => 'should not run'
    );

    expect(Reflect.get(result as object, 'content')).toContain('blocked by hook');
  });

  it('replaces tool input before handler runs', async () => {
    const handler = vi.fn(async (request: unknown) => Reflect.get(Reflect.get(request as object, 'toolCall'), 'args'));
    const middleware = createRocHookMiddleware({
      hookRuntime: {
        runEvent: vi.fn(async () => ({
          blocked: false,
          blockReason: null,
          updatedInput: { command: 'Get-Location' },
          additionalContexts: [],
          requestContinue: null,
          runs: []
        }))
      },
      runContext: {
        runId: 'run_1',
        threadId: 'thread_1',
        workspacePath: 'F:\\Code\\Roc',
        cwd: 'F:\\Code\\Roc',
        source: 'chat',
        modelId: 'model_1',
        workflowHint: null
      },
      emitHookEvent: vi.fn()
    });

    await expect(
      middleware.wrapToolCall!(
        {
          toolCall: {
            id: 'call_1',
            name: 'run_shell_command',
            args: { command: 'dir' }
          }
        } as never,
        handler
      )
    ).resolves.toEqual({ command: 'Get-Location' });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test -- tests/main/services/hooks/middleware.test.ts`

Expected: FAIL because `middleware.ts` does not exist.

- [ ] **Step 3: Implement hook middleware**

Create `src/main/services/hooks/middleware.ts`:

```typescript
import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { ChatRunEvent, RocHookCommandInput, RocHookRunSummary, WorkflowHint } from '../../../shared/types';
import type { HookRuntime } from './runtime';

export type RocHookRunContext = {
  runId: string;
  threadId: string | null;
  workspacePath: string | null;
  cwd: string;
  source: 'chat' | 'background_task';
  modelId: string;
  workflowHint: WorkflowHint;
};

export type RocHookMiddlewareOptions = {
  hookRuntime: Pick<HookRuntime, 'runEvent'>;
  runContext: RocHookRunContext;
  emitHookEvent: (event: ChatRunEvent) => void;
};

export function createRocHookMiddleware(options: RocHookMiddlewareOptions) {
  return createMiddleware({
    name: 'RocHookMiddleware',
    wrapToolCall: async (request, handler) => {
      const toolCallId = request.toolCall.id === undefined ? 'unknown-tool-call' : request.toolCall.id;
      const hookInput = createHookInput(options.runContext, 'PreToolUse', {
        toolName: request.toolCall.name,
        toolCallId,
        toolInput: request.toolCall.args
      });
      const preOutcome = await options.hookRuntime.runEvent(hookInput);
      emitHookRuns(options, preOutcome.runs);
      if (preOutcome.blocked) {
        return new ToolMessage({
          tool_call_id: toolCallId,
          name: request.toolCall.name,
          content: preOutcome.blockReason === null ? 'Tool call blocked by hook.' : preOutcome.blockReason,
          status: 'error'
        });
      }
      const nextRequest = preOutcome.updatedInput === undefined
        ? request
        : {
            ...request,
            toolCall: {
              ...request.toolCall,
              args: preOutcome.updatedInput
            }
          };
      const result = await handler(nextRequest);
      const postOutcome = await options.hookRuntime.runEvent(
        createHookInput(options.runContext, 'PostToolUse', {
          toolName: request.toolCall.name,
          toolCallId,
          toolInput: nextRequest.toolCall.args,
          toolOutput: result
        })
      );
      emitHookRuns(options, postOutcome.runs);
      return result;
    }
  });
}

function createHookInput<TEvent extends RocHookCommandInput['event']>(
  context: RocHookRunContext,
  event: TEvent,
  payload: Extract<RocHookCommandInput, { event: TEvent }>['payload']
): RocHookCommandInput {
  return {
    schemaVersion: 1,
    event,
    runId: context.runId,
    threadId: context.threadId,
    workspacePath: context.workspacePath,
    cwd: context.cwd,
    triggeredAt: new Date().toISOString(),
    payload
  } as RocHookCommandInput;
}

function emitHookRuns(options: RocHookMiddlewareOptions, runs: RocHookRunSummary[]): void {
  for (const hook of runs) {
    options.emitHookEvent({
      type: 'hook_completed',
      runId: options.runContext.runId,
      hook
    });
  }
}
```

- [ ] **Step 4: Wire middleware into agent builder**

Modify `src/main/services/deep-agent/agent-builder.ts`.

Add import:

```typescript
import type { RocHookMiddlewareOptions } from '../hooks';
import { createRocHookMiddleware } from '../hooks';
```

Add to `DeepAgentBuildInput`:

```typescript
  hookMiddleware?: RocHookMiddlewareOptions;
```

Add hook middleware before path policy in `guardrails`:

```typescript
  const hookMiddleware = input.hookMiddleware === undefined ? [] : [createRocHookMiddleware(input.hookMiddleware)];
  const guardrails = [
    ...hookMiddleware,
    createRocShellPathPolicyMiddleware({ workspacePath: input.workspacePath }),
    rtkMiddleware,
    createPromptCachingMiddleware({
      enabled: true,
      strategy: 'balanced',
      providerType: input.providerType
    }),
    toolRetryMiddleware({
      maxRetries: 2,
      tools: [...NETWORK_SENSITIVE_TOOLS],
      backoffFactor: 1.5
    }),
    createToolProtocolMiddleware(),
    createErrorBudgetMiddleware(),
    createForgeIterationTrackingMiddleware(),
    createRocFilesystemPathPolicyMiddleware(),
    createFilesystemToolErrorMiddleware(),
    createForgeTieredCompactionMiddleware({
      budgetTokens: input.contextBudgetTokens
    }),
    createRescueParsingMiddleware({ availableTools: knownToolCandidates }),
    createToolResolutionMiddleware(),
    createToolRuntimeErrorMiddleware(),
    createForgeCleanupMiddleware()
  ];
```

- [ ] **Step 5: Update build wiring test**

Modify `tests/main/deep-agent-build-wiring.test.ts` to assert `RocHookMiddleware` appears before `RocShellPathPolicyMiddleware` when provided:

```typescript
  it('wires hook middleware before Roc guardrails when hook runtime is provided', () => {
    const input = {
      model: {} as unknown,
      tools: [],
      instructions: 'Test instructions',
      memory: [],
      subagents: [],
      responseFormat: undefined,
      interruptOn: {},
      providerType: 'openai_compatible',
      workflowHint: 'default',
      contextBudgetTokens: undefined,
      hookMiddleware: {
        hookRuntime: {
          runEvent: vi.fn()
        },
        runContext: {
          runId: 'run_1',
          threadId: 'thread_1',
          workspacePath: 'F:\\Code\\Roc',
          cwd: 'F:\\Code\\Roc',
          source: 'chat',
          modelId: 'model_1',
          workflowHint: null
        },
        emitHookEvent: vi.fn()
      }
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) => Reflect.get(middleware as object, 'name')) ?? [];
    expect(middlewareNames.indexOf('RocHookMiddleware')).toBeLessThan(middlewareNames.indexOf('RocShellPathPolicyMiddleware'));
  });
```

- [ ] **Step 6: Run tests**

Run: `pnpm test -- tests/main/services/hooks/middleware.test.ts tests/main/deep-agent-build-wiring.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```powershell
git add src/main/services/hooks/middleware.ts src/main/services/hooks/index.ts src/main/services/deep-agent/agent-builder.ts tests/main/services/hooks/middleware.test.ts tests/main/deep-agent-build-wiring.test.ts
git commit -m "feat: add hook middleware wiring"
```

---

### Task 5: Agent Executor And Run Lifecycle Hooks

**Files:**
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `src/main/plugins/agent/runtime.ts`
- Modify: `src/main/plugins/agent/runtime-types.ts`
- Modify test helper: `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`
- Test: `tests/main/plugins/agent/deep-agent-executor-hooks.test.ts`
- Test: `tests/main/plugins/agent/runtime-hooks.test.ts`

**Interfaces:**
- Consumes: `HookRuntime`, `createRocHookMiddleware`, `RocHookRunContext`.
- Produces: Hook-aware `AgentDeepAgentExecutorOptions` and best-effort run lifecycle emission.

- [ ] **Step 1: Write executor hook tests**

Create `tests/main/plugins/agent/deep-agent-executor-hooks.test.ts` using existing helpers from `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectExecutorEvents, createCapabilities, workspacePath } from './deep-agent-executor-test-helpers';

describe('createAgentDeepAgentExecutor hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs SessionStart before building the DeepAgent', async () => {
    const hookRuntime = {
      runEvent: vi.fn(async () => ({
        blocked: false,
        blockReason: null,
        updatedInput: undefined,
        additionalContexts: [],
        requestContinue: null,
        runs: []
      }))
    };
    const calls: Array<{ name: string; input: unknown }> = [];

    await collectExecutorEvents({
      capabilities: createCapabilities(calls),
      hookRuntime,
      output: {
        messages: [
          {
            role: 'assistant',
            content: 'ok'
          }
        ]
      },
      requestOverride: {
        input: 'hello',
        mode: 'chat',
        threadId: 'thread_1',
        workspacePath
      }
    });

    expect(hookRuntime.runEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'SessionStart',
        payload: expect.objectContaining({ source: 'chat' })
      })
    );
  });
});
```

Modify `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts` before running this test.

Add import:

```typescript
import type { HookRuntime } from '../../../../src/main/services/hooks';
```

Add to `ExecutorEventsInput`:

```typescript
  hookRuntime?: Pick<HookRuntime, 'runEvent'>;
```

Pass the option into `createAgentDeepAgentExecutor()` inside `startExecutorExecution()`:

```typescript
  const executor = createAgentDeepAgentExecutor({
    capabilities: input.capabilities,
    getMemorySettings: input.getMemorySettings,
    hookRuntime: input.hookRuntime,
    paths: new RocPaths(join(workspacePath, '.roc-test')),
    store: new InMemoryStore()
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test -- tests/main/plugins/agent/deep-agent-executor-hooks.test.ts`

Expected: FAIL because `hookRuntime` is not accepted.

- [ ] **Step 3: Add hook runtime to executor options**

Modify `src/main/plugins/agent/deep-agent-executor.ts`.

Add import:

```typescript
import type { HookRuntime } from '../../services/hooks';
```

Add to `AgentDeepAgentExecutorOptions`:

```typescript
  hookRuntime?: Pick<HookRuntime, 'runEvent'>;
```

Before `buildDeepAgent()`, compute:

```typescript
      const hookRunContext = {
        runId: input.run.id,
        threadId: input.run.threadId,
        workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        cwd: runtimeWorkspace === null ? options.paths.root : runtimeWorkspace.path,
        source: isBackgroundTaskWorkflow(input.request) ? 'background_task' as const : 'chat' as const,
        modelId: input.modelHandle.modelId,
        workflowHint: input.request.workflowHint ?? null
      };
```

Invoke `SessionStart`:

```typescript
      if (options.hookRuntime !== undefined) {
        const sessionStart = await options.hookRuntime.runEvent({
          schemaVersion: 1,
          event: 'SessionStart',
          runId: input.run.id,
          threadId: input.run.threadId,
          workspacePath: hookRunContext.workspacePath,
          cwd: hookRunContext.cwd,
          triggeredAt: new Date().toISOString(),
          payload: {
            source: hookRunContext.source,
            modelId: input.modelHandle.modelId,
            workflowHint: hookRunContext.workflowHint
          }
        });
        if (sessionStart.blocked) {
          throw new Error(sessionStart.blockReason === null ? 'Blocked by SessionStart hook.' : sessionStart.blockReason);
        }
      }
```

Pass middleware to `buildDeepAgent()`:

```typescript
        hookMiddleware:
          options.hookRuntime === undefined
            ? undefined
            : {
                hookRuntime: options.hookRuntime,
                runContext: hookRunContext,
                emitHookEvent: eventQueue.push
              },
```

- [ ] **Step 4: Add lifecycle hook interface for runtime-level SessionEnd**

Modify `src/main/plugins/agent/runtime-types.ts`:

```typescript
import type { ChatApprovalRequest, ChatStartRunRequest, RocHookSessionEndStatus } from '../../../shared/types';

export type AgentLifecycleHookEmitter = {
  emitSessionEnd(input: {
    runId: string;
    threadId: string | null;
    request: ChatStartRunRequest;
    status: RocHookSessionEndStatus;
    error: string | null;
  }): Promise<void>;
};
```

Modify `src/main/plugins/agent/runtime.ts`:

Add import:

```typescript
import type { AgentLifecycleHookEmitter } from './runtime-types';
```

Add to `AgentPluginRuntimeOptions`:

```typescript
  lifecycleHooks?: AgentLifecycleHookEmitter;
```

Add active run metadata next to the existing active-run maps:

```typescript
  private readonly activeRunMetadata = new Map<
    string,
    {
      request: ChatStartRunRequest;
      threadId: string | null;
    }
  >();
```

After `this.activeRuns.add(run.id);` in `startRun()`, store the normalized request:

```typescript
    const normalizedRequest = {
      ...request,
      input
    };
    this.activeRunMetadata.set(run.id, {
      request: normalizedRequest,
      threadId: run.threadId
    });
```

Use `normalizedRequest` in the later `executeRun()` input:

```typescript
        request: normalizedRequest,
```

Delete metadata in every run-finalization path immediately after deleting `activeRuns` and `abortControllers`:

```typescript
      this.activeRunMetadata.delete(input.runId);
```

Call on completed after `completeRun()`:

```typescript
      await this.options.lifecycleHooks?.emitSessionEnd({
        runId: input.runId,
        threadId: input.threadId,
        request: input.request,
        status: 'completed',
        error: null
      });
```

Call in failure branch before publishing `run_failed`:

```typescript
      await this.options.lifecycleHooks?.emitSessionEnd({
        runId: input.runId,
        threadId: input.threadId,
        request: input.request,
        status: 'failed',
        error: failure
      });
```

Call in `cancelRun()` after status update:

```typescript
    const metadata = this.activeRunMetadata.get(input.runId);
    if (metadata === undefined) {
      throw new Error('active_run_metadata_missing');
    }
    void this.options.lifecycleHooks?.emitSessionEnd({
      runId: input.runId,
      threadId: metadata.threadId,
      request: metadata.request,
      status: 'cancelled',
      error: null
    });
```

Keep `SessionEnd` non-blocking for cancellation by using `void`, and keep the existing `cancelRun()` return value unchanged.

- [ ] **Step 5: Write runtime SessionEnd tests**

Create `tests/main/plugins/agent/runtime-hooks.test.ts` using the same local setup pattern as `tests/main/plugins/agent/runtime.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocEventBus, RocEventEnvelope } from '../../../../src/main/kernel/types';
import type { AgentModelFactoryAdapter } from '../../../../src/main/plugins/agent/model-factory-adapter';
import { AgentPluginRuntime } from '../../../../src/main/plugins/agent/runtime';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';
import type { ChatRunEvent, ChatStartRunRequest } from '../../../../src/shared/types';

let db: Database.Database;
let events: RocEventEnvelope[];

const modelFactory: AgentModelFactoryAdapter = {
  createDefaultModelHandle: async () => ({
    modelId: 'openai:gpt-4.1',
    providerId: 'openai'
  }),
  createModelHandleByModelId: async (modelId) => ({
    modelId,
    providerId: 'openai'
  })
};

const eventBus: RocEventBus = {
  publish: async (event) => {
    events.push(event);
  },
  subscribe: () => () => {}
};

const startRequest: ChatStartRunRequest = {
  enabledCapabilities: {
    mcpServers: [],
    skills: []
  },
  input: 'Summarize this workspace',
  mode: 'chat',
  workspacePath: 'F:\\Code\\Roc'
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

describe('AgentPluginRuntime lifecycle hooks', () => {
  it('emits SessionEnd on completed runs', async () => {
    const repository = new AgentSessionRepository(db);
    const lifecycleHooks = {
      emitSessionEnd: vi.fn(async () => undefined)
    };
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: createTextDeepAgentExecutor('done'),
      eventBus,
      lifecycleHooks,
      modelFactory,
      repository
    });

    const result = await runtime.startRun(startRequest);
    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(lifecycleHooks.emitSessionEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: result.runId,
        threadId: result.threadId,
        request: expect.objectContaining({
          input: 'Summarize this workspace',
          workspacePath: 'F:\\Code\\Roc'
        }),
        status: 'completed',
        error: null
      })
    );
  });
});

function createTextDeepAgentExecutor(text: string): NonNullable<ConstructorParameters<typeof AgentPluginRuntime>[0]['deepAgentExecutor']> {
  return {
    execute: async function* (input) {
      yield {
        type: 'assistant_block',
        runId: input.run.id,
        block: {
          kind: 'text',
          blockId: `text-${input.run.id}`,
          phase: 'delta',
          text
        }
      };
    }
  };
}

async function waitForEvent(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('expected_event_not_published');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readChatRunEvent(payload: unknown): ChatRunEvent | null {
  if (payload === null || typeof payload !== 'object' || !('type' in payload)) {
    return null;
  }
  return payload as ChatRunEvent;
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm test -- tests/main/plugins/agent/deep-agent-executor-hooks.test.ts tests/main/plugins/agent/runtime-hooks.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src/main/plugins/agent/deep-agent-executor.ts src/main/plugins/agent/runtime.ts src/main/plugins/agent/runtime-types.ts tests/main/plugins/agent/deep-agent-executor-test-helpers.ts tests/main/plugins/agent/deep-agent-executor-hooks.test.ts tests/main/plugins/agent/runtime-hooks.test.ts
git commit -m "feat: run agent lifecycle hooks"
```

---

### Task 6: IPC And Kernel Wiring

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipc-schema.json`
- Modify generated IPC: `src/shared/ipc-generated.ts`
- Modify: `src/main/ipc/settings-ipc.ts`
- Modify: `src/main/main-kernel-bootstrap.ts`
- Test: `tests/main/settings-ipc-hooks.test.ts`
- Test: `tests/main/microkernel-regression.test.ts` or nearest kernel bootstrap test if needed

**Interfaces:**
- Consumes: `HookConfigService`, `HookTrustService`.
- Produces settings IPC methods: `getHooks`, `saveHooks`, `trustHook`.

- [ ] **Step 1: Write settings IPC hook test**

Create `tests/main/settings-ipc-hooks.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { registerSettingsIpc } from '../../src/main/ipc/settings-ipc';
import type { IpcMainHandler } from '../../src/main/ipc/ipc-common';
import { defaultPermissions, defaultProviders, defaultSettings } from '../../src/main/services/config/defaults';
import type { ConfigService } from '../../src/main/services/config-service';
import type { ProviderRuntimeService } from '../../src/main/services/provider-runtime-service';
import type { SecretService } from '../../src/main/services/secret-service';
import { ipcChannels } from '../../src/shared/ipc';

describe('settings hook IPC', () => {
  it('registers hook config and trust handlers', async () => {
    const handlers = new Map<string, IpcMainHandler>();
    const configService = {
      getProvidersAsync: vi.fn(async () => defaultProviders),
      getSettingsAsync: vi.fn(async () => defaultSettings),
      getPermissionsAsync: vi.fn(async () => defaultPermissions),
      saveSettingsSnapshotAsync: vi.fn(async (request) => request)
    } as unknown as ConfigService;
    const secretService = {
      listSecretStatuses: vi.fn(() => [])
    } as unknown as SecretService;
    const providerRuntimeService = {
      testProvider: vi.fn()
    } as unknown as ProviderRuntimeService;
    const kernelSettings = {
      listMcpServers: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      syncSettingsSnapshot: vi.fn(async () => undefined)
    };
    const controls = {
      getHostIntegrationStatus: vi.fn(() => ({
        startup: {
          configuredOpenAtLogin: false,
          effectiveOpenAtLogin: false,
          syncError: null
        },
        globalHotkey: {
          accelerator: null,
          registered: false,
          registrationError: null
        }
      })),
      syncHostSettings: vi.fn()
    };
    const hookConfigService = {
      loadConfigSnapshot: vi.fn(async () => ({ configPath: 'C:\\Users\\me\\.roc\\hooks.json', exists: false, handlers: [], validationErrors: [] })),
      saveConfig: vi.fn(async () => ({ configPath: 'C:\\Users\\me\\.roc\\hooks.json', exists: true, handlers: [], validationErrors: [] }))
    };
    const hookTrustService = {
      trust: vi.fn(async () => undefined)
    };

    registerSettingsIpc(
      (channel, handler) => handlers.set(channel, handler),
      configService,
      secretService,
      providerRuntimeService,
      kernelSettings,
      controls,
      { hookConfigService, hookTrustService }
    );

    expect(handlers.has(ipcChannels.settingsHooksGet)).toBe(true);
    expect(handlers.has(ipcChannels.settingsHooksSave)).toBe(true);
    expect(handlers.has(ipcChannels.settingsHooksTrust)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test -- tests/main/settings-ipc-hooks.test.ts`

Expected: FAIL because channels and registration do not exist.

- [ ] **Step 3: Add IPC schema channels**

Modify `src/shared/ipc-schema.json` request channel list:

```json
{ "key": "settingsHooksGet", "channel": "roc:settings:hooks:get" },
{ "key": "settingsHooksSave", "channel": "roc:settings:hooks:save" },
{ "key": "settingsHooksTrust", "channel": "roc:settings:hooks:trust" }
```

Run: `pnpm generate:ipc`

Expected: `src/shared/ipc-generated.ts` updates.

- [ ] **Step 4: Add preload API types**

Modify `src/shared/ipc.ts` imports to include:

```typescript
  RocHookConfigSnapshot,
  SettingsSaveHookConfigRequest,
  SettingsTrustHookRequest,
```

Add methods under `settings`:

```typescript
    getHooks: () => Promise<IpcResult<RocHookConfigSnapshot>>;
    saveHooks: (request: SettingsSaveHookConfigRequest) => Promise<IpcResult<RocHookConfigSnapshot>>;
    trustHook: (request: SettingsTrustHookRequest) => Promise<IpcResult<RocHookConfigSnapshot>>;
```

- [ ] **Step 5: Register settings IPC handlers**

Modify `src/main/ipc/settings-ipc.ts`.

Add imports:

```typescript
  SettingsSaveHookConfigRequest,
  SettingsTrustHookRequest
```

Add dependency type:

```typescript
export type HookSettingsBridge = {
  hookConfigService: {
    loadConfigSnapshot(): Promise<SettingsSnapshot['hooks']>;
    saveConfig(config: SettingsSaveHookConfigRequest['config']): Promise<SettingsSnapshot['hooks']>;
  };
  hookTrustService: {
    trust(request: SettingsTrustHookRequest): Promise<void>;
  };
};
```

Add an optional parameter to `registerSettingsIpc`:

```typescript
  hooks?: HookSettingsBridge
```

Add handlers:

```typescript
  timedHandle(ipcChannels.settingsHooksGet, () =>
    wrapIpc(async () => {
      if (hooks === undefined) {
        throw new Error('hook_settings_unavailable');
      }
      return await hooks.hookConfigService.loadConfigSnapshot();
    })
  );
  timedHandle(ipcChannels.settingsHooksSave, (_event, request: SettingsSaveHookConfigRequest) =>
    wrapIpc(async () => {
      if (hooks === undefined) {
        throw new Error('hook_settings_unavailable');
      }
      return await hooks.hookConfigService.saveConfig(request.config);
    })
  );
  timedHandle(ipcChannels.settingsHooksTrust, (_event, request: SettingsTrustHookRequest) =>
    wrapIpc(async () => {
      if (hooks === undefined) {
        throw new Error('hook_settings_unavailable');
      }
      await hooks.hookTrustService.trust(request);
      return await hooks.hookConfigService.loadConfigSnapshot();
    })
  );
```

Update `buildSettingsSnapshotAsync()` to include:

```typescript
    hooks: hooks === undefined ? { configPath: '', exists: false, handlers: [], validationErrors: ['hook_settings_unavailable'] } : await hooks.hookConfigService.loadConfigSnapshot(),
```

- [ ] **Step 6: Wire services in kernel bootstrap**

Modify `src/main/main-kernel-bootstrap.ts`.

Add imports:

```typescript
import { HookCommandRunner, HookConfigService, HookRuntime, HookTrustService } from './services/hooks';
```

Construct services after `RocPaths` exists:

```typescript
const hookConfigService = new HookConfigService(paths);
const hookTrustService = new HookTrustService(paths);
const hookRuntime = new HookRuntime({
  configService: hookConfigService,
  trustService: hookTrustService,
  commandRunner: new HookCommandRunner()
});
```

Pass `hookRuntime` to `createAgentDeepAgentExecutor()` and pass hook services to `registerSettingsIpc()`.

- [ ] **Step 7: Run IPC checks**

Run: `pnpm test -- tests/main/settings-ipc-hooks.test.ts`

Expected: PASS.

Run: `pnpm check:ipc`

Expected: PASS.

- [ ] **Step 8: Commit Task 6**

```powershell
git add src/shared/ipc.ts src/shared/ipc-schema.json src/shared/ipc-generated.ts src/main/ipc/settings-ipc.ts src/main/main-kernel-bootstrap.ts tests/main/settings-ipc-hooks.test.ts
git commit -m "feat: expose hook settings ipc"
```

---

### Task 7: Settings UI Hook Management

**Files:**
- Create: `src/renderer/settings/sections/hooks-section.tsx`
- Modify: `src/renderer/settings/index.tsx`
- Modify: `src/renderer/settings/settings-save-model.ts`
- Modify: `src/renderer/loaded-state.ts`
- Test: `tests/renderer/settings-hooks-section.test.tsx`
- Test: `tests/renderer/settings-model-save.test.ts`

**Interfaces:**
- Consumes: `RocPreloadApi.settings.getHooks/saveHooks/trustHook`.
- Produces: Hooks settings UI section.

- [ ] **Step 1: Write renderer test**

Create `tests/renderer/settings-hooks-section.test.tsx`:

```typescript
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HooksSection } from '../../src/renderer/settings/sections/hooks-section';

describe('HooksSection', () => {
  it('shows review required hook and trusts current hash', async () => {
    const onTrust = vi.fn();
    render(
      <HooksSection
        snapshot={{
          configPath: 'C:\\Users\\me\\.roc\\hooks.json',
          exists: true,
          validationErrors: [],
          handlers: [
            {
              id: 'PreToolUse:0:0',
              event: 'PreToolUse',
              matcher: '^run_shell_command$',
              command: 'node hook.js',
              commandWindows: null,
              timeoutSeconds: 30,
              statusMessage: 'Checking command',
              enabled: true,
              failureMode: 'continue',
              hash: 'abc123',
              trustState: 'review_required',
              validationError: null,
              lastRun: null
            }
          ]
        }}
        onRefresh={vi.fn()}
        onTrust={onTrust}
        onSave={vi.fn()}
      />
    );

    expect(screen.getByText('PreToolUse')).toBeInTheDocument();
    expect(screen.getByText('review_required')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Trust current command/i }));

    expect(onTrust).toHaveBeenCalledWith({ handlerId: 'PreToolUse:0:0', hash: 'abc123' });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test -- tests/renderer/settings-hooks-section.test.tsx`

Expected: FAIL because `hooks-section.tsx` does not exist.

- [ ] **Step 3: Add HooksSection**

Create `src/renderer/settings/sections/hooks-section.tsx`:

```tsx
import type { RocHookConfigSnapshot, SettingsSaveHookConfigRequest, SettingsTrustHookRequest } from '../../../shared/types';

type HooksSectionProps = {
  snapshot: RocHookConfigSnapshot;
  onRefresh: () => Promise<void> | void;
  onSave: (request: SettingsSaveHookConfigRequest) => Promise<void> | void;
  onTrust: (request: SettingsTrustHookRequest) => Promise<void> | void;
};

export function HooksSection(props: HooksSectionProps) {
  return (
    <section className="settings-section" aria-label="Hooks">
      <div className="settings-section-header">
        <div>
          <h2>Hooks</h2>
          <p>{props.snapshot.configPath}</p>
        </div>
        <button type="button" onClick={() => void props.onRefresh()}>
          Refresh
        </button>
      </div>
      {props.snapshot.validationErrors.map((error) => (
        <p className="settings-error" key={error}>
          {error}
        </p>
      ))}
      <div className="settings-table">
        {props.snapshot.handlers.map((handler) => (
          <div className="settings-table-row" key={handler.id}>
            <div>
              <strong>{handler.event}</strong>
              <p>{handler.matcher === null ? 'all' : handler.matcher}</p>
              <code>{handler.command}</code>
            </div>
            <div>{handler.trustState}</div>
            <div>{handler.lastRun === null ? 'never' : handler.lastRun.status}</div>
            <button type="button" onClick={() => void props.onTrust({ handlerId: handler.id, hash: handler.hash })}>
              Trust current command
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
```

Keep the first version on the class names shown above: `settings-section`, `settings-section-header`, `settings-error`, `settings-table`, and `settings-table-row`. Do not introduce a new settings design system in this task.

- [ ] **Step 4: Wire settings page**

Modify `src/renderer/settings/index.tsx`:

Add import:

```typescript
import { HooksSection } from './sections/hooks-section';
```

Add handlers using `resolveClient().api.settings`:

```typescript
  const refreshHooks = useCallback(async () => {
    const refreshed = unwrap<RocHookConfigSnapshot>('settings hooks get', await resolveClient().api.settings.getHooks());
    updateLoadedState({ hookSettings: refreshed });
  }, [resolveClient, updateLoadedState]);

  const trustHook = useCallback(
    async (request: SettingsTrustHookRequest) => {
      const refreshed = unwrap<RocHookConfigSnapshot>('settings hooks trust', await resolveClient().api.settings.trustHook(request));
      updateLoadedState({ hookSettings: refreshed });
    },
    [resolveClient, updateLoadedState]
  );
```

Render:

```tsx
      <HooksSection
        snapshot={loadedState.hookSettings}
        onRefresh={refreshHooks}
        onSave={async (request) => {
          const refreshed = unwrap<RocHookConfigSnapshot>('settings hooks save', await resolveClient().api.settings.saveHooks(request));
          updateLoadedState({ hookSettings: refreshed });
        }}
        onTrust={trustHook}
      />
```

- [ ] **Step 5: Add loaded state mapping**

Modify `src/renderer/settings/settings-save-model.ts`:

Add import:

```typescript
  RocHookConfigSnapshot,
```

Add to `LoadedSettingsState`:

```typescript
  hookSettings: RocHookConfigSnapshot;
```

Add to the `applySettingsSnapshot()` return object:

```typescript
    hookSettings: snapshot.hooks,
```

Modify `src/renderer/loaded-state.ts`:

Add:

```typescript
  hookSettings: RocHookConfigSnapshot;
```

Use an empty fallback in the initial loaded state:

```typescript
hookSettings: {
  configPath: '',
  exists: false,
  handlers: [],
  validationErrors: []
}
```

- [ ] **Step 6: Run renderer tests**

Run: `pnpm test -- tests/renderer/settings-hooks-section.test.tsx tests/renderer/settings-model-save.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```powershell
git add src/renderer/settings/sections/hooks-section.tsx src/renderer/settings/index.tsx src/renderer/settings/settings-save-model.ts src/renderer/loaded-state.ts tests/renderer/settings-hooks-section.test.tsx tests/renderer/settings-model-save.test.ts
git commit -m "feat: add hooks settings section"
```

---

### Task 8: Integration Verification And Cleanup

**Files:**
- Modify only files needed to fix issues discovered by verification.
- Test command outputs are evidence for completion.

**Interfaces:**
- Consumes: All tasks above.
- Produces: Verified hook feature implementation.

- [ ] **Step 1: Run focused main hook tests**

Run:

```powershell
pnpm test -- tests/main/services/hooks/schema.test.ts tests/main/services/hooks/hash.test.ts tests/main/services/hooks/config-service.test.ts tests/main/services/hooks/trust-service.test.ts tests/main/services/hooks/command-runner.test.ts tests/main/services/hooks/runtime.test.ts tests/main/services/hooks/middleware.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run agent hook tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor-hooks.test.ts tests/main/plugins/agent/runtime-hooks.test.ts tests/main/deep-agent-build-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run settings hook tests**

Run:

```powershell
pnpm test -- tests/main/settings-ipc-hooks.test.ts tests/renderer/settings-hooks-section.test.tsx tests/renderer/settings-model-save.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Run IPC check**

Run:

```powershell
pnpm check:ipc
```

Expected: PASS.

- [ ] **Step 6: Run whitespace diff check**

Run:

```powershell
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 7: Inspect worktree for unrelated changes**

Run:

```powershell
git status --short --branch
```

Expected: only hook implementation files are staged or modified by this implementation. Existing unrelated user changes may remain, but they must not be staged in hook commits.

- [ ] **Step 8: Final cleanup commit**

If verification required small fixes, commit them:

```powershell
git add src/shared/types/hooks.ts src/shared/types/index.ts src/shared/types/chat.ts src/shared/types/settings.ts src/shared/ipc.ts src/shared/ipc-schema.json src/shared/ipc-generated.ts src/main/services/hooks src/main/services/deep-agent/agent-builder.ts src/main/plugins/agent/deep-agent-executor.ts src/main/plugins/agent/runtime.ts src/main/plugins/agent/runtime-types.ts src/main/ipc/settings-ipc.ts src/main/main-kernel-bootstrap.ts src/renderer/settings src/renderer/loaded-state.ts tests/main/services/hooks tests/main/plugins/agent/deep-agent-executor-hooks.test.ts tests/main/plugins/agent/runtime-hooks.test.ts tests/main/settings-ipc-hooks.test.ts tests/renderer/settings-hooks-section.test.tsx
git commit -m "fix: complete hooks verification cleanup"
```

Skip this commit if no cleanup changes exist after Task 7.

---

## Self-Review Notes

- Spec coverage: config source, global scope, event list, command-only handlers, trust hashing, settings UI, middleware, lifecycle hooks, Windows cwd, failure handling, and tests are each covered by tasks above.
- Scope: first implementation excludes workspace-local overrides, prompt handlers, agent handlers, and hook marketplace behavior.
- Type consistency: shared type names use `RocHook*`; main runtime class names use `Hook*`; IPC settings methods use `getHooks`, `saveHooks`, and `trustHook`.
