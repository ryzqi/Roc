# 科研 Python 运行时

Python 3.12.15 随应用分发，只有 Apple Silicon 版本。`uv.lock` 是单架构（arm64）的解析结果：MinerU 4.x 依赖的 torch / MPS 后端没有可用的 x64 wheel。

`transformers` 被钉在 `==5.20.2`（`mineru[torch]==4.0.12` 声明的下限）：4.x 的 `transformers` 已经删掉 MinerU 需要用到的旧 API，5.20.2 是 P0 实测能装、能离线跑、能在 sandbox 内用 MPS 的唯一区间。

MinerU 4.0.12 负责 PDF / 图片 / HTML 解析：版面（PP-DocLayoutV2）、公式、表格走 torch 小模型；`standard` / `advanced` 档位再加一个 llama.cpp VLM（`mineru-llama-cpp`，Metal 加速）做逐块理解。OCR 在 MinerU 内部完成（`ocr_mode` 为 `auto`/`txt`/`ocr`），**不再有独立的 Vision/ocrmac 链路**。解析模型不随安装包分发：开发机使用 `.runtime/research-models`，打包后下载到 `~/.roc/research-models`；模型自带的 `.mineru_complete` 标记由官方下载器写入，运行时只校验不伪造。打包 extraResources 排除 models、旧 `bibliography.py`、`PyObjCTest`、pip/debugpy/jedi/IPython、faker/polyfactory、torch 头文件以及 Python include；afterPack 用当前 `worker.py` / `figure.py` 覆盖 live 副本并改写 manifest。文献交换在主进程 `bibliography.ts`，不随工具链分发 Python 入口。运行时禁止自动联网拉取。Matplotlib 渲染仍由随包 Python 完成。模板 ZIP、文献、PDF 单页渲染、导出 ZIP 和图稿校验由主进程 TypeScript 实现。

Vale 3.24.0 作为第 4 个归档工具装到 `bin/vale`，供文稿检查（合同见仓库根的 `docs/research-prose.md`）。它的**规则集是 Roc 自己写的**，放在本目录 `vale/` 并原样复制进工具链：规则参与 `lockHashes`，所以改规则会要求重建，也会被运行时的 `research_toolchain_source_mismatch` 抓到。

本目录保存源文件和依赖声明。构建得到的解释器、环境与模型位于项目 `.runtime/`，不提交生成的第三方二进制。此目录提供可供应用打包的完整工具链；主进程接线与 Electron 打包校验已接入 `package:mac`。

Typst 0.15.0 作为第 5 个归档工具装到 `bin/typst`，**只服务导出附带的 `report.pdf`**（`src/main/plugins/research/typst-report.ts`），不进 LaTeX 主链；为什么不全面采用它见 `docs/adr/0025-typst-report-engine.md`。它的归档是 `.tar.xz`：Node 没有 xz 解码器，`prepare.ts` 用系统 `/usr/bin/tar`（bsdtar）解包，只取归档里那一个 `typst` 二进制，其余内容丢弃——这一步只在构建机上跑，应用运行时从不调 `/usr/bin/tar`。

`csl/` 是**引用格式化数据**（APA / IEEE / GB/T 7714），由 Typst 原生的 hayagriva 消费，不引第二个 CSL 引擎。与 `vale/` 一样原样复制进工具链并参与 `lockHashes`：改样式要重建，也会被运行时校验抓到。

## 准备和校验

构建机需要 Apple Silicon 上的 macOS、可直接执行 TypeScript 的 Node 26，以及首次准备时的网络。应用运行时使用随包 CPython。`prepare` 只接受 `--arch arm64`：Intel 与 cross-arch 构建都会以 `research_toolchain_build_requires_matching_macos_host` 失败。下列命令以当前仓库路径为例。

