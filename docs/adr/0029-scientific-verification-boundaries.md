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
supports/qualifies/contradicts/unrelated/insufficient/unable_to_verify；
强化语义门必须先有独立数据评价和明确产品决定。S01 扩展现有 evaluator，
S04 实现建议合同；当前 pilot 离线通过不表示科研有效。见
[统一合同](../../plan/contracts.md)、[验收矩阵](../../plan/acceptance.md)。
