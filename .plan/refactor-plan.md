# Deep Agents 官方对齐审计与重构计划

## Current State

- 状态：`Located`。本文件只记录资料归档、实现对照、重构计划；源码和测试改动属于后续实现阶段，不属于本次计划完善范围。
- 官方资料：12 个请求页面已保存到 `.plan/docs/`，`manifest.json` 记录每页 URL、HTTP status、字节数和行数。
- 代码库版本事实：`package.json` 使用 `deepagents@1.10.2`、`@langchain/langgraph@1.3.2`、`@langchain/langgraph-checkpoint-sqlite`。
- 当前装配入口：`src/main/services/deep-agent/agent-builder.ts` 调用 `createDeepAgent`；`src/main/services/deep-agent/session.ts` 负责每轮 runtime 参数。
- 当前核心风险：Roc 基本使用官方 Deep Agents，但在 backend/execute/permissions/memory/stream 映射上保留了多处自定义层，需要明确哪些是必要本地集成，哪些应回到官方契约。

## Blocking Alignment Defects

这两项不是“后续优化”，而是当前实现与安装版 `deepagents@1.10.2` 的阻断级契约偏差。任何后续 permissions、subagents、streaming 或 UI 能力声明都必须先建立在它们修复和验证之后。

| Priority | Defect | Current evidence | Official / installed contract | Required proof |
| --- | --- | --- | --- | --- |
| P0 | `execute` 很可能没有成为模型可用工具 | `src/main/services/deep-agent/backend.ts:175-177` 给 `CompositeBackend` 手工挂 `execute`；默认 backend 是 `StateBackend`，`CompositeBackend.id` 为空；直接 probe 显示 `isSandboxBackend === false` 且 `adaptBackendProtocol()` 丢弃 `execute`。 | `.plan/docs/backends.md` 说明 `execute` 由 sandbox 或 `LocalShellBackend` 提供；`node_modules/deepagents/dist/index.js:1756-1761` 要求 resolved backend 满足 `isSandboxBackend()`，即有 `execute` 且 `id` 为非空字符串。 | 用真实 `createFilesystemMiddleware` 或真实 `createDeepAgent` 验证工具清单包含可调用 `execute`，调用后进入 Roc 的 task-bound shell audit。 |
| P0 | 选中 skill 可能完全不会被 `SkillsMiddleware` 发现 | `src/main/services/deep-agent/session.ts:65` 把每个选中项传成 `/skills/<id>/`；probe 显示该目录下只有 `SKILL.md` 文件，middleware 会跳过文件并尝试 child skill lookup。 | `.plan/docs/skills.md` 的 skill source 是包含多个 skill 子目录的目录；`node_modules/deepagents/dist/index.js:3016-3051` 先 `ls(source)`，只保留目录，再读 `<source>/<child>/SKILL.md`。 | 用真实 `createSkillsMiddleware` 或真实 `createDeepAgent` 验证 `skills: ['/skills/']` 能加载选中 skill frontmatter，且未选中 skill 不出现在 `skillsMetadata`。 |

## Archived Official Pages

| Topic | Saved file |
| --- | --- |
| context engineering | `.plan/docs/context-engineering.md` |
| backends | `.plan/docs/backends.md` |
| subagents | `.plan/docs/subagents.md` |
| async subagents | `.plan/docs/async-subagents.md` |
| human in the loop | `.plan/docs/human-in-the-loop.md` |
| permissions | `.plan/docs/permissions.md` |
| memory | `.plan/docs/memory.md` |
| skills | `.plan/docs/skills.md` |
| sandboxes | `.plan/docs/sandboxes.md` |
| interpreters | `.plan/docs/interpreters.md` |
| event streaming | `.plan/docs/event-streaming.md` |
| streaming | `.plan/docs/streaming.md` |

## Implementation Map

| Area | Current Roc files | Current shape |
| --- | --- | --- |
| Agent creation | `src/main/services/deep-agent/agent-builder.ts:21` | Thin wrapper over `createDeepAgent`. Passes official option names: `model`, `systemPrompt`, `backend`, `store`, `memory`, `skills`, `subagents`, `tools`, `interruptOn`, `checkpointer`. |
| Session config | `src/main/services/deep-agent/session.ts:47`, `:65`, `:69` | Computes `interruptOn`, selected skill paths, custom subagents, backend, memory, tools. |
| Backend routing | `src/main/services/deep-agent/backend.ts:141`, `:156`, `:175` | `StateBackend` default plus `CompositeBackend` routes for `/skills/`, `/agents/`, `/memory/`, `/workspace/`; custom read-only wrappers; manual `execute`. |
| Memory store | `src/main/services/deep-agent/sqlite-store.ts:129` | Custom `BaseStore` implementation backed by Roc SQLite table `langgraph_store_items`. |
| Skills | `src/main/services/deep-agent/session.ts:65` | Selected skill IDs become one source per skill: `/skills/${skillId}/`. |
| Skill import/storage | `src/main/services/skill-service.ts:53`, `:66`, `:79`, `:238` | Uses official `parseSkillMetadata()` and `listSkills()` to validate imported `SKILL.md`, derives ID from frontmatter `name`, stores under `paths.skillsDir`, and exposes only Roc snapshot fields (`id`, `name`, `description`, `enabled`, `status`, `lastError`). |
| Subagents | `src/main/services/deep-agent/tools.ts:101` | Always adds `code-review` and `research` synchronous custom subagents. |
| HITL | `src/main/services/agent-service.ts:296`; `src/main/services/deep-agent-runtime-service.ts:175` | Uses Deep Agents `interruptOn`, LangGraph `Command`, `MemorySaver`/`SqliteSaver`; Roc keeps pending approval map and task records. |
| Permissions | `src/main/services/agent-service.ts:296`; `src/main/services/deep-agent/backend.ts:37` | Roc settings currently mean approval mode. Deep Agents `permissions` option is not passed; read-only behavior is done by backend wrappers. |
| Sandbox / execute | `src/main/services/deep-agent/backend.ts:32`, `:176` | `CompositeBackend` is cast to `SandboxBackendProtocolV2`; `execute` forwards to Roc shell execution service. No official `LocalShellBackend` and no provider sandbox. |
| Streaming | `src/main/services/deep-agent-runtime-service.ts:340`, `:533`; `src/main/services/deep-agent/stream-consumers.ts:47`, `:110`, `:174` | Uses `streamEvents({ version: "v3" })`; consumes `messages`, `toolCalls`, `subagents` projections concurrently and maps them to Roc IPC events. |

## Page-By-Page Analysis

### 1. context-engineering

Official source: `.plan/docs/context-engineering.md`.

Official points:
- Input context consists of system prompt, memory, skills, and built-in tool prompts.
- `systemPrompt` is static; context-dependent instructions should use dynamic prompt middleware.
- Memory is always injected; skills use progressive disclosure.
- Deep Agents handles large context through automatic offloading and summarization.
- Subagents isolate large intermediate work.
- Long-term memory normally uses `CompositeBackend` plus `StoreBackend` under a route such as `/memories/`.

Roc alignment:
- `buildDeepAgent` passes official `systemPrompt`, `memory`, `skills`, `backend`, `store`, and `subagents`.
- `session.ts:77` keeps always-loaded memory small: only `/agents/AGENTS.md`.
- `tools.ts:107` and `tools.ts:115` add synchronous subagents for context isolation.
- `backend.ts:156` uses `CompositeBackend` with `StoreBackend` for durable readable memory.