```bash
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/prepare.ts --arch arm64 --output /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/manifest.ts --root /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/fetch-models.ts --lock /Users/Apple_501/Desktop/Roc/Roc/resources/research-runtime/models.lock.json --output /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-models
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/smoke.ts --toolchain /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 --models /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-models --output /Users/Apple_501/Desktop/Roc/Roc/.artifacts/research-toolchain-smoke
```

`prepare.ts` 按工具归档 SHA-256 与 `uv.lock` 组装 Python / Tectonic / Vale / TeX 环境，生成逐文件完整性清单及实际 Python 包许可证索引。模型只写入 `--models` 缓存（默认 `.runtime/research-models`），不复制进 toolchain 输出。解释器和 console script 不依赖开发机 venv。下载缓存位于 `.runtime/research-downloads`；中断后重复命令会使用已完成分块及部分字节。相同输出已存在时执行完整校验；源文件或锁文件变化后需选择新输出目录，避免覆盖已有工具链。

TeX 资源从固定 TAR `tlextras-2022.0r0` 按 `tex-bundle-files.txt` 做成离线编译子集 ZIP。保留原始文件字节，并重写 `SHA256SUM`。源 TAR 哈希、子集 ZIP 哈希均在 `tools.lock.json`。运行时 `tectonic --only-cached`，不下载其余 TeX Live 包。缺包即编译失败。哈希不符、资源身份变化或归档越界都会失败，不会回退到 PATH 中的工具或临时下载其他版本。

`smoke.ts` 使用空缓存和 macOS sandbox 禁止外网，执行中英文 LaTeX 编译、TypeScript PDF 渲染、扫描图解析（MinerU 自带 OCR）、表格/公式/图稿提取，以及 Matplotlib 的 PNG/SVG/PDF 输出。输出目录必须不存在；成功后写入 `result.json`，并保留 PDF、页面图、解析结果和日志。验证搬迁时将完整工具链复制或移到含空格的新路径后执行同一命令。

## Worker 协议

`worker.py` 只处理 `parse_document`。每次从 stdin 接收一条 JSON 请求，在 stdout 返回 `{"ok":true,"result":...}` 或 `{"ok":false,"error":{"code":...,"type":...}}`；库日志走 stderr。成功退出码为 0，失败为 1。调用时使用私有 Python 的 `-I -B` 参数，外层负责超时、取消、缓存目录和进程权限。

- `parse_document`：必填 `projectRoot`、`sourcePath`、新的 `outputDir`、`options`；`modelsPath` 对 `flash` 档位可为 `null`，其余档位必填。

`options` 是冻结的解析配置，字段集合必须完全一致：`tier`（`basic`/`standard`/`advanced`/`flash`）、`smallBackend`（只接受 `torch`）、`vlmEngine`（`auto`/`llama-cpp`/`mlx`；非 VLM 档位只能 `auto`）、`device`（`mps`/`cpu`）、`pageRange`（空串为全文）、`ocrMode`（`auto`/`txt`/`ocr`）。每一项都进 `parserFingerprint`——换档位、换设备、换 OCR 策略都会产生新的指纹，不会复用旧结果。

路径必须为绝对路径，输入与输出都必须处于项目内；拒绝覆盖已有输出。解析返回带源文件摘要、页码、边界框坐标原点和节点定位的文本/表格/公式/图稿，生成页面图，并在 `artifacts/` 下写出 MinerU 的 `middle_json.json`、`markdown.md` 与 `structured_content.json`（相对路径登记在结果的 `artifacts` 字段，缺失即视为失败）。`modelManifest` 为空串表示本次没有模型参与。任何失败都清理本次新建的输出目录，来源在处理期间变化也会失败。

Worker 使用内置 MIME 类型表；不读取开发机的 Apache 或用户 MIME 配置。异常 traceback 输出至 stderr，便于主进程诊断，JSON stdout 不混入日志。

`figure.py` 仍由随包解释器渲染 Matplotlib 图稿；主进程只负责校验输出。许可证采集由 `scripts/research/collect-licenses.ts` 读取已安装包的 METADATA/RECORD，不再进入目标解释器。
