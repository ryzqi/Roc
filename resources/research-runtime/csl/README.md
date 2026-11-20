# CSL 样式（引用格式化数据）

这些文件是 **Citation Style Language** 样式，来自
[citation-style-language/styles](https://github.com/citation-style-language/styles)，
按 CC BY-SA 3.0 分发（[许可原文](../licenses/csl-CC-BY-SA-3.0.txt)）。

| 文件 | 用途 |
| --- | --- |
| `apa.csl` | 作者-年份（中英混排里最常用的通用样式） |
| `nature.csl` | Nature 数字序号 |
| `american-medical-association.csl` | AMA 医学样式 |
| `chicago-author-date.csl` | Chicago 作者年份 |
| `ieee.csl` | 数字序号（工程与计算机方向） |
| `china-national-standard-gb-t-7714-2015-numeric.csl` | GB/T 7714-2015 顺序编码制（中文投稿） |

## 使用与维护

Typst 原生读取这些 XML 样式，用于导出报告的参考文献；决策见 [ADR 0025](../../../docs/adr/0025-typst-report-engine.md)。导出请求可指定 `reportCitationStyle`，省略时按项目 zh/en 语言选择默认样式，locale 使用锁定 Typst 的内置资源。

新增样式时：

1. 保存上游 `.csl`，在 [`provenance.json`](provenance.json) 记录来源与 SHA-256。
2. 在[样式表](../../../src/shared/schemas/research-citation-style.ts)登记请求枚举与文件名。
3. 重新[准备工具链](../README.md)：本目录全部普通文件（含 README）进入 manifest 的 `lockHashes`，原工具链不会自动覆盖。

当前六份样式固定于上游 `master` 提交 `ffd2a7b91280d84c9237ae97f9e5fd1f5abbe756`（2026-10-19），逐文件摘要以 provenance 为准。
