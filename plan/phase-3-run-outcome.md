# 阶段 3：执行结果 seam —— executor 返回 RunOutcome

强度：Worth exploring。依赖：阶段 1（interrupt 数据已不走事件流捞回，本阶段处理剩余的最终消息与 usage）。

## 问题

"最终 assistant 消息是什么"没有单一权威点，事件流被当作层间数据通道：

- executor 累积 `assistantChunks` 第一遍，但仅用于空输出兜底判断，不上交 — `src/main/plugins/agent/deep-agent-executor.ts:103, 380, 412-425`
- runtime 靠重放事件流第二遍累积同一字符串 — `runtime.ts:1018, 1069-1072, 1104`
- 还要用顺序敏感的 split/join 剔除 hook 显示文本（`stripHookDisplayText`，`runtime.ts:1395-1401`）
- delta 分类在 `stream-consumers.ts:63-76`；`run-summary.ts` 再从该文本派生摘要
- 附带摩擦：mode 词汇 `'chat' ↔ 'run'` 在 5+ 处来回转换（`runtime.ts:1266, 1275, 1326`、`run-execution-snapshot.ts:208`、`deep-agent-executor.ts:731-733`、`session-repository.ts:324`）

这是"抽了纯函数但 bug 在编排处"的典型形状：每个分类函数可测，两层交界处只能整机穿透——727 行的 `deep-agent-executor-test-helpers.ts` 是 interface 无法窄测的直接证据。

## 目标形态

executor 的 interface 改为返回结构化结果对象（建议名 `RunOutcome`）：

```
RunOutcome {
  finalMessage: string        // 已剔除 hook 显示文本，唯一权威
  interrupts: PendingInterrupt[]   // 阶段 1 的领域形态
  usage: ModelUsage           // 阶段 4 会统一的共享值对象，此处先用现有形状
  summarySource: ...          // run-summary 需要的素材
}
```

事件流只承载 UI 增量，不再是数据通道。runtime 消费 RunOutcome，不再重放事件。

## 实施步骤

1. 定义 `RunOutcome` 类型；executor 内部把 `assistantChunks` 累积升级为权威组装（含 `stripHookDisplayText` 逻辑搬入 executor，在 chunk 产生处剔除而非事后字符串手术）。
2. executor 执行完成路径返回 RunOutcome；interrupt 字段由阶段 1 的 interrupt-projection 产出。
3. runtime 删除事件重放累积（`runtime.ts:1018-1104` 相关段）与 `stripHookDisplayText`；改从 RunOutcome 取值。
4. `run-summary.ts` 改从 RunOutcome 取素材。
5. **mode 词汇定案**：seam 上定死一种（建议 `run`，与 snapshot/持久层一致），转换只发生在 IPC 入口一次；删除 `readExecutorMode` 等来回转换点。
6. 精简 `deep-agent-executor-test-helpers.ts`：不再需要构造完整事件流夹具验证最终消息的部分删除。

## 设计决策（动工前定案）

- usage 累积（`stream-usage-accumulator.ts`）是否一并收进 RunOutcome？建议收——executor 已在 `deep-agent-executor.ts:432-439` 手工搬运五元组，RunOutcome.usage 让搬运消失；五元组的类型统一留给阶段 4。
- 恢复/重试路径（executeRun 的 while 循环，`runtime.ts:767-936`）中途失败时 RunOutcome 的部分结果语义：建议失败即无 RunOutcome，部分输出只存在于已发出的 UI 事件里——不引入"半个结果"形态。

## 验收

- 全仓 grep：runtime 不再出现 `assistantChunks` 累积与 `stripHookDisplayText`；最终消息只在 executor 组装一次。
- mode 词汇只剩一种，转换点唯一。
- runtime 测试不再构造事件流夹具验证最终消息；`deep-agent-executor-test-helpers.ts` 行数显著下降。
- `pnpm typecheck` + `pnpm test` 全绿。

## 完成证据

- `RunOutcome` 以判别联合承载 completed 的 `finalMessage`、`summarySource`、`usage`，以及 interrupted 的 `interrupts`、`usage`；失败和取消不伪造半结果。
- executor 在 assistant delta 产生时组装权威文本，只剔除开头 hook echo；正常回答中的同文文本由碰撞回归测试证明会保留。
- runtime 不再累积 assistant 文本或成功 tool name；事件流只负责 UI 增量，最终消息、摘要素材、interrupt 和成功 usage 均读取 outcome。
- completed outcome 已发布后若事件投影失败，runtime 会补记 outcome usage；失败执行的部分 usage 仍由 executor callback 记录，回归测试覆盖 recovery 累计值。
- 内部事件、snapshot、持久化和 renderer 统一使用 `run | plan | task`；`toChatRunMode` 只在 snapshot 重建 IPC request 的出口调用，live/replay `run_started` 完全一致。
- `deep-agent-executor-test-helpers.ts` 从阶段开始时的 735 行降至 487 行；capability fixture 拆到独立测试文件。
- 聚焦测试 58 文件/358 项通过；`pnpm typecheck`、strict unused、全量 324 文件/1820 项、`git diff --check` 通过。
- Standards 与 Spec 修复后最终复审均 PASS。
