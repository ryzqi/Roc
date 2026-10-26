# 科研运行时

## 文档解析

文档解析使用 Electron 主进程中的 TypeScript 管线：`paddleocr@1.2.0`、`onnxruntime-node@1.22.0-rev` 和 PDF.js。任务经 `src/main/plugins/research/research-job-cli.ts` 在隔离子进程执行；模型下载由用户主动触发，推理子进程没有网络权限。macOS arm64 优先使用 CoreML，无法创建 CoreML 会话时回退到 CPU。

模型文件不随安装包分发。`resources/research-models/models.lock.json` 固定了上游 revision、文件大小和 SHA-256；应用把模型放在用户数据目录的 `research-models` 下，并在安装及加载时验证。`compact` OCR/版面/表格包为 18,967,109 字节；`complete` 再加入公式模型和 tokenizer，总计 329,850,264 字节。来源、许可证和模型文件见 [`resources/research-models/README.md`](../research-models/README.md)。

解析契约为 v3，输入支持 PDF、HTML、PNG、JPEG、BMP、WebP 和 TIFF；HTML 与带文本层的 PDF 可以不下载模型，扫描件及图片需要模型。旧 Python 解析器与旧模型包已移除，不提供旧协议兼容路径。

## Python 与科研工具

随应用分发的 CPython 3.12.15 暂时保留在工具链中，供后续移除 Python runtime 的打包任务清理；新建实验不再接受 Python，历史 Python 运行只读。Matplotlib 3.11.2 仍留在旧锁定环境中，已经不承担图稿渲染；确认数据任务迁移后会连同 Python runtime 一起移除。新实验使用 Electron 45 内置的 Node 24.22.0 执行版本化 `.mts` 源码，Node 原生剥离 TypeScript 类型，不额外安装转译器。TypeScript 实验通过 `run(context)` 接口读取快照、处理参数并写入受限输出目录，只有 `d3-dsv`、`csv-parse` 和 `simple-statistics` 这组锁定依赖可被运行器加载。科研图稿使用本地 Vega-Lite v6 spec 与快照数据在隔离任务中原生渲染。

Vale 3.24.0 与仓库内 `vale/` 规则集用于文稿检查（合同见 `docs/research-prose.md`）。Typst 0.15.0 只负责导出附带的 `report.pdf`（`src/main/plugins/research/typst-report.ts`），不进入 LaTeX 主链。`csl/` 保存 APA、IEEE、GB/T 7714 引用格式数据；TeX 离线子集由 `tex-bundle-files.txt` 固定。

## 构建与检查

准备 Python/R/TeX 工具链需要 Apple Silicon macOS、Node 26 和首次下载所需的网络。`prepare.ts` 只接受 `--arch arm64`。模型要先通过应用的模型管理界面下载到 `.runtime/research-models`，然后可以运行：

```bash
pnpm exec tsx scripts/research/prepare.ts --arch arm64 --output .runtime/research-toolchain/darwin-arm64
pnpm exec tsx scripts/research/manifest.ts --root .runtime/research-toolchain/darwin-arm64
pnpm exec tsx scripts/research/smoke.ts --toolchain .runtime/research-toolchain/darwin-arm64 --models .runtime/research-models --output .artifacts/research-toolchain-smoke
```

`prepare.ts` 按 `tools.lock.json`、`uv.lock` 与 TeX 文件清单组装剩余工具，并把根目录 `.py` 和 `.mts` 运行器一并逐文件哈希，生成完整性清单和实际 Python 包许可证索引。生成的解释器、环境与第三方二进制在 `.runtime/`，不提交到源码仓库。输出目录必须不存在；已存在时只做完整性校验，不覆盖。

`smoke.ts` 保留 LaTeX 编译、主进程 PDF 渲染、原生 OCR/表格/公式/图稿解析以及 Vega-Lite PNG/SVG/PDF 图稿渲染覆盖。解析样例通过同一个 `research-job-cli.ts` 和 v3 结果契约运行。