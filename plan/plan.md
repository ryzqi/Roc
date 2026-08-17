# Roc 架构优化计划

评审日期：2026-08-16。范围由近三月提交热点驱动：agent 内核（`src/main/services/deep-agent/` + `src/main/plugins/agent/`）、sqlite 基础设施、task 插件、chat 渲染层、IPC 链路。方法：git 热点分析 + 两路代码探查。可视化报告（含 before/after 图）见临时文件 `architecture-review-20260816-211849.html`。

设计词汇沿用 codebase-design：**module / interface / depth / seam / adapter / locality / leverage**。目标是把浅模块加深——更多行为藏进更小的 interface，让修改与测试都落在一个地方。

> **分阶段执行计划见 [`plan/`](plan/00-overview.md)**：全部 9 个候选已拆为 9 个阶段（`plan/phase-1-*.md` 到 `plan/phase-9-*.md`），每阶段含问题定位（file:line）、目标形态、实施步骤、动工前设计决策、验收标准。本文件保留为评审结论总览。

## 现状概览

- `plugins/agent` 一侧过深无 seam：3 个巨型文件互相裸耦合（session-repository.ts 1,771 行、runtime.ts 1,439 行、deep-agent-executor.ts 859 行）。
- `services/deep-agent` 一侧过浅无 depth：33 个文件中约 10 个是 <70 行的转发/微工具层。
- 共同病根：**事件流被当作层间数据通道**（interrupt 与最终消息都靠 runtime 重放事件流反推）；**契约多处重复定义**（usage 五元组定义 4 次、payload 在渲染端用约 350 行鸭子 guard 重建）。

## 优化项（按建议顺序）

### 1. Interrupt 生命周期收敛 【Strong · 首选】

- **问题**：一个 interrupt 在主进程有 4 种形态（vendor 形状 → ChatRunEvent → PendingInterrupt → DB 行/checkpoint blob），跨 8 个文件；渲染层还有 live/persisted 两套并行 reducer（`chat-run-state.ts:179-208` 与 `chat-transcript.ts:430-441`），必须保持行为一致。近期至少 5 条 fix 提交在为此结构买单。
- **改法**：主进程建一个拥有 interrupt 投影与恢复的模块（interface：记录中断 / 读待处理中断 / 消费恢复），runtime 与 session-repository 只消费该 interface；渲染层将 live/persisted 事件归一化为同一事件流后进唯一 reducer。
- **验收**：渲染层双 reducer 等价性测试被删除；中断恢复可在新模块 interface 上直测，不再需要整机穿透。

### 2. session-repository 跨 seam 裸 SQL 收口 【Strong】

- **问题**：repository 直接读写三张"别人拥有"的表——裸 SQL 查 `langgraph_checkpoints`（硬编码 `'__interrupt__'`，格式一换静默返回 null，`session-repository.ts:1400-1417`）；旁路 UPDATE `agent_tool_effects` 绕过 AgentToolEffectStore 状态机（`:1519-1534`）；对 `agent_run_events` 自建第二套写路径，容量语义与 AgentRunEventLog 相反（trim vs throw，`:330-341, 1168-1186`）。
- **改法**：三个拥有者各暴露窄 interface（checkpointer 提供读待处理中断；effect store 提供重启置未知；event log 成为唯一写路径），repository 只组合这三个 interface。
- **验收**：全仓 grep 不再有 repository 对这三张表的裸 SQL；run_events 容量语义只定义一次；repository 测试可注入三个 fake。

### 3. 执行结果 seam：executor 返回结构化结果 【Worth exploring · 与 1/2 同病根】

- **问题**："最终 assistant 消息"被组装两遍——executor 累积一遍仅作兜底（`deep-agent-executor.ts:103,380`），runtime 重放事件流再累积一遍并用顺序敏感的 split/join 剔除 hook 文本（`runtime.ts:1018-1104, 1395-1401`）；interrupts 同样从事件流捞回（`:1049-1056`）。
- **改法**：executor 的 interface 改为返回结构化 RunOutcome（finalMessage、interrupts、usage），事件流只承载 UI 增量；runtime 不再从事件反推。
- **验收**：runtime 测试不再构造事件流夹具验证最终消息；727 行的 executor-test-helpers 显著缩水。

### 4. IPC 契约单源化 【Strong · 长期杠杆最高】

- **问题**：同一操作 3 个名字（`tasks.getSnapshot` / `roc:tasks:get-snapshot` / `task.snapshot.get`）；生成器只产出 channel 常量，preload 179 行一一映射、channel→capability 映射表全手写，加一个 channel 改 4+ 文件；事件 payload 定义为 `z.unknown()`（`task/contracts.ts:55`），渲染端用约 350 行 Reflect.get 鸭子 guard 重建类型（`chat-transcript.ts:146-363`）；传输 adapter 里藏着静默剥字段的语义规则（`plugin-capability-adapter.ts:196-212`）；usage 五元组定义 4 次。
- **改法**：① zod schema 为唯一事实源（z.infer 导出类型），payload 用 discriminated union 定义一次、主/渲染共享解析器，usage 收敛为一个共享值对象；② 生成器从 schema 产出 preload 转发与映射表；字段裁剪在 capability 输入 schema 里显式 omit/strip。
- **验收**：新增 channel 只改 schema 一处；preload-contract 测试从形状断言变为推导；渲染端 guard 及其测试删除。

