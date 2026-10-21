# 导出附带报告用 Typst，不替换 LaTeX 主链

## 背景

导出交付包今天有 PDF、`source/`（可重编译的 LaTeX）、`references.bib`、图稿与追溯数据。
缺两样东西，用户在审稿与投稿时会自己补：

1. **规范样式的参考文献表**。LaTeX 那边的样式由模板的 `\bibliographystyle` 决定，Roc 生成不了
   GB/T 7714 / APA / IEEE 的成品列表；
2. **过程材料**。研究目标、证据索引、图稿清单散在界面与 `provenance/sources.json` 里，
   人工评审闸门（`docs/research-exports.md`）看到的只有论文 PDF。

Typst 被提出来同时解决这两件事，并且被问到一个更大的问题：**能不能全面采用 Typst（替掉
Tectonic + TeX bundle）**。本 ADR 用实测数据回答后者，并记录前者落地的边界。

## 实测（darwin-arm64，20 页正文 / 30 条参考文献 / 1 表 / 1 公式）

| 引擎 | 冷启动 | 热启动（连续 3 次） | 峰值内存 | 二进制 | 额外资源 |
| --- | --- | --- | --- | --- | --- |
| Tectonic 0.17.0 + TeX 子集 | 1.18 s | 0.27 / 0.27 / 0.29 s | 198 MiB | 51.5 MB | `tex/bundle.zip` 34 MB |
| Typst 0.13.1 | — | 0.24 / 0.24 / 0.25 s | 61 MiB | 32 MB | 无 |
| Typst 0.15.0 | — | 0.30 / 0.31 / 0.30 s | — | 43 MB | 无 |

中文字形已验证：Typst 在 `--font-path /System/Library/Fonts{,/Supplemental}` 下用
`Songti SC` / `Times New Roman` 正常排版（PingFang 在 `AssetsV2` 里，沙箱下不开放，见下）。
沙箱可跑：`sandbox-exec` + 只读字体目录 + `--root` 限制，编译成功。

**结论：两者的编译速度基本持平（Typst 0.15 比 Tectonic 热启动慢约 3%，0.13 快约 17%）。**
「Typst 更快」在 CLI 单次编译这个层面**不成立**——Tectonic 的内存缓存已经很快了。

## 决定

1. **不全面采用 Typst。** LaTeX 主链（claims → `latex-source.ts` 确定性重算 → Tectonic → PDFium）
   不动。全面替换的收益与代价完全不成比例：
   - 省下的是 51.5 MB 二进制 + 34 MB bundle，而工具链整体 2.3 GB（Python + docling + 模型占 99%），
     **节省 3.7% 的重量，换来重写整条导出合同**（`docs/research-exports.md` 的槽位、
     `citation-integrity.ts`、模板导入、BibTeX 闸门全部只对 LaTeX 成立）；
   - 投稿生态只收 `.tex`：arXiv、绝大多数期刊的系统都要求 LaTeX 源。Typst 全面替代意味着
     **把用户挡在投稿流程之外**——这与「导出」这个阶段的目的直接冲突；
   - 速度不构成理由（见上表）。
2. **Typst 只做导出附带的 `report.pdf`**（`src/main/plugins/research/typst-report.ts`）：
   项目/研究目标、本版规模、证据索引表、图稿清单、按 CSL 样式排版的完整参考文献。
   它**渲染的不是正文**——正文的真身是 claim 序列，渲染第二遍就是两份真相。
3. **CSL 由 Typst 原生的 hayagriva 承担**，不引入 citeproc-js / citeproc-rs：
   - 一份 `#bibliography("references.bib", style: "apa.csl")` 就完成格式化，没有第二个引擎；
   - `citeproc-rs` 上游已 archived（最后一次 wasm 发布 2021），`citeproc-js` 则是「再用一个
     JS 引擎做同一件事」——两个引擎对同一份数据给出不同结果时，没人知道该信哪个；
   - 样式是**数据**：`resources/research-runtime/csl/` 三份 `.csl`（APA / IEEE / GB/T 7714），
     参与 `lockHashes`，加样式要重建工具链。
4. **附带物失败不阻断导出**：`export-builder.ts` 在 `try/catch` 里调用报告生成，失败只写
   `logs/typst-report-error.txt`。一份能编译的论文不该因为报告排版失败而导不出来。

## 落地边界（红线）

- **renderer 里不引入 `@myriaddreamin/typst.ts`**（WASM 编译器 + 字体数据）。PDF 预览继续走
  `files.preview*` 协议与 PDFium；`pnpm check:renderer-chunks` 维护的 eager 图不接受这个体积。
- **Typst 路径必须离线**：`--root` 指向本次 job，`networkAccess: 'none'`，字体显式给
  `--font-path`（用户自己装的字体不参与，与 Vale 的 `--no-global` 同一个理由：同一输入同一输出）。
- **`.tar.xz` 用系统 `bsdtar` 解**：Node 没有 xz 解码器。这是**构建机**上的例外（`prepare.ts`），
  应用运行时从不调用 `/usr/bin/tar`；解包后只 copy 一个同名二进制进 `bin/`，其余丢弃。
- 报告源的 `.typ` 一起进交付包（`report.typ`），用户手上有 Typst 就能改；不改也能用 PDF。

## 代价

- 工具链再重 43 MB（并存而非替换）。这是本决定的直接成本，写在表格里而不是藏起来。
- 一份新的工具要维护：版本锁、许可证（Apache-2.0）、smoke 覆盖、架构双份归档。
- `report.pdf` 的内容一旦成为用户的期待，它就是合同的一部分：改它的版式要像改导出一样谨慎。

## 什么情况下这个决定会变

- arXiv / 主要投稿系统开始接收 Typst 源（目前不接受），或者
- 报告类产物变成一等公民（例如文献综述、审稿回复都走同一条排版链），到那时 Typst 会从
  「附加物」变成「第二条产品线」，需要单独 ADR 重新划边界。