Gaps / repeated work:
- Dynamic run context is embedded into the prompt string in `prompt.ts:17-21`. This is acceptable because Roc rebuilds the agent per run, but it is not the official dynamic prompt middleware shape.
- Roc does not explicitly configure or test Deep Agents summarization behavior. If summarization emits tokens, current stream mapping does not filter `metadata.lcSource === "summarization"`.
- Roc uses `/memory/`, while docs use `/memories/` for writable long-term memory. Singular route can be valid, but it diverges from official examples.
- `/memory/` is read-only, so Roc currently does not support official hot-path memory learning via `edit_file`.

Refactor direction:
- Keep `buildDeepAgent` thin.
- Decide whether Roc memory is intentionally read-only curated memory or should support writable long-term memory.
- If writable memory is desired, add separate `/memories/` rather than changing `/memory/` semantics.
- Add streaming tests for summarization-token filtering only if real runs show summarization deltas entering user-visible output.

### 2. backends

Official source: `.plan/docs/backends.md`.

Official points:
- Filesystem tools use pluggable backends.
- Built-ins include `StateBackend`, `FilesystemBackend`, `LocalShellBackend`, `StoreBackend`, `ContextHubBackend`, `CompositeBackend`, and sandbox backends.
- `LocalShellBackend` exposes host shell and requires safeguards.
- `CompositeBackend` routes by prefix.
- `permissions` handles declarative path allow/deny before backend calls.
- Policy hooks/wrappers are allowed for custom validation beyond simple path rules.
- Direct backend instances are preferred over deprecated backend factories.

Roc alignment:
- Uses direct instances: `new StateBackend`, `new FilesystemBackend`, `new StoreBackend`, `new CompositeBackend`.
- Uses `virtualMode: true` for skills/agents/workspace filesystem routes in `backend.ts:147-153` and `backend.ts:169-172`.
- Uses `CompositeBackend` routes in `backend.ts:156-175`.
- Uses wrappers as policy hooks for read-only `/skills/`, `/agents/`, and `/memory/`; this is allowed by official docs when custom logic is needed.

Gaps / repeated work:
- `RocCompositeBackend` is cast to `SandboxBackendProtocolV2` and receives a manually attached `execute` in `backend.ts:32-34` and `backend.ts:176-177`. Official docs say `execute` comes from a sandbox backend or `LocalShellBackend`.
- The cast does not expose a visible `id`, while official `SandboxBackendProtocolV2` includes `execute` plus `id`.
- Read-only wrappers duplicate protocol methods and require ongoing protocol tracking.
- Unknown paths fall through to default `StateBackend`; tests currently allow writes that succeed virtually but do not land on disk. That can produce false success for wrong route usage.

Refactor direction:
- Replace manual `execute` graft with one explicit official-aligned path:
  - use `LocalShellBackend` if host shell execution is intentionally allowed, or
  - implement a complete `RocShellBackend` with official protocol shape, including `id`, and call it host execution rather than sandbox.
- Make unknown write paths fail explicitly unless there is a clear scratch-file requirement.
- Keep wrappers only where they carry custom policy/audit; otherwise prefer official `permissions` for simple path read/write rules.

### 3. subagents

Official source: `.plan/docs/subagents.md`.

Official points:
- Synchronous subagents are passed through `subagents` and invoked by `task`.
- Deep Agents auto-adds a `general-purpose` subagent unless replaced or disabled.
- Custom subagents need `name`, `description`, `systemPrompt`; custom `tools` override inherited tools.
- Custom subagents do not inherit main skills; `general-purpose` does.
- `responseFormat` is available for structured subagent output.

Roc alignment:
- `tools.ts:107-122` defines dictionary-style custom subagents.
- Descriptions and prompts are explicit.
- `research` gets a minimal `web_read` tool; `code-review` gets `tools: []`.
- `stream-consumers.ts:174-225` consumes `stream.subagents`.

Gaps / repeated work:
- Roc always creates `code-review` and `research`; default `general-purpose` likely still exists unless library suppression applies. This needs a trace/test, not an assumption.
- `code-review` uses `tools: []`. If Deep Agents treats this as overriding inherited custom tools only, built-in filesystem may still work; if not, the prompt saying it can read `/memory/` is misleading. Add test.
- No `responseFormat`; acceptable for chat UI, weaker for programmatic task routing.
- No per-subagent `permissions` or `interruptOn`.

Refactor direction:
- Add a test asserting exact subagent specs and default `general-purpose` presence/absence.
- Decide whether `general-purpose` should exist. If not, disable/override via official profile path, not middleware removal.
- Keep custom subagent tools minimal.
- Pass selected skills to custom subagents only when the product behavior requires it.
- If Roc later adopts `contextSchema`, add a contract test proving runtime context propagates unchanged into `general-purpose` and custom subagents.

### 4. async-subagents

Official source: `.plan/docs/async-subagents.md`.

Official points:
- Async subagents are preview in `deepagents>=1.9.0`.
- They return a task ID immediately and continue in the background.
- Official tools include `start_async_task`, `check_async_task`, `update_async_task`, `cancel_async_task`, and `list_async_tasks`.
- Task metadata lives in `asyncTasks`, separate from message history.
- Transport can be co-deployed or remote Agent Protocol.

Roc alignment:
- No current async subagent implementation found.
- Roc has its own `TaskService`, but it is app run persistence, not Deep Agents async subagent middleware.

Gaps / repeated work:
- If Roc later builds background research/coding with `TaskService` only, it would duplicate official async subagent lifecycle.
- Existing thread/run storage is useful for UI, but should not replace `asyncTasks` if official async subagents are adopted.

Refactor direction:
- Do not implement async subagents until a real non-blocking subagent requirement exists.
- If needed, use official `AsyncSubAgent` specs and map official task IDs into Roc UI.
- Add system prompt guardrails to prevent immediate polling loops if async subagents are enabled.

### 5. human-in-the-loop

Official source: `.plan/docs/human-in-the-loop.md`.

Official points:
- `interruptOn` configures approvals.
- A checkpointer is required.
- Resume uses `new Command({ resume: { decisions } })` with the same `thread_id`.
- Decisions can approve, edit, reject, and in some paths respond.
- Multiple tool calls require ordered decisions.
- Subagents can override interrupts.

Roc alignment:
- `agent-service.ts:296-310` builds `interruptOn`.
- `deep-agent-runtime-service.ts:79-91` uses `MemorySaver` in tests and `SqliteSaver` in app runtime.
- `session.ts:82` passes checkpointer for task runs.
- `deep-agent-runtime-service.ts:391` resumes through `new Command({ resume })`.
- `deep-agent-runtime-service.ts:186-193` validates same `threadId`.
- `deep-agent-runtime-service.ts:615-634` stores pending approvals and emits `run_interrupted`.

Gaps / repeated work:
- Chat mode passes no checkpointer. This is fine only while chat mode never enables interrupts.
- `resumeRun` accepts one `decision` and wraps it into `decisions: [request.decision]`; official multiple-action interrupts are not represented.
- `DELETE_FILE_ALLOWED_DECISIONS` excludes `respond`; official HITL allows it by default, so this should be documented as an intentional product decision and verified.
- No subagent-specific interrupt policy.

Refactor direction:
- Keep official `interruptOn` and `Command` path.
- Add tests for multiple `actionRequests`; either support ordered decisions or reject multi-action interrupts explicitly.
- Add tests for the `respond` branch: either support it intentionally for selected tools or reject it with a deterministic product error.
- If chat mode gets any interrupting tool, pass checkpointer for chat runs too.

### 6. permissions

Official source: `.plan/docs/permissions.md`.

Official points:
- `permissions` declaratively controls built-in filesystem read/write.
- First matching rule wins; default is allow.
- Permissions do not control custom tools, MCP tools, or sandbox `execute`.
- Subagents inherit parent permissions unless replaced.
- Composite plus sandbox requires route-scoped rules.

Roc alignment:
- Roc currently does not pass Deep Agents `permissions`; tests assert `permissions` is undefined.
- Roc settings permissions drive approval mode and `interruptOn`, not path access.
- Read-only behavior is implemented by backend wrappers.

