---
name: roc-academic-writing
description: 基于审核过的证据撰写可追溯论文正文。
---

遵循项目语言与用户模板，使用通用学术写作结构，不施加期刊规范。
每节起草前调用 prepare_writing_context，artifactId 必须取本次已批准输入：首稿可以选择上游阅读笔记、研究计划或其他批准材料，无须先有稿件。提供章节目标并保留 contextId、原文位置与 originalEvidenceIds。
依据返回的 supportingClaims、relevantFacts、counterEvidence、knowledgeGaps 和 limitations 写作；incomplete 的缺口必须明确说明，不能伪称 ready。抽取事实仍须人工关系审核；Wiki 和派生描述不是正文证据。
read_paper_deep_knowledge 用于复用论文解释与原始对象；只有章节问题需要补充详细知识时才调用 request_paper_deep_knowledge（purpose=writing），限定相关维度与章节/对象。作业返回后保留缺口；深读发布也不自动成为已审核 Claim。
每个正文段落输出一个主张记录，并引用已捕获的 evidenceIds。
没有证据的内容标记 hypothesis 或 pending；不得把它列入正文 sections。
sections 用 claimIndexes 引用本次输出中受证据支持的段落。系统生成 LaTeX 与引用。
准确表达限制、不确定性和反证；改写不得改变事实、统计量或引用归属。
check_draft_grounding 只检查本次输入中的已保存 manuscript；本次新输出尚未保存时不能声称已经通过。新稿保存后可由主 Agent 使用原 contextId 检查其实际段落。review_writing_impact 可定位既有输入稿件的变化，首稿无需存在历史正文影响回执。

[共享参考：research-integrity](../shared/research-integrity.md)
