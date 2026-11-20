# PDF 解析与 Paper IR

解析把原始 PDF 转为可追溯的文字、坐标和科研对象；Paper IR 为下游提供不可变的统一表示。版本集中在[当前实现](00-current-state.md)，字段定义见[数据合同](02-data-contracts.md)。发布成功说明工件一致性满足工程合同，识别质量仍需[独立评测](evaluation.md)。

## 原生文字、OCR 与阅读顺序

[document-parser.ts](../../src/main/plugins/research/document-parser.ts) 根据输入选择 Native、OCR 或 Mixed 路径。OCR 需要完整且与配置匹配的模型；普通原生文本路径不加载 OCR 模型。原始 PDF、原生文字项、OCR 区域、发布块及替代识别分别保留。

- [pdf-native-text.ts](../../src/main/plugins/research/pdf-native-text.ts) 保存 PDF.js TextItem、字体、transform 与原始几何，再投影到实际 raster viewport。裁剪后的可见区域不能代替原始边界；TextItem 矩形也不是字符或子串的精确坐标。
- [pdf-layout-merge.ts](../../src/main/plugins/research/pdf-layout-merge.ts) 按区域覆盖与对象类型选择来源，保留识别分歧和未覆盖的原生文字。相似度、规则分数及模型原始分数不作为校准概率。
- [pdf-reading-order.ts](../../src/main/plugins/research/pdf-reading-order.ts) 处理栏与跨栏块，未知几何明确保留。
- [pdf-document-reading.ts](../../src/main/plugins/research/pdf-document-reading.ts) 标记正文、标题、caption 和页边角色；只在相邻实际页面、兼容栏宽及句子续接条件下建立跨页链接。标题和对象构成屏障，原块 ID、原文和位置继续独立存在。

[paper-structure.ts](../../src/main/plugins/research/paper-structure.ts) 保存真实标题及 UTF-16 区间、父子章节和多语义角色。跳级标题不补造中间章节；caption、页边文字和普通 Results 章节不会自动变成科研结果。unknown 与 not_applicable 应按原状态传递。

## 可选语义与学术补充

[paper-semantic-service.ts](../../src/main/plugins/research/paper-semantic-service.ts) 对不确定正文作一次有界模型补充，不能改写原文、章节树、坐标或已有确定规则。当前[策略](../../src/shared/schemas/research-paper-semantics.ts)最多抽取候选的 25%（向上取整）、每篇 8 块；完整单块最多 1000 tokens，输入 6000、输出 1500、超时 30 秒。输入预算包含 prompt、schema、正文和 framing 预留。

补充记录明确区分 classified、no_candidates、unavailable、failed、timed_out。失败保留规则结果；父任务取消或来源变化阻止发布。模型配置变化不自动重分类所有旧论文，需要按来源所有者的 rebuild/reparse 流程生成新派生结果。

[GrobidAdapter](../../src/main/plugins/research/grobid-adapter.ts) 由 `ResearchPluginOptions.scholarlyParser` 显式注入，默认无服务。它请求 loopback HTTP 的全文解析接口，关闭 consolidation 和 redirect，校验 PDF hash，并限制输入、TEI 大小与 deadline。具体上限见[scholarly parser schema](../../src/shared/schemas/research-scholarly-parser.ts)。

TEI 坐标保持自己的 PDF point/top-left frame。只有与原文唯一完整匹配的字段才能绑定 Roc 的 block/span；引用 marker 还需核对所在段落和偏移。合法 TEI 的 `parsed` 不保证字段齐全。无服务、缺字段、非法 XML、异常坐标和无法匹配必须保留实际状态，不能成为原 PDF 的精确证据。

## 科研对象