Gaps / repeated work:
- Naming collision: Roc `permissions` means approval settings; official `permissions` means filesystem path rules.
- Read-only wrappers duplicate simple official path deny rules.
- Official permissions cannot secure `execute`; this is especially important because Roc exposes host shell execution.

Refactor direction:
- Separate naming: `approvalMode` for Roc HITL settings, `filesystemPermissions` for official Deep Agents path rules.
- Introduce official `permissions` only after `execute` backend semantics are clarified.
- Keep wrappers only for behavior official permissions cannot express.

### 7. memory

Official source: `.plan/docs/memory.md`.

Official points:
- Memory paths are passed through `memory`.
- Scope comes from `StoreBackend.namespace`, often `assistantId` or user identity.
- Writable memory uses file tools; read-only memory should use `permissions` or policy hooks.
- Background consolidation is optional.
- Concurrent writes can conflict.

Roc alignment:
- `session.ts:77` passes `memorySources: ['/agents/AGENTS.md']`.
- `backend.ts:155-164` routes `/memory/` to `StoreBackend`.
- `sqlite-store.ts:38-45` scopes durable memory by workspace path hash.
- `sqlite-store.ts:129-272` implements a custom SQLite `BaseStore`.
- `/memory/` is read-only via `ReadOnlyStoreBackend`.

Gaps / repeated work:
- Workspace-scoped memory is correct for a local workspace assistant, but differs from official user/assistant examples.
- `/agents/AGENTS.md` is mounted from Roc memory dir, not necessarily the repository AGENTS file unless app code has synced it.
- Custom `SqliteLangGraphStore` is legitimate local integration but must track LangGraph store operation changes.
- No writable memory and no background consolidation.

Refactor direction:
- Decide and document: `/memory/` is read-only curated memory.
- Add separate `/memories/` only if learning/writable memory becomes a requirement.
- Add conformance tests for `SqliteLangGraphStore`: get, put, delete, search, filters, query, namespace listing.

### 8. skills

Official source: `.plan/docs/skills.md`.

Official points:
- Skills are directories with `SKILL.md`.
- Agent reads frontmatter at startup, then full skill content only when relevant.
- Skill source paths are virtual POSIX paths.
- Later sources override earlier sources with the same skill name.
- General-purpose subagent inherits main skills; custom subagents require explicit `skills`.
- Interpreter skills need QuickJS middleware; script execution needs sandbox.

Roc alignment:
- `session.ts:65` passes selected skill virtual paths.
- `backend.ts:147-150` mounts `/skills/` from `paths.skillsDir` with `virtualMode: true`.
- `backend.ts:157` makes `/skills/` read-only.
- `prompt.ts:9` tells the model not to reveal `SKILL.md` content to the user.
- `skill-service.ts:79` uses official `parseSkillMetadata()` on import, and `skill-service.ts:238` uses official `listSkills()` to validate the canonical user skill library.

Gaps / repeated work:
- Roc passes one source per selected skill (`/skills/<id>/`) instead of a `/skills/` root. Installed `createSkillsMiddleware` treats each source as a directory that contains skill subdirectories, so the current source shape can load zero skills rather than merely losing precedence/layering.
- The local `SkillService` stores and lists valid skills, but its `SkillSnapshot` intentionally drops official metadata fields such as `allowed-tools`, `module`, `license`, `compatibility`, and `metadata`. That is acceptable only if Roc treats those fields as runtime-internal rather than user-visible or policy-driving.
- Interpreter skills declare `module` in frontmatter, but Roc has no interpreter middleware or module import bridge. Such skills can still be imported as regular instruction skills, but module execution must not be implied in UI.
- `allowed-tools` is parsed by official metadata but is not enforced by Roc's custom tools/MCP/UI layer. If shown to users later, it must be described as skill author guidance unless a real enforcement path is added.
- Custom subagents get empty skill arrays by default, so selected main skills do not reach `code-review` or `research`.
- No interpreter skills or sandbox script execution.

Refactor direction:
- Re-evaluate selected skill filtering:
  - required default: pass `skills: ['/skills/']` and filter the `/skills/` backend projection to selected IDs;
  - only keep per-skill source paths if Roc implements and tests a custom source adapter that makes `/skills/<id>/` behave like a source root.
- Add tests for selected and unselected skill discovery.
- Decide whether selected skills should be passed explicitly to custom subagents.
- Add a `SkillService` metadata policy decision:
  - if UI needs only name/description/status, keep snapshots narrow and add tests proving unknown official frontmatter fields do not break import;
  - if policy/runtime needs `allowed-tools` or `module`, extend shared types deliberately and add enforcement or a visible "not enforced" boundary.

### 9. sandboxes

Official source: `.plan/docs/sandboxes.md`.

Official points:
- Sandboxes are backends that isolate filesystem and shell execution from host.
- Sandbox backends provide `execute` plus filesystem tools.
- `execute` is conditionally visible only when backend implements sandbox protocol.
- App-side file transfer uses `uploadFiles` and `downloadFiles`.
- Secrets stay outside sandbox; sandbox outputs are untrusted.

Roc alignment:
- Exposes `execute` through backend.
- `deep-agent-runtime-service.ts:414-423` binds shell execution to Roc task/run audit context.
- Provider secrets are not injected into a sandbox.

Gaps / repeated work:
- Current implementation is host shell execution, not an isolated sandbox.
- `virtualMode` does not secure shell execution.
- Manual protocol cast plus execute bridge is a custom implementation of part of the sandbox surface.
- No sandbox lifecycle, provider backend, seeding, or artifact retrieval.

Refactor direction:
- Rename current behavior as audited host execution, not sandbox.
- Switch to official `LocalShellBackend` or complete a `RocShellBackend` protocol implementation.
- Add real sandbox provider only as a separate product feature.

### 10. interpreters

Official source: `.plan/docs/interpreters.md`.

Official points:
- Interpreters provide in-memory JavaScript execution for tool composition and structured data.
- QuickJS middleware exposes `eval`.
- Programmatic tool calling can allowlist tools such as `task`.
- PTC-invoked tools do not enforce `interruptOn` per call.
- Interpreter skills need a `module` entry and `skillsBackend`.

Roc alignment:
- No interpreter middleware found.
- No `@langchain/quickjs` dependency found.
- Current runtime uses direct tools and subagents.

Gaps / repeated work:
- No current duplicate implementation.
- If Roc later hand-rolls multi-tool orchestration, official interpreter middleware should be considered first.

Refactor direction:
- Do not add interpreter support now.
- If required later, add `@langchain/quickjs`, pass `middleware` through `agent-builder.ts`, and strictly allowlist PTC tools.
- Document that PTC bypasses per-tool HITL enforcement.

### 11. event-streaming

Official source: `.plan/docs/event-streaming.md`.

Official points:
- Prefer `agent.streamEvents(input, { version: "v3" })` typed projections.
- Parent stream exposes `messages`, `toolCalls`, `subagents`, and final output.
- Subagent stream exposes nested projections lazily.
- Consume projections concurrently for live UI.
- Use raw events only when exact global arrival order is required.

Roc alignment:
- `deep-agent-runtime-service.ts:340-348` and `:391-395` use `streamEvents` with `version: 'v3'`.
- `deep-agent-runtime-service.ts:533-552` consumes `toolCalls`, `messages`, and `subagents` concurrently.
- `stream-consumers.ts:174-225` maps `stream.subagents` into user-facing `subagent_event`.

Gaps / repeated work:
- Roc only marks subagent start/completion from top-level `subagent.output`; it does not show nested subagent messages/tool calls.
- `ChatRunEvent` is a necessary renderer IPC translation layer, but it can drift from official projection fields.
- `consumeToolCallStream` awaits `call.output` inside the loop; this can lag if tool output blocks.

