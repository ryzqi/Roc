# Chat Image Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add image input support to the main chat composer and pass selected images into DeepAgents as LangChain multimodal `HumanMessage` content.

**Architecture:** Add a shared structured image attachment contract, validate image inputs in renderer for UX and in main for trust, then build DeepAgents initial state from validated text plus image blocks. Keep image bytes out of persisted task history and only persist lightweight attachment metadata.

**Tech Stack:** TypeScript ESM, React 19, Electron IPC, Vitest, Zod, LangChain `HumanMessage`, DeepAgents `createDeepAgent`.

## Global Constraints

- User-facing replies and UI copy are Simplified Chinese.
- PowerShell command examples only.
- Use UTF-8 without BOM.
- Preserve the existing main/preload/renderer/shared boundaries.
- Do not add image support to task detail input.
- Do not add image support to the task creation dialog.
- Do not add assistant image generation or assistant image display.
- Do not silently compress, resize, or transcode images.
- Do not store base64 image data in task events or transcript history.
- Do not fall back to sending image paths as text when a model lacks image support.
- Image input supports only `png`, `jpg`, `jpeg`, and `webp`.
- Each chat message supports at most 4 images.
- Each image supports at most 5 MB.
- Use LangChain content blocks shaped as `{ type: 'image', mimeType, data }`.

---

## File Structure

- `src/shared/types/chat.ts`
  - Add shared chat image attachment, persisted attachment metadata, and validated runtime image attachment types.
  - Extend `ChatStartRunRequest`.

- `src/shared/types/settings.ts`
  - Add `supportsImages: boolean` to `ProviderModel`.

- `src/main/services/config/schema.ts`
  - Require `supportsImages` in persisted provider model schema.

- `src/main/services/config/migration.ts`
  - Backfill `supportsImages: false` for existing settings documents.

- `src/shared/provider-defaults.ts`
  - Set `supportsImages` for fixed OpenRouter default model configs where Roc owns defaults.

- `src/renderer/settings/provider-draft-model.ts`
  - Parse manually entered model rows into `ProviderModel` with `supportsImages: false`.

- `tests/shared/provider-config.test.ts`
  - Update provider fixtures and assert typed config preserves `supportsImages`.

- `tests/main/config-service-helpers.test.ts`
  - Add or update schema/migration coverage for `supportsImages` backfill.

- `tests/renderer/settings-model.test.ts`
  - Update parsed model expectations for `supportsImages`.

- `src/main/plugins/agent/index.ts`
  - Extend `chatStartRunRequestSchema` with image attachment validation.

- `src/main/plugins/agent/chat-image-attachments.ts`
  - New main-side validation and base64 preparation helper.

- `tests/main/plugins/agent/chat-image-attachments.test.ts`
  - New direct tests for main-side validation.

- `src/main/plugins/agent/session-repository.ts`
  - Store attachment metadata in user `message` events without base64.

- `src/main/plugins/agent/runtime.ts`
  - Normalize attachments before creating the run, pass validated images into the executor, and persist metadata.

- `src/main/plugins/agent/runtime-types.ts`
  - Extend executor/runtime result types if a new validated attachment input type is shared inside main.

- `src/main/plugins/agent/deep-agent-executor.ts`
  - Build initial DeepAgents state with multimodal `HumanMessage` content when images exist.

- `tests/main/plugins/agent/deep-agent-executor.test.ts`
  - Assert initial state contains text plus image content blocks.

- `tests/main/plugins/agent/runtime-executor.test.ts`
  - Assert runtime stores metadata only and passes validated images to the executor.

- `src/renderer/chat/image-attachments.ts`
  - New renderer-side image attachment helper for file selection, paste, drop, size/type checks, object URL lifecycle data, and selected model support lookup.

- `src/renderer/chat/task-run-payload.ts`
  - Add `attachments?: ChatImageAttachment[]`.

- `src/renderer/chat/chat-view.tsx`
  - Own selected image attachment state, submit attachments, clear them after success, reset object URLs on conversation change.

- `src/renderer/chat/chat-composer.tsx`
  - Replace string-path attachment props with structured image attachment props, add paste/drop handlers, remove buttons, and send blocking message.

- `tests/renderer/chat-image-attachments.test.ts`
  - New helper tests for renderer validation and model support lookup.

- `tests/renderer/chat-composer.test.ts`
  - Add render and interaction tests for selected image chips and blocking state.

- `tests/renderer/features/chat-feature.test.tsx`
  - Assert submitted payload includes attachments and clears them after successful send.

- `src/renderer/chat-transcript.ts`
  - Include persisted attachment metadata on user transcript messages.

- `src/renderer/chat-transcript-panel.tsx` or the actual transcript panel module under `src/renderer/chat/`
  - Render compact user message attachment metadata.

- `tests/renderer/chat-transcript.test.ts`
  - Assert persisted user image attachment metadata appears in transcript model.

- `tests/renderer/chat-transcript-panel.test.tsx` or existing transcript panel test file
  - Assert rendered transcript contains image attachment labels.

---

### Task 1: Shared Contract And Model Capability

**Files:**
- Modify: `src/shared/types/chat.ts`
- Modify: `src/shared/types/settings.ts`
- Modify: `src/shared/provider-defaults.ts`
- Modify: `src/main/services/config/schema.ts`
- Modify: `src/main/services/config/migration.ts`
- Modify: `src/renderer/settings/provider-draft-model.ts`
- Modify: `tests/shared/provider-config.test.ts`
- Modify: `tests/main/config-service-helpers.test.ts`
- Modify: `tests/renderer/settings-model.test.ts`

**Interfaces:**
- Produces: `ChatImageAttachment`, `ChatPersistedAttachment`, `ChatValidatedImageAttachment`, `ProviderModel.supportsImages`.
- Consumes: existing `ChatStartRunRequest`, `ProviderModel`, settings schema and migration flow.

- [ ] **Step 1: Write failing shared provider model test**

Add this assertion to `tests/shared/provider-config.test.ts` in the typed provider config round-trip coverage:

```ts
const typed = toTypedProviderConfig(provider({
  type: 'openai_compatible',
  models: [
    {
      id: 'vision-model',
      displayName: 'Vision Model',
      enabled: true,
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsImages: true
    }
  ]
}));

expect(typed.config.models[0]).toMatchObject({
  id: 'vision-model',
  supportsImages: true
});
expect(fromTypedProviderConfig(typed).models[0]).toMatchObject({
  id: 'vision-model',
  supportsImages: true
});
```

Also update the local `provider()` test helper default model:

```ts
supportsImages: false
```

