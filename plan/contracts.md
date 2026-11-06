# 目标架构、运行合同与切换规则

本文件定义阶段实施的共同合同。文件名为“计划新增”的项尚不存在，
不是当前代码能力声明。新增 API 在实施时对照安装包类型和官方文档核实。

S00 当前能力与调用依据见 [能力清单](capability-inventory.md)；
允许的来源/目标版本、停机与冷恢复见 [迁移台账](migration-ledger.md)，
逐符号切换见 [删除台账](deletion-ledger.md)。三项目标决定记录于
[ADR 0028](../docs/adr/0028-execution-task-ownership.md)、
[ADR 0029](../docs/adr/0029-scientific-verification-boundaries.md)、
[ADR 0030](../docs/adr/0030-required-skill-contracts.md)。

## 1. 架构所有权

重构沿用 Electron、TypeScript、React、Deep Agents、LangGraph 和本地 SQLite。
允许拆分或重写现有模块，但每种事实只有一个生产写入者，不能平行保留两套 Runtime。

| 责任 | 当前入口 | 目标责任与边界 |
| --- | --- | --- |
| 通用 run | [runtime.ts](../src/main/plugins/agent/runtime.ts)、[run-harness.ts](../src/main/plugins/agent/run-harness.ts) | 唯一聊天启动/恢复、冻结 snapshot、Deep Agent 装配、事件发布 |
| 科研执行 | [stage-runtime.ts](../src/main/plugins/research/stage-runtime.ts)、[task-controller.ts](../src/main/plugins/research/task-controller.ts) | 阶段工具和根任务控制调用统一执行协议；不能各自重定义 run |
| Task identity | [research-task-repository.ts](../src/main/plugins/research/research-task-repository.ts) | 根任务、execution 关联、DAG 节点/边/lease 在同一 agent DB 事务边界 |
| Effect | [tool-effect-store.ts](../src/main/services/deep-agent/tool-effect-store.ts) | 唯一操作幂等记录、attempt、receipt、对账与真实提交 |
| 预算/资源 | [run-budget-ledger.ts](../src/main/services/deep-agent/run-budget-ledger.ts)、[project-budget-ledger.ts](../src/main/services/deep-agent/project-budget-ledger.ts)、[tool-resource-coordinator.ts](../src/main/services/deep-agent/tool-resource-coordinator.ts) | 预留和结算、共享资源互斥；调度器不再计费或重复授予资源 |
| 权限 | [execution-grant-broker.ts](../src/main/services/deep-agent/execution-grant-broker.ts)、[role-profiles.ts](../src/main/plugins/research/role-profiles.ts) | 主进程可信身份、角色白名单、Manifest、grant 和实际 I/O 校验 |
| 科研事实 | [evidence-relation-repository.ts](../src/main/plugins/research/evidence-relation-repository.ts)、[citation-coverage-service.ts](../src/main/plugins/research/citation-coverage-service.ts) | 现有 Evidence/Claim/Locator/人工关系是真实数据源；模型只新增可失效建议 |
| Skill/context | [research-skills.ts](../src/main/plugins/research/research-skills.ts)、[context-compaction-pipeline.ts](../src/main/services/deep-agent/context/context-compaction-pipeline.ts)、[task-facts-store.ts](../src/main/plugins/research/task-facts-store.ts) | 必填 Manifest registry 替代 raw 映射；唯一上下文装配和来源约束 |
| Eval | [quality-evaluation/](../scripts/harness-eval/quality-evaluation/) | 当前协议/runner/统计全量化，统一 fixture 与真实 adapter 输入边界 |
| UI | [AppShell.tsx](../src/renderer/app/AppShell.tsx)、[ResearchTasksSection.tsx](../src/renderer/management/sections/ResearchTasksSection.tsx)、[artifacts/](../src/renderer/artifacts/) | 助手执行，任务抽屉观察，现有检查器审查；不加第二个任务路由 |

计划允许在 `src/main/plugins/research/` 内形成 `execution/`、`verification/`、
`retrieval/`、`skills/` 等职责清晰的子模块。只有依赖与所有权改善成立才移动文件；
移动时更新全部 import 和消费者并删除原文件，不建立兼容 re-export。
S00 固定实际拆分清单，后续阶段不能临时引入第三套框架或数据库。

