---
status: accepted
date: 2026-11-06
---

# 执行协议共享，根任务与节点事实归一个持久所有者

现有聊天、科研阶段和领域作业已有真实能力，但身份、恢复和终止分支分散，
Task/预算在 agent DB，阶段/证据在 research DB。决定复用通用 Agent 执行协议，
由 ResearchTaskRepository 唯一拥有根任务、execution 关联及后续 DAG node/edge/lease，
领域 repository 只拥有领域输入输出；跨库写入使用持久 intent 与幂等对账，
不宣称跨库事务原子性，也不保留第二套 Runtime 或 ledger。

这比复制 scheduler/runtime 或只搬目录增加一次关联对账成本，但能使暂停、取消、
恢复、预算和旧 generation 拒绝使用同一身份合同。Grant、Effect lease、Task lease、
资源 admission 各保留独立含义；调度不增权、不重复计费。助手仍是唯一执行入口，
任务仅在既有管理抽屉观察和控制。此决定固定目标；S02/S06 实现，
版本与历史数据边界见 [迁移台账](../../plan/migration-ledger.md)。
