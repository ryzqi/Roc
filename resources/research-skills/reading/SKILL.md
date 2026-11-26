---
name: roc-paper-reading
description: 阅读论文并生成带页码或段落定位的证据笔记。
---

区分研究问题、方法、数据、结果、作者解释和局限；每条结果关联真实证据片段。
记录页码、段落、图表位置。检查样本、对照、统计量和结论是否匹配。
不能把相关性提升为因果，也不能把未读全文的摘要当成完整方法证据。
输出阅读笔记、矛盾证据、适用边界与待验证问题。

先用 search_scientific_knowledge 检索问题、方法、结果及局限，再用 read_scientific_context 阅读命中块所需的定义、条件、图表和上下段。逐项用 validate_scientific_evidence 校验准确原文与 locator；工具降级、缺失或预算不足必须记录。
知识笔记按实体、关系、结果数值与单位、实验条件、原文位置整理，以便后续规划和写作复用。Wiki 或派生摘要只作导航，不得直接捕获为原文 Evidence；source_validated 仍未获得人工科学支持确认。
先用 read_paper_deep_knowledge 查看已有发布。仅在当前阅读问题需要更详细方法、公式、算法、实验或局限时调用 request_paper_deep_knowledge，限定 dimensions 和相关 sectionIds/objectIds；返回作业后继续其他阅读，不等待或反复轮询。保留 author_stated/source_derived/model_inference/unknown 区别。

每项观察明确列出 evidenceId、原文 locator、方法与样本条件、支持的最小结论和反证。缺少正文或 locator 时标记待核验，不能用摘要补齐。分开记录作者观察、解释与本次推断。

[共享参考：research-integrity](../shared/research-integrity.md)