## 2. 身份、版本与授权

- 可信主进程绑定 `projectId/threadId/runId/taskId`；模型和 wire 输入不能创建审批主体。
- 同版本恢复延续 run 身份与 checkpoint 线程；`attemptId` 改变不代表新研究任务。
- `stageRunId`、领域 job 和 DAG node 必须有真实 execution 关联，缺失关联显式拒绝写入。
- 每次输入冻结 source/artifact/plan/Skill/manifest/policy 版本与 hash。
- 用户审批绑定具体操作、项目、审批范围、预算和冻结请求 hash，版本变化使审批失效。
- 审稿建议、质量检查通过和“研究结论可信”不能替代公开发布授权。
- 归档项目只读，继续或恢复前仍需检查项目状态。

## 3. 显式合同，禁止成功形兜底

内部必需依赖改为构造时显式输入，例如 executor、grant broker、receipt reader、
diagnostic root、clock 与 repository；配置缺失在组合边界失败。
不在内部层层尝试“可选服务 → 默认实现 → 空结果”。

下列代码模式在被重构范围内删除：

- `catch` 后返回空列表、成功或虚构 receipt。
- 未知费用填 `0`、缺失版本使用“当前版本”冒充执行时版本。
- 旧枚举默认归为已完成、旧 approval 默认有效。
- `new ?? old`、双写、旧 API alias、兼容 re-export 和 schema decoder fallback。
- 以“网络错误”统一重试策略拒绝、来源过期、人工退回或副作用未知。

保留真正的外部边界 schema、路径/身份/授权校验、事务和错误传播。
预期的缺失观测、部分检索、未知费用使用显式联合状态；损坏或跨项目数据必须失败，
不能把错误转换成普通未知状态。

## 4. 根任务、节点、执行和 Effect

四者含义分别是：研究目标及总预算、可调度工作单元、一次实际尝试、真实操作副作用。
当前根任务 schema v2 的状态不能直接被节点状态覆盖。

节点目标状态：

```text
blocked → ready → claimed → running → result_pending_review → done
                    ↘ failed / cancelled
```

- 图必须无环；依赖只允许同一项目、同一根任务的节点。
- `done` 才满足下游依赖；`result_pending_review` 不能自动释放需要审核的后继。
- 根任务 pause 阻止新 dispatch，等待实际 cleanup；continue 重新核对输入和未决 effect。
- claim 使用短 SQLite 事务，含 `expectedRevision`、单调 `leaseGeneration`、
  `leaseExpiresAt`、worker identity。事务提交后才启动外部 worker。
- 过期 lease 的只读节点可在确认旧 worker 失去提交资格后重新入队；
  写节点或未知 effect 必须先对账。旧 generation 永远不能提交结果。
- `result_pending_review` 期间不持有执行 lease；审核绑定 node revision 与结果 hash，
  使用 CAS 提交，避免把人工等待误判成 worker 租约超时。
- 所有下游输出都校验 input versions、node revision、有效 lease 与结果 schema。
- Task lease 不替代已有 Effect lease；重试使用同一业务 operation key，
  attempt 单独编号。未知副作用不因换 attempt 获得再次执行资格。
- 节点调度预算先引用现有 reservation；同一 call 不在任务、run、stage 三次相加。

## 5. 事件、回放与恢复

Chat event 服务实时/UI 投影；Task event 保存任务执行和科研关键事实；checkpoint 保存可恢复图状态。
补科研事实时扩展现有事件存储，不另建同义科研 Event DB。

统一新事件 envelope 包含 schemaVersion、eventId、project/task/run 关联、
sequence、occurredAt、actorType、correlation/causation ID 与必要的 payload hash/ref。
事件序列、状态事务和重复提交的处理必须在 S02 定义，跨 DB 操作不能声称单事务原子性。

三种回放明确分开：

