# 科研最终导出

导出冻结已通过审稿的批准正文、图稿和来源，生成本地交付 ZIP。准备、发布到阶段闸门、人工批准和保存分别执行；生成成功不等于获准公开发布。

## 准备与模板

项目须处于 export 阶段，当前审稿周期为 accepted，正文是该周期接受的版本，所选图稿均已批准。

1. 调用 `getExportInputs`，指定项目、正文、图稿和模板，获取当前来源及 `sourceHash`。
2. 人工填写作者、许可、公开元数据和每项资源的原件/仅元数据交付决定，组成 `publicationReview`。
3. 调用 `prepareExport`，传入上述选择、标题和新 `requestId`。可选 `reportCitationStyle` 及 `conversionFormats: ['docx', 'html']`。
4. 通过 `getExport` / `listExports` 查询后台状态；`cancelExport` 取消并等待作业结束。重启将未完成作业标为 interrupted，不自动重跑。

相同请求与身份重试返回原记录，改变已有请求内容会失败；新准备使用新 ID。阶段 Agent 的项目/运行身份由服务绑定，可准备并发布交付工件，但不能自行批准或保存最终 ZIP。手工创建 `export_package` 元数据不能代替真实准备。

默认模板 `{kind: 'default', language: 'zh' | 'en'}` 分别使用固定 bundle 中的 CTeX/Fandol 或 article，不套用期刊规范。导入模板传 `{kind: 'imported', templateId, expectedRevision, expectedSourceDigest}`，入口须包含正文及参考文献入口，例如：

```latex
\input{roc-manuscript.tex}
\bibliographystyle{plain}
\bibliography{roc-references}
```

生成文件放在入口所在目录，图稿在其 `figures/` 中；支持嵌套入口和模板自己的 BibTeX 样式。原模板不改写，同名占位文件另存追溯目录。

人工入口位于已批准正文的工件抽屉“审查公开科研导出”，提供来源重读、逐项交付决定、预览、刷新和取消。修改草稿使预览失效；导航及重试遵循[工件检查器](research-artifact-inspector.md)的版本边界。公开元数据和资源审查见 [RO-Crate](research-ro-crate.md)。

## 来源与完整性

准备冻结正文/主张/Evidence、图稿、书目、模型与实验运行、代码/数据和定位。正文写入与读取都要求主张 supported、证据有效；导出另拒绝正文小节中的 figure 主张（`research_export_figure_claim_in_body`）。

引用键来自文献库，文件和实验来源保留实际标题及 sourceType/sourceId，不将私有 locator 写入 BibTeX。crossref 父条目递归纳入快照与版本检查，优先同项目，其次全局唯一有效条目；缺失、歧义、循环、变更及键冲突均失败。Evidence 到引用键映射保存在追溯数据中。

编译前扫描实际参与编译的 TeX 引用键，跳过注释、代码环境和 `\nocite{*}`。模板引用未知键时返回 `research_export_citation_unknown`，细节在 `logs/citation-report.json`。编译使用固定 Tectonic、本地 bundle 和受限进程；忽略的 BibTeX 错误也使准备失败。PDF 由 PDFium 打开并渲染核验，Typst 报告失败同样阻止交付。

原批准正文 LaTeX 原样存档，交付源采用同版本段落、批准图稿和统一 BibTeX 引用。逐资源审查决定原始输入/输出是否随包；图稿 PNG/SVG/PDF 必须交付。复制校验大小与 SHA-256，并检查私有文本。公开 JSON 投影单独记录摘要与省略字段，不把原文件 byte hash 当成投影 hash。

## 交付内容

| 文件 | 用途 |
| --- | --- |
| `paper.pdf` | 正文 PDF |
| `report.pdf` / `report.typ` | Typst 研究过程报告：目标、规模、证据、图稿与 CSL 参考文献；见 [ADR 0025](adr/0025-typst-report-engine.md) |
| `source/` | 完整模板、生成正文、BibTeX、存在时的 `.bbl`、PNG/SVG/PDF 图稿 |
| `references.bib` | 参考文献交换文件 |
| `provenance/` | 原批准正文、公开来源/审核投影、获准交付原件、模板原件 |
| `logs/` | 编译诊断公开投影及 `arxiv-preflight.json` |
| `manifest.json` | schema 3：公开请求、文件大小/哈希、工具链、来源版本、归档器摘要 |
| `ro-crate-metadata.json` / `ro-crate-profile.html` | 固定 RO-Crate 1.2 / roc-research-1，作者、许可、资源、运行与人工审批关系 |
| `conversion/`、`paper.docx` / `paper.html` | 请求转换时的 Pandoc 输入、工具链/来源摘要、转换 manifest 与成品 |
| `submission/` | 独立 arXiv 候选源、manifest，以及通过本地检查时的提交 ZIP |