Refactor direction:
- Keep event streaming as primary API.
- Add fixtures/tests for messages, tool calls, subagents, interrupted runs, failed tools, and nested subagents.
- Add nested subagent detail only if UI needs expandable subagent cards.

### 12. streaming

Official source: `.plan/docs/streaming.md`.

Official points:
- New apps should prefer event streaming over older `agent.stream(... streamMode ...)`.
- Older streaming supports `subgraphs: true`, namespaces, token streams, tool calls, custom updates, and multiple modes.
- Namespaces identify source agents/subgraphs.
- Custom updates use `config.writer`.

Roc alignment:
- Roc already uses `streamEvents`, not older `streamMode`.
- Roc emits custom app events: message deltas, reasoning deltas, tool events, todo events, subagent events, completion, failure, interruption.

Gaps / repeated work:
- Roc does not use namespace/source metadata.
- No `config.writer` custom updates; app events are generated in `stream-consumers.ts`.
- Reasoning extraction and non-assistant suppression in `stream-consumers.ts:258-364` are Roc-specific safety/provider logic around official streams.

Refactor direction:
- Keep `streamEvents`.
- Avoid old `streamMode` unless a missing capability requires it.
- Add targeted tests around reasoning extraction and `SKILL.md`/tool-message suppression.

## Duplicate / Custom Implementation Risk Register

| Risk | Evidence | Why it matters | Recommended action |
| --- | --- | --- | --- |
| `execute` may not be visible to the agent despite preview/UI showing it | `node_modules/deepagents/dist/index.js:1756-1761`, `:1855-1863`; `src/main/services/deep-agent/backend.ts:175-177`; direct probe showed `CompositeBackend.id === ""`, `isSandboxBackend === false`, and `adaptBackendProtocol` drops the manually attached `execute` | Official filesystem middleware only keeps `execute` when the resolved backend is a sandbox protocol with non-empty `id`. Roc tests call `backend.execute` directly or mock `createDeepAgent`, so they do not prove the real Deep Agents tool is available. | Treat as P0. Replace the monkey-patched backend with a real execution-capable default backend (`LocalShellBackend` or full `RocHostShellBackend` with `id`) and add a real middleware-level test. |
| Selected skills may not be discovered at all | `node_modules/deepagents/dist/index.js:3016-3051`; `src/main/services/deep-agent/session.ts:65`; probe showed `/skills/` finds `/skills/project-review/SKILL.md`, while `/skills/project-review/` makes middleware look for `/skills/project-review/SKILL.md/SKILL.md` | `createSkillsMiddleware` expects each source to be a directory containing skill subdirectories, not a single skill directory. Current mocked tests assert the wrong shape. | Pass `skills: ['/skills/']` and enforce selected-skill visibility in the backend projection, or explicitly add a custom source adapter that supports single-skill sources. Prefer root source plus filtering. |
| Manual shell backend masquerades as sandbox protocol | `backend.ts:32-34`, `backend.ts:176-177` | Official `execute` comes from sandbox or `LocalShellBackend`; cast can drift and security semantics are unclear. | Replace with `LocalShellBackend` or complete `RocShellBackend`; update UI language. |
| Unknown path writes go to default `StateBackend`, not workspace disk | `backend.ts:141`, `node_modules/deepagents/dist/index.js:681-692`, current backend tests | In real tool runs this can become LangGraph state scratch files via `filesUpdate`; direct backend tests show it does not affect disk. Wrong `/app/...` or `/hello.txt` paths can still look successful to the model. | Either expose a named scratch route and document it, or make unmatched paths fail explicitly. |
| Read-only wrappers duplicate simple permission rules | `backend.ts:37-130`; `.plan/docs/permissions.md` | Extra protocol maintenance. | Use official `permissions` where path-only rules suffice; keep wrappers only for custom policy/audit. |
| Custom SQLite LangGraph store | `sqlite-store.ts:129-272` | Legit local integration, but tracks LangGraph operation shapes. | Keep with conformance tests and version-watch notes. |
| Per-skill source paths may diverge from root skill discovery | `session.ts:65` | Official docs usually pass `/skills/`; source precedence/layering may be bypassed. | Prefer root source plus backend filtering, or document per-skill decision. |
| Roc permissions naming differs from official permissions | `agent-service.ts:293-310`; config permissions files | Users/devs may confuse approval mode with filesystem path rules. | Rename concepts in docs/code/UI where feasible. |
| Event translation layer can drift | `stream-consumers.ts`, `chat.ts`, renderer state | Official projection fields may change. | Add stream projection contract tests. |
| HITL single-decision resume | `deep-agent-runtime-service.ts:220-222` | Official supports multiple ordered decisions. | Add multi-action support or explicit rejection. |
| Default `general-purpose` subagent is not represented in Roc preview | `node_modules/deepagents/dist/index.js:8129-8144`; `src/main/services/agent-service.ts:277-287`; `src/main/services/deep-agent/tools.ts:107-122` | Deep Agents auto-adds `general-purpose` unless disabled or replaced. Roc preview lists only `code-review` and `research`, so users may see an incomplete capability manifest. | Decide whether to keep GP. If kept, show it in preview; if disabled, use the official harness profile route or a deliberate `general-purpose` replacement. |
| `CreateDeepAgentParams` pass-through is narrower than installed API | `node_modules/deepagents/dist/index.d.ts:3064-3167`; `agent-builder.ts:8-18` | Roc cannot currently opt into `middleware`, `contextSchema`, `responseFormat`, `streamTransformers`, `name`, or official `permissions` without changing the wrapper. This blocks interpreter middleware and custom stream extensions. | Keep wrapper thin but add explicitly needed fields when implementing a feature; do not add broad future-proof pass-throughs without tests. |

## Omission Audit Addendum

This addendum is based on the installed `deepagents@1.10.2` package, not only the website text. It corrects and expands the first audit where the plan was too soft or left assumptions unverified.

### A. Real `createDeepAgent` API surface

Installed API facts:
- `CreateDeepAgentParams` includes `model`, `tools`, `systemPrompt`, `middleware`, `subagents`, `responseFormat`, `contextSchema`, `checkpointer`, `store`, `backend`, `interruptOn`, `name`, `memory`, `skills`, `permissions`, and `streamTransformers`.
- It does not take a direct `profile` object. Harness profiles are resolved from model/provider registration (`registerHarnessProfile`, `getHarnessProfile`) and can affect prompt suffixes, tool exclusions, middleware exclusions, extra middleware, and `generalPurposeSubagent`.
- `createDeepAgent` automatically assembles middleware in this effective order: todo, skills, filesystem, subagent, summarization, patch-tool-calls, async-subagent, caller middleware, Anthropic cache middleware, memory, HITL.

Roc status:
- `agent-builder.ts` passes only `model`, `systemPrompt`, `backend`, `store`, `memory`, `skills`, `subagents`, `tools`, `interruptOn`, and `checkpointer`.
- Missing pass-through fields are not bugs by themselves. They become gaps only when Roc needs official permissions, interpreter middleware, stream transformers, structured responses, typed runtime context, or official agent naming.

Refactor rule:
- Do not widen `buildDeepAgent()` into an untyped bag. Add one official field at a time, with a failing test proving the product need.

### B. `execute` visibility is probably broken under real middleware

Installed API facts:
- `createExecuteTool()` calls `resolveBackend()`, then requires `isSandboxBackend(resolvedBackend)`.
- `isSandboxBackend()` requires both `execute` and a non-empty string `id`.
- `resolveBackend()` only preserves sandbox behavior when `isSandboxProtocol()` is true before adaptation.
- `CompositeBackend.id` delegates to the default backend only if the default is a sandbox; otherwise it returns `""`.

