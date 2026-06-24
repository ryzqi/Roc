# Chat Image Input Design

## Goal

Add image input support to the main chat composer so a user can attach images and ask the default model to inspect them.

The implementation must pass images into DeepAgents as true multimodal user message content. It must not degrade images into text paths or rely on file tools to infer what the user intended.

## Confirmed Decisions

- Support image input, not assistant image output.
- Scope this to the main chat input only.
- Support three input methods: local file selection, clipboard paste, and drag-and-drop.
- Allow `png`, `jpg`, `jpeg`, and `webp`.
- Allow at most 4 images per message.
- Allow at most 5 MB per image.
- Block send when any selected image is unsupported or over the limit.
- Block send when the selected default model does not support image input.
- Use a structured attachment contract instead of appending file paths to `input`.

## Current State

The renderer already has a paperclip action in `ChatComposer`. It can open the native file picker, store `selectedAttachments: string[]`, and render attachment pills.

The current submit path drops those attachments:

- `ChatView.submitCurrentInput()` sends only `{ input: trimmedInput }`.
- `ChatTaskSubmitPayload` has only `input`, `workflowHint`, `taskSource`, and `workspacePath`.
- `ChatStartRunRequest` has only text `input` plus run metadata.
- `AgentPluginRuntime.startRun()` trims `request.input` and stores that text as `userInput`.
- `createInitialState()` in `deep-agent-executor.ts` creates `new HumanMessage(input)`.

The repository has image preview helpers for workspace files, but chat image input does not yet reuse them.

## External Contract

DeepAgents JS accepts LangGraph-style initial state with a `messages` array:

```ts
await agent.invoke({
  messages: [{ role: 'user', content: 'What is in this image?' }]
});
```

Roc currently wraps the message as a LangChain `HumanMessage`, which is still the right boundary.

LangChain JS supports multimodal message content by passing an array of content blocks to `HumanMessage`. The installed `@langchain/core@1.2.1` type definition makes `MessageContent` equal to `string | Array<ContentBlock>`, and defines `ContentBlock.Multimodal.Image` as:

```ts
{
  type: 'image',
  mimeType: 'image/png',
  data: base64
}
```

Older `image_url`, `source_type`, and `mime_type` shapes appear in some integration examples, but the installed local types mark those data content blocks as deprecated and point to `ContentBlock.Multimodal.Data`. Roc should use the current local `ContentBlock` shape.

Sources checked:

- DeepAgents JS docs for `createDeepAgent` invocation state.
- LangChain JS messages docs for image input through `HumanMessage`.
- Local package types in `node_modules/@langchain/core/dist/messages/content/multimodal.d.ts`.

## Non-Goals

- Do not add image support to task detail input in this change.
- Do not add image support to the task creation dialog in this change.
- Do not add assistant image generation or assistant image display as a generated artifact.
- Do not silently compress, resize, or transcode images.
- Do not store base64 image data in task events or transcript history.
- Do not add a fallback that sends image paths as text when the model lacks image support.
- Do not infer model image support from provider name alone at send time.

## Data Contract

Add a shared chat attachment type:

```ts
export type ChatImageAttachment = {
  kind: 'image';
  source: 'file' | 'clipboard' | 'drop';
  name: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  sizeBytes: number;
  path?: string;
  data?: string;
};
```

Rules:

- File selection and file drag should use `path`.
- Clipboard images may use `data` when the clipboard item has no stable filesystem path.
- `data` is raw base64, not a `data:image/...;base64,...` URL.
- Exactly one of `path` or `data` must be present.
- Renderer may prefill metadata for UI, but main must validate format, size, and readable content again before invoking DeepAgents.

Extend `ChatTaskSubmitPayload` and `ChatStartRunRequest` with:

```ts
attachments?: ChatImageAttachment[];
```

The default absence of `attachments` means a text-only run. An empty array should be normalized to absence before crossing into runtime execution.

## Renderer Behavior

`ChatComposer` becomes the main UI owner for image selection, paste, and drop.

File selection:

- Native file dialog should filter to image extensions.
- Selected images replace the current attachment list, matching the existing picker behavior.
- If more than 4 files are selected, reject the selection and show a composer error.

Paste:

- Pasted image clipboard items append to the current attachment list until the 4 image limit.
- Unsupported clipboard items are ignored unless the paste contains only unsupported images, in which case show an error.

Drag-and-drop:

- Dropping image files onto the composer appends them until the 4 image limit.
- Drag hover should visually mark the composer drop target.
- Dropping unsupported files should show an error and leave existing attachments unchanged.

Display:

- Show each image as a compact attachment item with filename or source label, size, and remove control.
- Use object URLs for preview thumbnails only in renderer state, and revoke them when removed or reset.
- Clear image attachments after a successful send and when starting/selecting another conversation.

Send gating:

- Text is still required. Image-only messages are out of scope.
- Disable or block submit when the default model does not support image input.
- Show a direct error when image count, type, size, or model support fails.

## Model Capability

Add `supportsImages: boolean` to model capability metadata.

Existing model metadata already has `supportsStreaming` and `supportsToolCalls`. `supportsImages` should follow the same persistence and settings flow:

- Shared settings type.
- Config schema and migration/default handling.
- Settings UI model capability editing if the current UI exposes comparable model capability toggles.
- Provider defaults for known bundled/default model definitions only where Roc can state support explicitly.

Send-time behavior should read the selected default model metadata. If the metadata says `supportsImages: false`, the composer blocks send. If model metadata is missing or the default model cannot be resolved, fail explicitly with the same “image input unsupported” class of error.

## Main Process Validation

Before DeepAgents execution:

1. Validate attachment count is at most 4.
2. Validate every attachment has `kind: 'image'`.
3. Validate `mediaType` is one of `image/png`, `image/jpeg`, or `image/webp`.
4. Validate exactly one of `path` or `data` is present.
5. For `path`, read the file, validate extension/media type and byte size, then base64 encode.
6. For `data`, decode base64 enough to validate byte size.
7. Reject empty image data.

This validation belongs in main, close to the agent runtime or a small chat attachment helper under the main agent boundary. Renderer validation is only UX.

## DeepAgents Message Construction

Replace the current text-only `createInitialState(input: string)` with an initial-state builder that receives text and validated image inputs.

Text-only runs should keep the simple path:

```ts
messages: [new HumanMessage(input)]
```

Runs with images should use:

```ts
messages: [
  new HumanMessage({
    content: [
      { type: 'text', text: input },
      {
        type: 'image',
        mimeType: image.mediaType,
        data: image.base64
      }
    ]
  })
]
```

Keep `forge_error_tracker: defaultErrorTracker()` unchanged.

## Persistence And Transcript

Persist user message text as today so history search and transcript text remain small and stable.

Persist lightweight attachment metadata with the user message event:

```ts
attachments: [
  {
    kind: 'image',
    name: 'diagram.png',
    mediaType: 'image/png',
    sizeBytes: 12345
  }
]
```

Do not persist path for clipboard images. Do not persist base64 image content. If path persistence is needed for selected local files, it must be metadata only and should not be treated as a durable image source after the run.

Transcript rendering should show that a user message included images, using the persisted metadata. It does not need to rehydrate image bytes from history.

## Error Handling

Use explicit validation errors:

- `chat_image_too_many`
- `chat_image_unsupported_type`
- `chat_image_too_large`
- `chat_image_empty`
- `chat_image_unreadable`
- `chat_model_images_unsupported`

Renderer copy can be concise Simplified Chinese. Main errors should preserve machine-readable codes where existing Roc error handling supports them.

Do not catch and swallow validation failures in business logic. Boundary layers may convert thrown errors to IPC results as they already do.

## Testing

Focused tests:

- Renderer composer accepts file selection, paste, and drop.
- Renderer composer rejects unsupported type, too many images, and oversized images.
- Renderer submit includes attachments and clears them after a successful send.
- Renderer blocks image send when the default model does not support images.
- Shared chat request type accepts image attachments.
- Main validation rejects invalid image attachments.
- DeepAgent initial-state builder emits `HumanMessage` text content for text-only runs.
- DeepAgent initial-state builder emits `HumanMessage` content blocks for image runs.
- Runtime passes validated attachments into the executor without storing base64 in task events.

Verification commands:

```powershell
pnpm test -- tests/renderer/chat-composer.test.ts tests/renderer/features/chat-feature.test.tsx tests/main/plugins/agent/deep-agent-executor.test.ts
pnpm typecheck
git diff --check
```

Broader tests may be needed if settings schema migrations or provider defaults change more than the focused path.

## Acceptance Criteria

- Main chat input supports file selection, paste, and drag-and-drop for `png`, `jpg`, `jpeg`, and `webp`.
- A message can include text plus up to 4 valid images.
- A single image over 5 MB is rejected before the run starts.
- Unsupported formats are rejected before the run starts.
- A default model without `supportsImages` blocks send before the run starts.
- A supported image run passes a LangChain `HumanMessage` with `content` blocks containing one text block and image blocks shaped as `{ type: 'image', mimeType, data }`.
- Text-only chat behavior remains unchanged.
- History does not store image base64.
