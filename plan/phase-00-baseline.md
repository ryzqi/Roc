# S00：当前基线、能力清单与重构合同

优先级：P0。依赖：无。来源：WP-00、RH-00/RH-01。
实施状态：complete。开始/完成日期：2026-11-06。建议时间：第 1～2 周。
验收状态：`Verified passing（S00 文档与当前工程基线）`。

## 目标与关口

建立当前 SHA 上的真实能力、缺口和消费者清单，固定重构后的唯一所有权与删除范围。
当前六项检查均通过，新日志已固定；静态清单不代替后续运行行为验证。
完成后 S01、S02 可独立推进，本轮未启动。

## 当前起点

- [仓库核对](findings.md)记录当前 HEAD `eea2087b`，来源与历史账本使用其他 SHA。
- [数据库迁移](../src/main/infrastructure/database-migrations.ts)、
  [数据库 schema](../src/main/infrastructure/database-schemas.ts)与插件 repository 决定实际持久化。
- [CONTEXT.md](../CONTEXT.md)和 ADR 0020/0022/0023/0024/0027 是当前产品合同。
- `docs/` 多项路径被 Git 忽略；新 ADR 的跟踪条件必须核对，不用忽略文件假装已交付。

## 按顺序执行

- [x] **RH-00.1 固定基线**：记录 HEAD、dirty diff、Node/pnpm、实际安装依赖、macOS/arm64、
  Electron runtime 和现有 DB schema。只使用隔离测试数据，避免启动生产用户数据迁移。
- [x] **RH-00.2 能力 inventory**：逐项列 AgentRun、StageRun、Task、Event、checkpoint、
  grant、effect、budget、resource、Evidence/Claim、facts、retrieval、Skill、export、Eval。
  每项填写接口、表、拥有者、状态机、取消/恢复、消费者、测试和未测范围。
- [x] **RH-00.3 消费者图**：沿 `runtime → run-harness → stage/runtime → repository → IPC/preload → UI`
  核对真实调用；分别画 execution identity、授权、预算和证据版本流。
  已有 CodeGraph 只用于定位，不刷新索引。
- [x] **RH-00.4 当前检查**：跑下面最小基线集，登记通过和失败。
  遇预存失败复现并归因；不把旧账本的通过记录复制成当前结果。
- [x] **RH-01.1 固定目标合同**：按[统一合同](contracts.md)选定模块拆分、root/node/execution
  边界、当前版本 schema、事件传播与可观测输出，不以搬目录充当重构成果。
- [x] **RH-01.2 固定迁移清单**：列每个持久化版本是否需要转换，明确输入/输出版本、
  旧活跃 run 收束、用户数据备份、一次性转换、拒绝条件和冷恢复。
- [x] **RH-01.3 固定删除清单**：逐符号登记旧 runtime 分支、可选依赖兜底、raw Skill、
  旧 IPC/schema 和单独状态机的替代路径；每项附真实调用和删除验证。
  已满足目标合同的实现可继续使用，不为了“重构量”删有用代码。
- [x] **RH-01.4 决策文档**：形成执行/任务依赖、科研核验、Skill 合同三个 ADR，
  编号取仓库下一个可用编号。更新计划入口，不另复制一份完整 roadmap。

## 交付物

本阶段交付路径：

- [capability-inventory.md](capability-inventory.md)：能力、所有权、schema、测试、缺口与消费者。
- [baseline.json](baseline.json)：完整 SHA、环境、检查结果、数据 hash 和证据路径。
- [deletion-ledger.md](deletion-ledger.md)：旧符号、替代者、消费者和删除状态。
- [migration-ledger.md](migration-ledger.md)：明确的持久化升级与匹配版本冷恢复合同。
- [ADR 0028](../docs/adr/0028-execution-task-ownership.md)、
  [0029](../docs/adr/0029-scientific-verification-boundaries.md)、
  [0030](../docs/adr/0030-required-skill-contracts.md)；实际已允许跟踪，无需改 `.gitignore`。
- `.artifacts/research-harness/S00/` 当前基线日志与依赖图。

## 本阶段删除范围

仅删除盘点过程发现的任务临时脚本和调试输出；不在基线尚未固定时提前删 Runtime。
历史验收文档保持历史含义。规划不创建兼容 adapter、第二个 ledger 或多版本 dispatcher。

## 验证命令

从仓库根目录依次执行并保存日志：

```bash
pnpm typecheck
pnpm check:ipc
pnpm test:unit
pnpm harness:quality:check
pnpm build
node scripts/smoke-electron.mjs
```

本阶段用现有实际入口建立离线基线，付费/外部接口不加入基线集。
验收 inventory 中的路径、能力和表名；所有“已实现”指向源码，
所有“本 SHA 验证通过”指向新日志。新 ADR 和 ledger 确认未被 Git 忽略。

## 接受标准与下一步

AC-01、AC-18 的基线部分成立，数据/授权/版本/删除范围可追踪。
本 SHA：1469 个 unit 全通过、16 pilot offline audit 通过、build 与 13/13 smoke 通过；
完整结果见 [进度记录](progress.md)。smoke 使用 dist-main 构建且 `full=false`。
生产数据迁移/冷恢复、独立科学评价、外部服务和发布未运行。
预存失败有复现记录及影响范围；不能将失败范围宣布为通过。
S00 工程基线未解决的阻断必须标明影响哪个后续阶段，不阻止独立的文档与数据标注。
通过 G-A 后启动 S01 评测和 S02 执行合同。