Roc status:
- `backend.ts` uses `new CompositeBackend(new StateBackend(...), routes) as RocCompositeBackend`, then assigns `backend.execute = ...`.
- Because the default backend is `StateBackend`, `CompositeBackend.id` is empty.
- A direct runtime probe produced: `hasExecute: "function"`, `isSandboxBackend: false`, `isSandboxProtocol: false`, `adaptedHasExecute: "undefined"`.
- Current tests prove `backend.execute()` works when called directly, but do not prove the official `execute` tool is exposed to the model.

Required refactor:
- Replace monkey-patching with one real execution-capable backend shape:
  - `CompositeBackend(default = RocHostShellBackend, routes = ...)`, where `RocHostShellBackend` implements `SandboxBackendProtocolV2` including `id`, `execute`, and explicit deny/error file methods for unmatched paths; or
  - `CompositeBackend(default = LocalShellBackend, routes = ...)` if Roc accepts direct host shell without its current audit wrapper; or
  - a real sandbox provider backend if isolation is a product requirement.
- Keep command audit binding (`threadId`, `runId`, `cwd`, RTK bypass metadata). If `LocalShellBackend` cannot preserve this, prefer `RocHostShellBackend`.
- Add a real integration test using actual `createDeepAgent` or `createFilesystemMiddleware` that asserts the model-visible tools include `execute` and that invoking the tool reaches Roc audit logging.

### C. Selected skill source paths are not compatible with `SkillsMiddleware`

Installed API facts:
- `createSkillsMiddleware({ sources })` calls `listSkillsFromBackend(resolvedBackend, sourcePath)`.
- `listSkillsFromBackend()` lists the source directory, keeps only directory entries, and reads `${sourcePath}/${entry.name}/SKILL.md`.
- Therefore a source such as `/skills/project-review/` is interpreted as a directory that contains child skill directories, not as the `project-review` skill itself.

Roc status:
- `session.ts` builds `skillSources = enabledCapabilities.skills.map((skillId) => `/skills/${skillId}/`)`.
- With a real backend, `/skills/` lists `/skills/project-review/` and can load `/skills/project-review/SKILL.md`.
- With the current source `/skills/project-review/`, the middleware lists `SKILL.md` as a file, skips it, and loads no skills.
- Current tests assert `skills: ['/skills/project-review/']` on the mocked `createDeepAgent` call, which locks in the broken source shape.

Required refactor:
- Preferred: pass `skills: ['/skills/']`.
- Add a selected-skill backend projection around `/skills/` so startup listing, `glob`, and `grep` expose only selected skill directories.
- Decide direct-path policy explicitly:
  - softer policy: unselected skills are not discoverable, but direct `/skills/<id>/SKILL.md` reads remain allowed if the model already knows the path;
  - stricter policy: unselected direct reads are denied too.
- The prior official-first direction favored root `/skills/` plus selected-skill filtering. Use that as the default unless product requirements demand direct-path openness.

### D. `SkillService` is mostly official-aligned but metadata policy is incomplete

Official / installed facts:
- The Agent Skills spec supports frontmatter beyond `name` and `description`, including `allowed-tools`, `module`, `license`, `compatibility`, and arbitrary `metadata`.
- `.plan/docs/skills.md` warns that descriptions over 1024 characters are truncated and `SKILL.md` files over 10 MB are skipped during Deep Agents loading.
- Interpreter skills require a `module` field plus interpreter middleware; skill scripts can be read through any backend, but executing scripts requires shell access through sandbox or host shell backend.

Roc status:
- `skill-service.ts` imports and validates with official `parseSkillMetadata()` and indexes with official `listSkills()`.
- `SkillSnapshot` exposes only `id`, `name`, `description`, `enabled`, `path`, `status`, and `lastError`.
- Roc currently does not surface or enforce `allowed-tools`, does not configure interpreter middleware for `module`, and does not differentiate "regular instruction skill" from "interpreter-capable skill" in runtime configuration.

Required refactor:
- Keep import/storage official-first and avoid reimplementing the parser.
- Add tests that import skills with `allowed-tools`, `module`, `license`, `compatibility`, and oversized descriptions so Roc's behavior is explicit.
- Decide product semantics:
  - if metadata is informational, keep shared snapshots narrow and document that `allowed-tools` / `module` are not enforced by Roc;
  - if metadata becomes policy, extend `SkillSnapshot` and runtime wiring in the same phase as enforcement tests.
- Do not advertise interpreter or script execution support until `middleware` pass-through, `@langchain/quickjs`, and execution backend semantics are implemented and verified.

### E. `general-purpose` subagent is silently auto-added

Installed API facts:
- `createDeepAgent()` separates async and inline subagents, then prepends `general-purpose` unless a sync subagent with that name exists or the harness profile disables it.
- The auto-added GP subagent inherits main skills and main tools.
- Custom subagents do not inherit skills unless their own `skills` field is set.

Roc status:
- Roc passes `code-review` and `research`.
- No `general-purpose` subagent is passed, so Deep Agents will add one under default profile behavior.
- Roc preview exposes only the two Roc-defined subagents, and tests assert those names from the mocked call rather than the final middleware state.
- `code-review` has `tools: []`, but Deep Agents still wraps it with filesystem middleware; it should have built-in filesystem tools but not main custom tools. `research` gets `web_read` plus built-in filesystem.

Required refactor:
- Decide whether Roc wants the official GP subagent.
- If yes, add it to capability preview and tests, including its inherited selected skills.
- If no, disable it through the official harness profile mechanism or provide a deliberate `general-purpose` replacement. Do not remove `SubAgentMiddleware` directly.

### F. Official permissions become stricter once `execute` is fixed

Installed API facts:
- `permissions` apply only to built-in filesystem tools.
- They do not constrain `execute`.
- `createFilesystemMiddleware` throws if permissions are used with an execution-capable backend unless the backend is a `CompositeBackend` and every permission path is scoped under route prefixes.

Roc implication:
- After fixing `execute` with an execution-capable `CompositeBackend`, official permissions must use route-scoped paths such as `/workspace/**`, `/skills/**`, `/agents/**`, and `/memory/**`.
- This is compatible with Roc's routed backend, but not with broad `/**` deny rules if the backend exposes execute.
- Read-only wrappers can be reduced only after the route-scoped official permissions are tested.

Required refactor:
- Rename Roc approval config internally toward `approvalMode`/`interruptPolicy`.
- Introduce `filesystemPermissions` only for official path rules.
- Keep shell execution approval/security separate because official permissions cannot secure command execution.

### G. Runtime context and middleware are currently prompt-string based

Official facts:
- Dynamic prompt middleware can read `request.runtime.context` and `request.runtime.store`.
- Tools receive runtime through LangChain tool runtime.
- `contextSchema` exists for invoke-time runtime context typing.

Roc status:
- Roc rebuilds the system prompt per run with workspace path and selected capabilities.
- Stream config passes only `configurable.thread_id` and `configurable.run_id`; no typed `context` is passed.
- This is acceptable for static per-run prompt content, but it is not the official runtime-context pattern.

Required refactor:
- Leave as-is unless a middleware/tool needs typed runtime context.
- If needed, add `contextSchema` and pass context through `streamEvents` config rather than expanding the prompt.

### H. Async subagents and interpreter support require wrapper type changes

Installed API facts:
- `subagents` can contain sync `SubAgent`, compiled subagents, and `AsyncSubAgent`.
- `AsyncSubAgent` is discriminated by `graphId` and adds `start_async_task`, `check_async_task`, `update_async_task`, `cancel_async_task`, and `list_async_tasks`.
- Interpreter support is middleware-driven (`createCodeInterpreterMiddleware` from `@langchain/quickjs`) and would enter through `middleware`.

