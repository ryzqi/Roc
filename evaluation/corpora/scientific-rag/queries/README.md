# 人工问题与证据

[queries.json](queries.json) 是 [scientificQuerySchema](../../../lib/scientific-rag-corpus.mjs) 数组，manifest 的 queriesHash 固定文件字节。空数组、未固定 hash 或未达到资格配额都不能使 corpus ready；以本次 checker 输出为准。

每题包括 id/category/query、targetPaperIds/BlockIds/TableIds/FigureIds/EquationIds、expectedEvidenceSpans、expectedAnswer、answerable、unanswerableReason 和 review。配额：paper-qa 50、method-equation 40、table-results 40、cross-paper 30、figure 20、unanswerable 20。相同问题与相同论文集合不能通过更换题号重复计数。

每个 evidence span 固定 id/paperId/sourceHash/blockId/page/start/end/quote/relevance（1–3），quote 必须等于对应 gold block.text 的 UTF-16 slice。跨论文比较至少两篇且各有真实证据；表格/图像题需对应对象目标。无答案题 expectedAnswer=null、spans=[]，保留人工判定理由。不要使用模型生成答案充当 Ground Truth。

review 的规则及内容 digest 与 [结构标注](../annotations/README.md) 相同，每个 query 单独绑定其全部题干、目标和预期结果。生产模型只接收公开问题与声明的来源范围；预期答案、gold evidence 和 review 留在 evaluator，不能作为模型输入。接入已有 eval runner 时，分区须沿用 source-connected components，不能把相关题拆成独立 holdout 来源。