- [ ] **Step 2: Run shared test to verify failure**

Run:

```powershell
pnpm test -- tests/shared/provider-config.test.ts
```

Expected: TypeScript or test failure because `ProviderModel` does not contain `supportsImages`.

- [ ] **Step 3: Add shared chat image types**

Modify `src/shared/types/chat.ts`:

```ts
export const chatImageAttachmentMediaTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type ChatImageAttachmentMediaType = (typeof chatImageAttachmentMediaTypes)[number];

export type ChatImageAttachment = {
  kind: 'image';
  source: 'file' | 'clipboard' | 'drop';
  name: string;
  mediaType: ChatImageAttachmentMediaType;
  sizeBytes: number;
  path?: string;
  data?: string;
};

export type ChatPersistedAttachment = {
  kind: 'image';
  name: string;
  mediaType: ChatImageAttachmentMediaType;
  sizeBytes: number;
};

export type ChatValidatedImageAttachment = ChatPersistedAttachment & {
  base64: string;
};
```

Extend `ChatStartRunRequest`:

```ts
export type ChatStartRunRequest = {
  input: string;
  mode: ChatRunMode;
  enabledCapabilities: EnabledCapabilities;
  threadId?: string | null;
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
  workspacePath?: string | null;
  attachments?: ChatImageAttachment[];
};
```

- [ ] **Step 4: Add model image capability type and defaults**

Modify `src/shared/types/settings.ts`:

```ts
export type ProviderModel = {
  id: string;
  displayName: string;
  enabled: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsImages: boolean;
};
```

Modify `src/shared/provider-defaults.ts` fixed OpenRouter defaults:

```ts
supportsImages: true
```

for `~openai/gpt-latest`, `~anthropic/claude-sonnet-latest`, and `~google/gemini-pro-latest`.

Use `supportsImages: false` for model objects created from manually entered text in `src/renderer/settings/provider-draft-model.ts`:

```ts
supportsStreaming: true,
supportsToolCalls: true,
supportsImages: false
```

- [ ] **Step 5: Add schema and migration**

Modify `ProviderModelSchema` in `src/main/services/config/schema.ts`:

```ts
const ProviderModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsToolCalls: z.boolean(),
  supportsImages: z.boolean()
});
```

In `src/main/services/config/migration.ts`, add a small model normalizer at the point provider models are normalized:

```ts
function normalizeProviderModel(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if ('supportsImages' in record) {
    return record;
  }
  return {
    ...record,
    supportsImages: false
  };
}
```

Apply it to every provider model during migration:

```ts
models: Array.isArray(provider.models) ? provider.models.map(normalizeProviderModel) : []
```

Use the exact local migration function names in `migration.ts`; preserve surrounding style.

- [ ] **Step 6: Update settings parser tests**

Update expected objects in `tests/renderer/settings-model.test.ts` for `parseProviderModelDraft('gpt-4.1 | GPT 4.1\nclaude-sonnet-4-5')`:

```ts
{
  id: 'gpt-4.1',
  displayName: 'GPT 4.1',
  enabled: true,
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsImages: false
}
```

and:

```ts
{
  id: 'claude-sonnet-4-5',
  displayName: 'claude-sonnet-4-5',
  enabled: true,
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsImages: false
}
```

Add migration assertion in `tests/main/config-service-helpers.test.ts` or the existing migration-focused config test:

```ts
expect(snapshot.providers[0]?.models[0]).toMatchObject({
  supportsImages: false
});
```

- [ ] **Step 7: Run focused tests**

Run:

```powershell
pnpm test -- tests/shared/provider-config.test.ts tests/main/config-service-helpers.test.ts tests/renderer/settings-model.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add src/shared/types/chat.ts src/shared/types/settings.ts src/shared/provider-defaults.ts src/main/services/config/schema.ts src/main/services/config/migration.ts src/renderer/settings/provider-draft-model.ts tests/shared/provider-config.test.ts tests/main/config-service-helpers.test.ts tests/renderer/settings-model.test.ts
git commit -m "feat: add chat image input contract"
```

---

### Task 2: Main-Side Attachment Validation

**Files:**
- Create: `src/main/plugins/agent/chat-image-attachments.ts`
- Modify: `src/main/plugins/agent/index.ts`
- Test: `tests/main/plugins/agent/chat-image-attachments.test.ts`

**Interfaces:**
- Consumes: `ChatImageAttachment`, `ChatPersistedAttachment`, `ChatValidatedImageAttachment`, `chatImageAttachmentMediaTypes`.
- Produces: `prepareChatImageAttachments(attachments: readonly ChatImageAttachment[] | undefined): ChatPreparedImageAttachments`.

- [ ] **Step 1: Write failing validation tests**

Create `tests/main/plugins/agent/chat-image-attachments.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareChatImageAttachments } from '../../../../src/main/plugins/agent/chat-image-attachments';

describe('prepareChatImageAttachments', () => {
  it('reads file attachments and returns metadata plus base64', () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-image-'));
    try {
      const filePath = join(root, 'sample.png');
      writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = prepareChatImageAttachments([
        {
          kind: 'image',
          source: 'file',
          name: 'sample.png',
          mediaType: 'image/png',
          sizeBytes: 4,
          path: filePath
        }
      ]);

      expect(result.metadata).toEqual([
        {
          kind: 'image',
          name: 'sample.png',
          mediaType: 'image/png',
          sizeBytes: 4
        }
      ]);
      expect(result.images).toEqual([
        {
          kind: 'image',
          name: 'sample.png',
          mediaType: 'image/png',
          sizeBytes: 4,
          base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
        }
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts clipboard base64 data without persisting bytes', () => {
    const result = prepareChatImageAttachments([
      {
        kind: 'image',
        source: 'clipboard',
        name: 'pasted.png',
        mediaType: 'image/png',
        sizeBytes: 3,
        data: Buffer.from([1, 2, 3]).toString('base64')
      }
    ]);

    expect(result.metadata[0]).toEqual({
      kind: 'image',
      name: 'pasted.png',
      mediaType: 'image/png',
      sizeBytes: 3
    });
    expect(result.images[0]?.base64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('rejects more than four images', () => {
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      kind: 'image' as const,
      source: 'clipboard' as const,
      name: `image-${index}.png`,
      mediaType: 'image/png' as const,
      sizeBytes: 1,
      data: Buffer.from([index]).toString('base64')
    }));

    expect(() => prepareChatImageAttachments(attachments)).toThrow('chat_image_too_many');
  });

  it('rejects unsupported media types', () => {
    expect(() =>
      prepareChatImageAttachments([
        {
          kind: 'image',
          source: 'clipboard',
          name: 'bad.gif',
          mediaType: 'image/gif' as never,
          sizeBytes: 1,
          data: Buffer.from([1]).toString('base64')
        }
      ])
    ).toThrow('chat_image_unsupported_type');
  });

  it('rejects images over five megabytes', () => {
    expect(() =>
      prepareChatImageAttachments([
        {
          kind: 'image',
          source: 'clipboard',
          name: 'large.png',
          mediaType: 'image/png',
          sizeBytes: 5 * 1024 * 1024 + 1,
          data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')
        }
      ])
    ).toThrow('chat_image_too_large');
  });

  it('rejects attachments with both path and data', () => {
    expect(() =>
      prepareChatImageAttachments([
        {
          kind: 'image',
          source: 'clipboard',
          name: 'ambiguous.png',
          mediaType: 'image/png',
          sizeBytes: 1,
          path: 'C:\\\\tmp\\\\ambiguous.png',
          data: Buffer.from([1]).toString('base64')
        }
      ])
    ).toThrow('chat_image_source_invalid');
  });
});
```