Roc status:
- `RuntimeSubagent = SubAgent`, so current typing excludes async subagents.
- No `middleware` pass-through exists, so interpreter middleware cannot be configured.
- `paths.ts` contains a `tasks/async-subagents` directory, but Roc task service is not official `asyncTasks` state.

Required refactor:
- Do not implement async/interpreter by custom Roc task wrappers.
- If async is required, widen `RuntimeSubagent` to the official union, pass `AsyncSubAgent` specs through `subagents`, and map official task IDs into the UI.
- If interpreter is required, add a narrow `middleware` pass-through and dependency on `@langchain/quickjs`, with PTC allowlist and HITL caveat documented.

### I. Stream projection coverage is incomplete

Official facts:
- `streamEvents(..., { version: 'v3' })` provides typed projections: `messages`, `toolCalls`, `subagents`, plus extension streams from custom `streamTransformers`.
- Each subagent stream can expose nested `messages`, `toolCalls`, `subagents`, values, and final output.

Roc status:
- Roc consumes top-level `messages`, `toolCalls`, and `subagents`.
- It emits only subagent start/completed summaries, not nested subagent messages or tool calls.
- It ignores `run.extensions` because no custom stream transformers are configured.
- Renderer approval state can show multiple `actionRequests`, but resume still sends one decision.

Required refactor:
- Keep `streamEvents` as the source of truth.
- Add fixtures using the official projection shape, not only loose unknown records.
- Cover nested subagent streams only if the UI will display them.
- Add an explicit test for multiple action requests and ordered decisions before changing the UI.

## Ordered Refactoring Plan

### Execution Rules For This Plan

- 只在进入实现阶段后修改源码；计划维护阶段只允许修改 `.plan/refactor-plan.md`。
- 不使用 `git reset`、`git checkout --`、`git restore` 或其它 git 撤销命令回滚文件；需要回退时只做人工补丁，并说明目标文件和原因。
- 每个阶段都先写能失败的契约测试，再改实现，再跑同一条测试证明转绿。
- 不把 mocked `createDeepAgent` 调用断言当成官方 middleware 行为证明；mock 只用于 Roc 参数装配测试。
- 不声明 `execute` 可用，直到真实 `createFilesystemMiddleware` 或真实 `createDeepAgent` 工具清单测试证明它是模型可调用工具。
- 不把原始 `SKILL.md` 全文、tool message、skill metadata dump 渲染到用户聊天输出；它们只能进入模型上下文、内部日志或审计文件。
- 不把 official `permissions` 当成 shell 安全边界；它只覆盖内置 filesystem 工具，不覆盖 custom tools、MCP 或 `execute`。
- 不把 `TaskService` 后台任务包装成 official async subagents；除非产品需求明确，否则 async subagents、QuickJS interpreter、remote sandbox、sandbox file transfer 都保持非目标。

### Cross-Phase Dependency Order

| Dependency | Required order | Reason |
| --- | --- | --- |
| Selected skill discovery before subagent skill propagation | Phase 1 before any custom subagent skill inheritance change | 如果 `/skills/` root source 还没修好，把 skills 传给 `code-review` 或 `research` 只会复制错误 source shape。 |
| Execution backend before official permissions | Phase 2 before Phase 3 | execution-capable `CompositeBackend` 会触发 route-scoped permission 约束；先加 permissions 会锁定错误规则。 |
| Permissions after host-shell wording | Phase 2 before preview/UI wording in Phase 3 | Roc 当前是 audited host execution，不是 isolated sandbox；UI 和 docs 不能提前声称 sandbox。 |
| HITL multi-action after execute/tool visibility | Phase 6 after Phase 2 | 多 action interrupt 的主要风险来自真实工具调用；先证明工具清单和 backend 语义。 |
| Interpreter and async support after middleware pass-through | non-goal until explicit product requirement | 两者都需要 `middleware` 或 `RuntimeSubagent` 类型扩展，不能在现有 wrapper 上硬接。 |

### Phase 0: Baseline verification

Goal: lock current behavior before any refactor.

Files:
- Modify only during implementation: `tests/main/deep-agent-backend.test.ts`
- Modify only during implementation: `tests/main/deep-agent-runtime-service.test.ts`
- Modify only during implementation: `tests/main/deep-agent-tools.test.ts`
- Modify only during implementation: `tests/main/deep-agent-prompt.test.ts`
- Create only if shared fixtures are needed: `tests/main/deep-agent-official-contracts.test.ts`

Red tests to add:
- `exposes execute only when the runtime backend satisfies the official sandbox backend protocol`
- `discovers selected skills through a root /skills/ source and selected backend projection`

Steps:
1. Run targeted tests:
   - `pnpm vitest run tests/main/deep-agent-runtime-service.test.ts tests/main/deep-agent-backend.test.ts tests/main/deep-agent-tools.test.ts tests/main/deep-agent-prompt.test.ts`
2. Add the two red contract tests above. Use actual `deepagents` middleware or actual `createDeepAgent`, not a mocked `createDeepAgent`.
3. Run only the new tests and confirm both fail on current code for the expected reasons:
   - `execute` is missing from the official tool surface or dropped after backend adaptation;
   - selected skill frontmatter is absent when Roc passes `/skills/<id>/`.
4. Run typecheck:
   - `pnpm typecheck`
5. If implementation starts later, save command output summary under `.artifacts/deepagents-official-audit/`.

Non-goals:
- Do not change `src/main/services/deep-agent/*` in Phase 0.
- Do not update UI copy, preview cards, or runtime behavior in Phase 0.

Acceptance:
- Targeted tests pass before source changes.
- Typecheck passes.
- The two new contract tests reproduce the current official-alignment defects before refactor.
- Any pre-existing failure is logged with command, exit code, and failure text.

### Phase 1: Fix selected skill discovery

Goal: restore official progressive disclosure for selected skills.

Files:
- Modify: `src/main/services/deep-agent/session.ts`
- Modify: `src/main/services/deep-agent/backend.ts`
- Modify: `src/main/services/deep-agent/tools.ts` only if custom subagent skill propagation is explicitly enabled in this phase.
- Modify: `tests/main/deep-agent-runtime-service.test.ts`
- Modify: `tests/main/deep-agent-backend.test.ts`
- Modify: `tests/main/deep-agent-tools.test.ts`
- Create only if needed for official middleware fixtures: `tests/main/deep-agent-official-contracts.test.ts`

Red tests to add:
- `loads only selected skills from a /skills/ source root through the real skills middleware`
- `does not advertise an unselected skill in skillsMetadata`
- `does not emit raw SKILL.md content as assistant-visible output`
- `passes /skills/ rather than /skills/<id>/ to createDeepAgent`

Steps:
1. Add a failing contract test using real `createSkillsMiddleware` or actual `createDeepAgent`: a selected `project-review` skill must appear in `skillsMetadata` when the source is Roc's runtime source.
2. Replace per-skill source paths in `session.ts` with one official root source: `skills: ['/skills/']` when at least one skill is selected, or an empty array when no skill is selected.
3. Add selected-skill filtering at the `/skills/` backend projection boundary for `ls`, `glob`, and `grep`; the listing seen by `createSkillsMiddleware` must contain only selected skill directories.
4. Use the strict direct-path policy unless product requirements say otherwise: direct reads, raw reads, glob, grep, edit, upload, and download under unselected `/skills/<id>/` paths must be denied consistently.
5. Keep custom `code-review` and `research` subagent `skills` empty in this phase unless a test proves selected skills should intentionally apply to them. If enabled, pass `skills: ['/skills/']` only after the backend projection is selected-skill aware.
6. Update mocked runtime tests that currently assert `/skills/<id>/` so they lock in the official root source shape instead.
7. Re-run the contract tests and the existing Deep Agents main test subset.

