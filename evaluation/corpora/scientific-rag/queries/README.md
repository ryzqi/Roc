# 人工问题与证据

[queries.json](queries.json) 是 [scientificQuerySchema](../../../lib/scientific-rag-corpus.mjs) 数组，manifest 的 queriesHash 固定文件字节。空数组、未固定 hash 或未达到资格配额都不能使 corpus ready；以本次 checker 输出为准。

每题包括 id/category/query、targetPaperIds/BlockIds/TableIds/FigureIds/EquationIds、expectedEvidenceSpans、expectedAnswer、answerable、unanswerableReason 和 review。配额：paper-qa 50、method-equation 40、table-results 40、cross-paper 30、figure 20、unanswerable 20。相同问题与相同论文集合不能通过更换题号重复计数。

每个 evidence span 固定 id/paperId/sourceHash/blockId/page/start/end/quote/relevance（1–3），quote 必须等于对应 gold block.text 的 UTF-16 slice。跨论文比较至少两篇且各有真实证据；表格/图像题需对应对象目标。无答案题 expectedAnswer=null、spans=[]，保留人工判定理由。不要使用模型生成答案充当 Ground Truth。

review 的规则及内容 digest 与 [结构标注](../annotations/README.md) 相同，每个 query 单独绑定其全部题干、目标和预期结果。生产模型只接收公开问题与声明的来源范围；预期答案、gold evidence 和 review 留在 evaluator，不能作为模型输入。接入已有 eval runner 时，分区须沿用 source-connected components，不能把相关题拆成独立 holdout 来源。

## v2 条件与拒答

v2 manifest 中每题还必须包含 `schemaVersion: 2`、`answerability` 和 `requiredConditions`。既有字段对应方案中的 question_id/question/paper_ids/expected_answer/expected_evidence/required_objects/reviewer_decisions；继续复用 id/query/targetPaperIds/expectedAnswer/expectedEvidenceSpans/各类 target IDs/review，不建立重复真相。

`answerability` 取 `answerable`、`insufficient_evidence`、`conditions_not_comparable`，必须与既有 answerable 布尔值一致。`requiredConditions` 显式列出各论文实验条件：id、paperId、field、status、value、evidenceSpanIds。field 包括 dataset、dataset_version、split、metric、baseline、unit、training_budget、inference_budget、hardware、random_seed、repetitions、uncertainty、other。

known 条件需要非空原值及同一论文的已核验 evidence span；unknown/inapplicable 条件使用 value=null、evidenceSpanIds=[]，不得用默认值补齐。没有适用条件时显式使用空数组。改变条件会改变 review contentHash，需要重新审核。

条件不可比题必须列出 requiredConditions，并保留人工拒答理由。v2 无答案题允许保留用于判断条件的原始证据，但每个 span 必须被 requiredConditions 引用，expectedAnswer 仍为 null；这些证据不代表问题可回答，不加入正例召回分母。v1 无答案合同保持 spans=[]。