- [ ] **Step 2: Run validation tests to verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/chat-image-attachments.test.ts
```

Expected: FAIL because `chat-image-attachments.ts` does not exist.

- [ ] **Step 3: Implement main validation helper**

Create `src/main/plugins/agent/chat-image-attachments.ts`:

```ts
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import type {
  ChatImageAttachment,
  ChatImageAttachmentMediaType,
  ChatPersistedAttachment,
  ChatValidatedImageAttachment
} from '../../../shared/types';
import { chatImageAttachmentMediaTypes } from '../../../shared/types';

const maxImageAttachments = 4;
const maxImageAttachmentBytes = 5 * 1024 * 1024;
const mediaTypes = new Set<ChatImageAttachmentMediaType>(chatImageAttachmentMediaTypes);
const extensionMediaTypes = new Map<string, ChatImageAttachmentMediaType>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp']
]);

export type ChatPreparedImageAttachments = {
  metadata: ChatPersistedAttachment[];
  images: ChatValidatedImageAttachment[];
};

export function prepareChatImageAttachments(
  attachments: readonly ChatImageAttachment[] | undefined
): ChatPreparedImageAttachments {
  if (attachments === undefined || attachments.length === 0) {
    return { metadata: [], images: [] };
  }
  if (attachments.length > maxImageAttachments) {
    throw new Error('chat_image_too_many');
  }

  const images = attachments.map(prepareOneAttachment);
  return {
    metadata: images.map(({ base64: _base64, ...metadata }) => metadata),
    images
  };
}

function prepareOneAttachment(attachment: ChatImageAttachment): ChatValidatedImageAttachment {
  if (attachment.kind !== 'image') {
    throw new Error('chat_image_unsupported_type');
  }
  if (!mediaTypes.has(attachment.mediaType)) {
    throw new Error('chat_image_unsupported_type');
  }
  if (attachment.sizeBytes > maxImageAttachmentBytes) {
    throw new Error('chat_image_too_large');
  }
  const hasPath = typeof attachment.path === 'string';
  const hasData = typeof attachment.data === 'string';
  if (hasPath === hasData) {
    throw new Error('chat_image_source_invalid');
  }

  const base64 = hasPath ? readPathAttachment(attachment) : readDataAttachment(attachment);
  return {
    kind: 'image',
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    base64
  };
}

function readPathAttachment(attachment: ChatImageAttachment & { path: string }): string {
  const mediaType = extensionMediaTypes.get(extname(attachment.path).toLowerCase());
  if (mediaType === undefined || mediaType !== attachment.mediaType) {
    throw new Error('chat_image_unsupported_type');
  }
  const stat = statSync(attachment.path);
  if (!stat.isFile()) {
    throw new Error('chat_image_unreadable');
  }
  if (stat.size === 0) {
    throw new Error('chat_image_empty');
  }
  if (stat.size > maxImageAttachmentBytes) {
    throw new Error('chat_image_too_large');
  }
  const buffer = readFileSync(attachment.path);
  return buffer.toString('base64');
}

function readDataAttachment(attachment: ChatImageAttachment & { data: string }): string {
  const buffer = Buffer.from(attachment.data, 'base64');
  if (buffer.byteLength === 0) {
    throw new Error('chat_image_empty');
  }
  if (buffer.byteLength > maxImageAttachmentBytes) {
    throw new Error('chat_image_too_large');
  }
  if (buffer.byteLength !== attachment.sizeBytes) {
    throw new Error('chat_image_size_mismatch');
  }
  return attachment.data;
}
```

- [ ] **Step 4: Extend agent input schema**

Modify `src/main/plugins/agent/index.ts` near `chatStartRunRequestSchema`:

```ts
const chatImageAttachmentSchema = z.object({
  kind: z.literal('image'),
  source: z.enum(['file', 'clipboard', 'drop']),
  name: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sizeBytes: z.number().int().positive(),
  path: z.string().min(1).optional(),
  data: z.string().min(1).optional()
}).refine(
  (value) => (value.path === undefined) !== (value.data === undefined),
  'Image attachment must provide exactly one source.'
);
```

Add to `chatStartRunRequestSchema`:

```ts
attachments: z.array(chatImageAttachmentSchema).max(4).optional()
```

- [ ] **Step 5: Run validation tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/chat-image-attachments.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/main/plugins/agent/chat-image-attachments.ts src/main/plugins/agent/index.ts tests/main/plugins/agent/chat-image-attachments.test.ts
git commit -m "feat: validate chat image attachments"
```

---

### Task 3: Runtime Persistence And Executor Input

**Files:**
- Modify: `src/main/plugins/agent/session-repository.ts`
- Modify: `src/main/plugins/agent/runtime.ts`
- Modify: `src/main/plugins/agent/runtime-types.ts`
- Test: `tests/main/plugins/agent/runtime-executor.test.ts`
- Test: `tests/main/plugins/agent/session-repository.test.ts`

**Interfaces:**
- Consumes: `prepareChatImageAttachments()`.
- Produces: runtime calls executor with `validatedAttachments?: ChatValidatedImageAttachment[]`; `createTaskRun()` accepts `attachments?: ChatPersistedAttachment[]`.

- [ ] **Step 1: Write failing repository metadata test**

In `tests/main/plugins/agent/session-repository.test.ts`, add a test near `createTaskRun` coverage:

```ts
it('stores user image attachment metadata without base64 data', () => {
  const repository = createRepository();
  const run = repository.createTaskRun({
    enabledCapabilities: { mcpServers: [], skills: [] },
    modelId: 'model-1',
    threadKind: 'chat',
    userInput: '描述图片',
    attachments: [
      {
        kind: 'image',
        name: 'diagram.png',
        mediaType: 'image/png',
        sizeBytes: 123
      }
    ]
  });

  const events = repository.listThreadEvents(run.threadId);

  expect(events[0]?.payload).toEqual({
    role: 'user',
    content: '描述图片',
    enabledCapabilities: { mcpServers: [], skills: [] },
    attachments: [
      {
        kind: 'image',
        name: 'diagram.png',
        mediaType: 'image/png',
        sizeBytes: 123
      }
    ]
  });
  expect(JSON.stringify(events[0]?.payload)).not.toContain('base64');
});
```

Use the local repository factory already present in that test file.

- [ ] **Step 2: Write failing runtime executor test**

In `tests/main/plugins/agent/runtime-executor.test.ts`, add:

```ts
it('validates image attachments before invoking the DeepAgent executor', async () => {
  const deepAgentExecutor = {
    execute: vi.fn(async function* () {
      yield {
        type: 'assistant_block',
        runId: 'run-1',
        block: {
          kind: 'text',
          blockId: 'text-1',
          phase: 'delta',
          text: '图片里有图表。'
        }
      };
    })
  };
  const repository = new AgentSessionRepository(db);
  const runtime = new AgentPluginRuntime({
    deepAgentExecutor,
    eventBus,
    modelFactory,
    repository
  });

  await runtime.startRun({
    input: '描述图片',
    mode: 'chat',
    enabledCapabilities: { mcpServers: [], skills: [] },
    attachments: [
      {
        kind: 'image',
        source: 'clipboard',
        name: 'chart.png',
        mediaType: 'image/png',
        sizeBytes: 3,
        data: Buffer.from([1, 2, 3]).toString('base64')
      }
    ]
  });
  await waitForEvent(() =>
    events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
  );

  expect(deepAgentExecutor.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      validatedAttachments: [
        {
          kind: 'image',
          name: 'chart.png',
          mediaType: 'image/png',
          sizeBytes: 3,
          base64: Buffer.from([1, 2, 3]).toString('base64')
        }
      ]
    })
  );
});
```

This uses the existing `db`, `events`, `eventBus`, `modelFactory`, `waitForEvent()`, and `readChatRunEvent()` helpers already defined in `runtime-executor.test.ts`.

