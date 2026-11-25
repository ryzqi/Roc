# 科研运行时

## 文档解析

文档解析使用 Electron 主进程中的 TypeScript 管线：PaddleOCR.js、ONNX Runtime 和 PDF.js，版本以项目锁文件为准。任务经 [`research-job-cli.ts`](../../src/main/plugins/research/research-job-cli.ts) 在隔离子进程执行；模型下载由用户主动触发，推理子进程没有网络权限。[生产默认解析选项](../../src/main/plugins/research/toolchain.ts)使用 CPU；主进程显式选择 CoreML 时，无法创建 CoreML 会话会回退到 CPU，结果记录实际设备。

模型文件不随安装包分发，默认保存在应用数据根下的 `research-models/`，安装和加载前校验固定 revision、大小与 SHA-256。包内容、下载量和许可见[模型说明](../research-models/README.md)。

解析契约为 v4，派生代次为 10，parser 为 `roc-research-parser/10`；权威版本见 [research-production.ts](../../src/shared/schemas/research-production.ts)。输入支持 PDF、HTML、PNG、JPEG、BMP、WebP 和 TIFF；HTML 与带文本层的 PDF 可以不下载模型，扫描件及图片需要模型。旧 Python 解析器与旧模型包已移除，不提供旧协议兼容路径。

## 实验与科研工具

`python-tools.lock.json` 固定 uv 和 CPython 下载来源、版本及字节身份；主进程按需下载到私有 runtime/cache，为项目创建独立 `.venv`。实验支持离线 TypeScript 和已准备的 Python 3.14 项目环境；新建和重跑均须符合当前协议，旧 `bundled-python` / `uv` 快照没有兼容执行路径。环境、冻结输入与发布合同见[实验运行](../../docs/research-experiments.md)和[Python 环境](../../docs/research-python-environment.md)。

TypeScript 使用 Electron 内置 Node 执行版本化 `.mts` 源码，不额外安装转译器；Python 使用已准备并复核的项目环境。图稿使用本地 Vega-Lite v6 spec 与快照数据隔离渲染；请求显式声明 engine/sourceVersion、输入、尺寸、DPI 和 seed，运行保存实际环境及 pipeline 身份。可选 `expectedEnvironmentHash` 固定已检查环境；合同见[图稿](../../docs/research-figures.md)。

[`tools.lock.json`](tools.lock.json) 固定 Tectonic、Vale、Typst 和 Pandoc。Vale 与本地规则集负责[写作检查](../../docs/research-writing-checks.md)，Typst 生成附带报告，Pandoc 生成可选 DOCX/HTML；LaTeX 正文仍由 Tectonic 编译。六种[CSL 样式](csl/README.md)和 TeX 离线子集随工具链分发，交付合同见[导出](../../docs/research-exports.md)。

## 构建与检查

在仓库根目录准备科研工具链，需要 Apple Silicon macOS、[.node-version](../../.node-version) 指定的 Node 26、按 [package.json](../../package.json) 的 `packageManager` 安装的项目依赖，以及首次下载所需的网络；缓存命中的归档与 TeX bundle 会复用。`prepare.ts` 只接受 `--arch arm64`，不需要先下载 OCR 模型：

```bash
node scripts/research/prepare.ts --arch arm64 --output .runtime/research-toolchain/darwin-arm64
node scripts/research/manifest.ts --root .runtime/research-toolchain/darwin-arm64
pnpm exec tsx scripts/research/smoke.ts --toolchain .runtime/research-toolchain/darwin-arm64 --models .runtime/research-models --output .artifacts/research-toolchain-smoke
```

`prepare.ts` 组装锁定的原生工具、TypeScript 运行器、TeX 子集及[许可证](licenses/README.md)，生成文件完整性清单和源码 `lockHashes`。输出目录须不存在；已存在时仅校验，不覆盖。规则、样式和许可目录中的 README 也参与源码哈希，修改后须使用新的输出目录重新准备工具链。生成物留在 `.runtime/`，不提交到源码仓库。

升级时，原生工具归档按锁定的 SHA-256 和上游文件名缓存在 `.runtime/research-downloads/`。已有工具链的 `tex/bundle.zip` 可复制到该缓存的 `tex-bundle.zip`。准备脚本核对 ZIP 的锁定摘要，命中时可跳过 2.88 GB 的 TeX 源归档下载。

前两条命令使用 Node 26 的原生 TypeScript 支持。第三条使用项目锁定的 `tsx`，离线解析子进程通过 Node 的 `--import` 加载同一版本。

完整 smoke 要求已下载并通过校验的 `complete` 模型包；将示例模型路径替换为实际目录。未指定 `--models` 时，脚本使用仓库的 `.runtime/research-models`，这不是应用默认下载路径。[smoke 脚本](../../scripts/research/smoke.ts)显式选择 CoreML，并要求 OCR/表格/公式样例的实际设备为 CoreML；CPU 回退不能通过该项检查。检查覆盖 LaTeX/报告编译、PDF 渲染、OCR/表格/公式解析和 Vega-Lite PNG/SVG/PDF 图稿；解析样例走生产子进程和当前结果契约。每次检查使用新的输出目录，并保存该次源码、模型与工具链身份。
