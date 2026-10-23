# 科研工具链第三方资源

本目录的许可证原文来自 `sources.json` 所列固定版本，保留上游版权声明；准备脚本将本目录原样复制到工具链。

| 资源 | 固定来源与许可证位置 |
| --- | --- |
| CPython 及 standalone 依赖 | `locks/tools.lock.json`；解释器中的 `python/lib/python3.12/LICENSE.txt` 及随包 notices |
| uv | 0.13.5；`uv-MIT.txt`、`uv-APACHE.txt` |
| Tectonic | 0.17.0；`tectonic-MIT.txt` |
| Vale | 3.24.0；`vale-MIT.txt`。二进制与规则集分开登记：规则集是 Roc 自己写的（`vale/styles/`），随工具链打包并进 lockHashes |
| Typst | 0.15.0；`typst-APACHE.txt`。只用于导出附带的报告排版（`typst-report.ts`），不进 LaTeX 主链 |
| CSL 样式 | 引用格式化**数据**（不是程序）：`csl/*.csl` 来自 citation-style-language/styles，CC BY-SA 3.0（`csl-CC-BY-SA-3.0.txt`）；与 Vale 规则集同理进 lockHashes |
| Python 科研依赖 | `locks/uv.lock`；构建时生成的 `python-packages.json` 记录实际版本、元数据与随包许可证文件路径，原文保留在各包中 |
| MinerU 解析模型（torch） | `locks/models.lock.json`；`opendatalab/MinerU-4_models_torch` 标注 Apache-2.0，版权与模型说明保留在对应仓库 README 中 |
| MinerU VLM（GGUF） | `locks/models.lock.json`；`42ailab/MinerU2.5-Pro-2605-1.2B-GGUF` 标注 Apache-2.0，量化自 `opendatalab/MinerU2.5-Pro-2605-1.2B` |
| MinerU 程序本体 | `python-packages.json` 中 `mineru-4.0.12` 的 `licenses/LICENSE.md`：MinerU Open Source License（Apache-2.0 + 商用阈值/在线服务署名附加条款） |
| TeX/字体资源 | `tex/bundle.zip` 为官方 tlextras-2022.0r0 的编译子集，文件名单锁定在 `tex-bundle-files.txt`；保留入选文件原有版权/许可声明；源 TAR 与子集 ZIP 哈希记录在 `locks/tools.lock.json` |

TeX bundle 与各 Python 包属于多许可证集合，不能用 Roc 核心许可证替代其各自声明。分发时同时携带本目录、模型说明、Python 包许可证与入选 TeX 文件；工具链完整性清单覆盖这些资源。
