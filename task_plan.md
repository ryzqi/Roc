# Roc 新架构全迁移计划

## Goal

全面迁移到新架构，删除旧架构、旧运行时、旧数据路径和兼容迁移逻辑，只保留新 kernel/plugin/per-plugin data 架构。

## Scope

- 主进程启动只使用 `KernelRuntime` 和插件能力。
- Agent/DeepAgent 运行不再依赖 legacy `createAppServices` 宿主。
- 数据只保留 `plugin-data` 下的 per-plugin SQLite 和新配置/secret 存储。
- 删除旧 `roc.sqlite` monolith 数据迁移、旧 app-service 运行时、旧 IPC service 注册路径和对应测试夹具。
- 旧 monolith 数据按用户确认直接从磁盘删除，但只允许删除 Roc data root 下的精确旧 DB 文件名，不能递归删除目录或删除任意路径。
- 保留仍被新插件直接复用的领域实现，但移动或改造成 plugin-owned/service-owned 模块，不保留 legacy composition root。

## Current Acceptance Criteria

1. `src/main/main-kernel-bootstrap.ts` 不再导入或创建 `createAppServices`。
2. `src/main/services/app-service.ts` 被删除或不再参与构建/测试。
3. `src/main/services/database-service.ts` 与 monolith `roc.sqlite` 运行路径被删除或不再被 main runtime 使用。
4. `src/main/infrastructure/migration/monolith-to-plugins.ts` 和相关 `roc.sqlite` 兼容路径被删除，且启动不再读取旧 monolith DB。
5. Agent plugin 自己拥有 DeepAgent runtime 需要的依赖，或通过新 plugin capabilities/context 明确注入，不通过 delegated runtime host。
6. IPC 只经 preload typed API -> plugin capability adapter -> kernel capability；旧 service-specific IPC 注册路径删除或隔离为不存在的死代码后清理。
7. 测试从 `app-services*` / `database-*` legacy 夹具迁到 plugin/kernel fixtures。
8. 启动时对旧 DB 执行安全磁盘删除：只删除 resolved data root 内的 `roc.sqlite`、`roc.sqlite-wal`、`roc.sqlite-shm` 和旧迁移备份文件，不删除目录，不跟随用户输入任意路径。
9. `pnpm typecheck`、相关 main/plugin tests、renderer contract tests、package/smoke gate 通过。

## Phases

### Phase 6 - Review P1 Regression Fixes

- **Status:** complete

Work:
- Restore plugin-owned DeepAgent execution for normal agent/task runs without reintroducing legacy `createAppServices` delegate.
- Gate legacy monolith DB deletion on a verified migration completion marker, or otherwise keep old data recoverable.

Verification:
- Add RED tests for DeepAgent execution/tool event path and unsafe legacy DB deletion.
- Run focused agent/kernel/cleanup tests.
- Run `pnpm typecheck`, `pnpm test`, `pnpm package:dir`, and `pnpm smoke:electron` if the focused fixes pass.

Progress:
- Restored plugin-owned DeepAgent execution by adding the default `createAgentDeepAgentExecutor` path to `@roc/plugin-agent`.
- Default bootstrap now injects the DeepAgent executor without restoring `createAppServices` or runtime delegate.
- DeepAgent executor now constructs `buildDeepAgent`, file/shell/web/MCP/skill tool surfaces, checkpoint/store, guardrail state, and interrupt policy from plugin capabilities.
- Agent runtime now routes normal runs through the executor when configured, preserves the full LangChain model handle, publishes tool/message/reasoning/subagent events, and leaves approval interrupts in `waiting_user`.
- DeepAgent resume now re-enters the executor with `Command({ resume })`, records `approval_decision`, and completes the original run after resumed output.
- Legacy monolith data cleanup now requires a verified `plugin-data/.migration-complete.json` marker before deleting `roc.sqlite*` files.
- Verification passed: `pnpm typecheck`, focused agent/kernel/cleanup suites, broader main/plugin suites, `pnpm test`, `pnpm package:dir`, `pnpm smoke:electron`, and `git diff --check`.

### Phase 0 - Evidence Inventory

- **Status:** complete

Work:
- 建立 planning files。
- 列出现有旧架构入口、旧数据入口、旧测试入口。
- 标记哪些 `src/main/services/*` 是可复用领域服务，哪些是 legacy composition/data coupling。