- [ ] **Step 3: Run runtime tests to verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/session-repository.test.ts tests/main/plugins/agent/runtime-executor.test.ts
```

Expected: FAIL because repository/runtime do not accept attachments yet.

- [ ] **Step 4: Extend repository input and event payload**

Modify `src/main/plugins/agent/session-repository.ts` import list:

```ts
ChatPersistedAttachment,
```

Modify `createTaskRun` input:

```ts
createTaskRun(input: {
  userInput: string;
  modelId: string;
  enabledCapabilities: EnabledCapabilities;
  threadKind: TaskKind;
  threadId?: string;
  attachments?: ChatPersistedAttachment[];
}): TaskRun {
```

Build payload before `recordEvent` insert:

```ts
const userMessagePayload = input.attachments === undefined || input.attachments.length === 0
  ? {
      role: 'user',
      content: input.userInput,
      enabledCapabilities: input.enabledCapabilities
    }
  : {
      role: 'user',
      content: input.userInput,
      enabledCapabilities: input.enabledCapabilities,
      attachments: input.attachments
    };
```

Use `JSON.stringify(userMessagePayload)` in the `task_events` insert.

- [ ] **Step 5: Extend executor input type**

Modify `src/main/plugins/agent/runtime.ts` `AgentDeepAgentExecutor.execute` input shape:

```ts
validatedAttachments?: ChatValidatedImageAttachment[];
```

Add `ChatValidatedImageAttachment` to the import list.

If `runtime-types.ts` owns related execution result types only, do not add unused types there.

- [ ] **Step 6: Prepare attachments in runtime**

Modify `src/main/plugins/agent/runtime.ts`:

```ts
import { prepareChatImageAttachments } from './chat-image-attachments';
```

Inside `startRun()` after text validation and before `createTaskRun()`:

```ts
const preparedAttachments = prepareChatImageAttachments(request.attachments);
```

Pass metadata into `createTaskRun()`:

```ts
const run = this.options.repository.createTaskRun({
  enabledCapabilities: request.enabledCapabilities,
  modelId: modelHandle.modelId,
  threadKind: resolveNewRunThreadKind(request),
  threadId: typeof request.threadId === 'string' ? request.threadId : undefined,
  userInput: input,
  attachments: preparedAttachments.metadata
});
```

Pass images into `executeRun()`:

```ts
validatedAttachments: preparedAttachments.images,
```

Add `validatedAttachments` to `executeRun()` input and `executeDeepAgentRun()` input, then pass into the executor:

```ts
const execution = await this.executeDeepAgentRun({
  abortSignal: input.abortSignal,
  modelHandle: input.modelHandle,
  request: input.request,
  resumePayload: input.resumePayload,
  run: input.run,
  validatedAttachments: input.validatedAttachments
});
```

Inside `executeDeepAgentRun()`:

```ts
for await (const event of await this.options.deepAgentExecutor!.execute(input)) {
```

works after the input type includes `validatedAttachments`.

Resume paths should not add attachments.

- [ ] **Step 7: Run runtime tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/session-repository.test.ts tests/main/plugins/agent/runtime-executor.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add src/main/plugins/agent/session-repository.ts src/main/plugins/agent/runtime.ts src/main/plugins/agent/runtime-types.ts tests/main/plugins/agent/session-repository.test.ts tests/main/plugins/agent/runtime-executor.test.ts
git commit -m "feat: pass chat image attachments through runtime"
```

If `runtime-types.ts` is unchanged, omit it from `git add`.

---

### Task 4: DeepAgents Multimodal Initial State

**Files:**
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor.test.ts`

**Interfaces:**
- Consumes: executor input `validatedAttachments?: ChatValidatedImageAttachment[]`.
- Produces: `createInitialState(input: string, attachments: readonly ChatValidatedImageAttachment[] | undefined): unknown`.

- [ ] **Step 1: Write failing DeepAgents initial-state test**

In `tests/main/plugins/agent/deep-agent-executor.test.ts`, add:

```ts
it('passes image attachments to DeepAgents as LangChain multimodal content blocks', async () => {
  await buildExecutorOnce(createCapabilities([]), {
    input: '描述图片'
  }, [
    {
      kind: 'image',
      name: 'chart.png',
      mediaType: 'image/png',
      sizeBytes: 3,
      base64: Buffer.from([1, 2, 3]).toString('base64')
    }
  ]);

  const streamEvents = readStreamEventsCall();
  const initialState = streamEvents.input as { messages: Array<{ content: unknown }> };
  expect(initialState.messages[0]?.content).toEqual([
    { type: 'text', text: '描述图片' },
    {
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from([1, 2, 3]).toString('base64')
    }
  ]);
});
```

If `readStreamEventsCall()` does not exist, add it to `deep-agent-executor-test-helpers.ts` in Step 3 below.

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: FAIL because helpers do not support validated image attachments and initial state is text-only.

- [ ] **Step 3: Extend executor test helper**

Modify `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`:

```ts
import type { ChatValidatedImageAttachment } from '../../../../src/shared/types';
```

Add optional field:

```ts
validatedAttachments?: ChatValidatedImageAttachment[];
```

Update `buildExecutorOnce` signature:

```ts
export async function buildExecutorOnce(
  capabilities: RocCapabilityRegistry,
  requestOverride: Partial<ChatStartRunRequest> = {},
  validatedAttachments?: ChatValidatedImageAttachment[]
): Promise<void> {
  await collectExecutorEvents({
    capabilities,
    requestOverride,
    validatedAttachments,
    output: {
      messages: [
        {
          role: 'assistant',
          content: 'ok'
        }
      ]
    }
  });
}
```

Pass into `executor.execute()`:

```ts
validatedAttachments: input.validatedAttachments,
```

Capture `streamEvents` call:

```ts
let lastStreamEventsCall: { input: unknown; config: unknown } | null = null;
```

Inside mock:

```ts
streamEvents: vi.fn(async (runInput: unknown, config: unknown) => {
  lastStreamEventsCall = { input: runInput, config };
  return {
    toolCalls: input.toolCalls ?? emptyAsyncIterable(),
    messages: input.messages ?? emptyAsyncIterable(),
    subagents: input.subagents ?? emptyAsyncIterable(),
    output: input.output ?? { messages: [] }
  };
})
```

Export:

```ts
export function readStreamEventsCall(): { input: unknown; config: unknown } {
  if (lastStreamEventsCall === null) {
    throw new Error('stream_events_call_missing');
  }
  return lastStreamEventsCall;
}
```

- [ ] **Step 4: Build multimodal `HumanMessage` content**

Modify `src/main/plugins/agent/deep-agent-executor.ts` import types:

```ts
ChatValidatedImageAttachment,
```

Change run input:

```ts
const runInput =
  input.resumePayload === undefined
    ? createInitialState(input.request.input, input.validatedAttachments)
    : new Command({
        resume: input.resumePayload
      });
```

Replace `createInitialState`:

```ts
function createInitialState(input: string, attachments: readonly ChatValidatedImageAttachment[] | undefined): unknown {
  if (attachments === undefined || attachments.length === 0) {
    return {
      messages: [new HumanMessage(input)],
      forge_error_tracker: defaultErrorTracker()
    };
  }
  return {
    messages: [
      new HumanMessage({
        content: [
          { type: 'text', text: input },
          ...attachments.map((attachment) => ({
            type: 'image' as const,
            mimeType: attachment.mediaType,
            data: attachment.base64
          }))
        ]
      })
    ],
    forge_error_tracker: defaultErrorTracker()
  };
}
```

- [ ] **Step 5: Run DeepAgent executor tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/main/plugins/agent/deep-agent-executor.ts tests/main/plugins/agent/deep-agent-executor-test-helpers.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "feat: send chat images to deepagents"
```

---

### Task 5: Renderer Attachment Helpers

**Files:**
- Create: `src/renderer/chat/image-attachments.ts`
- Test: `tests/renderer/chat-image-attachments.test.ts`

**Interfaces:**
- Consumes: `ChatImageAttachment`, `ProviderModel`, `LoadedState`.
- Produces: `createFileImageAttachment(file: File, source: 'clipboard' | 'drop'): Promise<RendererImageAttachment>`, `isImageInputSupported(state: LoadedState): boolean`, `validateImageAttachmentSelection(items)`.

- [ ] **Step 1: Write failing helper tests**

Create `tests/renderer/chat-image-attachments.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  createFileImageAttachment,
  isImageInputSupported,
  validateImageAttachmentSelection
} from '../../src/renderer/chat/image-attachments';
import { createLoadedState } from './view-test-helpers';

describe('chat image attachment helpers', () => {
  it('creates base64 attachments from dropped or pasted image files', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'chart.png', { type: 'image/png' });

    const attachment = await createFileImageAttachment(file, 'drop');

    expect(attachment).toMatchObject({
      kind: 'image',
      source: 'drop',
      name: 'chart.png',
      mediaType: 'image/png',
      sizeBytes: 3,
      data: 'AQID'
    });
  });

  it('rejects unsupported image types', async () => {
    const file = new File([new Uint8Array([1])], 'motion.gif', { type: 'image/gif' });

    await expect(createFileImageAttachment(file, 'drop')).rejects.toThrow('chat_image_unsupported_type');
  });

  it('rejects images over five megabytes', async () => {
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' });

    await expect(createFileImageAttachment(file, 'drop')).rejects.toThrow('chat_image_too_large');
  });

  it('rejects selections with more than four images', () => {
    expect(() => validateImageAttachmentSelection([1, 2, 3, 4, 5])).toThrow('chat_image_too_many');
  });

  it('requires the selected default model to support images', () => {
    const supported = createLoadedState({
      defaultModelId: 'vision-model',
      providers: [
        {
          id: 'provider-1',
          name: 'Provider',
          type: 'openai_compatible',
          endpoint: 'https://example.test',
          credentialRef: null,
          enabled: true,
          models: [
            {
              id: 'vision-model',
              displayName: 'Vision Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: true
            }
          ]
        }
      ]
    });
    const unsupported = createLoadedState({
      defaultModelId: 'text-model',
      providers: [
        {
          id: 'provider-1',
          name: 'Provider',
          type: 'openai_compatible',
          endpoint: 'https://example.test',
          credentialRef: null,
          enabled: true,
          models: [
            {
              id: 'text-model',
              displayName: 'Text Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ]
        }
      ]
    });

    expect(isImageInputSupported(supported)).toBe(true);
    expect(isImageInputSupported(unsupported)).toBe(false);
  });
});
```

- [ ] **Step 2: Run helper tests to verify failure**

Run:

```powershell
pnpm test -- tests/renderer/chat-image-attachments.test.ts
```

Expected: FAIL because helper file does not exist.

- [ ] **Step 3: Implement renderer helper**

Create `src/renderer/chat/image-attachments.ts`:

```ts
import type { ChatImageAttachment, ChatImageAttachmentMediaType } from '../../shared/types';
import type { LoadedState } from '../loaded-state';

export type RendererImageAttachment = ChatImageAttachment & {
  previewUrl: string | null;
};

const maxImageAttachments = 4;
const maxImageAttachmentBytes = 5 * 1024 * 1024;
const mediaTypes = new Set<string>(['image/png', 'image/jpeg', 'image/webp']);

export function validateImageAttachmentSelection(items: readonly unknown[]): void {
  if (items.length > maxImageAttachments) {
    throw new Error('chat_image_too_many');
  }
}

export async function createFileImageAttachment(
  file: File,
  source: 'clipboard' | 'drop'
): Promise<RendererImageAttachment> {
  const mediaType = resolveFileMediaType(file);
  if (mediaType === null) {
    throw new Error('chat_image_unsupported_type');
  }
  if (file.size > maxImageAttachmentBytes) {
    throw new Error('chat_image_too_large');
  }
  const base64 = await readFileBase64(file);
  return {
    kind: 'image',
    source,
    name: file.name.length === 0 ? 'pasted-image.png' : file.name,
    mediaType,
    sizeBytes: file.size,
    data: base64,
    previewUrl: URL.createObjectURL(file)
  };
}

export function isImageInputSupported(state: LoadedState): boolean {
  if (state.defaultModelId === null) {
    return false;
  }
  for (const provider of state.providers) {
    const model = provider.models.find((item) => item.id === state.defaultModelId);
    if (model !== undefined) {
      return model.supportsImages;
    }
  }
  return false;
}

export function toChatImageAttachments(attachments: readonly RendererImageAttachment[]): ChatImageAttachment[] {
  return attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment);
}

function resolveFileMediaType(file: File): ChatImageAttachmentMediaType | null {
  if (mediaTypes.has(file.type)) {
    return file.type as ChatImageAttachmentMediaType;
  }
  const name = file.name.toLowerCase();
  if (name.endsWith('.png')) {
    return 'image/png';
  }
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (name.endsWith('.webp')) {
    return 'image/webp';
  }
  return null;
}

async function readFileBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
```

- [ ] **Step 4: Run helper tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-image-attachments.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/renderer/chat/image-attachments.ts tests/renderer/chat-image-attachments.test.ts
git commit -m "feat: add renderer chat image helpers"
```

---

### Task 6: Main Chat Composer UI And Submit Payload

**Files:**
- Modify: `src/renderer/chat/task-run-payload.ts`
- Modify: `src/renderer/chat/chat-view.tsx`
- Modify: `src/renderer/chat/chat-composer.tsx`
- Modify: `tests/renderer/chat-composer.test.ts`
- Modify: `tests/renderer/features/chat-feature.test.tsx`

**Interfaces:**
- Consumes: `RendererImageAttachment`, `toChatImageAttachments()`, `isImageInputSupported()`.
- Produces: main chat submit payload includes `attachments?: ChatImageAttachment[]`.

- [ ] **Step 1: Write failing composer render test**

Add to `tests/renderer/chat-composer.test.ts`:

```ts
it('renders selected image attachments with remove controls', () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatComposer, {
      client: testClient,
      chatInput: '描述图片',
      onChatInputChange: () => {},
      selectedAttachments: [
        {
          kind: 'image',
          source: 'clipboard',
          name: 'chart.png',
          mediaType: 'image/png',
          sizeBytes: 123,
          data: 'AQID',
          previewUrl: null
        }
      ],
      onSelectedAttachmentsChange: () => {},
      activeComposerPopover: null,
      onActiveComposerPopoverChange: () => {},
      submitting: false,
      state: createLoadedState({}),
      updateLoadedState: () => {},
      onSubmit: async () => {}
    })
  );

  expect(html).toContain('data-testid="chat-image-attachment"');
  expect(html).toContain('chart.png');
  expect(html).toContain('data-testid="chat-image-remove"');
});
```

- [ ] **Step 2: Write failing submit payload test**

In `tests/renderer/features/chat-feature.test.tsx`, add a jsdom test that uses the existing paperclip flow:

```ts
it('submits image attachments with the chat input and clears them after success', async () => {
  const provider = createProvider();
  provider.models[0] = {
    ...provider.models[0]!,
    supportsImages: true
  };
  const submit = vi.fn().mockResolvedValue({ ok: true as const });
  const state = createLoadedState({
    providers: [provider],
    defaultModelId: provider.models[0]!.id
  });
  const client = createChatClient();
  vi.mocked(client.api.files.selectFromDialog).mockResolvedValue({
    ok: true,
    data: {
      filePaths: ['F:\\Code\\Roc\\chart.png']
    }
  });

  await act(async () => {
    root.render(
      <ChatFeature
        chatSelectionVersion={1}
        client={client}
        onSubmitChatTask={submit}
        selectedThreadId={null}
        state={state}
        updateLoadedState={() => {}}
      />
    );
  });

  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
  const attach = container.querySelector<HTMLButtonElement>('[data-testid="chat-attachment-trigger"]')!;
  await act(async () => {
    input.value = '描述图片';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await act(async () => {
    attach.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flushPromises();

  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="chat-task-submit"]')!.click();
  });

  expect(submit).toHaveBeenCalledWith({
    input: '描述图片',
    attachments: [
      expect.objectContaining({
        kind: 'image',
        source: 'file',
        name: 'chart.png',
        mediaType: 'image/png',
        path: 'F:\\Code\\Roc\\chart.png'
      })
    ]
  });
});
```

- [ ] **Step 3: Run renderer tests to verify failure**

Run:

```powershell
pnpm test -- tests/renderer/chat-composer.test.ts tests/renderer/features/chat-feature.test.tsx
```

Expected: FAIL because composer props still use `string[]` and submit payload has no `attachments`.

- [ ] **Step 4: Extend submit payload**

Modify `src/renderer/chat/task-run-payload.ts`:

```ts
import type { ChatImageAttachment, WorkflowHint } from '../../shared/types';

export type ChatTaskSubmitPayload = {
  input: string;
  attachments?: ChatImageAttachment[];
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
  workspacePath?: string | null;
};
```

- [ ] **Step 5: Update `ChatView` state and submit**

Modify `src/renderer/chat/chat-view.tsx` imports:

```ts
import type { RendererImageAttachment } from './image-attachments';
import { isImageInputSupported, toChatImageAttachments } from './image-attachments';
```

State:

```ts
const [selectedAttachments, setSelectedAttachments] = useState<RendererImageAttachment[]>([]);
```

Before submit:

```ts
const imageInputSupported = isImageInputSupported(state);
const sendDisabled =
  submitting ||
  trimmedInput.length === 0 ||
  state.agent.execution !== 'ready' ||
  (selectedAttachments.length > 0 && !imageInputSupported);
```

Submit payload:

```ts
const attachments = toChatImageAttachments(selectedAttachments);
const result = await onSubmitChatTask({
  input: trimmedInput,
  ...(attachments.length === 0 ? {} : { attachments })
});
```

Clear after success:

```ts
selectedAttachments.forEach((attachment) => {
  if (attachment.previewUrl !== null) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
});
setSelectedAttachments([]);
```

Reset effect should also revoke object URLs before clearing. Add a helper:

```ts
function revokeAttachmentPreviewUrls(attachments: readonly RendererImageAttachment[]): void {
  attachments.forEach((attachment) => {
    if (attachment.previewUrl !== null) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  });
}
```

Pass `imageInputSupported` into `ChatComposer`.

- [ ] **Step 6: Update `ChatComposer` props and UI**

Modify `src/renderer/chat/chat-composer.tsx`:

```ts
import type { RendererImageAttachment } from './image-attachments';
import { createFileImageAttachment, validateImageAttachmentSelection } from './image-attachments';
```

Props:

```ts
selectedAttachments: RendererImageAttachment[];
onSelectedAttachmentsChange: (attachments: RendererImageAttachment[]) => void;
imageInputSupported: boolean;
```

Add local error state if not already present:

```ts
const [attachmentError, setAttachmentError] = useState<string | null>(null);
```

Use a copy helper:

```ts
function imageAttachmentErrorCopy(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'chat_image_too_many') {
    return '每条消息最多添加 4 张图片。';
  }
  if (message === 'chat_image_too_large') {
    return '单张图片不能超过 5 MB。';
  }
  if (message === 'chat_image_unsupported_type') {
    return '仅支持 PNG、JPG、JPEG、WEBP 图片。';
  }
  if (message === 'chat_model_images_unsupported') {
    return '当前默认模型不支持图片输入。';
  }
  return '图片添加失败。';
}
```

Render strip:

```tsx
{selectedAttachments.length === 0 ? null : (
  <div className="chat-attachment-strip">
    {selectedAttachments.map((attachment) => (
      <span className="chat-attachment-pill" data-testid="chat-image-attachment" key={`${attachment.name}-${attachment.sizeBytes}`}>
        {attachment.previewUrl === null ? <PaperclipIcon /> : <img alt="" className="chat-attachment-thumb" src={attachment.previewUrl} />}
        <span>{attachment.name}</span>
        <small>{Math.ceil(attachment.sizeBytes / 1024)} KB</small>
        <button
          aria-label={`移除 ${attachment.name}`}
          data-testid="chat-image-remove"
          type="button"
          onClick={() => removeAttachment(attachment)}
        >
          ×
        </button>
      </span>
    ))}
  </div>
)}
```

Implement remove:

```ts
function removeAttachment(target: RendererImageAttachment): void {
  if (target.previewUrl !== null) {
    URL.revokeObjectURL(target.previewUrl);
  }
  onSelectedAttachmentsChange(selectedAttachments.filter((attachment) => attachment !== target));
}
```

File dialog remains native path-based for selected files:

```ts
const nextAttachments = selection.data.filePaths.map((path) => ({
  kind: 'image' as const,
  source: 'file' as const,
  name: path.split(/[/\\]/).at(-1) ?? path,
  mediaType: mediaTypeFromPath(path),
  sizeBytes: 1,
  path,
  previewUrl: null
}));
```

Add `mediaTypeFromPath(path)` and reject unsupported extension. If byte size is not available in renderer for native paths, leave size as `1` and rely on main validation for true size; UI copy should not show KB for path-only entries unless size is known.

Paste/drop uses `createFileImageAttachment(file, 'clipboard' | 'drop')`.

Send disabled:

```ts
const sendDisabled =
  submitting ||
  trimmedInput.length === 0 ||
  state.agent.execution !== 'ready' ||
  (selectedAttachments.length > 0 && !imageInputSupported);
