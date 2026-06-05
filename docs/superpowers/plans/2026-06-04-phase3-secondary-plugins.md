# Phase 3 Secondary Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将剩余 main-process domains 迁移到微内核插件，完成业务功能覆盖。

**Architecture:** 本阶段补齐 Workspace、MCP、Skills、Runtime Tools、Diagnostics 五个插件。所有插件使用 Phase 1 `RocPlugin` 合同；不创建 `src/plugins/*`；不使用未安装或不存在的第三方 API。

**Tech Stack:** TypeScript 6.0.3, Better-SQLite3 12.10.0, @langchain/mcp-adapters 1.1.3, node-pty 1.1.0, Vitest 4.1.6.

---

## Dependencies

- Phase 1-2 已完成。
- Current shared types remain the external renderer contract until Phase 4-5 replace renderer IPC wiring.
- MCP client API source of truth is the installed `@langchain/mcp-adapters@1.1.3` package export and README: `MultiServerMCPClient`, `mcpServers`, `getTools()`, and `close()`. If the official latest docs show a different config shape, do not silently switch; update the dependency and tests in the same task.

## File Structure

- Create: `src/main/plugins/workspace/index.ts`
- Create: `src/main/plugins/workspace/file-capabilities.ts`
- Create: `src/main/plugins/workspace/git-capabilities.ts`
- Create: `src/main/plugins/workspace/terminal-capabilities.ts`
- Create: `src/main/plugins/mcp/index.ts`
- Create: `src/main/plugins/mcp/mcp-client-adapter.ts`
- Create: `src/main/plugins/skills/index.ts`
- Create: `src/main/plugins/runtime-tools/index.ts`
- Create: `src/main/plugins/runtime-tools/rtk-adapter.ts`
- Create: `src/main/plugins/runtime-tools/shell-adapter.ts`
- Create: `src/main/plugins/runtime-tools/web-read-adapter.ts`
- Create: `src/main/plugins/diagnostics/index.ts`
- Create: `src/main/plugins/diagnostics/performance-adapter.ts`
- Create: `src/main/plugins/diagnostics/lifecycle-adapter.ts`
- Test: `tests/main/plugins/workspace/*.test.ts`
- Test: `tests/main/plugins/mcp/*.test.ts`
- Test: `tests/main/plugins/skills/*.test.ts`
- Test: `tests/main/plugins/runtime-tools/*.test.ts`
- Test: `tests/main/plugins/diagnostics/*.test.ts`
- Test: `tests/main/plugins/secondary-plugins.integration.test.ts`

## Capability Contract

| Plugin | Capability group |
|---|---|
| `@roc/plugin-workspace` | `workspace.*`, `files.*`, `git.*`, `terminal.*` |
| `@roc/plugin-mcp` | `mcp.listServers`, `mcp.upsertServer`, `mcp.setServerEnabled`, `mcp.deleteServer`, `mcp.testServer`, `mcp.tools.get` |
| `@roc/plugin-skills` | `skills.list`, `skills.import`, `skills.setEnabled`, `skills.delete`, `skills.files.list`, `skills.file.read` |
| `@roc/plugin-runtime-tools` | `rtk.status`, `shell.execute`, `shell.confirm`, `web.read` |
| `@roc/plugin-diagnostics` | `diagnostics.samplePerformance`, `diagnostics.createPackage`, `diagnostics.runChecks`, `diagnostics.getMetricsSnapshot`, `diagnostics.runHealthCheck`, `lifecycle.getTraySummary`, `lifecycle.pauseBackgroundExecution`, `lifecycle.resumeBackgroundExecution` |

Capability names are internal microkernel names. They may differ from existing preload method names. Each capability must use the current shared request/result type from the existing preload contract, and Phase 5 must provide the explicit preload-method-to-capability mapping.

## Task 1: Workspace Plugin

**Files:**
- Create: `src/main/plugins/workspace/index.ts`
- Create: `src/main/plugins/workspace/file-capabilities.ts`
- Create: `src/main/plugins/workspace/git-capabilities.ts`
- Create: `src/main/plugins/workspace/terminal-capabilities.ts`
- Test: `tests/main/plugins/workspace/plugin.test.ts`
- Test: `tests/main/plugins/workspace/file-capabilities.test.ts`
- Test: `tests/main/plugins/workspace/git-capabilities.test.ts`
- Test: `tests/main/plugins/workspace/terminal-capabilities.test.ts`

- [ ] **Step 1: Write tests**

Assert current behavior from `WorkspaceService`, `FileService`, `GitService`, and `TerminalSessionService` is preserved through capability calls. Tests must use temp directories and must not touch the repository worktree.

Run: `pnpm test -- tests/main/plugins/workspace`
Expected: FAIL.

- [ ] **Step 2: Implement plugin**

Move current service behavior into plugin adapters. The plugin manifest is `@roc/plugin-workspace`, `loadPhase: 'critical'`, `required: true`, `dependencies: []`.

Run: `pnpm test -- tests/main/plugins/workspace`
Expected: PASS.

## Task 2: MCP Plugin

**Files:**
- Create: `src/main/plugins/mcp/index.ts`
- Create: `src/main/plugins/mcp/mcp-client-adapter.ts`
- Test: `tests/main/plugins/mcp/plugin.test.ts`
- Test: `tests/main/plugins/mcp/mcp-client-adapter.test.ts`