Verification:
- `rg` 证据覆盖 `createAppServices`、`DatabaseService`、`roc.sqlite`、`monolith-to-plugins`、legacy IPC。
- findings.md 有按模块分类的迁移清单。

### Phase 1 - Agent Runtime Ownership Design

- **Status:** complete

Work:
- 设计 `@roc/plugin-agent` 如何直接构建 DeepAgent runtime。
- 明确 DeepAgent runtime 依赖从 legacy services 改成 plugin-owned repositories、capability adapters、或 shared pure services。
- 拆出不能保留在 `app-service` 里的初始化逻辑。

Verification:
- 设计说明列出每个 DeepAgentRuntimeService 构造依赖的新来源。
- 无 `delegatedAgentRuntimeHost` 保留理由。

### Phase 2 - Data Boundary Removal

- **Status:** complete

Work:
- 停止 `RocPaths.databasePath`/`roc.sqlite` runtime 使用。
- 删除 monolith-to-plugin migration activation。
- 将仍需要的 session/task/memory/checkpoint 数据明确落到 plugin DB。
- 实现旧 monolith DB 精确文件删除，删除前校验 resolved path 仍在 `paths.root` 内。

Verification:
- `rg "roc.sqlite|monolith-to-plugins|activatePluginDataMigration|DatabaseService"` 无 runtime 命中，或仅剩删除计划中测试临时命中。
- 覆盖删除函数：root 外路径不删、目录不删、只删允许文件名、缺失文件幂等。

Progress:
- Added `deleteLegacyMonolithData` and tests.
- Default `createMainKernelBootstrap` now deletes legacy monolith DB files before plugin runtime activation.
- Default bootstrap no longer accepts/runs monolith migration activation.
- `StaticAgentModelFactoryAdapter` now exposes stream output, so default non-delegate plugin runtime supports microkernel tests.
- Deleted obsolete monolith migration module/tests.
- Removed `RocPaths.databasePath` / `DatabaseService` runtime surface after legacy service graph removal.

### Phase 3 - IPC And Bootstrap Cleanup

- **Status:** complete

Work:
- 简化 `createMainKernelBootstrap`。
- 删除 legacy service-specific IPC 文件或从构建/test 引用中移除。
- 保持 preload contract 不变，除非新架构明确改变 public API。

Verification:
- `registerIpc` 只注册 plugin capability adapter、settings/dialog/window/shell boundary handlers。
- IPC schema/check tests 通过。

Progress:
- `createMainKernelBootstrap` no longer imports or creates `createAppServices`.
- `delegatedAgentRuntimeHost` removed from default plugin construction.
- Default plugin list no longer passes `runtimeDelegate` to agent plugin.
- Agent plugin/runtime no longer exposes or branches through `runtimeDelegate`.
- Deleted legacy service-specific IPC files/tests; `registerIpc` now routes public domains through plugin capability adapter plus settings/dialog/window/shell boundary handlers.

### Phase 4 - Test Migration

- **Status:** complete

Work:
- 删除 `app-service-fixtures`。
- 将 legacy integration tests 改为 kernel/plugin fixtures。
- 删除 monolith migration/runtime activation tests。

Verification:
- Focused plugin/kernel/provider/deep-agent/task/memory suites 通过。

Progress:
- Deleted old `app-service-fixtures` and legacy app-service/task/memory/monolith DB tests.
- Kept provider/model regression coverage by migrating it to a direct provider fixture.
- Kept task cron coverage by moving cron utilities into the task plugin.

### Phase 5 - Final Cleanup And Gates

- **Status:** complete

Work:
- 删除死文件、死导出、旧脚本。
- 运行 typecheck/test/package/smoke。
- 做 completion audit。

Verification:
- `pnpm typecheck`
- `pnpm test`
- `rg` audit proves no old architecture/data path remains.

Progress:
- `pnpm typecheck` passed.
- `pnpm test` passed: 185 files, 944 tests.
- `git diff --check` passed.
- Old architecture grep finds no live `createAppServices`, `DatabaseService`, monolith migration, runtime delegate, or old DB path references outside legacy-data-cleanup/absence assertions and local plugin DB variable names.
- `pnpm package:dir` passed and produced `release\win-unpacked\Roc.exe`.
- `pnpm smoke:electron` passed against the packaged runtime.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---|---|
| none | none | none |
