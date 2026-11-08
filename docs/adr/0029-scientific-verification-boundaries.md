---
status: accepted
date: 2026-11-06
---

# 科研核验建议与人工证据决定分开保存

现有 Evidence/Claim/Locator、人工 relation revisions 和 citation coverage 已建立
来源完整性边界；模型自评不足以证明科研结论。决定确定性检查直接执行，
语义 Verifier 与隔离 Reviewer 只生成可失效建议，冻结 claim/source/artifact/
规则/模型/Skill 的版本与 hash；建议不覆盖人工 confirmed/rejected，不替代审批或公开授权。

这保留人工审查成本，但避免模型建议变成自己的证据或授权。语义 verdict 固定为
supports/qualifies/contradicts/unrelated/insufficient/unable_to_verify；Reviewer findings 通过 response matrix
记录人工 addressed/declined 处置，导出清单把建议标为需要人工审查。确定性来源、
人工 relation 和导出 currentness 分别校验；当前合成工程 fixture 不表示科研有效。
独立数据、人工盲审与受控真实模型评价未通过前，不把语义建议升级为科研正确性硬门。见
[证据关系](../research-evidence-relations.md)、[写作检查](../research-writing-checks.md)及[审稿回复矩阵](../research-response-matrix.md)。
