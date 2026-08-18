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

## 2026-08-17（阶段 4）

- 2026-08-17 续跑：重新读取四份追踪文档并核对 `fc6b95e` 与工作树；确认传输生成链已验证，但 Agent 高影响内容 schema、完整门禁、双轴审查与提交仍未完成。
- 读取 Agent harness、Deep Agents core 与 LangGraph HITL 参考；确认 schema 迁移需保持 checkpointer/thread identity、JSON interrupt/resume payload 与 LangSmith trace 审计边界，当前阶段不改变执行顺序或副作用。
- 恢复 `task_plan.md`、`findings.md`、`progress.md`、`plan/00-overview.md` 与 `plan/phase-4-ipc-contract.md`。
- 确认阶段 1-3 已独立提交；阶段 4 fixed point 为 `fc6b95e`，工作树开始时干净。
- 阶段 4 状态切换为 `in_progress`；根因暂定为 IPC 传输和内容契约多点平行定义，等待当前源码验证。
- 读取错误：Promise 聚合受 `git check-ignore` exit 1 影响；PowerShell UTF-8 输出乱码。已改为 `allSettled` 与 Node UTF-8 读取。
- CodeGraph 验证当前重复：手写 `RocPreloadApi`、只生成 channel 的 `ipc-generated.ts`、手写 plugin capability mapping，以及 snapshot type/schema 平行定义。
- 盘点现有 schema 与弱契约：task payload 使用 `z.unknown()`，agent replay/capability 使用 `z.custom`，renderer transcript 有 45 处 `Reflect.get`，usage 五元组多点重复。
- CodeGraph 追踪 TaskEvent 生产/持久化/消费：30 个 event type、54 个消费者；agent outbox 子集和 background lifecycle 事件并存，需按真实 event 类型建共享联合并在 DB 读取边界解析。
- 定位 adapter 隐藏裁剪：chat 去 `shellAllowedCommands`，shell 去 `signal/allowedCommands`，id 参数包装与 optional 空对象；registry 必须显式表达并由测试锁定。
- 探测性 `rg` 再次因无匹配 exit 1 中断并行批次；已升级为固定规约：此类搜索只用 `allSettled`。
- task event 红测先因模块缺失失败；实现后聚焦 3 文件/23 项通过。首轮 typecheck 剩 4 项 schema 类型错误，进入定向修复。
- TaskEvent 接入 DB 读取边界后复验：`pnpm typecheck` 通过；10 个聚焦文件共 88 项中 14 项失败，统一错误为 payload 中 `enabledCapabilities` 未被严格 schema 接受。状态保持 `Changed, unverified`。
- 补齐 user message capabilities 后失败降至 2 项，再定位 assistant message 冗余 provider/model；确认无消费者后从事件写入与 schema 删除，并将 renderer user helper 收窄到判别分支。
- repository 契约测试证明 assistant message 的 provider/model 是既有审计要求；撤回该字段删减，保持必填，并更新旧 renderer 夹具为完整契约。user helper 的判别收窄保留。
- TaskEvent 契约修正后聚焦 10 文件/88 项与 `pnpm typecheck` 通过；新增损坏 DB payload 的显式 `ZodError` 回归测试。
- usage 五元组开始迁移到共享 `tokenUsageSchema`/`TokenUsage`；adapter、accumulator、telemetry 与 executor 改用 canonical 字段，累计算法不变。
- usage 迁移目标验证：5 个相关文件/64 项、`pnpm typecheck` 通过；五元组平行手写类型扫描无匹配。
- 新增 TS IPC registry 与双生成物生成器；切换 preload、shared IPC 与 plugin adapter 到生成路径，旧 JSON schema 和手写映射/API 已删除，等待类型与聚焦测试验证。
- IPC 生成链目标验证：`pnpm check:ipc`、`pnpm typecheck`、5 个聚焦文件/13 项通过；literal Map/Set 类型错误已修复。传输层单源完成，继续迁移内容 schema。

## 2026-08-18（阶段 4 续）

