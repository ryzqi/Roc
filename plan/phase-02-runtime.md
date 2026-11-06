# S02：统一执行事实、事件、Effect 与恢复

优先级：P0。依赖：S00。来源：WP-01、WP-10 边界、RH-02/RH-03。
实施状态：pending。建议时间：第 2～5 周。

## 目标与关口

统一当前 Task/Run/Stage 的执行身份、版本、事件和取消恢复合同。
复用已有 checkpoint、effect、budget 和 resource owner，
通过整体调用方切换消除重复状态处理；本阶段不引入 DAG scheduler。

## 当前起点

- [Agent Runtime](../src/main/plugins/agent/runtime.ts)与
  [run-harness](../src/main/plugins/agent/run-harness.ts)是通用执行入口。
- [Task schema](../src/shared/schemas/research-tasks.ts)当前为 v2，已有根任务与 execution 关联。
- [Task repository](../src/main/plugins/research/research-task-repository.ts)在 agent DB 维护身份与预算。
- [event log](../src/main/plugins/agent/run-event-log.ts)、[grant broker](../src/main/services/deep-agent/execution-grant-broker.ts)、
  [effect store](../src/main/services/deep-agent/tool-effect-store.ts)和预算机制已存在。

## 按顺序执行

- [ ] **RH-02.1 执行合同**：目标 ResearchTask schema v3 增加 revision 与合同版本引用，
  保持根任务、节点和 execution 不同语义。run/stage/job 关联必须有真实来源，
  输入包含冻结 manifest、Skill、source/artifact/plan 版本。
- [ ] **RH-02.2 单一控制路径**：重构 `TaskController/StageRuntime/AgentRuntime` 的
  start、pause、cancel、continue、waiting approval、resume。
  必需依赖显式构造；归档/跨项目/版本冲突在真实 dispatch 前拒绝。
- [ ] **RH-02.3 事件 envelope**：为 Task event 引入当前版本 envelope，补 plan approved、
  source invalidated、claim reviewed、quality gate、effect committed 的语义；
  node/lease 事件类型由本合同预留并在 S06 实现。
  sequence、event identity、causation、payload hash/ref 统一且有大小/保留期。
- [ ] **RH-02.4 跨存储一致性**：同 DB 状态与事件在同一事务写入；跨 Research/Agent DB
  或真实 I/O 用明确可对账提交记录和恢复流程。
  事件发布失败必须可恢复且可见，不能以已完成消息掩盖缺事件。
- [ ] **RH-02.5 Effect/预算统一**：使用现有 operation/idempotency/lease/receipt；
  冻结 operation input，副作用前落 intent，副作用未知先 reconcile。
  同 call 的 root/run/stage 展示只读现有 ledger 聚合，不能重复结算。
- [ ] **RH-03.1 三种 replay**：分别实现 projection、recorded receipt、live re-execution。
  前两种不调用外部系统；live 按当前授权创建明确新尝试，不伪装旧效果恢复。
- [ ] **RH-03.2 同版本恢复**：从 checkpoint + Task/Effect receipt 恢复同 runId，
  重新验证审批、输入和项目状态；重复事件/回调不重复追加副作用。
- [ ] **RH-03.3 诊断与 IPC**：现有任务观察返回关联、gap、缺 receipt、版本失效与真实
  unknown；脱敏导出保持 2 MiB。同步 registry、preload、generated schema 和消费者。
- [ ] **RH-03.4 冷迁移**：按 S00 来源/目标版本清单，离线备份、转换、校验。
  不兼容活跃 snapshot 不用新权限继续；新启动只读当前 schema，错误版本显式拒绝。
- [ ] **RH-03.5 故障注入**：覆盖 intent 前/后、effect 后 receipt 前、提交后 event 发布前、
  reservation 后崩溃、缺/重/乱序事件、取消 cleanup 失败、人工审批变更和重启。

## 交付物与切换

改写 Task/Run/Stage 相关现有模块与 schema，形成当前版本统一执行协议、事件映射、
冷迁移工具和回放报告。计划新增共享执行合同及 replay verifier 的文件由 S00 固定。
正常启动不加载历史解析器；离线迁移仅支持枚举的来源版本。

整体切换该合同的 production consumers 和 fixture API，移除旧字段、旧调用和旧解析。
数据库备份与受控历史证据保留；旧业务路径、双写和跨版本 resume adapter 删除。

## 删除范围

- 各层重复的状态转移、可选必需服务与成功形异常吞噬。
- 旧 Task/event schema decoder、IPC 别名和针对旧状态结构的分支。
- 第二份预算汇总、伪造 execution 关联、执行时版本以当前值填补。
- 旧 replay 入口中隐式调用真实工具或静默补 gap 的代码。

## 验证

最小专项：

```bash
node --test tests/unit/research-task-identity.test.mjs tests/unit/research-task-cancellation.test.mjs tests/unit/research-task-events.test.mjs tests/unit/run-event-log.test.mjs tests/unit/tool-effect-store.test.mjs tests/unit/run-budget-ledger.test.mjs tests/unit/research-task-diagnostics.test.mjs
pnpm typecheck
pnpm check:ipc
pnpm harness:eval
```

本阶段共享状态与 DB 改动再跑 `pnpm test:unit`、`pnpm build` 和 Electron smoke。
新增故障夹具必须从真实持久化状态 reopen，核对原 run identity、调用表 digest、
operation receipt、预算占用和事件投影；只 mock 状态函数不证明恢复。
冷迁移在隔离备份上演练，实际用户数据迁移另按具体目标执行。

## 接受标准与下一步

AC-01～05、AC-17 的本阶段范围成立，旧生产执行合同零引用。
预算/Effect 与未知状态没有倒退；回放仅在声明范围确定一致。
解锁 S03；S06 后续在该执行协议上增加 node lease，不重造 run 或 effect owner。
