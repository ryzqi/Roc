# CSL 样式（引用格式化数据）

这些文件是 **Citation Style Language** 样式，来自
[citation-style-language/styles](https://github.com/citation-style-language/styles)，
按 CC BY-SA 3.0 分发（原文见 `../licenses/csl-CC-BY-SA-3.0.txt`）。

| 文件 | 用途 |
| --- | --- |
| `apa.csl` | 作者-年份（中英混排里最常用的通用样式） |
| `ieee.csl` | 数字序号（工程与计算机方向） |
| `china-national-standard-gb-t-7714-2015-numeric.csl` | GB/T 7714-2015 顺序编码制（中文投稿） |

## 为什么是数据而不是依赖

Typst 的 `#bibliography(..., style: "x.csl")` 通过 hayagriva 直接吃 CSL 样式，所以这三份 XML
就是全部运行时依赖——不需要再引入 citeproc-js 之类的第二个 CSL 引擎（两个引擎就是两份真相，
而且 `citeproc-rs` 上游已 archived，见 `docs/adr/0025-typst-report-engine.md`）。

## 怎么加一种样式

1. 从上游仓库下载 `.csl`，去掉文件名里的空格（`prepare.ts` 按原文件名复制，文件名进 lockHashes）；
2. 放进本目录，`scripts/research/prepare.ts` 的 `computeLockHashes()` 会自动纳入 `csl/` 下的每个文件，
   所以**加样式要重建工具链**，这与 Vale 规则集同一条规矩；
3. 在 `src/main/plugins/research/typst-report.ts` 的样式表里登记（`'apa' | 'ieee' | 'gb-t-7714'`），
   否则这个文件只是随包睡在那里。

固定来源：分支 `master`、提交 `ffd2a7b91280d84c9237ae97f9e5fd1f5abbe756`（2026-10-19）。
文件哈希由 `tools.lock.json` 的 `lockHashes` 与实际文件共同钉住，不在这里抄第二遍。