- 新增 shared Agent/Chat Zod 内容契约，`types/agent.ts` 与 `types/chat.ts` 改为稳定的 `z.infer` 类型转导门面。
- snapshot、LangSmith settings/trace session、interrupt normalization 与 agent plugin capability descriptors 改为消费 shared schema；V1→V2 migration、manifest hash、DB/trace 生命周期和错误码保持在 main。
- 当前状态：Changed, unverified；下一步先跑 typecheck 修复结构差异，再继续 IPC runtime contract。
- shared schema 首轮 typecheck 报 39 项：已恢复 capability handler 的共享 schema parse、拆分 text/reasoning 判别分支，并在 stream/subagent tool block 构造点执行 JSON-safe schema；剩余测试 helper 将通过同一 chat event schema 构造。
- 内容契约修复后 `pnpm typecheck` 通过；11 个聚焦文件/85 项通过。question payload 未知字段由旧 strip 改为 strict 显式拒绝，replay DB 读取使用完整 `chatRunEventSchema`。
- 本轮恢复完成：session catchup 无未同步报告；工作树仍以 `fc6b95e` 为阶段 4 fixed point，当前 `main` 相对 `origin/main` ahead 41。
- 重新读取阶段 4 规格并执行 `rtk pnpm typecheck`，结果通过；但 CodeGraph 证明 registry contract 仍为 phantom，故阶段状态保持 `Changed, unverified`，继续完成全量 runtime schema 与主进程边界解析。
- 盘点 `ipc-core.ts`、`register-ipc.ts`、`window-messaging.ts`、生成器与 IPC 测试：第一批值对象已存在；统一 request/event runtime parse 和推导式 preload 测试尚未实现。
- 核对 shared 类型与 app/task/diagnostics/memory/mcp/skills/workspace/runtime-tools/agent descriptor；确认不能复用 `z.custom` 输出，开始按领域建立严格 shared schema。
- 新增三组 shared IPC schema 并将 100 个 request、7 个 event 全量换为真实 Zod contract；首轮 typecheck 定位 20 项旧手写类型过宽问题，进入 settings/task `z.infer` 迁移。
- settings/task 稳定类型门面改为 `z.infer`；第二轮 typecheck 从 20 项降至 11 项，继续修复真实构造边界和旧平行 config schema。
- 2026-08-18 恢复后 fresh `rtk pnpm typecheck`：11 项错误、6 个文件；错误集与上轮一致，状态保持 `Changed, unverified`。
- 11 项类型错误已修复：事件构造通过 shared schema parse，main config 改为 shared schema 转导，provider JSON 字段收紧为 JSON-safe，非法 legacy hook fixture 删除；`rtk pnpm typecheck` 通过。
- fresh `rtk pnpm check:ipc` 复现生成器失败：单文件 data URL transform 无法解析 `zod` 与 registry 相对 imports；进入 esbuild bundle 修复。
- 生成器改用 esbuild bundle 完整 registry 模块图；`rtk pnpm generate:ipc` 成功更新双生成物，随后 `rtk pnpm check:ipc` 通过。主进程 request/result 与 window event 已接入 shared runtime parse；`rtk pnpm typecheck` 通过。
- IPC 边界回归首轮发现 event key 在 preload `on`/`off` 合法出现两次，以及 adapter 残留废弃 `omit-first` 分支；修复后 4 文件/15 项与 `pnpm typecheck` 通过。
- 阶段规格扫描：task event 路径无 `z.unknown()`，`chat-transcript.ts` 无 `Reflect.get`，usage 五元组以 shared schema/type 为事实源；剩余缺口为 MCP/hook 与 IPC-facing plugin descriptors 的平行 schema/`z.custom`。
- 插件聚焦首次 76 文件/449 项有 3 项 task history 失败；shared IPC request schema 曾放宽旧 contract 的 limit/cursor/thread 约束。约束已收紧到 shared，等待复跑。
- 2026-08-18 本轮继续：session catchup 无遗漏；核对 `HEAD=fc6b95e`、`main` 相对 `origin/main` ahead 41，阶段 4 工作树仍未提交，阶段 5-9 未开始。
- 已完整重读 planning/typescript/maintaining-agents-md/code-review 技能、RTK 规则、三份追踪文档与阶段总览；下一步先复现 strict unused 结果并仅删除旧 import，再执行阶段 4 全量门禁。
- strict unused fresh 扫描复现 45 个旧 import、7 个文件；仅删除编译器列出的迁移残留。复验 `pnpm exec tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters`、`pnpm typecheck`、`pnpm check:ipc`、`git diff --check` 全部通过。
- 插件/config/hook/IPC/shared 聚焦集扩大复跑：136 个文件、850 项全部通过；Node 25/node-pty 辅助进程仍输出已知 `AttachConsole failed`，但 Vitest 退出码为 0、无失败测试。
- 阶段 4 首次全量 `pnpm test`：325/327 文件、1829/1832 项通过；失败为 Anthropic thinking 错误 path 旧断言、retired cache-control 静默丢弃旧语义，以及 `chat.startRun` 未裁剪 `shellAllowedCommands`。状态保持 `Changed, unverified`，进入契约根因修复。
- 根因修复：删除绕过真实边界的 adapter 隐藏裁剪断言，在 `ipc-contract-boundary.test.ts` 新增 chat/shell main-only 授权字段拒绝回归；config 测试改为断言 strict Zod path 与 retired 字段拒绝。3 文件/13 项、`pnpm typecheck`、`git diff --check` 通过。
- 第二次全量 `pnpm test`：326/327 文件、1831/1832 项通过；唯一失败为未改动的 `metrics-service.test.ts` 1000 样本 5ms 性能阈值（实测 5.79ms），按环境波动候选处理，等待目标复跑。
- 性能失败目标复跑：`metrics-service.test.ts` 12/12 通过；未修改该测试或生产 metrics 代码，继续进行全量门禁复验。
- 第三次全量 `pnpm test`：326/327 文件、1831/1832 项通过；未改动的 `terminal-capabilities.test.ts` 在 `rmSync` 临时目录处触发 Node 25/ConPTY `EPERM`，并出现 teardown RPC 未处理 rejection，等待串行复验。
- terminal-capabilities 目标复跑：1/1 通过；串行全量将使用 `pnpm exec vitest run --fileParallelism=false`，以区分并发环境竞争与产品失败。
- 串行全量门禁通过：`pnpm exec vitest run --fileParallelism=false` 327/327 文件、1832/1832 项，退出码 0；Node 25/node-pty `AttachConsole failed` 仅为已知辅助进程噪声。
- fresh `pnpm generate:ipc` 成功；最终 `pnpm check:ipc`、strict unused tsc、`pnpm typecheck`、`pnpm build`、`git diff --check` 全部通过。阶段 4 进入双轴子代理审查，尚未提交。
- Standards 子代理首轮因服务端 429 超过重试上限而失败，Spec 子代理仍运行；该失败已记入台账，审查门禁未放行。
- 阶段 4 双轴首审完成：Standards FAIL 4 项，Spec FAIL 4 项。问题集中为 task 约束弱化、shared type 平行定义、IPC 受控错误/错误响应未验证、生成器 `omit-first` 死分支与 README 事实源过期；进入问题修复，阶段仍未提交。
- 首轮审查修复第 1 组：新增 `RocError`/`IpcResult` runtime schema，`executeIpcRequest` 统一 parse 成功与错误 envelope 并将边界异常转换为受控结果；删除生成器 `omit-first`，同步 README/AGENTS 事实源。3 文件/11 项、`pnpm typecheck`、`pnpm check:ipc`、`git diff --check` 通过。
- 首轮审查修复第 2 组：从 `fc6b95e` 恢复 task history/background task 的正整数、非空 trim、datetime 与非负 runCount 约束；task/shared 聚焦 13 文件/78 项及 `pnpm typecheck` 通过，并新增 shared contract 回归锁定四类约束。
- 2026-08-18 本轮继续：session catchup 无遗漏；fresh `pnpm typecheck` 与 strict unused tsc 均通过。CodeGraph 确认剩余审查缺口为 `mcp/skill/workspace/git/terminal/rtk/shell` 的 IPC 类型仍与现有 schema 平行，进入最后一批 `z.infer` 转导。
- `mcp/skill/workspace/git/terminal/rtk/shell` 七个稳定类型门面已改为从 shared Zod schema 或父结果索引派生；内部 `FilePreviewLike/FileDeleteResult` 保留手写。fresh `pnpm typecheck`、strict unused tsc、`git diff --check` 通过，定向扫描只剩已确认的领域内部对象类型。
- 阶段 4 审查修复后的最终门禁：聚焦 29 文件/117 项、串行全量 328 文件/1837 项通过；`pnpm generate:ipc`、`pnpm check:ipc`、`pnpm typecheck`、strict unused tsc、`pnpm build`、`git diff --check` 全部退出码 0。Node 25/node-pty `AttachConsole failed` 仍为不影响 Vitest 结果的已知噪声；进入双轴复审。
- Standards 复审 FAIL 1 项：`DefaultModelState` 仍平行手写。已导出并复用 `defaultModelStateSchema`，settings 类型改为 `z.infer`，新增 strict 额外字段拒绝回归；聚焦 4 文件/27 项、`pnpm typecheck`、strict unused、`pnpm check:ipc`、`git diff --check` 均通过，等待 Standards 再复核。
- Spec 复审 FAIL 1 项：persisted approval payload 仍为宽 JSON record，renderer guard 未验证元素。先新增 `actionRequests: [{}]` 负例并确认 red；随后提取 canonical HITL schema，chat/task/main 共用，renderer 删除全部 persisted interrupt 鸭子 guard。相关 5 文件/18 项与 `pnpm typecheck`、`pnpm check:ipc`、`git diff --check` 通过；strict unused 仅报一个已删除的迁移残留常量，等待复验。
- 删除 HITL 提取残留后，相关 5 文件/18 项、`pnpm typecheck`、strict unused、`pnpm check:ipc`、`pnpm build`、`git diff --check` 全部通过；串行全量 328 文件/1838 项通过，新增项为畸形 approval 负例。进入 Standards/Spec 最终复审。
- Spec 最终复审 PASS；Standards 仍发现 agent 与 HITL 重复维护 decision enum。已导出 canonical `hitlDecisionTypeSchema`，agent policy/manifest 复用并推导 `InterruptDecisionType`，等待聚焦复验和双轴最终确认。
- 枚举单源修复后，6 文件/24 项聚焦、`pnpm typecheck`、strict unused tsc、`pnpm check:ipc`、`pnpm build`、`git diff --check` 全部通过；最终串行全量 328 文件/1838 项通过。Node 25/node-pty `AttachConsole failed` 仍仅为辅助进程噪声。
- Spec 复审旁路修复：recorded resume 审计从 `Reflect.get`/数组强转改为共享 HITL decision schema parse；`chat-view.tsx` 删除已解析 TaskEvent 的 Reflect guard。修复后 4 文件/45 项通过，`pnpm typecheck`、strict unused、`pnpm check:ipc`、`git diff --check` 通过，进入最终构建/全量门禁。
- 旁路修复后 `pnpm build` 通过；最终串行全量 328 文件/1839 项通过。ConPTY `AttachConsole failed` 仍仅为 Node 25/node-pty 辅助进程噪声，Vitest 退出码 0；进入最终 Standards/Spec 复审。
- Standards 最终复审发现并已修复最后一处重复 validator：session repository 直接复用 task-event 导出的 approval decision/question answered payload schema，删除局部重复定义。等待最终聚焦与双轴复审。
- 重复 validator 修复后 5 文件/50 项聚焦、`pnpm typecheck`、strict unused、`pnpm check:ipc`、`pnpm build`、`git diff --check` 均通过；最终串行全量仍为 328 文件/1839 项通过。进入最终双轴复审。
- 阶段 4 最终 Standards/Spec 复审均 PASS：无剩余标准违规、smell、规格缺失、scope creep 或行为错误。阶段状态为 Verified passing，准备独立提交。

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
