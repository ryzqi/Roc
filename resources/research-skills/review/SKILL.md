---
name: roc-peer-review
description: 独立评估论文的方法、证据与表达并给出可执行修订意见。
---

区分重大问题、次要问题和表达建议；每项意见定位到段落、证据或图稿。
独立角色分别检查方法和统计、论据和引用、结构和表达，不预先读取其他角色结论。
综合意见保留分歧和未解决问题，不用多数票掩盖关键证据缺口。
verdict 为 ready、revise 或 uncertain。无法验证时明确 uncertain，不能宣称已验证实验。

每项缺陷以稳定编号记录严重程度、受影响段落或 evidenceId、可观察问题、所需修订与验收条件。区分来源完整性检查和科学判断；没有实际检查的项目标记 uncertain。

独立子角色只读取冻结稿件、原始证据、反证和已批准实验；不读取作者工作记录或其他角色报告，不修改正文、证据关系或审批。材料按工具分页读取，先核对 inputHash、claimHash、sourceDigest；引用采用 excerpt 的准确 UTF-16 start/end/quote。

证据角色输出 scientificReview.kind=verifier，逐条覆盖冻结 claim ID/version。分类是待人工审核的建议：factual 检查 direct_source；comparative 检查 comparable_conditions/baseline；numerical 检查 metric/unit/population/uncertainty；causal 检查 causal_design/confounders/identification；experimental 检查 run/controls/metric/reproducibility；novelty 检查 search_coverage/comparable_conditions/baseline；hypothesis 检查 falsification，不能当作已支持的事实。条件缺失时输出 insufficient 或有明确限定的 qualifies，不提供科学概率或 verified 状态。

支持、反证、负结果、替代解释和限定条件必须并列审查。已登记的反证不能省略。examinedEvidenceIds 记录检查范围，未检查完整时说明 unexaminedReason；“未发现反例”不等于不存在。

方法与写作角色输出 scientificReview.kind=reviewer。finding 必须含稳定 id、fatal/major/minor、fatal_flaw/method_fit/evidence_sufficiency/novelty_support/reproducibility/writing_integrity 分类、claimIds、原始 references、observation、action、acceptance；缺少证据本身的问题可无引用，但必须定位主张。无 finding 时说明 noFindingsRationale。只生成建议，由人工在修订矩阵中处置；修订后重新核验并关联修改位置。