| 模式 | 保证 | 操作权限 |
| --- | --- | --- |
| projection replay | 保留事件范围内状态折叠确定一致 | 不触发真实工具 |
| recorded tool replay | 校验固定 receipt 后模拟输出 | 不访问真实外部系统 |
| live re-execution | 执行新的尝试，模型/网络结果可不同 | 按当前权限和具体副作用重新授权 |

缺事件、裁剪、损坏、缺收据和外部状态未核实各有显式状态。不能用 UI 事件恢复代替 checkpoint；
不能把新执行称为已记录结果的重放。诊断包继续遵守既有 2 MiB 边界和脱敏字段合同。

## 6. Skill、科研建议和 Context

- 11 个内置 stage Skill 全部必填 Manifest，未知许可、能力、hash 或输出 schema 拒绝加载。
- 可执行 capability 为角色白名单、run Manifest、Skill requirement、grant scope 的交集。
  文本与 Manifest 声明不授予权限。
- Writer 与 Reviewer 使用隔离上下文；Verifier 返回建议，不修改人工证据审核状态。
- verdict 固定为 `supports/qualifies/contradicts/unrelated/insufficient/unable_to_verify`。
- verdict/finding 绑定 claim、source、artifact、规则、模型与 Skill 版本；任一输入变化失效。
- 确定性质量门直接执行；语义门先进入人工审查。经独立评测和明确产品决定后才可强化，
  不能默认让 AI 终止项目或通过闸门。
- Context 分硬约束/人工决定、来源绑定 task facts、证据引用、可压缩 transcript。
  摘要不能变成证据或授权源。
- 遵守 [ADR 0027](../docs/adr/0027-retain-roc-context-compaction.md)：
  Roc compactor 仍是唯一压缩器，不并行启用上游 SummarizationMiddleware。

## 7. 无兼容切换与数据安全

| 对象 | 切换方式 | 禁止事项 |
| --- | --- | --- |
| TS/API/IPC | 一次切换调用方、registry、preload、生成 schema 和测试 | alias、旧通道、运行时 fallback |
| Skill | 所有内置 Skill 同阶段转为必填 Manifest | 无 Manifest 降级为提示或 raw 旧加载 |
| 当前生产 schema | 只接受新目标版本；不兼容版本明确失败 | 多版本 decoder、未知枚举默认成功 |
| 历史持久化数据 | 停机备份、离线预检、有限一次性转换、完整性报告 | 自动删用户数据、运行中双写、静默丢旧 evidence |
| 跨版本活跃 run | 升级前停止/收束；不兼容 snapshot 不跨版本恢复 | 用最新权限执行旧 snapshot |
| 回滚 | 停机后恢复匹配旧应用版本与迁移前完整备份；核对外部 effect | 只换 UI、旧应用直接读新 DB、生产保留双路径 |
| A/B | 固定旧 SHA 的隔离环境与新环境，共用冻结评价协议 | 在新生产 Runtime 中保留旧实现开关 |

一次性迁移是数据转换工具，不是业务向后兼容。只支持 S00 明确列出的来源版本和目标版本，
不建立泛用历史版本加载框架。备份保留原事件；必要审计关联可使用转换映射和 legacy hash。
迁移无法准确重建的执行时版本不能伪造，新审核和审批必须重新取得。

迁移记录写入完整来源/目标 schema、备份校验、行数、ID/ref/hash 映射和失败原因。
程序版本不匹配立即停机。原始用户工作区文件不在迁移删除范围。
迁移代码只服务该次升级；交付为独立离线工具，后续版本按已完成升级范围退役，
不加载进 renderer 或正常业务启动图。

## 8. 删除清单与采纳决定

每次切换产出 `旧符号/路径 → 新拥有者 → 消费者 → 删除结果 → 验证` 清单。
只清理本阶段确实被替代的代码，不按文件名包含 `old` 或 `legacy` 批量删除。
旧路径测试改写为新合同的行为回归，删除仅断言旧实现结构的测试。

若新算法无收益，删除候选算法，选定算法继续走统一当前合同；
若并行无收益，当前 DAG scheduler 使用 concurrency=1，不恢复旧调度器。
关闭执行或降低并行是运行参数与停机控制，不是回退旧实现。
