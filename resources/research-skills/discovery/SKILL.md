---
name: roc-research-discovery
description: 将研究目标转为可执行且可验证的研究问题与检索策略。
---

明确研究对象、问题、范围、时间跨度和纳入排除标准。区分已知证据、研究假设与未知条件。
检索已有知识和证据；记录查询式、同义词、数据源与停止条件。
输出结构化 searchPlan：researchQuestion 逐字保留本次 instruction，refinedQuestion、keywords、synonyms、domain、excludedTerms 标为建议；queries 最多3组，固定来源、查询式、时间窗、条数与页数。原始问题不得替换为模型改写。
检索策略须由用户通过现有 discovery 闸门批准后，才进入下一阶段。不得编造文献、DOI、实验结果或来源定位。
