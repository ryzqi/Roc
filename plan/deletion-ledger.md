# S00 生产代码删除台账

日期：2026-11-06。基线：`eea2087b5d2d79df3b2fea7764ce48e4975fd764`。
S00 固定范围；S01 完成 D09；S02 完成 D01～D06、D12 及 D10 的事件/诊断部分。
S02 的切换和验证证据见 [执行报告](s02-execution-report.md)。
S03 完成 D07/D08 与空摘要继续路径删除，见 [S03 执行报告](s03-execution-report.md)。
替代名称表示责任合同，具体新符号在实施时登记；不能为了完成台账提前建立 alias。

## 按符号与调用方切换

| ID / 阶段 | 当前符号或分支 | 替代责任 | 真实消费者 | 删除验证 / 状态 |
| --- | --- | --- | --- | --- |
| D01 / S02 | [agent.ts](../src/shared/schemas/agent.ts)：`legacyRunBudgetSchema`、`runExecutionSnapshotV7Schema`、`runExecutionSnapshotV8Schema`、`legacyRunExecutionSnapshotSchema`、`runExecutionSnapshotAnySchema` | 单一目标 snapshot schema v10；有限离线来源转换见迁移台账 | snapshot helper、session repository、grant broker、execution-grant tests/fixture | `rg` 确认生产旧符号零引用；旧输入在生产拒绝；类型/IPC、授权与恢复回归；complete（S02 工程，见 s02-execution-report.md） |
| D02 / S02 | [run-execution-snapshot.ts](../src/main/plugins/agent/run-execution-snapshot.ts)：`migrateLegacyRunExecutionSnapshot` | 离线预检与迁移工具，业务 reader 只读当前版本 | [session-repository.ts](../src/main/plugins/agent/session-repository.ts) `getRunExecutionSnapshot`；[execution-grant-broker.test.mjs](../tests/unit/execution-grant-broker.test.mjs)；[fixture](../tests/unit/fixtures/execution-grant-test-api.ts) | 删除生产 export/import 与 runtime upgrade；fixture 不再导出旧业务转换器；历史数据拒绝/冷恢复有回归；complete（S02 工程，见 s02-execution-report.md） |
| D03 / S02 | `AgentSessionRepository.getRunExecutionSnapshot` 接受 7/8/9、读时 UPDATE 与递归重读分支；broker 对 any schema 的两处解码 | v10 明确读取失败；转换先停机完成；grant 只校验 v10 冻结身份 | [runtime.ts](../src/main/plugins/agent/runtime.ts) 的 resume/telemetry/control；grant `assertResearchRun` 与 dispatch 校验 | 数据 reader 无副作用升级；同版本 resume 与跨版本拒绝；grep 旧版本常量需人工排除离线迁移/历史 fixture；complete（S02 工程，见 s02-execution-report.md） |
| D04 / S02 | [stage-runtime.ts](../src/main/plugins/research/stage-runtime.ts)：`start(request, dispatch = null)` 的外部可执行直达路径；executor undefined 分支；必需 effect cleanup 的可选跳过 | 显式可信执行输入：区分 conversation dispatch 与 main-owned retry/child；必需 executor、effect coordinator | [research-tools.ts](../src/main/plugins/agent/research-tools.ts)、research capability runtime、组合根、stage fixture | 全调用方必须提供可信 origin；无 token 的 wire 输入拒绝；内部 child/retry 不能靠省略授权；取消等待真实 cleanup；complete（S02 工程，见 s02-execution-report.md） |
| D05 / S02 | [AgentPluginRuntimeOptions](../src/main/plugins/agent/runtime.ts)、[RunHarnessServices](../src/main/plugins/agent/run-harness.ts) 中研究执行必需 broker 的可选分支；run revoke 的 optional chaining | 组合边界显式 research execution services；未启用研究能力用明确 capability 状态 | [main-kernel-bootstrap.ts](../src/main/main-kernel-bootstrap.ts)、`buildRunHarness`、`createManifestAuthorizedResearchTools`、stage dispatch | 缺必需 broker 构造失败；研究权限/撤销真实回归；保留非执行性的可选通知与观测 hook；complete（S02 工程，见 s02-execution-report.md） |
| D06 / S02 | [role-executor.ts](../src/main/plugins/research/role-executor.ts) 与 stage/task 控制中独立的通用执行身份/恢复/终止协议 | 共用通用执行协议；Task Controller 仍协调根任务，stage repository 仍产出领域结果 | `ResearchStageRuntime.prepareRole/executeOutput/continueTask`、`ResearchTaskController`、组合根 | stage 同身份恢复或明确新尝试、cleanup 失败传播、跨库 intent 故障回归；不整文件盲删；complete（S02 工程，见 s02-execution-report.md） |
| D07 / S03 | [research-skills.ts](../src/main/plugins/research/research-skills.ts)：11 个 `?raw` 导入、`skills` 映射、`getResearchSkillInstructions` | 必填 Manifest registry + 受校验内容读取；保留 11 份 Skill 内容并赋版本/hash/许可 | [run-repository.ts](../src/main/plugins/research/run-repository.ts) `captureContext`、role executor、[builtin-skills tests](../tests/unit/builtin-skills.test.mjs) | 11/11 受 registry 管理；无 Manifest 失败；raw stage 映射及旧函数生产引用为零；complete（S03 工程，见 s03-execution-report.md） |
| D08 / S03 | [context-assembler.ts](../src/main/services/deep-agent/context/context-assembler.ts) 的 `allowedToolNames ?? [...]`；role executor 单独拼装硬约束/事实/来源 prompt | 唯一 context assembler、显式 permission intersection、分层冻结来源 | chat harness、stage executor、context/facts/budget tests | 无省略权限默认授权；Writer/Reviewer 隔离、来源失效与摘要不增权回归；complete（S03 工程，见 s03-execution-report.md） |
| D09 / S01 | [quality-evaluation/runner.ts](../scripts/harness-eval/quality-evaluation/runner.ts) 与 data/protocol/audit 的 pilot-only 输入限制 | `loadQualityDatasetPackage` + `runQualityEvaluationWithJournal`，同一 runner 接受冻结 split 与隔离 adapter；原 16 项迁入测试 fixture | quality check CLI、run.mjs、context-long-task、quality-runner/evaluation/dataset/application-adapter tests | complete（工程）；删除 data.ts 与 runQualityPilot/qualityPilotAudit，生产旧 API 零引用；30 专项、1481 unit、94 harness、typecheck/build 通过；证据见 evaluation/engineering-verification.json |
| D10 / S02～S07 | [research-tasks.ts](../src/shared/schemas/research-tasks.ts) 旧 Task event DTO；改动涉及的 [ipc-registry.ts](../src/shared/ipc-registry.ts) 与 [generated preload](../src/preload/ipc-api-generated.ts) 旧 DTO 签名 | 当前 envelope 与 execution/diagnostics 合同，同步生成 IPC | task-capabilities、`getTaskEvents/getTaskDiagnostics/listTasks`、[ResearchTasksSection.tsx](../src/renderer/management/sections/ResearchTasksSection.tsx)、fixtures/tests | `check:ipc`、消费者 typecheck、真实抽屉路径；不新增旧通道 alias；未变化的 IPC 方法不因重构盲删；S02 complete；后续阶段新增合同按对应阶段继续 |
| D11 / S06 | 无 DAG 的 stage 局部 scheduling 分支中被 node scheduler 替代的 dispatch/重试决策 | Task node scheduler + repository 原子 claim；领域 executor 保留执行 | `ResearchStageRuntime.schedule/linkAndSchedule`、review children、Task Controller | 无两份 scheduler；revision/lease/fence/依赖/取消恢复专项；并行无收益时新 scheduler concurrency=1；pending |
| D12 / S02 | [tool-effect-store.ts](../src/main/services/deep-agent/tool-effect-store.ts) 的 identity v0 正常业务 upgrade/read 分支 | 当前 identity v1 操作合同；旧行离线有限转换或只读审计隔离 | reserve/read/reconcile、[tool-effect-store tests](../tests/unit/tool-effect-store.test.mjs)、checkpoint/effect 恢复 | 未知副作用不自动重做；无法重建身份的历史回执保留、阻止继续；不能删除真实旧 receipt；complete（S02 工程，见 s02-execution-report.md） |

