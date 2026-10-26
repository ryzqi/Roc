# 科研工具链第三方资源

Python/R/TeX 工具链的许可证原文来自 `sources.json`，由准备脚本原样复制进工具链。Python 包以生成的 `python-packages.json` 为准，包内许可证保留在各自的 `licenses` 文件中。

| 资源 | 固定来源与许可证位置 |
| --- | --- |
| CPython 及 standalone 依赖 | `tools.lock.json`；解释器中的 `python/lib/python3.12/LICENSE.txt` 及随包 notices |
| uv | 0.13.5；`uv-MIT.txt`、`uv-APACHE.txt` |
| Tectonic | 0.17.0；`tectonic-MIT.txt` |
| Vale | 3.24.0；`vale-MIT.txt`。规则集是 Roc 自己写的（`vale/styles/`），随工具链打包并进 lockHashes |
| Typst | 0.15.0；`typst-APACHE.txt`，只用于附带报告 |
| CSL 样式 | APA、IEEE、GB/T 7714 引用数据来自 citation-style-language/styles，CC BY-SA 3.0（`csl-CC-BY-SA-3.0.txt`） |
| Python 科研依赖 | `uv.lock`；构建时生成的 `python-packages.json` 记录实际版本、元数据与许可证文件路径 |
| TeX/字体资源 | 官方 tlextras-2022.0r0 编译子集，文件名单锁定在 `tex-bundle-files.txt`；保留入选文件的版权/许可声明 |
| 原生文档解析 | `paddleocr@1.2.0`、`onnxruntime-node@1.22.0-rev` 与解码依赖的许可证随 npm 包分发 |
| OCR/版面/表格/公式模型与 tokenizer | `../research-models/models.lock.json` 固定来源 revision、SHA-256、Apache-2.0 声明；来源说明见 `../research-models/README.md` |

TeX bundle 与 Python 包属于多许可证集合，不能用 Roc 核心许可证替代其各自声明。分发时同时携带本目录、模型来源说明、Python 包许可证与入选 TeX 文件的许可声明。
