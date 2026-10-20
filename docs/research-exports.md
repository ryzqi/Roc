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

准备开始前先过一道**正文结构闸门**（`manuscript-integrity.ts`，在 `collect()` 的副作用之前调用）：

| 码 | 含义 |
| --- | --- |
| `research_export_figure_claim_in_body` | 图稿主张被放进了正文小节（它只能作图注） |

为什么只有一条、以及其他几条不变量住在哪里，写在 `manuscript-integrity.ts` 开头。摘要：
主张必须 `supported` 且证据可解析，由 `resolveManuscriptClaims()` 在**写正文时**
（`saveManuscript`）与**读正文时**（`requireCurrentManuscript`，导出走的正是这条）各验一次；
`supported` 但无证据的主张在 `createClaim` 就被拒了。上述三道都比导出的闸门早，再查一遍不会多
拦住任何东西。真正没被管的是 `subjectType`：那一层只看状态与证据，所以一条 `figure` 主张能被写进
正文小节，然后同时被渲染成正文（下面没有图）与图注。

错误信息带定位（`<码>:<claimId>`），因为科研域的错误码直接就是用户看到的信号。
闸门在准备开始前就挡住，不会等图稿校验、实验快照跑完再失败；发布与交付时会重新跑一遍。

> `\cite` / `\ref` / `\label` 一致性**不在这里查**：正文的 `\cite` 键由构造保证来自快照，
> 而模板里的缺失键由更强的闸门兜住——`export-builder.ts` 拒绝「BibTeX 报错被忽略」的编译结果。
> `\ref` / `\label` 今天没有可失败的情形（Roc 只给图稿生成 `\label`，正文不生成 `\ref`）；
> 等同跟交叉引用落到渲染器里时再把它加到这里。

准备过程冻结批准正文及其主张/证据、批准图稿、引用的文献元数据、模型与实验运行、原始代码/数据和来源定位。文献引用键取自文献库；BibTeX crossref 父条目递归纳入快照及版本检查，并排在引用它的条目之后。父键优先匹配当前项目，未匹配时只接受全局唯一的有效条目。缺失、歧义、循环、版本变化或引用键冲突都会失败；文件与实验来源生成保留实际标题和定位的 misc 条目。正文和图稿的证据 ID 与 BibTeX 引用键之间的映射保存在追溯数据中。

原批准正文的 LaTeX 保持原样存档。交付源文件采用同一段落内容与版本，合入批准图稿及统一的 BibTeX 引用。编译使用固定 Tectonic、本地 TeX bundle 和受限进程；Tectonic 报告忽略了 BibTeX 错误时，即使退出码为 0 也拒绝交付。生成 PDF 后由 PDFium 打开并渲染验证。归档由主进程 TypeScript 读取清单登记且哈希一致的普通文件，拒绝链接、越界和已有归档。

ZIP 包含：

- `paper.pdf`：供预览和提交的 PDF。
- `source/`：可重新编译的模板、正文、BibTeX 与 PNG/SVG/PDF 图稿。
- `references.bib`：参考文献交换文件。
- `provenance/`：原批准正文、主张/证据、模型/实验运行、代码/数据和模板占位文件。
- `logs/`：编译输出与诊断。
- `manifest.json`：文件大小/哈希、工具链版本/摘要、来源版本和归档器摘要。

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
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/smoke.ts --toolchain /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 --models /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-models --output /Users/Apple_501/Desktop/Roc/Roc/.artifacts/research-toolchain-smoke
```

成功后读取该输出目录的 `result.json`，其中保留 PDF、页面图和解析结果。应用端到端另见 `pnpm test` 的 `.artifacts/wave1/electron-smoke.json`。