```

If submit clicked while images exist and `imageInputSupported` is false, set `attachmentError` to `chat_model_images_unsupported` copy and return.

- [ ] **Step 7: Run renderer tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-composer.test.ts tests/renderer/features/chat-feature.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add src/renderer/chat/task-run-payload.ts src/renderer/chat/chat-view.tsx src/renderer/chat/chat-composer.tsx tests/renderer/chat-composer.test.ts tests/renderer/features/chat-feature.test.tsx
git commit -m "feat: submit images from chat composer"
```

---

### Task 7: Transcript Attachment Metadata

**Files:**
- Modify: `src/renderer/chat-transcript.ts`
- Modify: transcript panel module under `src/renderer/chat/`
- Modify: `tests/renderer/chat-transcript.test.ts`
- Modify: transcript panel renderer test file if present

**Interfaces:**
- Consumes: persisted `attachments: ChatPersistedAttachment[]` on user message events.
- Produces: `ChatTranscriptMessage.attachments: ChatPersistedAttachment[]`.

- [ ] **Step 1: Write failing transcript model test**

In `tests/renderer/chat-transcript.test.ts`, add:

```ts
it('projects persisted user image attachment metadata into transcript messages', () => {
  const messages = buildPersistedTranscriptMessages([
    {
      id: 'event-1',
      threadId: 'thread-1',
      runId: 'run-1',
      type: 'message',
      payload: {
        role: 'user',
        content: '描述图片',
        attachments: [
          {
            kind: 'image',
            name: 'chart.png',
            mediaType: 'image/png',
            sizeBytes: 123
          }
        ]
      },
      createdAt: '2026-06-24T00:00:00.000Z'
    }
  ], 'thread-1');

  expect(messages[0]).toMatchObject({
    role: 'user',
    content: '描述图片',
    attachments: [
      {
        kind: 'image',
        name: 'chart.png',
        mediaType: 'image/png',
        sizeBytes: 123
      }
    ]
  });
});
```

