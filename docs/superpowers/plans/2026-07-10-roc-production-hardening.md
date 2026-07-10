# Roc Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按五个独立验收批次完成 Roc 的安全、数据一致性、数据库生命周期、renderer 性能和动画交互生产加固。

**Architecture:** 本索引只定义执行顺序、跨批接口和完成门禁；每个批次的失败测试、精确文件、接口和实现代码位于独立计划。每批严格执行 `失败测试 -> 实现 -> review -> 修复 -> 验证 -> commit`，批内不做中间提交。

**Tech Stack:** Electron 42、React 19、TypeScript 6、Zod 4、better-sqlite3 12、LangChain 1.5、LangGraph 1.4、Vitest 4、Playwright 1.61、PowerShell。

## Global Constraints

- 直接在 `main` 工作；不创建分支，除非用户后续明确要求。
- 默认无损保留现有数据库、历史会话、后台任务、interrupt、tool effect 和恢复连续性。
- 不新增兼容别名、双协议、迁移胶水、用户配置项、未来扩展点或无关重构。
- 关键字段缺失、cursor 非法、schema 不匹配和恢复状态未知必须显式失败。
- 不用 `??`、`||` 或等价默认值掩盖关键合同破坏。
- 不把 DeepAgents `/workspace/` 虚拟路由当成 Windows shell cwd。
- 生产代码必须先有稳定失败测试；测试断言业务结果、状态、side effect 或错误分支。
- 每批只在 review 问题修复且直接验证通过后提交一次。
- 修改 `src/shared/ipc.ts` 或共享 IPC schema 后运行 `pnpm generate:ipc` 与 `pnpm check:ipc`。
- 不修改 `dist/`、`release/`、`node_modules/`。

---

## Plan Map

| 顺序 | 批次 | 详细计划 | 唯一提交 |
|------|------|----------|----------|
| 1 | 安全边界 | `docs/superpowers/plans/2026-07-10-roc-production-hardening-01-security.md` | `fix: harden renderer security boundaries` |
| 2 | 数据一致性 | `docs/superpowers/plans/2026-07-10-roc-production-hardening-02-consistency.md` | `fix: make thread deletion recoverable` |
| 3 | 数据库生命周期 | `docs/superpowers/plans/2026-07-10-roc-production-hardening-03-database-lifecycle.md` | `feat: activate database maintenance lifecycle` |
| 4 | Renderer 性能 | `docs/superpowers/plans/2026-07-10-roc-production-hardening-04-renderer-performance.md` | `perf: bound renderer history and startup cost` |
| 5 | 动画与交互 | `docs/superpowers/plans/2026-07-10-roc-production-hardening-05-motion-interaction.md` | `fix: complete dialog and history interactions` |

## Cross-Batch Interfaces

- 批次一把 `task.background.create` 从 `BackgroundTaskPreview` 改为 `BackgroundTaskPreviewRequest`；后续批次只使用新合同。
- 批次二新增 task migration v2；批次三在此基础上新增 core migration v2，不能改写已提交 migration SQL。
- 批次四新增 agent migration v2 的 `(thread_id, sequence)` cursor 索引；这是为满足 query-plan 验收补正设计规格中的索引遗漏，不回填新 cursor 字段。
- 批次四新增 `PersistedTaskEvent`、sequence page contract 和 `ChatTranscriptMessage.source`；批次五直接消费 `source`，不再定义第二套 persisted/live 判定。
- 批次四把 Settings 与重型页面 lazy 化；批次五的 `AnimatePresence` 必须位于 lazy boundary 外侧。
- 数据库 maintenance lease 与 restore CLI 只操作真实 Windows data root，不接受 `/workspace/` 路由。

## Per-Batch Gate

每份详细计划末尾都执行以下顺序：

1. 运行本批 focused tests，并确认新增回归先红后绿。
2. review 当前未提交 diff，先列问题，按严重度排序并带文件和行号。
3. 修复 review findings；若修复改变行为，补失败测试并重跑 focused tests。
4. 运行本批要求的 IPC、migration、build、smoke 或 package 额外门禁。
5. 运行 `pnpm typecheck` 和 `git diff --check`。
6. 只暂存本批文件并核对 `git diff --cached --stat`。
7. 使用计划表中的唯一提交信息提交。

## Completion Audit

- [ ] **Step 1: Confirm all five batch commits exist in order**

Run:

```powershell
git log -5 --oneline
```

Expected: 最近五个生产代码提交依次对应五个计划中的提交信息，不混入下一批文件。

- [ ] **Step 2: Run strict unused scan**

```powershell
pnpm exec tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters
```

Expected: exit code `0`。

- [ ] **Step 3: Run repository-wide verification**

```powershell
pnpm typecheck
pnpm check:ipc
pnpm build
pnpm test
node tests\smoke\responsive-layout-smoke.mjs
pnpm smoke:electron
pnpm smoke:performance
git diff --check
```

Expected: 每条命令 exit code `0`；performance smoke 报告固定预算通过，而不是 soft warning。

- [ ] **Step 4: Run packaging verification because batch three adds a main CLI entry**

```powershell
pnpm verify:native-packaging
pnpm package:dir
```

Expected: 两条命令 exit code `0`，`release\win-unpacked` 中包含可由 package scripts 调用的 maintenance CLI bundle。

- [ ] **Step 5: Review the final worktree**

```powershell
git status --short --branch
git diff --check
```

Expected: `main` 分支；工作树没有遗漏的生产改动或生成文件漂移。Review 逐项回读 design spec 第 15 节的 18 条覆盖项并记录“未发现问题”或精确 findings。
