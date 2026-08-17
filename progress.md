# Roc 架构优化进度

## 2026-08-16

- 读取用户规则、项目 `AGENTS.md`、RTK 规则、`package.json`、README 和计划总览。
- 运行 planning-with-files session catchup；无未同步报告。
- 确认 `.codegraph/` 可用。
- 确认分支 `main`，HEAD `45168f1`，相对远端 ahead 38；仅 `plan/` 未跟踪。
- 建立 `task_plan.md`、`findings.md`、`progress.md`。
- 当前阶段：1 Interrupt 生命周期收敛，状态 `in_progress`。
- 读取阶段 1 计划；采用建议决策：checkpoint 裸 SQL 本阶段先封装在 interrupt projection，resume dispatch 暂留 runtime。
- 使用 CodeGraph 定位 executor/runtime/final-output 调用关系；确认当前 executor interface 仅传递事件流。
- 使用 CodeGraph 定位 repository resume 事务与 `AppShell` task 刷新；确认两者是阶段 1 的不可破坏语义。
- 扫描所有 pending interrupt SQL 与 renderer interrupt 分支；确认主进程需共享 DB adapter，renderer 可共享纯投影函数。
- 一次嵌套 PowerShell 读取因变量提前展开失败；已更换命令引用方式。
- 确定阶段 1 executor seam：事件流与结构化 outcome 分离；runtime 后续只从 outcome 读取 interrupts。
- 读取 runtime 执行循环、production executor、renderer live/persisted interrupt 分支；固定主进程与 renderer 的最小改动边界。
- 盘点 executor fake 与 interrupt 测试；确定先新增 runtime outcome 来源测试和 renderer 共享投影测试。
- 确认 checkpoint 测试夹具与恢复格式，准备新增 projection 直测。
- `pnpm typecheck` 首次迁移后通过；目标回归测试 7 文件/72 项通过。
- 删除 `deep-agent-final-output.ts` 中已迁移的 interrupt 归一化/事件包装及其等价测试；新增 runtime 回归：事件流含 `run_interrupted` 但 outcome 为 `completed` 时仍完成。
- 全量 Vitest 首次重跑 321/322 文件通过；发现 executor outcome 未处理 rejection 与 node-pty `AttachConsole failed` 环境噪声。补充 execution 工厂/helper rejection handler，并在 runtime 事件异常/取消边界消费 outcome；streaming/hooks 聚焦测试分别 7/7、3/3 通过。
- 全量 Vitest 修复后 322 文件/1807 项通过（退出码 0）；仍打印 Node 25/node-pty `AttachConsole failed`，未形成 Vitest failure。
- 将 checkpoint 解析与 projection 回写的异常边界分离，避免静默吞 SQLite 写入错误；session-repository + production multiple-interrupts 30 项、strict unused tsc、git diff check 均通过。
- Standards 子代理发现并已修复两个 unused type imports；Spec 子代理审查待回传。
- 新增 main/renderer projection red tests。首次运行预期失败：主进程 property 缺失、renderer module 缺失。
- 目标命令误跑全量 323 文件：321 文件通过，2 个新增 red 失败；后续改用 `pnpm exec vitest run`。
- renderer projection、chat run state、transcript 目标测试 28 项通过；main projection 因 import 路径错误未运行，已定位修正。
- 主进程 projection 接入 repository；旧 getter 测试全部迁到窄 interface。`session-repository.test.ts` 29/29 通过。
- renderer 共享 projection 接入 live state 与 persisted transcript；相关 3 文件 28/28 通过。
- 生产代码 typecheck 错误清零后，使用一次性括号扫描脚本机械迁移 13 个测试文件、48 个 async-generator fake 到测试 execution helper；临时脚本已删除。
- 阶段 1 Standards 审查发现：消费者提前停止可能令 outcome 永久 pending、question payload 校验不完整、损坏 projection 被静默覆盖；全部修复。
- 阶段 1 Spec 审查发现：`runtime-types.ts` 保留旧类型转导、restart recovery 未经 projection 窄 interface 直测；全部修复。
- 修复后目标回归 7 文件/72 项通过；`pnpm typecheck`、strict unused tsc、`git diff --check` 通过。
- 修复后全量 `pnpm test`：323 文件/1811 项通过，退出码 0；Node 25/node-pty `AttachConsole failed` 仍为非失败环境噪声。
- Standards/Spec 子代理复审均为 PASS，未发现剩余问题。
- 阶段 1 状态：Verified passing；准备提交并进入阶段 2。
- 阶段 1 提交：`79d8aa0 refactor(agent): centralize interrupt lifecycle`。
- 阶段 2 fixed point：`79d8aa0`；容量语义定为 trim，符合 `agent_run_events` 的有界投影缓存用途。
- 阶段 2 初始实现将 checkpoint 读取、tool-effect restart 转移和 run-event 写入收回三个 owner；database rebuild 恢复 sequence 时同步 cursor。
- 首轮 Standards 审查发现 `run-event-log.ts` 链式调用缩进错误；首轮 Spec 审查发现 history deletion、retention、database rebuild 仍有 owner 外 operational SQL。
- 修复 Standards 缩进；为 `AgentRunEventLog`、`AgentToolEffectStore`、`RocSqliteCheckpointer` 增加删除、保留和旧库恢复维护 API，并将三个基础设施调用方改为只编排窄接口。
- 新增 production SQL ownership 静态测试；新增 owner 删除/保留直测。聚焦 7 文件/29 项通过。
- `pnpm typecheck`、strict unused tsc、`git diff --check` 通过。
- 全量测试首次仅 `terminal-session-service` 受 Node 25/ConPTY 环境波动失败；该文件复跑 4/4 通过，随后全量复跑 324 文件/1818 项通过。
- 修复后 Standards/Spec 子代理复审均 PASS；阶段 2 状态：Verified passing，准备独立提交。
- 阶段 2 提交：`d8e4640 refactor(agent): enforce session repository ownership seams`。
- 阶段 3 fixed point：`d8e4640`；usage 纳入 outcome，失败/取消不产生半结果，内部 mode 定为 `run | plan | task`。
- 新增结构化 `RunOutcome`，executor 负责最终消息、summary source、interrupt 和成功 usage；runtime 删除最终消息与成功 tool name 的事件重放累积。
- hook echo 改为 assistant delta 前缀消费；新增正常回答包含相同 hook 文本时不误删的回归测试。
- 测试 execution helper 删除默认 outcome，所有 fake 显式声明结果；capability fixture 拆分后 helper 从 735 行降至 487 行。
- 第一轮 Standards 审查发现 completed outcome 在事件投影失败后 usage 丢失；修复为异常边界消费已结算 outcome usage，并新增 provider recovery 累计回归。
- 第一轮 Spec 审查发现 hook 全局删除、取消伪 completed outcome、mode 转换分散；全部修复，Spec 复审 PASS。
- 聚焦测试首次扩大到 58 文件时发现 repository 持久事件仍断言旧 `chat`；迁移为内部 `run` 后 58 文件/358 项通过。
- 首次全量测试发现 outcome usage helper 的空 `catch`；改为显式 Promise 双分支后质量测试 29 项通过。
- Standards 最终复审发现 live `run_started` 仍使用请求态 `chat`；改为 `snapshot.mode` 并新增 live/replay 等值断言，相关 3 文件/33 项通过。
- 最终 `pnpm typecheck`、strict unused、`git diff --check` 通过；全量 `pnpm test` 为 324 文件/1820 项通过，Node 25/node-pty `AttachConsole failed` 仅为非失败环境噪声。
- Standards/Spec 最终复审均 PASS；阶段 3 状态：Verified passing，按用户要求提交后停止，不进入阶段 4。

## 阶段证据模板

每阶段记录：

1. fixed point 与变更文件。
2. 复现/目标行为。
3. 目标测试与结果。
4. `pnpm typecheck`、`pnpm test` 及专项门禁结果。
5. Standards 子代理审查结果。
6. Spec 子代理审查结果。
7. 修复与复验结果。
8. commit SHA 与标题。
