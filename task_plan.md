# Roc 架构优化执行计划

## 目标

依次完成 `plan/00-overview.md` 定义的 9 个架构优化阶段。每阶段必须完成实现、直接验证、子代理双轴审查、问题修复、复验和独立提交，之后才进入下一阶段。

## 范围

- 计划源：`plan/00-overview.md`、`plan/phase-1-*.md` 至 `plan/phase-9-*.md`
- 产品代码：仅各阶段明确列出的 main/preload/renderer/shared/test 路径
- 文档：阶段状态、执行发现和验证证据

## 约束

- 保留用户现有变更；不执行破坏性 git 操作。
- 不修改 deepagents vendor 版本。
- 不保留旧路径、兼容层、迁移胶水或静默 fallback。
- 每阶段使用该阶段开始时的 HEAD 作为 review fixed point。
- 每阶段先跑目标测试，再跑 `pnpm typecheck` 和 `pnpm test`；按风险追加 IPC/build/smoke 检查。
- 审查问题必须修复并复验后才能提交。

## 权威事实与当前假设

- 权威计划：`plan/00-overview.md` 及对应 phase 文件。
- 权威项目规则：`AGENTS.md`、`package.json`、`C:\Users\任彦舟\.codex\RTK.md`。
- 当前分支：`main`；开始时 HEAD 为 `45168f1`，相对 `origin/main` ahead 38。
- 当前未跟踪内容：`plan/`。所有权视为用户已有内容，执行中保留。
- 根因目前来自计划，尚待逐阶段代码验证：事件流被当作跨层数据通道、契约多处重复、repository/adapter seam 泄漏。

## 验收标准

- 9 个阶段均为 `complete`。
- 每阶段有目标行为测试、通用验证、双轴子代理审查及问题闭环记录。
- `plan/00-overview.md` 阶段状态与提交记录同步。
- 最终全量门禁通过；未运行项必须明确标记 `Blocked, not run` 及原因。

## 阶段

| 阶段 | 主题 | 状态 | 阶段门槛 |
| --- | --- | --- | --- |
| 1 | Interrupt 生命周期收敛 | complete | 实现 -> 验证 -> Standards/Spec 子代理审查 -> 修复 -> 提交 |
| 2 | session-repository 跨 seam 裸 SQL 收口 | complete | 同上 |
| 3 | executor 返回结构化 RunOutcome | pending | 同上 |
| 4 | IPC 契约单源化 | pending | 同上 + `pnpm generate:ipc` / `pnpm check:ipc` |
| 5 | Stream adapter 领域事件与投影合并 | pending | 同上 |
| 6 | task-repository 聚合化与按名注册 | pending | 同上 |
| 7 | Shell 安全 policy 单源 | pending | 同上 |
| 8 | 插件 DB 隔离 seam 修复 | pending | 同上 |
| 9 | 死代码与零深度微文件清理 | pending | 同上 + strict unused scan |

## 当前步骤

提交阶段 2；提交完成后读取阶段 3 计划并以新 HEAD 作为 fixed point。

## Errors Encountered

| 时间 | 错误 | 尝试 | 处理 |
| --- | --- | --- | --- |
| 2026-08-16 | PowerShell 默认输出编码导致中文计划显示乱码 | 1 | 显式使用 UTF-8 读取，后续沿用该方式 |
| 2026-08-16 | 并行命令中 `git check-ignore` 以“未忽略”返回 exit 1，导致组合调用失败 | 1 | 拆分读取；后续对预期 exit 1 的查询显式处理，不重复组合方式 |
| 2026-08-16 | 嵌套 PowerShell 行号读取脚本的 `$` 变量被外层 shell 提前展开 | 1 | 改用单引号包裹 `powershell.exe -Command` 脚本，避免外层插值 |
| 2026-08-16 | PowerShell 行范围脚本中单元素嵌套数组自动展开，`[Math]::Min` 参数类型错误 | 1 | 不再构造范围数组；改用固定 `Select-Object -Skip/-First` 读取 |
| 2026-08-16 | `pnpm test -- <files>` 在当前 Vitest 4 脚本中把 `--` 传给 Vitest，误跑 323 个文件 | 1 | 后续目标测试使用 `pnpm exec vitest run <files>`；全量仍使用 `pnpm test` |
| 2026-08-16 | 误跑全量时 Node 25 的 node-pty console helper 报 `AttachConsole failed` | 1 | 记录为环境噪声；阶段门禁若重现，核对项目支持 Node 版本和 smoke 结果 |
| 2026-08-16 | 新 `interrupt-projection.ts` 引用 `record-utils` 的相对路径少了两层 | 1 | 改用现有模块真实路径 `../../services/deep-agent/record-utils` |
| 2026-08-17 | executor interface 首次 typecheck 有 69 项错误：4 项产品类型问题，其余为测试 fake 仍返回 AsyncGenerator | 1 | 先修产品类型，再用显式 execution/outcome helper 迁移测试；拒绝 legacy union/fallback |
| 2026-08-17 | AST 迁移脚本使用 TypeScript 默认 ESM 导入，`ScriptTarget` 未定义 | 1 | 改用 `import * as ts from 'typescript'`；确认失败发生在任何写入前 |
| 2026-08-17 | 当前 Node ESM 对 TypeScript 只暴露 `default/module.exports`，namespace import 仍无 compiler API | 1 | 脚本改用 `createRequire()` 加载 CommonJS compiler API |
| 2026-08-17 | TypeScript 7 包的 CommonJS 入口同样不含 compiler API | 1 | 放弃 AST；改用限定语法且处理字符串/注释的括号扫描，并用 typecheck/diff 验证 |
| 2026-08-17 | 全量 Vitest 首次重跑出现 1 个断言失败和 2 个未处理 rejection：事件流失败时 outcome 未消费 | 1 | runtime 在事件流异常/取消早退边界消费 outcome；execution 工厂和测试 helper 立即注册 rejection handler；聚焦测试复验通过 |
| 2026-08-17 | Standards 审查发现迁移后两个未使用类型导入 | 1 | 清理 `interrupt-projection.ts` 与 `runtime-types.ts` 导入；strict unused tsc 通过 |
| 2026-08-17 | 双轴子代理 `wait_agent` 多次超时，但 agent 已完成 | 2 | 使用 `close_agent` 读取完成报告；修复后复审同样取得 PASS 报告 |
| 2026-08-17 | projection 直测首次因 FK 夹具缺失失败，提前停止测试因 mock 不响应 abort 超时 | 1 | 补真实 thread/run 夹具；让受控 provider 显式 reject/close 后验证 outcome settle |
| 2026-08-17 | 阶段 2 首次全量测试的 `terminal-session-service` 因 Node 25/ConPTY 关闭事件未到达并触发临时目录 EPERM | 1 | 单测复跑 4/4 通过；全量复跑 324 文件/1818 项通过，确认环境波动而非阶段回归 |
