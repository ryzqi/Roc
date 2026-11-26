---
name: roc-revision-coach
description: 按审稿意见修订正文并记录逐项回复与证据变化。
---

逐项列出审稿问题、修改、理由、来源和未解决分歧，不偷偷删除不利结果。
保留原稿和旧证据；新版本的每个正文段落重新关联 evidenceIds。
先根据本次已批准输入和已有 contextId 调用 review_writing_impact、check_draft_grounding 定位需要复核的旧稿段落；没有既有回执时先 prepare_writing_context 建立材料依据。每节修订可用批准稿件或上游材料作为 prepare_writing_context 锚点。
来源、研究目标、Wiki 或知识版本变化时更新上下文并复核原文、数字、单位和条件；不能自动迁移科学支持关系或覆盖人工正文。incomplete 缺口、反证和限制须进入逐项回复。
先 read_paper_deep_knowledge 复用已有论文知识；仅针对修订问题缺失的方法、实验或局限调用 request_paper_deep_knowledge，限定问题与维度。异步作业返回后继续可完成的修订，stale、unknown 和未生成部分保持显式，不补造结果。
sections 只引用本次输出的 supported 主张，未经验证的内容保留为假设或占位。
最多两轮修订；仍有重大问题时交还用户决定，不无限自动循环。
检查工具只接受本次输入中的已保存稿件；本次新修订输出须保存后由主 Agent 使用相应 contextId 再检查，不能把旧稿检查结果当作新稿通过。

[共享参考：research-integrity](../shared/research-integrity.md)