DOCX/HTML 从批准 sections、claims、引用及 caption 构造，不转换导入 TeX 模板布局。Claim 按纯文本处理，复杂公式、表格与 Markdown 保持字面文本；仅嵌入已校验 PNG。报告和转换采用指定 CSL 样式或文稿语言默认值，保存 AST、BibTeX、CSL 和输入图像。目标应用排版需人工核对，文件不提供 Zotero Word 动态引文字段。

单文件上限 64 MiB，总内容 512 MiB、10,000 个文件，ZIP 上限 600 MiB。归档只接受已登记且 hash 一致的普通文件，拒绝链接、越界与已有归档，内部日期固定。`readExportFile` 只读登记文件，预览上限 4 MiB；失败作业保留收集文件和错误。

导出 PDF 按项目/导出 ID 与 hash 读取，ZIP 不走预览路由：

```text
roc-preview://research/exports/{encodedProjectId}/{encodedExportId}/{pdfSha256}.pdf
```

## 科研审核快照

`provenance/sources.json` 的公开投影保留 `ideaOutcomes`；只纳入正文/所选图稿实际引用结果对应的最新人工评估，没有时为空。`provenance/scientific-review.json` 的内部 schema 5 保存方法评估、引用直接性、正文及图稿数值映射、回复矩阵、期刊检查的最新头与完整分页历史。缺少必填类别或旧 schema 被拒绝。

当前来源、冻结方法、结果回执、Evidence、规则与最新人工审核均在准备、发布、审批和保存时重验。生成期间新增审核也使旧快照失效，须重新准备并审核；正常图稿 rendered → approved 不使已有映射失效。历史 `stored_receipt` / 公开投影只证明保存字节与回执完整性，不证明当前来源有效、科学支持或批准。

间接/不支持的引用、不一致数值、未处理意见照实保留。矩阵引用进入来源闭包；期刊补充材料仅封存路径、大小、hash，`metadata_only` 文件不随包但当前字节仍需验证。图稿脱敏回执保留原/脱敏摘要和明确省略字段。各领域合同见[写作检查](research-writing-checks.md)、[图稿](research-figures.md)、[方法评估](research-ideas.md)、[回复矩阵](research-response-matrix.md)和[期刊检查](research-journal-compliance.md)。

## arXiv 候选包

从冻结 `source/` 构建 `submission/source/`，完整原件字节保留。仅衍生目录移除不可达且未提及的 `.tex`；宏或依赖无法静态解析时禁用剪枝。不会删注释、展开宏或改正文，manifest 记录 original/derived SHA-256 与删减理由。

预检区分 warning 与 error：缺 `.bbl`、缺引用文件、需要 shell escape 等 error 设置 `submissionBlocked`，不编译候选包；草稿标记、文件名、未知依赖、biblatex兼容性及图稿格式/大小给出人工检查提醒。5 MiB 图稿阈值是 Roc 提醒值。内部交付包仍可保留这些预检结论。

候选包本地编译 ready 且满足嵌套归档预算才生成 `submission/submission.zip`。`submission/manifest.json` 为 schema 1 / `roc-arxiv-v2`，记录依赖分析、原/衍生文件和编译结果。没有执行 arXiv 环境；提交前须人工核对目标平台处理器与规则。

## 审核与保存

`publishExport({projectId, exportId, replacesExportId: null})` 发布到阶段闸门。start 后 complete 进入 waiting_approval，由用户核对完整工件版本后 approve。退回可准备新版本，以 `replacesExportId` 替换旧草稿；历史保留，批准版本不可原地修改。

仅批准且当前来源有效的导出可调用 `writeExport({projectId, exportId, destinationPath})`。目标是父目录已存在的绝对 ZIP 路径，文件须不存在；先在同目录暂存并校验，再排他创建，拒绝覆盖文件或链接。返回实际路径、hash、大小和时间。历史导出仍可在保存文件及 ZIP 字节核验后读取，来源过期不能据此重新批准或交付。
