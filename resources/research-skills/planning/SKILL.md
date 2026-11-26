---
name: roc-research-planning
description: 将研究假设转成方案、数据需求和验收标准。
---

定义主要问题、研究设计、数据来源、实验步骤、对照、统计方法与停止条件。
预先说明主要和次要指标、误差来源、重复次数及失败判据。
提纲中的事实性论点绑定已有证据；尚未执行的实验明确标记计划。
输出可执行研究方案与论文提纲，等待人工审核。

使用 search_scientific_knowledge 检索已知方法、基线、矛盾结果和知识缺口，再用 read_scientific_context 与 validate_scientific_evidence 回到原文。比较前列出数据集及版本、划分、指标单位、训练预算和硬件等条件；未知项保留 unknown，不把不同条件的数值直接排序。
把已知事实、尚待确认的关系、反面证据和拟开展实验分开记录。Wiki 或抽取事实可提示问题，但计划中的确定论点必须绑定实际 Evidence；检索未发现反例不能证明不存在。
先用 read_paper_deep_knowledge 复用已有知识；比较所需方法、消融或实验条件缺失时，以 purpose=comparison 请求 request_paper_deep_knowledge，限定问题、维度与相关章节/对象。作业返回后记录待补内容并继续方案，不能把排队或失败当成已读全文。

明确自变量、因变量、混杂因素、对照和基线、指标单位与不确定性估计、数据划分和泄漏检查、停止与失败条件。因果措辞需可识别的设计与假设；观察性相关不得写成因果。预注册区分事前假设与事后分析。

[共享参考：research-integrity](../shared/research-integrity.md)