- [ ] **Step 1: Write tests against local package API**

Assert adapter imports `MultiServerMCPClient`, not `MCPClient`. Assert config uses the installed package's `mcpServers` shape, tool loading uses `getTools()`, cleanup calls `close()`, and server inspection uses current config from the config store.

Run: `pnpm test -- tests/main/plugins/mcp`
Expected: FAIL.

- [ ] **Step 2: Implement MCP plugin**

Migrate current `McpService` validation and Exa preset behavior. The plugin must keep `transport: 'stdio' | 'http' | 'sse'` validation and return current `McpServerSnapshot` / `McpServerTestResult`.

Run: `pnpm test -- tests/main/plugins/mcp`
Expected: PASS.

## Task 3: Skills Plugin

**Files:**
- Create: `src/main/plugins/skills/index.ts`
- Test: `tests/main/plugins/skills/plugin.test.ts`

- [ ] **Step 1: Write tests**

Assert current `SkillService` behavior is reachable through capabilities and that invalid skill metadata returns the current error shape.

Run: `pnpm test -- tests/main/plugins/skills`
Expected: FAIL.

- [ ] **Step 2: Implement plugin**

Move current `SkillService` behavior behind `@roc/plugin-skills`. Keep skill files under the existing runtime path contract.

Run: `pnpm test -- tests/main/plugins/skills`
Expected: PASS.

## Task 4: Runtime Tools Plugin

**Files:**
- Create: `src/main/plugins/runtime-tools/index.ts`
- Create: `src/main/plugins/runtime-tools/rtk-adapter.ts`
- Create: `src/main/plugins/runtime-tools/shell-adapter.ts`
- Create: `src/main/plugins/runtime-tools/web-read-adapter.ts`
- Test: `tests/main/plugins/runtime-tools/plugin.test.ts`
- Test: `tests/main/plugins/runtime-tools/rtk-adapter.test.ts`
- Test: `tests/main/plugins/runtime-tools/shell-adapter.test.ts`

- [ ] **Step 1: Write tests**

Assert:
- RTK path resolution uses current `RTKBinaryManager` and supports packaged resources.
- Shell execution keeps current confirmation and risk behavior.
- Web read keeps current validation and error mapping.

Run: `pnpm test -- tests/main/plugins/runtime-tools`
Expected: FAIL.

- [ ] **Step 2: Implement plugin**

Move current `RtkService`, `ShellExecutionService`, and `WebReadService` behavior. Do not hardcode `win32-x64`; use the current binary manager.

Run: `pnpm test -- tests/main/plugins/runtime-tools`
Expected: PASS.

## Task 5: Diagnostics Plugin

**Files:**
- Create: `src/main/plugins/diagnostics/index.ts`
- Create: `src/main/plugins/diagnostics/performance-adapter.ts`
- Create: `src/main/plugins/diagnostics/lifecycle-adapter.ts`
- Test: `tests/main/plugins/diagnostics/plugin.test.ts`
- Test: `tests/main/plugins/diagnostics/performance-adapter.test.ts`
- Test: `tests/main/plugins/diagnostics/lifecycle-adapter.test.ts`

- [ ] **Step 1: Write tests**

Assert current diagnostics package includes task snapshot, performance sample, logs, recovery points, and RTK status. Assert lifecycle pause/resume updates the task scheduler through capabilities, not direct service imports.

Run: `pnpm test -- tests/main/plugins/diagnostics`
Expected: FAIL.

- [ ] **Step 2: Implement plugin**

Move current `DiagnosticsService`, `HealthCheckService`, `MetricsService`, `PerformanceObserverService`, and `LifecycleService` behavior behind `@roc/plugin-diagnostics`.

Run: `pnpm test -- tests/main/plugins/diagnostics`
Expected: PASS.

## Task 6: Secondary Plugin Integration

**Files:**
- Create: `tests/main/plugins/secondary-plugins.integration.test.ts`

- [ ] **Step 1: Write integration test**

Start `KernelRuntime` with Phase 2 and Phase 3 plugins. Assert:
- all required plugins load.
- workspace select changes app status input for file/git/terminal.
- MCP preset is present but disabled.
- RTK status resolves from bundled resources.
- diagnostics sample records IPC and performance metadata through the plugin capability path.

Run: `pnpm test -- tests/main/plugins/secondary-plugins.integration.test.ts`
Expected: FAIL until Tasks 1-5 are complete.

- [ ] **Step 2: Make integration pass**

Fix capability registration and dependency order only. Do not introduce renderer IPC in this phase.

Run: `pnpm test -- tests/main/plugins/secondary-plugins.integration.test.ts`
Expected: PASS.

## Phase 3 Verification

- [ ] `pnpm test -- tests/main/plugins/workspace tests/main/plugins/mcp tests/main/plugins/skills tests/main/plugins/runtime-tools tests/main/plugins/diagnostics tests/main/plugins/secondary-plugins.integration.test.ts`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`

## Phase 3 Exit Criteria

- Current main-process domain behavior has a plugin owner.
- No plugin imports `MCPClient`; MCP integration uses `MultiServerMCPClient`.
- No plugin hardcodes platform-specific RTK resource paths.
- No renderer or preload changes are made before Phase 4-5.