| 对象 | 发布合同 | 源码 |
| --- | --- | --- |
| Table | 保留 HTML、行列、合并跨度、显式表头、caption、脚注、原始 cell 字符串与单位来源。普通首行不自动当表头；无合法 cell 几何时保留 null。 | [pdf-table-extractor.ts](../../src/main/plugins/research/pdf-table-extractor.ts) |
| Equation | 保留完整 raw LaTeX；规范化只处理既定空白规则，不修复数学含义。编号歧义、识别缺失和非法结构继续可见；变量定义须有原文范围。 | [pdf-equation-extractor.ts](../../src/main/plugins/research/pdf-equation-extractor.ts) |
| Figure / Caption | 保存对象、图片、caption 及编号引用的原位置；只有满足唯一邻域和几何规则才 linked，跨页、重号或多面板歧义保留 candidate。 | [pdf-caption-linker.ts](../../src/main/plugins/research/pdf-caption-linker.ts) |
| 页级质量 | 根据选定页的真实观测报告 coverage、重复、读序和结构警告；缺观测为 null。面积覆盖与 `good` 都不表示文字或科学结论正确。 | [pdf-quality-assessor.ts](../../src/main/plugins/research/pdf-quality-assessor.ts) |

[document-files.ts](../../src/main/plugins/research/document-files.ts) 在收集发布工件时重建并核验来源、对象、结构、质量与资产，不能仅凭两份被同步修改的输出互相证明。图片使用原资产身份；没有坐标或原文时不生成虚构定位。

## 不可变 IR 与资源释放

[paper-ir-builder.ts](../../src/main/plugins/research/paper-ir-builder.ts) 将已验证来源转为 IR v2：章节、blocks、tables/cells、figures、equations、algorithms、citations/references 与结构关系共享 Source Locator。元数据来自实际来源快照；缺失值保持未知。

[paper-ir-repository.ts](../../src/main/plugins/research/paper-ir-repository.ts) 校验身份、原文跨度、几何、引用、内容 hash 和字节数后发布不可变工件。对象 ID 编码 parse 与原始对象身份；cell 和算法 step 仍归属于同一 parse。下游必须核验工件与来源，不能只信路径或自行重算的摘要。

[ocr-stage-sessions.ts](../../src/main/plugins/research/ocr-stage-sessions.ts) 按阶段管理原生会话，取消和清理等待实际操作结束。项目暂停、关闭及删除通过现有准入与资源生命周期等待在途工作完成。

[artifact-gc.ts](../../src/main/plugins/research/artifact-gc.ts) 只处理满足预算和保留条件、当前无引用的派生工件。回收前重查数据库引用、发布活动和目录身份；历史 Evidence 与索引代次的 parse pins 必须受保护。原件、Evidence 和 Wiki revisions 不因重解析或索引失败而被覆盖。

## 处理 trace 与资源解释

[processing-trace.ts](../../src/main/plugins/research/processing-trace.ts) 用严格 v1 事件 `research_processing_stage` 关联解析、IR、分块、嵌入、抽取、卡片和 Wiki 阶段。`context` 保留 trace/project/paper/document、source hash、parse/parser、IR/chunk、embedding 配置及 index/Wiki generation 身份；未知身份和计数为 null，多论文关联 `related_papers` 最多 50 项。

每个 span 记录 started/ready/failed、墙钟 `durationMs`、计数与单位及受限失败码。模型阶段按页聚合，`activeDurationMs` 是实际调用耗时之和（含失败调用），input/output 分别计尝试和完成次数；它不等于包含调用间其他工作的阶段墙钟。Worker 通过 stderr 的 `roc_processing_stage:` 前缀传递 JSONL，主进程验证事件及 trace/来源归属后转发；事件不携带正文、模型回答、凭据或任意 provider 错误文本。

`resources.scope` 为 `process`：RSS 与生命周期峰值属于整个进程，CPU 是 span 期间的进程增量。主进程等待与 Worker 解析的范围不同，IR/分块/发布也可能嵌套；这些墙钟、CPU 和 RSS 不能直接求和得出总成本，峰值也不是单阶段独占内存。性能比较须另取固定来源及配置的成对测量。
