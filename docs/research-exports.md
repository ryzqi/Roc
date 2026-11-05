# 科研最终导出

导出以已通过审稿的批准正文为基础，生成 PDF、LaTeX 源文件、BibTeX、图稿和追溯数据的 ZIP。准备、发布到审核闸门、保存交付文件分别执行；生成成功后仍需人工批准。

## 准备

项目进入 export 阶段且审稿周期为 accepted 后，调用 `prepareExport`：

```typescript
await research.prepareExport({
  projectId,
  requestId,
  title: '研究报告',
  manuscriptArtifactId,
  figureIds,
  template: { kind: 'default', language: 'zh' }
});
```

`manuscriptArtifactId` 必须是当前审稿周期接受的正文；所选 `figureIds` 必须已批准。每次新准备使用新的 `requestId`，重复同一请求返回原记录，改变已有请求内容会失败。阶段 Agent 调用导出时，项目和运行身份由服务绑定；不能写入最终 ZIP 或宣称已批准。中文默认使用固定 TeX bundle 中的 CTeX/Fandol；英文使用通用 article。默认格式不套用期刊规范。

使用用户模板时，传入 `{kind: "imported", templateId, expectedRevision, expectedSourceDigest}`。版本与摘要来自当前模板记录。模板入口须包含：

```latex
\input{roc-manuscript.tex}
\bibliographystyle{plain}
\bibliography{roc-references}
```

正文与图稿注释写入入口文件所在目录中的 `roc-manuscript.tex`，参考文献写入同目录的 `roc-references.bib`，图稿放入其 `figures/` 子目录。嵌套入口采用同一规则。模板可以选择自己的 BibTeX 样式；缺少正文或参考文献入口会失败。原模板中的同名占位文件保存在追溯目录，原模板不会被改写。

`prepareExport` 返回 preparing 记录；使用 `getExport({projectId, exportId})` 或 `listExports({projectId, limit})` 查询。`cancelExport` 取消准备并等待结束。关闭和重启将未完成作业标为 interrupted，不自动重复执行；重新准备需新请求。

## 来源和输出

导出前有两道完整性检查，分居两个层，因为它们的输入不同：

**一、正文结构闸门**（`manuscript-integrity.ts`，在 `collect()` 的副作用之前，准备的第一步）：

| 码 | 含义 |
| --- | --- |
| `research_export_figure_claim_in_body` | 正文小节里的主张被标成 `figure`：它的溯源会被记成图稿主张 |

为什么只有一条、以及其他几条不变量住在哪里，写在 `manuscript-integrity.ts` 开头。摘要：
主张必须 `supported` 且证据可解析，由 `resolveManuscriptClaims()` 在**写正文时**
（`saveManuscript`）与**读正文时**（`requireCurrentManuscript`，导出走的正是这条）各验一次；
`supported` 但无证据的主张在 `createClaim` 就被拒了。上述三道都比导出的闸门早，再查一遍不会多
拦住任何东西。真正没被管的是 `subjectType`：那一层只看状态与证据，所以一条 `figure` 主张能被写进
正文小节，并被当作普通正文渲染。

**二、引用键闸门**（`citation-integrity.ts`，在 `export-builder.ts` 里、编译之前）：

| 码 | 含义 |
| --- | --- |
| `research_export_citation_unknown` | 模板里引用了快照参考文献里没有的键；全部缺失键写在 `logs/citation-report.json` |

这一条的必要性是**实测**出来的，不是推的：用随包 Tectonic 编译一份带 `\cite{does-not-exist}` 的文稿，

- `.bib` 文件**不存在**时才出现 `errors were issued by BibTeX, but were ignored`（退出码仍是 0）——
  `export-builder.ts` 只管这一种；
- `.bib` 存在但**缺这个键**时，BibTeX 只在 `.blg` 里写
  `Warning--I didn't find a database entry for "does-not-exist"`，Tectonic 退出码 0，
  `.log` 里是 `LaTeX Warning: Citation 'does-not-exist' on page 1 undefined`。

结果是：**一份引用键对不上的模板会编译成功并交付出去**，错误只在 PDF 里以一个未定义引用出现。
正文自己的 `\cite` 键由构造保证来自快照（`renderCitations()` 缺键就抛 `research_citation_key_required`），
所以这条规则真正的目标是**模板自己的 `.tex`**。它扫描本次会参与编译的 `.tex`（入口 + 模板文件 + 生成的正文），
跳过注释、`verbatim` / `lstlisting` / `minted` 与 `\nocite{*}`。

错误信息带定位（`<码>:<claimId>`）：科研域的错误码直接就是用户看到的信号，
但**位置**只在同步路径（publish / write / 每个 verifyStage）上完整——它们在 `collect()` 的调用栈里；
`prepare` 走后台作业，错误码要过 `exportError()` 的形状校验才能落进记录。