### 5. Stream adapter 输出领域事件 + 合并克隆投影 【Worth exploring】

- **问题**：`deep-agents-1-10-stream-adapter.ts`（575 行、42 个错误码）输出与 vendor 输入近同构——防腐层的位置没做防腐层的翻译，vendor 形状泄漏到下游；`stream-consumers.ts:101-183` 与 `subagent-projection.ts:175-242` 的 consumeToolCalls 近克隆（仅事件外壳不同）；1,012 行 conformance 测试在复验镜像。
- **改法**：adapter 输出领域事件（吸收 stream-consumers 分类逻辑）；tool-call 生命周期抽单一投影器，外壳作参数。
- **验收**：deepagents 升级只碰 adapter；克隆删除；conformance 测试改为验证翻译。

### 6. task-repository 聚合化 + capability 按名注册 【Worth exploring】

- **问题**：fold-back 合并了文件没合并结构——class（50-1026 行）大量一行转发到同文件 45 个自由函数（1028-1692 行），`this.db` 与参数 `db` 双轨；`task/index.ts:222-332` 按数组下标注册 descriptors[0]…[20]，中间插入会静默错位后续全部 handler。
- **改法**：按聚合拆子模块（scheduled-occurrence / background-task / projection）或自由函数收为私有方法；注册改按 name 或 descriptor 自带 handler。
- **验收**：一行转发消失；下标错位从运行时静默错误变为编译期错误；claim/reconcile 获得窄 interface 直测。

### 7. Shell 安全 policy 单源 【Worth exploring】

- **问题**：同一不变量（禁 /workspace、禁 Linux 路径）在 tool（`shell-path-guard.ts` + `command-tool.ts`）、middleware（`shell-path-policy.ts:24-101`）、service（`shell-execution-service.ts`）三个 seam 各实现一份，错误文案措辞不一；allowedCommands 解析散在 executor 与 runtime 两处。
- **改法**：保留三层纵深防御，但都调用同一个 policy 模块（输出判定 + 统一文案），各层只透传结论。
- **验收**：规则改一处三层同步；policy 一套测试覆盖判定逻辑。

### 8. 插件 DB 隔离 seam 修复 【Speculative】

- **问题**：per-plugin 独立 db 是刻意的隔离 seam，但 `database-pool.ts:78-93` 的 facade 把所有连接发给每个插件；`agent-task-history.ts` 名为 Reader 实为写入 agent 库；infrastructure 层放着两个域的删表 SQL；连接获取有 4 种姿势。journal 补偿机制目前工作正常，故摩擦是"将来会咬"而非"正在咬"。
- **改法**：facade 只暴露本插件连接；跨插件访问走 capability 或显式跨库 contract 模块；thread 删除+恢复封进 journal 单一入口；连接获取统一为一种姿势。

## 死代码与零深度微文件（仅报告，处置待确认）

- `database-rebuild.ts`（1,057 行，占 infrastructure 26%）：生产零调用方，仅自身测试引用。需确认是否为规划中的 restore-with-migrate 预备件；否则连同测试删除。
- `query-plan.ts`：`assertUsesIndex` 只被自己的测试消费。要么移入 tests 并对 task-repository 热查询加真实索引断言，要么删。
- 微转发文件群（~10 个）：两处 7 行 schema.ts 转发、`prompt-serialization.ts`（5 行）、`stream-tool-utils.ts`+`redact.ts`（同概念拆两文件）、`readInterrupted(run)` ≡ `run.interrupted`、`consumeSubagentStream` 15 行参数重排、capability preview 三层逐字段透传链、`tools.ts` 名实不符（创建的是 subagents）、`emitTodoEvent: () => {}` 永久空实现。
- mode 词汇 `'chat' ↔ 'run'` 在 5+ 处来回转换（`runtime.ts:1266,1275,1326`、`run-execution-snapshot.ts:208` 等）——可随优化项 3 一并定死一种词汇。

## 边界 / 不做项

- 不动 deepagents vendor 版本本身；候选 5 只改我方防腐层。
- 三层 shell 安全检查的纵深防御结构保留，只收敛规则实现。
- 死代码不擅自删除，等确认。
- 本计划不含接口详细设计；每项动工前建议先走一轮设计讨论（可用 grilling/design-it-twice 流程）确定 interface 形状。

## 建议实施顺序

```
1 (interrupt) → 2 (repository 收口) → 3 (RunOutcome)   ← 同一条工作线，同一病根
→ 4 (IPC 契约单源)                                      ← 独立，面宽，长期杠杆最高
→ 5 (adapter 领域事件) → 6 (task-repository) → 7 (shell policy) → 8 (DB seam)
死代码清理确认后随时插入（负成本）
```

每项完成的通用验证：`pnpm typecheck` + `pnpm test` 全绿；被收敛路径的旧测试（等价性测试、形状断言、穿透夹具）应当变少而非变多。