- [ ] **Step 2: Run transcript test to verify failure**

Run:

```powershell
pnpm test -- tests/renderer/chat-transcript.test.ts
```

Expected: FAIL because `attachments` is not projected.

- [ ] **Step 3: Extend transcript types and payload guard**

Modify `src/renderer/chat-transcript.ts` imports:

```ts
ChatPersistedAttachment,
```

Extend `ChatTranscriptMessage`:

```ts
attachments: ChatPersistedAttachment[];
```

Extend `MessagePayload`:

```ts
attachments?: ChatPersistedAttachment[];
```

Add guard:

```ts
function isPersistedAttachment(value: unknown): value is ChatPersistedAttachment {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const kind = Reflect.get(value, 'kind');
  const name = Reflect.get(value, 'name');
  const mediaType = Reflect.get(value, 'mediaType');
  const sizeBytes = Reflect.get(value, 'sizeBytes');
  return (
    kind === 'image' &&
    typeof name === 'string' &&
    (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp') &&
    typeof sizeBytes === 'number'
  );
}
```

Update `isMessagePayload`:

```ts
const attachments = Reflect.get(payload, 'attachments');
return (
  (role === 'user' || role === 'assistant') &&
  typeof content === 'string' &&
  (attachments === undefined || (Array.isArray(attachments) && attachments.every(isPersistedAttachment)))
);
```