## S05 增补

D13：`LiteratureExecutionContext.queryIndex`、无 ID 的 plan 执行参数与旧审批 UI 字段已删除，
切换到 schemaVersion/version/queryId、perspective 和持久化预算占用；stage search plan 的工具、context、ledger 和 import 执行路径中
queryIndex 零引用；独立 systematic review 协议仍使用其已有冻结版本/数组索引。旧数据只经离线转换器成为历史审计/文本，不进入执行授权。
消费者、冷迁移和构建证据见 [S05 执行报告](s05-execution-report.md)。状态 complete（工程）。

## 不列入代码清理

以下仍为有效责任：通用 Agent runtime、领域 begin/complete、Task/Effect/预算唯一 ledger、
Roc compactor、人工 Evidence relation、真实审批与 I/O 验证、单 AppShell/管理抽屉。
历史迁移记录与旧 SHA 的隔离评价材料具有审计价值，不能按 `legacy/old` 名称批量删除。
用户工作区、文稿、来源、历史事件和科研记录不是被替代代码。

只有接口确实变更的消费者同步删除旧路径。目录迁移不产生 re-export、
`new ?? old` 或兼容 dispatcher。有关的新测试验证行为；仅断言旧结构的测试可以删除。

## 每次实施必须补齐

逐行登记新符号/路径、切换 SHA、消费者更新、实际删除范围、零引用检查与回归日志。
旧代码清零不代表历史数据转换通过；后者单列在 [迁移台账](migration-ledger.md)。
删除行只有替代合同、消费者、数据边界与验证全部成立才改为 `complete`。
