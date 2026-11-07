# S06 Task DAG 与 Worker 验收

日期：2026-11-07。开始 SHA：`9d16212d`。
范围状态：`Verified passing`（本地工程；科学调度对照未运行）。

## 实现范围

- 同一 agent DB 的 Task owner 保存 graph/node/dependency/lease；短 SQLite 事务
  核对根任务、预算、依赖、版本和写入名额，再递增 generation 后 dispatch。
- StageRuntime 是唯一调度器；审稿的三个只读 child 和唯一 reducer 都是持久节点。
  reducer 不占用名额等待 child，必须在三个子结果完成且 hash 核验后领取。
- 工具调用和结果提交核对 Worker、node revision、generation、冻结输入与当前授权。
  人工审核前释放 lease；接受决定绑定确切输出 hash/revision，仍由原人工 gate 执行。
- research DB 的结果/决定回执与 agent DB fence 协作；冷启动能核验并补完中断提交，
  不以模型重跑恢复已经提交的结果。未知 effect 先对账，不盲目重新执行。
- 逻辑节点重试保持 operation identity，attempt/revision 独立递增；既有 Effect store
  仍为 effect 唯一拥有者，资源准入仍由现有 coordinator 管理。
- 现有 Task IPC/管理抽屉增加依赖、等待原因、尝试、租约与结果记录；无新任务页面。
- agent21/research64 使用离线门；转换器覆盖 S02/S04/S05 来源，旧执行原文留审计，
  不伪造当前 lease/批准，生产读取不保留旧合同分支。

## 已完成的专项证据

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`，Node v26.13.0、pnpm 12.5.1。
日志均在 `.artifacts/research-harness/S06/`。

- `dag-runtime-v3.log`：1/2 槽调度及关闭 4/4，先 fence 根任务再停止活动和排队节点。
- `production-retry-v2.log`：17/17，真实 SQLite worker 竞争、旧 lease 返回、双库提交
  冷恢复、人工接受 hash、真实工作区文件重试不重复修订。
- `task-renderer-v1.log`：17/17，浅/深色依赖与等待详情、键盘操作。
- `scheduler-benchmark-v2.json`：30 个受控场景 × 3 次配对 × 2 个并行度，180 次全部通过；
  结果投影和预算 digest 一致，每次 4 calls/320 tokens。
  单槽 p50/p95 156.95/167.84ms，双槽 138.14/153.01ms。

调度对照为 synthetic engineering；独立科研任务 0、真实 provider dispatch 0、
真实费用 null。它只证明这些受控场景的调度一致性，不证明科学质量或生产收益。
默认并发采用同一 scheduler 的 1 槽；2 槽保留为经过工程验证的配置，待独立证据再采纳。

## 最终验收与失败保留

汇总证据 `.artifacts/research-harness/S06/final-verification.json` 保存最终源码 hash、
原报告/补验 hash、命令与结果。所有命令 cwd 为仓库根。

- 首轮全量 `2026-11-07T04-21-18.193Z/verification.json` 保持 failed：unit
  1517/1575、renderer 374/451。主要为旧测试未在 Worker 上下文执行；另一个预算夹具
  创建没有 research 行的伪 child。期间修订源码，不能当作单一快照全通过。
- 冻结补验 `2026-11-07T04-40-55.340Z/verification.json`：`pnpm test:unit`
  1577/1577、`pnpm typecheck` exit 0，采集期间源码未变。
- 随后增加前置校验失败清理后唤醒回归，红灯证据 `scheduler-cleanup-before.log`；
  修复只在 cleanup 完成后重新 pump。DAG/runtime/cancellation/lifecycle 补验
  `scheduler-cleanup-after.log` 39/39，包括新增回归。
- 九份受影响 renderer 补验 `renderer-worker-recheck.log` 83/85；两项直接改写
  冻结正文后期待批准的旧测试改为模拟元数据漂移，保留 stale approval/重读确认行为。
  新增正文篡改即使人类重读也不可批准的 UI 回归；最终 inspector 26/26、exit 0，
  `renderer-inspector-final-v2.log`。首次尝试正常 updateArtifact 因 waiting_approval
  不可编辑而失败，随后用明确的隔离 SQL 元数据漂移夹具；未放松生产权限。
- 最终生产修复后执行的 admission、IPC、Harness 94/94、review workflow 1/1、
  build（含 skills/typecheck）、renderer chunks、Electron smoke 13/13 全 exit 0。
  时间、完整命令、日志 hash 均在首轮报告对应检查项中。
- `git diff --check` exit 0。旧 `schedule` / `executeChild` 独立派发已删除；
  task graph 使用同一 agent DB，Effect 与资源 coordinator 保持唯一所有者。

最后一轮完整单测之后的生产差异只有清理完成重新 pump；由 39 项专项与最终
build/Harness/workflow/smoke 覆盖。renderer fixture 变更由上述补验覆盖。
不把各轮结果拼成不存在的单次全量通过。

## 限制与下一步

真实用户库没有转换，未使用外部账号或发布。科学 30 任务对照仍依赖 S01 独立材料。
工程验收完成后提交 S06，继续 S07 组合攻击和单壳桌面检查。