Update `createUserMessage`:

```ts
attachments: event.payload.attachments === undefined ? [] : event.payload.attachments,
```

Add `attachments: []` to assistant drafts and all other message constructors.

- [ ] **Step 4: Render metadata in transcript panel**

Find transcript panel module:

```powershell
rg -n "ChatTranscriptPanel|chat-bubble|ChatTranscriptMessage" src\renderer
```

In the component that renders user message content, add:

```tsx
{message.attachments.length === 0 ? null : (
  <div className="chat-message-attachments" data-testid="chat-message-attachments">
    {message.attachments.map((attachment) => (
      <span className="chat-message-attachment" key={`${attachment.name}-${attachment.sizeBytes}`}>
        <span>{attachment.name}</span>
        <small>{Math.ceil(attachment.sizeBytes / 1024)} KB</small>
      </span>
    ))}
  </div>
)}
```

Keep styling compact and under existing chat CSS namespace.

- [ ] **Step 5: Run transcript tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-transcript.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/renderer/chat-transcript.ts tests/renderer/chat-transcript.test.ts
git add src/renderer/chat
git commit -m "feat: show chat image attachment metadata"
```

---

### Task 8: Focused Integration And IPC Checks

**Files:**
- Modify only files required by failed checks from Tasks 1-7.
- Test only.

**Interfaces:**
- Consumes: complete feature path.
- Produces: verified focused test set and TypeScript pass.

- [ ] **Step 1: Run focused feature tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-image-attachments.test.ts tests/renderer/chat-composer.test.ts tests/renderer/features/chat-feature.test.tsx tests/renderer/chat-transcript.test.ts tests/main/plugins/agent/chat-image-attachments.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/runtime-executor.test.ts tests/main/plugins/agent/session-repository.test.ts tests/shared/provider-config.test.ts tests/main/config-service-helpers.test.ts tests/renderer/settings-model.test.ts
```

Expected: PASS.

- [ ] **Step 2: Fix direct failures only**

If a test fails, inspect the failing file and fix only the failing contract. Examples:

```powershell
pnpm test -- tests/main/plugins/agent/chat-image-attachments.test.ts
```

Expected after fix: PASS.

Do not broaden scope to task-detail image input, task creation image input, or image generation.

- [ ] **Step 3: Run IPC generation check**

Run:

```powershell
pnpm check:ipc
```

Expected: PASS.

If it fails because shared IPC generated files changed, run:

```powershell
pnpm generate:ipc
pnpm check:ipc
```

Expected after generation: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: no output.

- [ ] **Step 6: Commit verification fixes**

If Step 2 or Step 3 changed files, commit them:

```powershell
git add .
git commit -m "test: verify chat image input"
```

If no files changed, do not create an empty commit.

---

### Task 9: Manual Smoke Notes

**Files:**
- No tracked source file changes are expected by default.
- Optional update only if an existing manual smoke checklist file already covers chat composer behavior.

**Interfaces:**
- Consumes: built feature.
- Produces: short manual smoke evidence for local desktop behavior.

- [ ] **Step 1: Start dev app only if visual/manual validation is requested**

Run:

```powershell
pnpm dev
```

Expected: Electron app starts.

- [ ] **Step 2: Manual checks**

Check these in the app:

- Select a PNG through the paperclip, enter text, send with a model marked `supportsImages: true`.
- Paste a PNG from clipboard, enter text, send with a model marked `supportsImages: true`.
- Drag a WEBP onto the composer, enter text, send with a model marked `supportsImages: true`.
- Try a GIF and verify the composer rejects it.
- Try five valid images and verify the composer rejects the fifth.
- Try a valid image with a model marked `supportsImages: false` and verify send is blocked.

- [ ] **Step 3: Stop dev app**

Close the Electron dev process with `Ctrl+C` in PowerShell.

- [ ] **Step 4: Record result in final response**

Do not create a source commit for manual smoke notes unless a tracked manual checklist was intentionally updated.

---

## Final Verification

Run:

```powershell
pnpm test -- tests/renderer/chat-image-attachments.test.ts tests/renderer/chat-composer.test.ts tests/renderer/features/chat-feature.test.tsx tests/renderer/chat-transcript.test.ts tests/main/plugins/agent/chat-image-attachments.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/runtime-executor.test.ts tests/main/plugins/agent/session-repository.test.ts tests/shared/provider-config.test.ts tests/main/config-service-helpers.test.ts tests/renderer/settings-model.test.ts
pnpm check:ipc
pnpm typecheck
git diff --check
```

Expected:

- All focused tests pass.
- IPC check passes.
- TypeScript passes.
- `git diff --check` prints no output.

If settings schema or IPC generated output changed, include those generated files in the relevant commit and state the generation command in the final evidence.

## Self-Review

Spec coverage:

- Image input only: Tasks 1-8.
- Main chat input only: Task 6.
- Selection, paste, drag-and-drop: Tasks 5-6.
- `png`, `jpg`, `jpeg`, `webp`: Tasks 2 and 5.
- 4 image limit and 5 MB limit: Tasks 2 and 5.
- Model support blocking: Tasks 1, 5, and 6.
- DeepAgents multimodal `HumanMessage`: Task 4.
- No base64 in history: Tasks 3 and 7.
- Focused verification: Task 8.

Placeholder scan:

- No `TBD`.
- No `TODO`.
- No deferred implementation marker.

Type consistency:

- Renderer submits `ChatImageAttachment[]`.
- Main validates into `ChatValidatedImageAttachment[]`.
- Repository persists `ChatPersistedAttachment[]`.
- DeepAgents receives `ChatValidatedImageAttachment[]` and emits LangChain content blocks.
