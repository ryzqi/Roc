# DeepAgents Unified Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Roc's legacy synchronous provider execution with a Deep Agents and LangChain streaming runtime, add a fixed NVIDIA provider, remove the old execution path, and ship the updated packaged app.

**Architecture:** Keep the existing settings, config, and secret persistence layers, but replace the execution path with a LangChain model factory and a Deep Agent runtime service that emits main-to-renderer stream events. Update the chat UI to render incremental output, keep task snapshots as the durable task surface, and add a fixed NVIDIA settings surface backed by provider-specific options.

**Tech Stack:** Electron 41, React 19, TypeScript 6, LangChain.js, Deep Agents, better-sqlite3, Vitest, Playwright smoke, electron-builder

---

### Task 1: Upgrade dependencies and replace the provider execution core

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/main/services/app-service.ts`
- Modify: `src/main/services/provider-runtime-service.ts`
- Modify: `src/main/services/chat-service.ts`
- Create: `src/main/services/langchain-model-factory.ts`
- Create: `tests/main/langchain-model-factory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';
import { createInMemoryAppServices } from './test-utils';

describe('LangChainModelFactory', () => {
  it('builds an NVIDIA ChatOpenAI model with fixed baseURL and thinking kwargs', async () => {
    const services = createInMemoryAppServices();
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'kimi-k2',
      providers: [
        {
          id: 'nvidia',
          name: 'NVIDIA',
          type: 'nvidia',
          endpoint: 'https://integrate.api.nvidia.com/v1',
          credentialRef: 'secret:nvidia',
          enabled: true,
          models: [
            {
              id: 'kimi-k2',
              displayName: 'kimi-k2',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            thinking: true,
            temperature: 0.4,
            maxTokens: 1024
          }
        }
      ]
    });
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel();

    expect(result.provider.id).toBe('nvidia');
    expect(result.modelId).toBe('kimi-k2');
    expect(result.runtime.providerType).toBe('nvidia');
    expect(result.runtime.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(result.runtime.streaming).toBe(true);
    expect(result.runtime.modelKwargs).toMatchObject({
      chat_template_kwargs: {
        thinking: true
      }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/main/langchain-model-factory.test.ts`
Expected: FAIL because `src/main/services/langchain-model-factory.ts` and provider type `nvidia` do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ConfigService } from './config-service';
import type { SecretService } from './secret-service';

export class LangChainModelFactory {
  constructor(
    private readonly configService: ConfigService,
    private readonly secretService: SecretService
  ) {}

  async createDefaultChatModel(): Promise<{
    provider: ProviderConfig;
    model: BaseChatModel;
    modelId: string;
    runtime: {
      providerType: ProviderType;
      baseUrl: string | null;
      streaming: true;
      modelKwargs: Record<string, unknown>;
    };
  }> {
    // Resolve default model, provider, and secret.
    // Build ChatOpenAI or ChatAnthropic with streaming enabled.
    // For NVIDIA, force baseURL and map options.thinking -> modelKwargs.chat_template_kwargs.thinking.
  }
}
```

- [ ] **Step 4: Replace the legacy execution path with the factory**

```ts
// app-service.ts
const langChainModelFactory = new LangChainModelFactory(configService, secretService);

// provider-runtime-service.ts
// Keep only provider validation helpers and provider test entrypoints that call LangChain models.

// chat-service.ts
// Remove direct executeChat() transport usage; delegate execution to the new Deep Agent runtime in Task 2.
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm test tests/main/langchain-model-factory.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit milestone 1**

```powershell
git add package.json pnpm-lock.yaml src/main/services/app-service.ts src/main/services/provider-runtime-service.ts src/main/services/chat-service.ts src/main/services/langchain-model-factory.ts tests/main/langchain-model-factory.test.ts
git commit -m "Refactor provider runtime onto LangChain models" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Add the Deep Agent runtime and stream event IPC

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/register-ipc.ts`
- Modify: `src/main/services/chat-service.ts`
- Modify: `src/main/services/task-service.ts`
- Create: `src/main/services/deep-agent-runtime-service.ts`
- Create: `tests/main/deep-agent-runtime-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createInMemoryAppServices } from './test-utils';
import { DeepAgentRuntimeService } from '../../src/main/services/deep-agent-runtime-service';

describe('DeepAgentRuntimeService', () => {
  it('emits message, reasoning, and completed events for a chat run', async () => {
    const services = createInMemoryAppServices();
    const runtime = new DeepAgentRuntimeService(
      services.langChainModelFactory,
      services.taskService,
      services.agentService
    );
    const events: string[] = [];

    runtime.onRunEvent((event) => {
      events.push(event.type);
    });

    await runtime.startRun({
      input: 'Reply with OK only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });

    expect(events).toContain('run_started');
    expect(events).toContain('message_delta');
    expect(events).toContain('run_completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/main/deep-agent-runtime-service.test.ts`
Expected: FAIL because the runtime service and stream event types do not exist yet.

- [ ] **Step 3: Add stream event types and IPC surface**

```ts
export type ChatRunMode = 'chat' | 'task';

export type ChatRunEvent =
  | { type: 'run_started'; runId: string; mode: ChatRunMode; threadId: string | null; providerId: string; modelId: string; createdAt: string }
  | { type: 'message_delta'; runId: string; delta: string }
  | { type: 'reasoning_delta'; runId: string; delta: string }
  | { type: 'tool_event'; runId: string; event: 'start' | 'progress' | 'end' | 'error'; name: string; data: unknown }
  | { type: 'todo_event'; runId: string; todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | { type: 'subagent_event'; runId: string; subagent: string; status: string; summary: string | null }
  | { type: 'run_completed'; runId: string; threadId: string | null; providerId: string; modelId: string; createdAt: string; durationMs: number; summary: string; assistantMessage: string }
  | { type: 'run_failed'; runId: string; threadId: string | null; code: string; message: string; retryable: boolean };
```

- [ ] **Step 4: Implement the Deep Agent runtime service**

```ts
// deep-agent-runtime-service.ts
// - createDefaultChatModel() via LangChainModelFactory
// - createDeepAgent({ model, tools, subagents, systemPrompt, ... })
// - stream agent events
// - map chunks into ChatRunEvent
// - write taskService records when mode === 'task'
// - broadcast events via main window messaging
```

- [ ] **Step 5: Replace chat.submit with startRun and event subscriptions**

```ts
// shared ipc
chatStartRun
chatCancelRun

// preload
chat.startRun()
chat.cancelRun()
chat.onRunEvent()

// register-ipc
ipcMain.handle(ipcChannels.chatStartRun, ...)
sendToWindow(..., 'roc:chat:run-event', event)
```

- [ ] **Step 6: Run focused tests and typecheck**

Run: `pnpm test tests/main/deep-agent-runtime-service.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit milestone 2**

```powershell
git add src/shared/ipc.ts src/shared/types.ts src/preload/index.ts src/main/index.ts src/main/ipc/register-ipc.ts src/main/services/chat-service.ts src/main/services/task-service.ts src/main/services/deep-agent-runtime-service.ts tests/main/deep-agent-runtime-service.test.ts
git commit -m "Add Deep Agents streaming chat runtime" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Rebuild renderer chat flow and add the fixed NVIDIA provider

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/settings-model.ts`
- Modify: `src/renderer/settings/index.tsx`
- Modify: `src/renderer/settings/sections/providers-section.tsx`
- Modify: `src/main/services/config-service.ts`
- Modify: `src/shared/types.ts`
- Create: `tests/renderer/chat-stream-state.test.ts`
- Modify: `tests/renderer/settings-model.test.ts`
- Modify: `tests/renderer/providers-section.test.ts`

- [ ] **Step 1: Write the failing renderer test**

```ts
import { describe, expect, it } from 'vitest';
import { reduceChatRunEvent } from '../../src/renderer/chat-stream-state';

describe('reduceChatRunEvent', () => {
  it('accumulates assistant and reasoning deltas into the active run state', () => {
    const started = reduceChatRunEvent(null, {
      type: 'run_started',
      runId: 'run_1',
      mode: 'chat',
      threadId: null,
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2.6',
      createdAt: '2026-05-09T00:00:00.000Z'
    });
    const withMessage = reduceChatRunEvent(started, { type: 'message_delta', runId: 'run_1', delta: 'OK' });
    const withReasoning = reduceChatRunEvent(withMessage, { type: 'reasoning_delta', runId: 'run_1', delta: 'think' });

    expect(withReasoning?.assistantMessage).toBe('OK');
    expect(withReasoning?.reasoningMessage).toBe('think');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/renderer/chat-stream-state.test.ts`
Expected: FAIL because the reducer and run state do not exist yet.

- [ ] **Step 3: Replace the one-shot chat UI with a streaming renderer**

```tsx
// App.tsx
// - subscribe to window.roc.chat.onRunEvent(...)
// - replace state.chatResult panel with streaming message surface
// - submit via window.roc.chat.startRun(...)
// - keep disabled / error / capability preview states intact
```

- [ ] **Step 4: Add the fixed NVIDIA settings model**

```ts
export type ProviderType = 'openai_compatible' | 'anthropic_compatible' | 'nvidia';

export type NvidiaProviderOptions = {
  thinking: boolean;
  temperature: number;
  maxTokens: number;
};

// settings-model.ts
// - add helpers for fixed NVIDIA provider defaults
// - model id stays user-entered
// - endpoint is fixed and not editable
```

- [ ] **Step 5: Rebuild the providers section around a fixed NVIDIA card**

```tsx
// providers-section.tsx
// - left list always includes NVIDIA
// - NVIDIA cannot be deleted
// - NVIDIA detail form omits provider type selector and base URL input
// - keeps API key, model id, enabled, thinking, temperature, max tokens
```

- [ ] **Step 6: Run focused renderer tests and typecheck**

Run: `pnpm test tests/renderer/chat-stream-state.test.ts tests/renderer/settings-model.test.ts tests/renderer/providers-section.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit milestone 3**

```powershell
git add src/renderer/App.tsx src/renderer/settings-model.ts src/renderer/settings/index.tsx src/renderer/settings/sections/providers-section.tsx src/main/services/config-service.ts src/shared/types.ts tests/renderer/chat-stream-state.test.ts tests/renderer/settings-model.test.ts tests/renderer/providers-section.test.ts
git commit -m "Add streaming chat UI and fixed NVIDIA provider" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Delete obsolete paths, update smoke, build, package, and verify

**Files:**
- Modify: `tests/main/app-services.test.ts`
- Modify: `tests/smoke/electron-smoke.mjs`
- Modify: `tests/main/workspace-dialog-ipc.test.ts`
- Delete or trim: any legacy-only execution code proven unused by the new runtime

- [ ] **Step 1: Add or update the failing regression coverage**

```ts
// app-services.test.ts
// assert chat startRun uses DeepAgent runtime and no longer depends on direct transport execution

// electron-smoke.mjs
// assert settings show fixed NVIDIA provider and chat output appears incrementally
```

- [ ] **Step 2: Run tests to verify they fail for the old assumptions**

Run: `pnpm test tests/main/app-services.test.ts`
Expected: FAIL until the old assumptions are updated.

- [ ] **Step 3: Delete legacy-only execution paths**

```ts
// Remove dead code only after tests prove the new runtime covers it:
// - old synchronous chat result path
// - old fetch transport execution helpers
// - old renderer one-shot result surfaces
```

- [ ] **Step 4: Run the relevant full verification**

Run: `pnpm test`
Expected: PASS

Run: `pnpm build`
Expected: PASS

Run: `pnpm package:dir`
Expected: PASS

Run: `$env:ROC_SMOKE_TARGET='packaged'; pnpm smoke:electron`
Expected: PASS and `.artifacts/wave1/electron-smoke.json` reports `"passed": true`

- [ ] **Step 5: Commit milestone 4**

```powershell
git add tests/main/app-services.test.ts tests/smoke/electron-smoke.mjs tests/main/workspace-dialog-ipc.test.ts src
git commit -m "Finalize Deep Agents runtime migration" -m "Co-authored-by: Codex <noreply@openai.com>"
```
