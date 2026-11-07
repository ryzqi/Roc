# S06：Task DAG、租约、有限并行与 Worker 协议

优先级：P1。依赖：S02、S03、S05 查询与输出合同。
来源：WP-07、RH-13/RH-14/RH-15。
实施状态：complete（工程；独立科学调度对照未运行），见 [执行报告](s06-execution-report.md)。建议时间：第 11～13 周。

## 目标与关口

将现有 Task execution tree 增强为有依赖、可认领、可回收的节点调度。
试点 discovery → retrieval → reading → evidence synthesis；
并行上限 2；当前默认 1（独立质量/费用对照未运行），写作/项目状态提交保持单写者，实验探索留 S09。
研究助手是唯一启动入口，stage tool 转入同一 scheduler。

## 当前起点

[Task repository](../src/main/plugins/research/research-task-repository.ts)已有根任务与 execution
父子关联，但已读 schema 没有 node DAG/lease。
[TaskController](../src/main/plugins/research/task-controller.ts)和
[StageRuntime](../src/main/plugins/research/stage-runtime.ts)已有暂停取消继续。
[Effect store](../src/main/services/deep-agent/tool-effect-store.ts)已有 operation lease，
它不替代节点认领；[resource coordinator](../src/main/services/deep-agent/tool-resource-coordinator.ts)
仍是实际资源准入拥有者。

## 按顺序执行

- [x] **RH-13.1 Graph contract**：同一 agent DB/task owner 中增加 node、dependency、
  lease 和 output revision；root Task 保留总预算/项目状态，execution 记录每次尝试。
  边明确 `prerequisite → dependent`，同 root/project、无自环、无循环。
- [x] **RH-13.2 可运行性**：依赖全部 `done` 且项目/根任务可执行、审批/input version
  有效才 ready。failed/cancelled/review pending 不被当作依赖已完成。
  图变更绑定 expected revision，不允许运行中悄悄换输入。
- [x] **RH-14.1 Atomic claim**：SQLite 短事务重新核对依赖、root 状态、revision 和旧 lease，
  写单调 generation 与 expiry 后 commit；commit 后 dispatch。
  不能事务内等待网络或用内存 Map 充当 durable lease。
- [x] **RH-14.2 Fencing**：heartbeat、完成和结果提交校验 worker ID、lease generation、
  node revision、input versions、output schema/hash。过期 worker 返回不能提交或推进下游。
  result pending review 释放执行 lease，人工接受绑定结果 hash/revision。
- [x] **RH-14.3 稳定操作身份**：节点重试保留由 project/root/node/冻结输入/操作类型
  派生的业务 idempotency key，attempt 单独变化；对既有 Effect store 传入相同
  逻辑 operation 身份，避免换 tool-call/attempt 就再次产生 effect。
- [x] **RH-14.4 权限与资源**：Worker 仅获得窄 role/Skill/Manifest/grant，
  Scheduler 只判断 runnable，不生成新的 capability allowlist。
  读工具可能有 cache/index/receipt 写入，按真实 effect/resource 声明安排；
  Worker 结果先独立写入，聚合以唯一 reducer 和 CAS 提交。
- [x] **RH-14.5 取消与暂停**：根任务先 durable 阻止 dispatch，再取消 children，
  等该任务真实资源/进程 cleanup。readonly 节点清理确认后可回 ready；
  有未决 effect 先对账。继续检查版本/审批，不能取消后迟到结果复活任务。
- [x] **RH-14.6 分类恢复**：transient network 按既有有限退避；policy denied/
  source stale/human rejected 不盲重试；side effect unknown 先 reconcile。
  lease expiry 仅允许合法节点重认领，非幂等写分支不自动重跑。
- [x] **RH-14.7 Supervisor/Worker**：Supervisor 拆解并验收 output contract，
  不提升权限、不直接过闸门；阅读/检索 Worker 各有冻结输入、预算、结果 refs。
  synthesis 用版本化证据和反证，写作不并发修改同稿。
- [x] **RH-15.1 任务读侧**：现有 Task IPC 返回 node/edge、等待原因、lease 状态、
  attempt、预算引用、失败和结果链接。更新抽屉数据消费者，不新建任务路由。
- [x] **RH-14/15.2 默认路径切换**：stage/internal task dispatch 全转唯一 scheduler，
  删除旧直接队列/独立 Worker 启动；concurrency=1/2 都使用同一实现。

## 交付物

计划新增 task node/edge/lease schema、同 DB 表与有限一次性迁移、
`execution/` 调度/lease/reducer 模块、Worker adapter、真实 SQLite 竞争夹具。
改写现有 task/stage/controller、execution linkage、IPC 和 task drawer 读侧。
S02 事件合同落地 dependency ready/lease claimed/expired/output accepted 等事件。

## 删除范围

旧内存任务队列、直接 stage dispatch 分支、第二个状态/预算汇总、
过期结果接受、取消后回调复活、无限重试和 supervisor 特权 allowlist。
已有 thread/run checkpoint 与 Effect store 保持唯一当前拥有者。

## 验证

```bash
node --test tests/unit/research-task-identity.test.mjs tests/unit/research-task-cancellation.test.mjs tests/unit/research-worker-contract.test.mjs tests/unit/tool-effect-store.test.mjs
pnpm typecheck
pnpm check:ipc
pnpm harness:eval
pnpm research:admission-bench
pnpm build
```

新增 Task DAG integration：两个实际 claim 竞争、依赖完成与取消竞争、
worker crash/reopen、lease expiry 后旧 worker 回传、共享文件冲突、同逻辑 effect 重试、
node/source revision 改变、审批等待期间 lease 不被误回收。
断言真实 DB、文件/查询/receipt 和预算 digest，不以 worker 自报成功为准。
30 个任务比较统一 scheduler concurrency=1/2；质量/费用先成立，耗时收益再采纳。

## 接受标准与下一步

AC-04/09/10 成立，项目与 root 的 scope 严格一致，旧调度生产路径零引用。
并行无稳定收益时 concurrency=1，仍保留当前 DAG 的依赖与恢复价值；
不保留旧串行 Runtime 回退。S07 验收组合攻击与任务观察。
