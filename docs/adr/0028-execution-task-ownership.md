---
status: accepted
date: 2026-11-06
---

# 执行协议共享，根任务与节点事实归一个持久所有者

聊天、科研阶段和领域作业共用通用 Agent 执行协议。Task/预算在 agent DB，阶段/证据在 research DB。
由 ResearchTaskRepository 唯一拥有根任务、execution 关联及 DAG node/edge/lease，
领域 repository 只拥有领域输入输出；跨库写入使用持久 intent 与幂等对账，
不宣称跨库事务原子性，也不保留第二套 Runtime 或 ledger。

这比复制 scheduler/runtime 或只搬目录增加一次关联对账成本，但能使暂停、取消、
恢复、预算和旧 generation 拒绝使用同一身份合同。Grant、Effect lease、Task lease、
资源 admission 各保留独立含义；调度不增权、不重复计费。助手仍是唯一执行入口，
任务仅在既有管理抽屉观察和控制。执行身份、任务事实与恢复边界见[任务与上下文](../research-task-observability.md)。
