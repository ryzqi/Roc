# 科研工具链第三方资源

Tectonic、Vale、Typst、Pandoc 与 CSL 的许可来源及 SHA-256 记录在 [`sources.json`](sources.json)，由准备脚本复制并纳入完整性清单。TeX 离线 bundle 保留入选文件的版权与许可声明。

| 资源 | 固定来源与许可证位置 |
| --- | --- |
| Tectonic | 0.17.0；`tectonic-MIT.txt` |
| Vale | 3.24.0；`vale-MIT.txt`。规则集是 Roc 自己编写的（`vale/styles/`），随工具链打包并进入 lockHashes |
| Typst | 0.15.0；`typst-APACHE.txt`，只用于附带报告 |
| Pandoc | 3.13；GPL-2.0-or-later，`pandoc-COPYRIGHT.txt` 与 `pandoc-GPL-2.0.md`，用于可选 DOCX/HTML |
| CSL 样式 | [六种样式](../csl/README.md)来自 citation-style-language/styles，CC BY-SA 3.0（`csl-CC-BY-SA-3.0.txt`） |
| TeX/字体资源 | 官方 tlextras-2022.0r0 编译子集，文件名单锁定在 `tex-bundle-files.txt`；保留入选文件的版权与许可声明 |

TeX bundle 是多许可证集合，分发时须携带入选文件各自的声明及本目录。工具链不含 Python、uv 或模型权重；按需下载的模型许可见[模型说明](../../research-models/README.md)。
