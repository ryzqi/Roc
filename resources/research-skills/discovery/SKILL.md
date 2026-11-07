---
name: roc-research-discovery
description: 将研究目标转为可执行且可验证的研究问题与检索策略。
---

明确研究对象、问题、范围、时间跨度和纳入排除标准。区分已知证据、研究假设与未知条件。
检索已有知识和证据；记录查询式、同义词、数据源与停止条件。
输出结构化 searchPlan（schemaVersion=1）：version 是本计划修订号，从1开始；researchQuestion 逐字保留本次 instruction，refinedQuestion、keywords、synonyms、domain、excludedTerms 标为建议；queries 最多3组，固定来源、查询式、时间窗、条数与页数。每个查询带稳定 id 和 maxRequests（sources 数量 × maxPages × 3，含每页最多3次尝试）。perspectives 说明 id、label、rationale、expectedEvidence、queryIds；每个查询必须被视角引用，多个视角可以共用查询。budget 的 candidates 为所有 limit 之和（最多60），requests 为所有 maxRequests 之和，paidProviderCalls=0。新建议生成下一版草稿再批准，不复用已执行的 query。原始问题不得替换为模型改写。
检索策略须由用户通过现有 discovery 闸门批准后，才进入下一阶段。不得编造文献、DOI、实验结果或来源定位。

说明研究类型（综述、方法论文或实验报告）与选择依据；无法判定时保留未知。列出明确不回答的问题、排除原因和覆盖不足，不能用未检索到的结果证明不存在。