> `\ref` / `\label` 一致性**不在这里查**：Roc 只给图稿生成 `\label`，正文不生成 `\ref`，
> 今天没有可失败的情形。等同跟交叉引用落到渲染器里时再把它加到这里。

准备过程冻结批准正文及其主张/证据、批准图稿、引用的文献元数据、模型与实验运行、原始代码/数据和来源定位。文献引用键取自文献库；BibTeX crossref 父条目递归纳入快照及版本检查，并排在引用它的条目之后。父键优先匹配当前项目，未匹配时只接受全局唯一的有效条目。缺失、歧义、循环、版本变化或引用键冲突都会失败；文件与实验来源生成保留实际标题和定位的 misc 条目。正文和图稿的证据 ID 与 BibTeX 引用键之间的映射保存在追溯数据中。

每张图稿的 `provenance/figures/<figureId>/` 保存 hash 与已批准图稿一致的 `figure-manifest.json`、全部冻结输入、输出和日志，包含实际 post-transform 场景数据的 `output/figure-data.json`。复制时逐文件核对大小和 SHA-256；回执或输入变化不能生成成功交付。图像三格式继续写入 LaTeX 的 `figures/` 目录。

原批准正文的 LaTeX 保持原样存档。交付源文件采用同一段落内容与版本，合入批准图稿及统一的 BibTeX 引用。编译使用固定 Tectonic、本地 TeX bundle 和受限进程；Tectonic 报告忽略了 BibTeX 错误时，即使退出码为 0 也拒绝交付。生成 PDF 后由 PDFium 打开并渲染验证。归档由主进程 TypeScript 读取清单登记且哈希一致的普通文件，拒绝链接、越界和已有归档。

编译带 `--keep-intermediates`，目的只有一个：拿到 `.bbl` 并随包提供。arXiv 只跑一遍 `pdflatex`、
**不运行 BibTeX**，缺 `.bbl` 的包在那边每一处引用都会渲染成 `?`。中间文件本身不进交付包。

ZIP 包含：

- `paper.pdf`：供预览和提交的 PDF。
- `report.pdf`：**研究过程报告**（Typst 排版）：项目与研究目标、本版规模、证据索引、图稿清单、
  按 CSL 样式（APA / IEEE / GB/T 7714，随项目文稿语言选默认）排版的完整参考文献。它不是正文的
  第二个渲染——正文的真身仍是 claim 序列。取舍见 [ADR 0025](adr/0025-typst-report-engine.md)。
  报告排版失败会使导出作业失败，诊断保存在 `logs/export-error.txt`；不发布缺少报告的交付包。
- `report.typ`：报告的 Typst 源，用户手上有 Typst 就能改。
- `source/`：可重新编译的模板、正文、BibTeX、编译产出的 `.bbl` 与 PNG/SVG/PDF 图稿。
- `references.bib`：参考文献交换文件。
- `provenance/`：原批准正文、主张/证据、模型/实验运行、代码/数据和模板占位文件。
- `logs/`：编译输出、诊断、`arxiv-preflight.json`。
- `manifest.json`：文件大小/哈希、工具链版本/摘要、来源版本和归档器摘要。

`provenance/sources.json` 必须包含 `ideaOutcomes`，保存正文及所选图稿实际引用结果的当前人工评估。没有评估时为空数组。关联使用精确项目、结果回执 ID/hash 和冻结方法身份；每个冻结方法只纳入最新评估，另一个结果的评估不会因属于同一项目而进入导出。

`provenance/scientific-review.json` 使用 schema 4，包含完整评估回执及每个方法的全部 `stored_receipt` 历史，按每页 100 条读取。原冻结假设、预期结果、真实测量、人工结论和修订原因同时保留；历史标记只表示保存回执的完整性。schema 1、2、3 和缺少必填字段的数据被拒绝。

捕获和后续审核重验当前评估 head、冻结方法、真实结果/运行时间、指标 Evidence 及计划引用的证据。来源或人工评估变化会使原导出及审核失效，必须重新准备并审核；校验不会修改原来源快照或保存的审核文件。详细验收见 [Idea 方法与结果评估](research-idea-plans.md)。

### Citation / Scientific Consistency 审核快照

schema 4 必须包含 `citationReviews`、`consistencyReviews`、`figureConsistencyReviews` 和 `responseMatrices`。对正文与所选图稿固定最新人工审核、完整分页历史、确切主张/Evidence/实验结果版本及转换、舍入、容差规则。引用历史按每页 50 条读取；正文、图稿数值及审稿矩阵历史按每页 100 条读取，不能只导出第一页。没有审核的类别为空数组；移除的引用配对仍留在历史中，当前配对不含它。间接/不支持的引用声明、不一致数值及未处理/未采纳意见照实保留，不能自动变成语义支持、已处理状态或科学批准。

