---
status: accepted
date: 2026-11-06
---

# 十一阶段 Skill 必填 Manifest，共用上下文装配

十一阶段 Skill 通过 Manifest registry 加载，聊天与阶段角色共享分层 context assembler。
Manifest 固定内容版本/hash、许可、能力要求和 output
schema；执行能力为角色白名单、run Manifest、Skill requirements、grant scope 的交集，
缺合同就拒绝加载，不回退 raw Skill；继续遵守 ADR 0027 的唯一 Roc compactor。

这增加内置 Skill 的维护与版本冻结成本，但消除省略 Manifest 和默认工具列表造成的
权限歧义。文本、摘要与 task facts 仍为来源绑定数据，不能授予权限；Writer/Reviewer
上下文隔离，硬约束与人工决定不可被压缩改变。S03 已完成十一份内容与全部消费者，
删除旧映射和单独装配分支。见 [删除台账](../../plan/deletion-ledger.md)。
