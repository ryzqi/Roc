# 科研工具链第三方资源

本目录的许可证原文来自 `sources.json` 所列固定版本，保留上游版权声明；准备脚本将本目录原样复制到工具链。

| 资源 | 固定来源与许可证位置 |
| --- | --- |
| CPython 及 standalone 依赖 | `locks/tools.lock.json`；解释器中的 `python/lib/python3.12/LICENSE.txt` 及随包 notices |
| uv | 0.12.10；`uv-MIT.txt`、`uv-APACHE.txt` |
| Tectonic | 0.17.0；`tectonic-MIT.txt` |
| Vale | 3.24.0；`vale-MIT.txt`。二进制与规则集分开登记：规则集是 Roc 自己写的（`vale/styles/`），随工具链打包并进 lockHashes |
| Python 科研依赖 | `locks/uv.lock`；构建时生成的 `python-packages.json` 记录实际版本、元数据与随包许可证文件路径，原文保留在各包中 |
| Docling 布局模型 | `locks/models.lock.json`；Apache-2.0，版权及模型说明保留在对应模型 README 中 |
| Docling 表格与公式模型 | `locks/models.lock.json`；`CDLA-Permissive-2.0.txt` 与对应模型 README |
| TeX/字体资源 | `tex/bundle.zip` 为官方 tlextras-2022.0r0 的编译子集，文件名单锁定在 `tex-bundle-files.txt`；保留入选文件原有版权/许可声明；源 TAR 与子集 ZIP 哈希记录在 `locks/tools.lock.json` |

TeX bundle 与各 Python 包属于多许可证集合，不能用 Roc 核心许可证替代其各自声明。分发时同时携带本目录、模型说明、Python 包许可证与入选 TeX 文件；工具链完整性清单覆盖这些资源。
