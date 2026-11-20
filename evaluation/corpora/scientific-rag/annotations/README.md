# 人工结构标注

每篇独立 JSON，使用 [scientificAnnotationSchema](../../../lib/scientific-rag-corpus.mjs)。manifest 的 annotationHash 固定文件字节。不要把当前 Parser 的输出自动复制为人工 Ground Truth。

字段为 schemaVersion=1、annotationVersion=scientific-gold-v1、paperId/sourceHash、parseRef、coordinateSystem、pages、blocks、expectedSections/Tables/Figures/Equations/Citations 和 review。pages 覆盖全部真实页数，保存人工 transcript；blocks 保存独立 gold ID、page、kind、text、readingOrder 和 bbox。所有 block/object ID 建议加 paperId 前缀。

gold bbox 使用 `TOPLEFT_NORMALIZED`：按原 PDF 页旋转后的 CropBox 可见范围归一化 `[x0,y0,x1,y1]`，每个数在0–1之间；评测适配器须从生产坐标合同转换，不能通过字符索引猜坐标。query 的 start/end 是 gold block.text 中的 UTF-16 偏移。gold 是独立参考，与生产 parse locators 不混用。基于已有 parse 标注时 parseRef 固定 parseId/parseHash/parserFingerprint；直接对 PDF 标注用 null。

表格标注含 html 和真实 cells 的 row/column/rowSpan/columnSpan/text；公式含原始 latex、normalizedLatex 和 normalizationVersion；图像含 caption。重叠 cell、错误对象类型、页范围及未定义 block 被拒绝。TEDS HTML/cells 语义一致性、转录准确性和完整性需独立人审与后续 scorer，当前资格检查不测这些质量。

沿用现有 evaluation 的双人独立审核：review.status=reviewed；annotations 至少两人且不能是 provenance.producer，记录 reviewer、reviewedAt、contentHash、judgmentHash。contentHash 使用 `scientificReviewContentHash(annotation)`，即公共 canonical hash 去掉 review 后的内容。两份判断 digest 不同须有独立第三人 arbitration（reviewer/reviewedAt/contentHash/resolution）。记录来源和真实人工身份由数据维护者核实；本工具不会创建审核身份。