矩阵绑定保存稿件、精确 UTF-16 修改位置和所选 Evidence；独立于正文引用的矩阵 Evidence 进入导出来源闭包，实验指标按真实执行/源码/结果版本校验。过期稿件/来源阻止当前审批及导出；人工回复追加版本使旧 seal 失效。完整历史只证明原保存回执，没有审核时的空数组不证明没有外部审稿意见。

准备完成、发布到审核闸门、审批和交付前均核对当前来源与固定审核快照。生成期间新增审核也使旧快照失效；正常图稿 `rendered → approved` 状态变化不使已有映射失效。历史导出读取仍核对保存文件和 ZIP 字节，来源失效不妨碍读取已保存包。

图稿审核使用明确的 `redacted_receipt` 投影：只移除 `snapshot.material.run.workspacePath` 与 `workspaceRoot`，列出 `omittedFields`，分别保存 `originalSnapshotHash` 与 `redactedSnapshotHash`。后者可由导出 snapshot JSON 的 SHA-256 核对；前者是原私有回执的来源标识。脱敏投影不声称能够重建或验证依赖本机路径的原完整图稿 manifest。全包其余既有私有路径的整改由 PR10 处理，本部分不声明全包已满足公开发布隐私要求。

## arXiv 预检

`export-builder.ts` 在写完来源后跑一次 `arxiv-preflight.ts`，结论写 `logs/arxiv-preflight.json`。
**全部是警告，不是闸门**：arXiv 的体裁要求不该让一份合法的内部交付包导不出来。检查的项：

| 码 | 含义 |
| --- | --- |
| `missing_bbl` | 用了 BibTeX 但这次没拿到 `.bbl`（arXiv 上引用会变成 `?`） |
| `unreachable_tex` | 从入口到不了、也没被任何可达文件提到的 `.tex`，已从 `source/` 剪掉 |
| `draft_markup` / `todo_markup` / `commented_block` / `conditional_block` | `\todo{}`、`TODO/FIXME` 注释、`comment` 环境、`\iffalse` 残留在源里 |
| `absolute_path` | 源里出现 `/Users/…` 这类绝对路径 |
| `filename_not_portable` | 文件名含空格或非 ASCII |
| `figure_extension` / `figure_size` | 图稿格式不在 pdf/png/jpg/eps 里，或单图超过 5 MB |
| `missing_reference` | `\input` / `\includegraphics` 指向的文件不在模板里 |

剪枝的边界写在那儿：只剪 `.tex`，只剪不可达且未被提到的，模板库与磁盘上的文件都不动，
被剪文件的路径与 sha256 记进日志。`\input` 闭包按「相对引用文件所在目录」与「相对根目录」两种解析，
**注释里提到过的文件名也算提到**（作者写的「备用入口」是线索，不是噪声）。
不剥模板里的注释与草稿标记：模板文件的 sha256 是模板记录的一部分，改一个字节就会让 provenance 对不上。

单文件上限 64 MiB，内容总量上限 512 MiB，最多 10,000 个文件。ZIP 上限 600 MiB，内部文件日期固定。`readExportFile({projectId, exportId, path})` 只读取登记文件，预览上限 4 MiB；失败作业保留已收集文件和错误信息。

PDF 预览按导出 ID 和内容哈希读取，ZIP 不通过预览路由提供：

```text
roc-preview://research/exports/{encodedProjectId}/{encodedExportId}/{pdfSha256}.pdf
```

## 审核和保存

准备完成后调用 `publishExport({projectId, exportId, replacesExportId: null})`。发布、阶段 complete/approve 和最终保存都会重新检查来源、文件及 ZIP；核验期间改变来源或替换待审核版本，会拒绝旧请求。阶段 Agent 完成导出时，结构化输出会写到本次运行已发布的交付工件并记录模型 provenance；不能写入最终 ZIP 或宣称已批准。手工创建的 export_package 元数据不能代替实际导出准备。

在导出阶段 start 后，complete 进入 waiting_approval；用户检查 PDF、文献、图稿和来源后 approve。退回后可准备新版本，并通过 `replacesExportId` 替换旧草稿；旧版本保留，已批准版本不可原地修改。

仅批准的导出可调用：

```typescript
await research.writeExport({ projectId, exportId, destinationPath: '/absolute/destination/study.zip' });
```

目标父目录须已存在，目标 ZIP 须不存在。应用先在同一父目录暂存并验证副本，再排他创建目标文件；文件或链接已经存在时会失败，不覆盖旧交付文件。响应返回实际路径、哈希、大小及保存时间。正文、图稿、引用元数据或审稿接受状态失效后，须重新准备并审核。

## 验证

```bash
node scripts/research/smoke.ts \
  --toolchain .runtime/research-toolchain/darwin-arm64 \
  --models .runtime/research-models \
  --output .artifacts/research-toolchain-smoke
```

成功后读取该输出目录的 `result.json`，其中保留 PDF、页面图和解析结果。应用端到端另见 `pnpm test` 的 `.artifacts/smoke-electron/result.json`。