Non-goals:
- Do not surface `allowed-tools`, `module`, `license`, `compatibility`, or arbitrary metadata in the UI in Phase 1.
- Do not add interpreter middleware or script execution for skill modules.
- Do not change skill import storage layout unless selected-skill filtering cannot be implemented at the virtual backend boundary.

Acceptance:
- Selected skills are discoverable by frontmatter through the real middleware.
- Unselected skills are not advertised in `skillsMetadata`.
- The selected-skill direct-path policy is covered by tests.
- `SKILL.md` content remains internal and never appears as assistant-visible user output.
- Tests no longer assert the broken `/skills/<id>/` source shape.
- Existing import behavior still uses official `parseSkillMetadata()` and `listSkills()`.

### Phase 2: Clarify execution backend

Goal: align `execute` with official backend semantics.

Files:
- Modify: `src/main/services/deep-agent/backend.ts`
- Modify: `src/main/services/deep-agent/types.ts`
- Modify: `src/main/services/deep-agent/session.ts` only if backend construction input changes.
- Modify: `src/main/services/agent-service.ts` only for preview wording that distinguishes host execution from sandbox execution.
- Modify: `tests/main/deep-agent-backend.test.ts`
- Modify: `tests/main/deep-agent-runtime-service.test.ts`
- Modify: `tests/main/app-services.provider.test.ts` only if preview/runtime capability output changes.

Red tests to add:
- `does not expose execute through official filesystem middleware when CompositeBackend has StateBackend default`
- `exposes execute through official filesystem middleware after RocHostShellBackend provides id and execute`
- `records agent_execute audit event when the official execute tool invokes the Roc backend`
- `rejects unmatched write paths instead of silently storing them in StateBackend`

Steps:
1. Add a failing contract test using real `createFilesystemMiddleware` or actual `createDeepAgent` showing current Roc backend does not satisfy official `execute` exposure despite having a manually attached method.
2. Decide one path:
   - preferred: custom `RocHostShellBackend` implementing official `SandboxBackendProtocolV2`, preserving Roc task/run audit and cwd policy;
   - alternative: official `LocalShellBackend` only if Roc can wrap it without losing task-bound audit;
   - separate feature: real sandbox provider integration.
3. Implement the chosen execution backend with a non-empty `id`; remove unsafe cast and manual `backend.execute = ...`.
4. Make `CompositeBackend` default backend execution-capable so `CompositeBackend.id` is non-empty and `isSandboxBackend(resolveBackend(...))` is true.
5. Make unknown non-routed paths fail explicitly. Add a named scratch route only when a real feature needs scratch files.
6. Update tests around backend protocol, real `execute` tool visibility, and execute preview wording.
7. Re-run the official middleware contract test after implementation; do not rely on direct `backend.execute()` calls as proof.

Non-goals:
- Do not call current host execution a sandbox.
- Do not remove Roc command audit, task binding, RTK bypass metadata, or cwd checks.
- Do not treat official filesystem `permissions` as command execution security.

Acceptance:
- No unsafe `SandboxBackendProtocolV2` cast.
- `isSandboxBackend(runtimeBackend)` is true after official adaptation.
- A real Deep Agents filesystem tool invocation reaches Roc shell audit.
- UI/preview copy does not imply sandbox isolation for host shell.
- `execute` remains task-bound and audited.
- Unknown write paths do not produce a false success in virtual state.

### Phase 3: Separate approval mode from filesystem permissions

Goal: eliminate terminology and contract collision.

Files:
- Modify: `src/main/services/agent-service.ts`
- Modify: `src/main/services/deep-agent/agent-builder.ts`
- Modify: `src/main/services/deep-agent/session.ts`
- Modify: `src/main/services/deep-agent/backend.ts` only if wrappers are replaced by official path rules.
- Modify: `src/main/services/deep-agent/types.ts` only if a named config type is introduced.
- Modify: `tests/main/deep-agent-runtime-service.test.ts`
- Modify: `tests/main/deep-agent-backend.test.ts`
- Modify: `tests/main/app-services.provider.test.ts`

Red tests to add:
- `keeps Roc approvalMode mapped only to interruptOn`
- `passes route-scoped filesystem permissions only when official path rules are enabled`
- `does not claim filesystem permissions restrict execute`
- `inherits parent filesystem permissions in subagents unless explicitly replaced`

Steps:
1. Rename internal concepts where they collide: Roc approval settings feed `approvalMode` or `interruptPolicy`; official filesystem rules feed `filesystemPermissions`.
2. Add a narrow `permissions` pass-through in `agent-builder.ts` only when the product needs official path rules.
3. If official rules are passed with an execution-capable `CompositeBackend`, use only route-scoped paths such as `/workspace/**`, `/skills/**`, `/agents/**`, and `/memory/**`.
4. Decide whether read-only `/skills/`, `/agents/`, and `/memory/` should remain policy wrappers or move to official `permissions`.
5. Add tests for the exact `permissions` payload and first-match behavior if official rules are enabled.
6. Add tests for subagent permission inheritance and explicit replacement semantics before enabling per-subagent `permissions`.

Non-goals:
- Do not remove read-only wrappers until official permissions cover the same behavior and tests prove equivalence.
- Do not use broad `/**` rules once the backend is execution-capable.
- Do not use path permissions to approve, reject, or edit custom tool calls.

Acceptance:
- `approvalMode` still drives HITL.
- Official `permissions`, if enabled, only expresses filesystem path rules.
- Shell execution caveat remains explicit because official permissions do not constrain `execute`.
- Subagents inherit parent path rules unless an explicit replacement policy is configured and tested.
- Existing approval UI behavior remains unchanged unless Phase 6 changes it deliberately.

### Phase 4: Make SkillService metadata policy explicit

Goal: keep skill import official-first while avoiding false runtime claims about metadata.

Files:
- Modify: `src/main/services/skill-service.ts`
- Modify: `src/shared/types/app.ts` only if `SkillSnapshot` is intentionally widened.
- Modify: `src/shared/types/index.ts` only if shared exports change.
- Modify: `src/renderer/skill-drawer.tsx` only if UI wording or metadata display changes.
- Modify: `tests/main/app-services.test.ts`
- Modify: `tests/main/app-services.provider.test.ts`
- Modify: `tests/renderer/chat-view.test.ts` only if visible skill card output changes.

Red tests to add:
- `imports a skill containing allowed-tools without enforcing it as Roc policy`
- `imports a skill containing module without advertising interpreter execution`
- `preserves narrow SkillSnapshot when extra official metadata is informational`
- `rejects invalid frontmatter through official parseSkillMetadata`
- `does not display raw SKILL.md content or metadata dumps in skill cards`

Steps:
1. Add tests for importing valid skills with `allowed-tools`, `module`, `license`, `compatibility`, and arbitrary `metadata`.
2. Add tests for invalid or oversized official constraints that Roc wants to surface, including invalid frontmatter and description/name limits if the installed parser exposes them.
3. Decide and document whether `SkillSnapshot` should remain narrow or expose the extra official metadata fields.
4. If `allowed-tools` is surfaced, add enforcement or explicit "not enforced by Roc" UI/API wording.
5. If `module` is surfaced, add an "interpreter unavailable" status until interpreter middleware exists; do not imply module import works.
6. Keep official parser and lister as the only metadata source of truth.

Non-goals:
- Do not implement `allowed-tools` enforcement unless it is backed by runtime tool filtering tests.
- Do not add `@langchain/quickjs`, `middleware`, or interpreter skill execution in this phase.
- Do not widen shared API types only to expose fields that no UI or runtime path consumes.

Acceptance:
- Skill import still uses official `parseSkillMetadata()` and `listSkills()`.
- Extra official metadata does not break import.
- UI/runtime does not imply enforcement or interpreter support that Roc has not implemented.
- Invalid skills fail with deterministic product errors rather than silent partial imports.

