# Roc Agent Harness PR-04: MCP Tool Gateway

**Status:** Implementation and deterministic verification complete. PR-04 freezes each selected remote MCP tool contract in the run snapshot, enforces client-side transport and payload limits, and rejects contract drift before a tool becomes available.

## Contract freeze and drift handling

`McpToolContractV1` lives in the shared MCP schema boundary at `src/shared/schemas/ipc-mcp-skills.ts`. Contract version and canonicalization version are both `1`. The contract binds the server ID, remote and runtime tool names, transport, schema hash, description hash, and the fixed input, output, and inbound limits.

The schema hash is SHA-256 over canonical JSON containing both the input schema and `outputSchema ?? null`. Canonicalization sorts object keys and the order-insensitive `required`, `enum`, and `type` arrays. The description receives its own SHA-256 hash. Non-JSON schema values and schemas or descriptions beyond their byte caps fail discovery.

`AgentPluginRuntime.startRun` discovers contracts after pilot narrowing and before `repository.createTaskRun` persists the snapshot. The main-process provider uses the internal `mcp.tools.contracts.get` capability with a temporary discovery run ID and releases that session in `finally`. `bindMcpToolContracts` attaches the selected contracts, derives each tool version from the contract hashes, normalizes the manifest, and recomputes its integrity hash.

When a run or resumed run loads tools, `loadSelectedMcpTools` matches the frozen runtime tool name to the remote tool metadata and compares the full contract. Missing, duplicate, malformed, or changed contracts fail closed before the selected tool is exposed. The Exa preset exposes the stable `web_search` name and freezes the selected remote implementation (`web_search_exa`, with `web_search_advanced_exa` as fallback).

## Transport and invocation bounds

The adapter uses `@modelcontextprotocol/client` 2.3.1 directly. The earlier MCP adapter hid pre-parse transport limits behind private connection management, so the direct client keeps the inbound boundary visible and testable.

| Boundary | Limit and enforcement |
| --- | --- |
| Inbound MCP message | 1 MiB. Stdio sets `maxBufferSize`; HTTP JSON bodies and individual SSE events are counted while streaming, before parsing. Oversize bodies are cancelled and rejected. |
| Tool input | 64 KiB of UTF-8 JSON, checked after schema validation and before the MCP request. |
| Tool input schema | 64 KiB. |
| Tool description | 32 KiB. |
| Tool output | 128 KiB combined structured and converted output, checked before returning content to the agent. A frozen output schema is also validated when the server supplies structured output. |
| Server concurrency | 2 active tool calls per server. Aborted waiters are removed from the semaphore queue. |
| Initialization / call | 15 seconds / 30 seconds. The call timeout signal covers both semaphore wait and the MCP request. |

HTTP redirects are restricted to the configured origin. Streamable HTTP falls back to SSE on 404/405, retaining the existing terminal `/mcp` to `/sse` fallback behavior. Sessions release their clients on completion or failure.

## Verification evidence

| Check | Result |
| --- | --- |
| Focused manifest, contract, adapter, and bounded transport tests | 16/16 passed |
| `pnpm test:unit` | 525/525 passed |
| `pnpm test:renderer` | 31/31 passed serially |
| `pnpm typecheck` | Passed |
| `pnpm check:ipc` | Passed; generated IPC files current |
| `pnpm harness:eval` | 93/93 passed; report: `.artifacts/harness-eval/2026-10-30T09-40-56.947Z-32055/report.json` |
| `pnpm build` | Passed |
| `pnpm check:renderer-chunks` | 1,130,127 eager JS bytes across 6 files |
| Error-level LSP diagnostics | 0 across changed-path sweeps |

The focused tests exercise canonical hash stability and changes, manifest binding and integrity after JSON serialization, frozen-contract drift rejection, caller cancellation, timeout while queued, input and output byte caps, JSON Content-Length and streamed-body rejection, and per-event SSE limits.

## Limits

These are client-side limits. The 64 KiB input check runs before the remote call; the 128 KiB output check runs after the MCP response has been received and converted. The 1 MiB inbound transport limit bounds the JSON body or each SSE event before parsing, but it does not constrain remote server computation.

Contract hashes freeze the schema and description observed during discovery; they are not a remote signature or proof of server identity. A server can change behavior while keeping the same advertised contract. Cancellation or timeout can race with a remote side effect, so an uncertain result remains subject to PR-03's reconciliation rules. This work makes no exactly-once claim for remote MCP effects.

Validation used deterministic fixtures and fake clients. It did not exercise a live external MCP service or claim provider-side enforcement of the client limits.
