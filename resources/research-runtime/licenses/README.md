# 科研工具链第三方资源

工具链中 Tectonic、Vale、Typst 与 CSL 资源的许可证原文来自 `sources.json`，由准备脚本复制并纳入完整性清单。TeX 离线 bundle 保留入选文件的版权与许可声明。

| 资源 | 固定来源与许可证位置 |
| --- | --- |
| Tectonic | 0.17.0；`tectonic-MIT.txt` |
| Vale | 3.24.0；`vale-MIT.txt`。规则集是 Roc 自己编写的（`vale/styles/`），随工具链打包并进入 lockHashes |
| Typst | 0.15.0；`typst-APACHE.txt`，只用于附带报告 |
| CSL 样式 | APA、IEEE、GB/T 7714 引用数据来自 citation-style-language/styles，CC BY-SA 3.0（`csl-CC-BY-SA-3.0.txt`） |
| TeX/字体资源 | 官方 tlextras-2022.0r0 编译子集，文件名单锁定在 `tex-bundle-files.txt`；保留入选文件的版权与许可声明 |
| 原生文档解析 | `paddleocr@1.2.0`、`onnxruntime-node@1.22.0-rev` 与解码依赖的许可证随 npm 包分发 |
| OCR/版面/表格/公式模型与 tokenizer | `../research-models/models.lock.json` 固定来源 revision、SHA-256、Apache-2.0 声明；来源说明见 `../research-models/README.md` |

TeX bundle 是多许可证集合，不能用 Roc 核心许可证替代其中各自的声明。分发时同时携带本目录、模型来源说明与入选 TeX 文件的许可声明。科研工具链不含 Python、uv 或 Python 包许可证索引。
