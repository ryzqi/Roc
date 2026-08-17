# Roc 架构优化总览

评审日期：2026-08-16。全部 9 个候选均纳入实施，拆为 9 个阶段。每阶段一份独立计划，可单独作为一条工作线交给一次会话执行。

## 阶段索引与依赖

| 阶段 | 文件 | 主题 | 强度 | 依赖 | 状态 |
|------|------|------|------|------|------|
| 1 | [phase-1-interrupt-lifecycle.md](phase-1-interrupt-lifecycle.md) | Interrupt 生命周期收敛（主进程 + 渲染层） | Strong | 无 | ✅ 2026-08-17 |
| 2 | [phase-2-session-repository-seams.md](phase-2-session-repository-seams.md) | session-repository 跨 seam 裸 SQL 收口 | Strong | 与阶段 1 相邻，建议紧随 | ✅ 2026-08-17 |
| 3 | [phase-3-run-outcome.md](phase-3-run-outcome.md) | 执行结果 seam：executor 返回 RunOutcome | Worth exploring | 阶段 1（interrupt 已收敛） | 待开始 |
| 4 | [phase-4-ipc-contract.md](phase-4-ipc-contract.md) | IPC 契约单源化 | Strong | 无（独立） | 待开始 |
| 5 | [phase-5-stream-adapter-domain-events.md](phase-5-stream-adapter-domain-events.md) | Stream adapter 领域事件 + 合并克隆投影 | Worth exploring | 阶段 3（事件流已只承载 UI） | 待开始 |
| 6 | [phase-6-task-repository-aggregates.md](phase-6-task-repository-aggregates.md) | task-repository 聚合化 + 按名注册 | Worth exploring | 无（独立） | 待开始 |
| 7 | [phase-7-shell-policy.md](phase-7-shell-policy.md) | Shell 安全 policy 单源 | Worth exploring | 无（独立） | 待开始 |
| 8 | [phase-8-db-isolation.md](phase-8-db-isolation.md) | 插件 DB 隔离 seam 修复 | Speculative | 阶段 6（task 侧接口稳定后） | 待开始 |
| 9 | [phase-9-dead-code-cleanup.md](phase-9-dead-code-cleanup.md) | 死代码与零深度微文件清理 | 快赢 | 无（随时可插入） | 待开始 |

```
主工作线：  1 → 2 → 3 → 5        （同一病根：事件流被当数据通道）
独立线：    4（IPC 契约）          6（task-repository） → 8（DB seam）    7（shell policy）
随时插入：  9（死代码清理，负成本）
```

推荐执行顺序：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8，阶段 9 在任意间隙执行。独立线（4/6/7）如需并行，避免与主工作线同时改 `runtime.ts` / `session-repository.ts`。

## 设计词汇

沿用 codebase-design：**module / interface / depth / seam / adapter / locality / leverage**。每阶段目标一致：更多行为藏进更小的 interface，修改与测试落在一个地方。

## 通用约束

- 不动 deepagents vendor 版本本身；阶段 5 只改我方防腐层。
- 三层 shell 安全检查的纵深防御结构保留（阶段 7 只收敛规则实现）。
- 不保留旧路径、兼容层、迁移胶水——每阶段完成即收敛为单一路径。
- 每阶段动工前先读对应 phase 文件的"设计决策"节；有开放决策的先定案再动手。

## 通用验收（每阶段收尾必做）

1. `pnpm typecheck` 全绿。
2. `pnpm test` 全绿。
3. 被收敛路径的旧测试（等价性测试、形状断言、穿透夹具）应当**变少而非变多**——测试行数增加是收敛失败的信号。
4. 涉及 IPC schema 改动的阶段（4）需 `pnpm generate:ipc` + `pnpm check:ipc` 通过。
5. 阶段完成后更新本文件的阶段状态（在表格行尾标注 ✅ 与完成日期）。