### Phase 5: Make memory semantics explicit

Goal: avoid mixing curated read-only memory with writable learned memory.

Files:
- Modify: `src/main/services/deep-agent/backend.ts`
- Modify: `src/main/services/deep-agent/session.ts`
- Modify: `src/main/services/deep-agent/sqlite-store.ts`
- Modify: `tests/main/deep-agent-backend.test.ts`
- Modify: `tests/main/deep-agent-runtime-service.test.ts`
- Create only if conformance tests should be isolated: `tests/main/deep-agent-sqlite-store.test.ts`

Red tests to add:
- `treats /memory/ as read-only curated memory`
- `loads /agents/AGENTS.md only when the mounted memory file exists`
- `supports BaseStore get put delete search and namespace listing with workspace scope`
- `keeps writable /memories/ separate from read-only /memory/ if writable memory is added`

Steps:
1. Document `/memory/` as read-only curated memory, or add separate writable `/memories/`.
2. Keep `/agents/AGENTS.md` as always-loaded memory only if app sync behavior is verified.
3. Add SQLite `BaseStore` conformance tests.
4. If writable memory is added, include conflict strategy and permission rules.
5. Keep workspace-path hash scoping unless product requirements switch to user-level or assistant-level memory.

Non-goals:
- Do not add background consolidation before writable memory exists.
- Do not rename `/memory/` to `/memories/` in place; add a separate route if writable official memory is needed.
- Do not make curated memory writable through `edit_file` without explicit permission tests.

Acceptance:
- Memory route semantics are documented and tested.
- Writable and read-only memory routes are distinct if both exist.
- Store conformance tests pass.
- Workspace-scoped memory remains intentional and documented.

### Phase 6: HITL completeness

Goal: keep official resume protocol intact.

Files:
- Modify: `src/main/services/deep-agent-runtime-service.ts`
- Modify: `src/main/services/agent-service.ts`
- Modify: `src/shared/types/chat.ts`
- Modify: `src/renderer/chat-run-state.ts`
- Modify: `src/renderer/chat/chat-transcript-panel.tsx` only if approval UI shape changes.
- Modify: `tests/main/deep-agent-runtime-service.test.ts`
- Modify: `tests/renderer/chat-run-state.test.ts`
- Modify: `tests/renderer/chat-view.test.ts`

Red tests to add:
- `records multiple actionRequests from one interrupt without dropping order`
- `resumes with ordered decisions for the same thread_id`
- `rejects a multi-action interrupt clearly when UI/API sends only one decision`
- `rejects respond for delete_file with the configured product policy`
- `does not enable interrupts in chat mode without a checkpointer`

Steps:
1. Add fixture/test for multiple action requests in one interrupt.
2. Either support `decisions: [...]` in UI/API or reject multi-action interrupts with a clear error.
3. Confirm every interrupting run mode has a checkpointer.
4. Confirm approval UI edit behavior does not edit only the first action when several actions are present.
5. Add subagent interrupt policies only for concrete risky subagent tools.
6. Document and test Roc's `respond` policy per tool class instead of inheriting the official default implicitly.
7. Keep `Command({ resume: { decisions } })` and the original `thread_id` as the only resume path.

Non-goals:
- Do not add subagent-specific interrupt rules before a risky subagent tool exists.
- Do not coerce `respond` into approve, edit, or reject.
- Do not let chat mode enable interrupting tools without persistent checkpoint ownership.

Acceptance:
- Resume always uses same `thread_id`.
- Multi-action behavior is deterministic and covered.
- Tools that disallow `respond` fail clearly instead of silently coercing to another decision type.
- Ordered decisions are preserved across main process, shared types, and renderer state.

### Phase 7: Streaming contract hardening

Goal: reduce drift risk from official stream projection changes.

Files:
- Modify: `src/main/services/deep-agent/stream-consumers.ts`
- Modify: `src/main/services/deep-agent-runtime-service.ts`
- Modify: `src/shared/types/chat.ts` only if event shape changes.
- Modify: `src/renderer/chat-run-state.ts` only if event shape changes.
- Modify: `tests/main/deep-agent-runtime-service.test.ts`
- Modify: `tests/renderer/chat-run-state.test.ts`
- Modify: `tests/renderer/use-chat-run.test.ts`
- Modify: `tests/renderer/chat-view.test.ts`

Red tests to add:
- `maps official message projection deltas to assistant_delta without non-assistant tool text`
- `maps official toolCalls projection start and completion without leaking secret inputs`
- `maps top-level subagent projection start and completion`
- `keeps nested subagent projection internal unless UI explicitly supports it`
- `handles failed tool output and interrupted run projection deterministically`
- `filters summarization-origin text if a real Deep Agents projection emits it as non-user-visible content`

Steps:
1. Add stream projection fixtures: messages, toolCalls, subagents, nested subagents, failed tool, interrupted run.
2. Test reasoning extraction and non-assistant text suppression.
3. Decide whether nested subagent messages/tool calls need user-facing UI.
4. Keep `streamEvents({ version: 'v3' })` as the runtime API unless an official regression forces a different projection path.
5. Add renderer state tests for interleaved message/tool/subagent events before changing event shape.

Non-goals:
- Do not switch to older `agent.stream(... streamMode ...)`.
- Do not expose raw tool messages, raw skill content, or nested subagent transcript text by default.
- Do not add custom `streamTransformers` without a concrete UI feature that consumes them.

Acceptance:
- Official projection to Roc `ChatRunEvent` mapping is covered by tests.
- Renderer state stays stable under interleaved projection events.
- Reasoning output and assistant output remain separate.
- Tool inputs that can contain prompts or secrets are not emitted verbatim unless an existing audited event already permits it.

### Phase 8: Explicit non-goals

Do not implement unless product requirements appear:
- Async subagents: use official `AsyncSubAgent` later instead of custom launch/check/cancel tools.
- Interpreters: add `@langchain/quickjs` only when deterministic in-loop code execution is required.
- Remote sandbox provider: separate feature from current local desktop assistant host execution.
- Background memory consolidation: only useful after writable memory exists.
- Official sandbox file transfer (`uploadFiles()` / `downloadFiles()`) and skill sandbox sync remain out of scope until Roc ships a real sandbox backend.

If one of these becomes a requirement, create a separate plan section first:
- Async subagents require widening `RuntimeSubagent`, preserving official `asyncTasks`, and mapping official task IDs into Roc UI.
- Interpreter support requires `middleware` pass-through, `@langchain/quickjs`, PTC allowlist tests, and clear HITL caveats.
- Remote sandbox support requires lifecycle, seeding, artifact transfer, untrusted output handling, and provider secret boundaries.

## Verification Plan For Future Implementation

Minimum:
- `pnpm vitest run tests/main/deep-agent-runtime-service.test.ts tests/main/deep-agent-backend.test.ts tests/main/deep-agent-tools.test.ts tests/main/deep-agent-prompt.test.ts`
- `pnpm typecheck`

Contract-specific:
- `pnpm vitest run tests/main/deep-agent-official-contracts.test.ts`
- `pnpm vitest run tests/main/deep-agent-backend.test.ts --runInBand`

When streaming/UI changes:
- `pnpm vitest run tests/renderer/chat-run-state.test.ts tests/renderer/use-chat-run.test.ts tests/renderer/chat-view.test.ts`
- `pnpm smoke:electron`

When packaging/runtime changes:
- `pnpm build`
- `pnpm test`

Completion evidence for each implementation phase:
- failing test name and failure reason before implementation;
- changed files list;
- passing targeted command with exit code;
- broader command when blast radius crosses runtime, renderer, or packaging;
- explicit note if a verification command is blocked or skipped.
