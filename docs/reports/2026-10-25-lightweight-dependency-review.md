# 科研工具链轻量替代：MinerU、Torch 与 Python 清理可行性

调研日期：2026-10-25。范围：Roc 当前内置科研工具链；核对本地源码、GitHub README/源文件、npm 清单和官方 ONNX Runtime 文档。本次为可行性分析，没有安装候选、下载模型或修改产品实现。

## 结论

- **全面移除内置 MinerU：可行。** 替换对象是文档解析链，包括 OCR、版面、阅读顺序、表格、公式、工件生成与缓存身份。单独接入普通 OCR 无法覆盖全部现有行为。
- **全面移除内置 Torch：可行。** 使用现有 ONNX 模型和 Node/C++/Rust 推理实现；模型在上游训练、导出时使用 Torch，不代表用户机器推理时需要 Torch。正式包和首次启动都不应再执行模型转换。
- **内置功能不依赖 Python、安装包不携带 Python：可行，推荐作为目标。** 文档解析、固定数据处理、声明式绘图均可迁移。
- **同时删除所有 Python 支持并保留现有任意 `.py` / Matplotlib 运行行为：不可行。** 若坚持彻底去 Python，需要改变这些产品合同；若保留兼容性，则将其改为用户配置的外部环境，不能称为“完全没有 Python”。

建议目标是：内置解析和绘图零 Python、零 Torch、零 MinerU；通用脚本执行与内置科研功能分离。是否保留外部 Python 是产品能力选择，不能靠替换一个包解决。

## 当前成本与真实依赖

上一轮对既有 macOS arm64 发布产物的目录测量（未重建）：

| 项目 | 解包目录体积 MiB |
| --- | ---: |
| 整个科研工具链 | 1434.33 |
| Python 目录，含第三方包 | 1219.33 |
| site-packages | 1163.36 |
| Torch | 455.94 |
| Gradio | 78.85 |
| ONNX Runtime 的 Python 包 | 74.61 |
| SciPy | 69.90 |
| Transformers | 54.12 |

这些数字有包含关系，不能求和。删除 Python 目录的毛收益约为 1.19 GiB，最终净收益必须减去新引擎、模型、字体等新增部分。不是 DMG 大小，也不是已实施后的节省。

当前 `resources/research-runtime/pyproject.toml` 直接声明 `mineru[torch]==4.0.12`、`transformers==5.20.2`、`pypdfium2==5.14.0`、`matplotlib==3.11.2`、pandas、scipy。此前查验的 MinerU 传递依赖还包含 Gradio、ModelScope、jieba；DocVortex 的 Magika 路径直接依赖 ONNX Runtime。不能从旧环境手动删除某几个目录而继续声称它是完整的已锁定环境。

Torch 新进程导入中位数约 1955.6 ms，峰值 RSS 约 212.8 MiB；这是上一轮三次导入探针，不是 PDF 解析速度。当前 `worker.py` 的 `ensure_device` 与 `runtime_identity` 都导入 Torch，flash 档也经过这些路径。替换后的性能仍需同机测量。

## 必须迁移的现有合同

| 位置 | 当前行为 | 清理时必须处理 |
| --- | --- | --- |
| `src/shared/schemas/research-production.ts` | `smallBackend: z.literal('torch')`；`engine: z.literal('mineru')`；结果合同版本 2 | 更新引擎身份、设备能力、合同版本及历史数据处理，不能将新结果伪装成 MinerU |
| `src/main/plugins/research/toolchain.ts` | 解析、模型下载、随包 Python、manifest 完整性检查集中在工具链内 | 移除 MinerU 下载命令与 Python 启动；重建资源清单、哈希、模型锁与许可证清单 |
| `src/main/plugins/research/index-service.ts` | 缓存键含 `mineru:`；工件路径依赖 `parserFingerprint` | 更新指纹和缓存失效；保留旧工件可读性，允许重新解析 |
| `resources/research-runtime/worker.py` | MinerU 适配、Torch 设备检查、结构化块输出 | 用新解析模块替换，保留页码、坐标、表格/公式、图片和警告语义 |
| `src/main/plugins/research/experiment-environment.ts` | uv 环境解释器真实路径必须等于随包 Python | 不能删除 Python 后只改 PATH；要改环境合同、探针、锁验证与可复现记录 |
| `resources/research-runtime/figure.py`、`src/main/plugins/research/figure-runner.ts` | 执行用户 Python 源码，要求产出 Matplotlib `Figure`，导出 PNG/SVG/PDF | 声明式图表是新合同；旧源码无法直接喂给 Vega 执行 |
| `src/shared/schemas/research-experiments.ts` | Python `.py`、R `.r`、Julia `.jl` 实验合同 | 外部环境或新任务引擎必须显式建模；当前没有 JS 实验运行合同 |

PDF 展示已使用 `pdfjs-dist` 和 `@napi-rs/canvas`（`src/main/plugins/research/pdf-render.ts`）；这两项已在依赖里。可以复用 PDF 读取、像素渲染与坐标来源，但当前文本提取只是串接文本项，不能当成已经完成科研版面解析。书目与 ZIP 也已有 TS 实现，不要重复计算迁移收益。

## PaddleOCR 的三种部署方式

1. **安装 PaddleOCR/PaddleX 的 Python 分发包**：可替代部分 MinerU 能力，但保留 Python、Paddle 推理及其依赖。与“全面清理 Python”目标不符，不能仅凭 OCR 模型小就认定总包轻。
2. **使用 PaddleOCR 导出的 ONNX 模型，由 Node/C++/Rust 推理**：无需 Python、Torch 或 PaddlePaddle 运行时。最符合本项目目标。
3. **PaddleOCR-VL 或其他文档 VLM**：能力与部署成本不同，不能和 mobile OCR 小模型混为一谈。切换 VLM 品牌并不自动实现轻量化。

ONNX Runtime 官方 Node 文档当前列出 macOS arm64 的 CPU 与 CoreML 预编译支持，WebGPU 仍属实验性。具体锁定版本的二进制、算子覆盖和模型形状必须实测；旧版本也不能直接套用最新支持表。CoreML 是新的执行提供程序，不能继续用 `mps` 字段假装代表同一个后端。

## 可直接集成的开源实现

下表“支持”来自上游接口与源码核查，未在 Roc 中运行质量评测。星数只是检索快照，不是选型依据。

| 项目 | 已核实能力与依赖 | 对 Roc 的判断 |
| --- | --- | --- |
| [x3zvawq/paddleocr.js](https://github.com/x3zvawq/paddleocr.js) | TypeScript；OCR、版面检测、表格结构/单元格、公式识别、文档结构 pipeline；应用注入 ONNX Runtime；不含模型和图片解码 | **完整科研解析方向的优先 PoC**。接口覆盖最贴合现有 TS 工程，但项目较小、较新，不能视为已验证的 MinerU 等价替换 |
| [arcships/light-ocr](https://github.com/arcships/light-ocr) | C++、Node-API；PP-OCRv6；文字、置信度、四边形坐标；带 PDFium；macOS Apple Silicon 可选 CoreML | **普通 OCR 方向的优先 PoC**，集成和预编译分发完整。未确认完整的公式/复杂表格/科研阅读顺序替代能力 |
| [xushengfeng/eSearch-OCR](https://github.com/xushengfeng/eSearch-OCR) | TS、ONNX Runtime；文字检测、识别、方向等，应用负责后端和模型 | 适合复用已有 PDF 像素与图像处理，控制依赖；科研结构化需补充 |
| [gutenye/ocr](https://github.com/gutenye/ocr) | Node 包依赖 ONNX Runtime、sharp、共享 OCR 模块和模型 | 基础 OCR 候选；会新增 sharp，需与已有 canvas 解码能力对比 |
| [RapidAI/RapidOcrOnnx](https://github.com/RapidAI/RapidOcrOnnx) | C++、ONNX OCR 路径 | 可选原生 helper，避免 Python；需承担原生编译、分发与图像依赖成本 |
| [zibo-chen/rust-paddle-ocr](https://github.com/zibo-chen/rust-paddle-ocr) | Rust、ONNX OCR，非 Python 方案 | 团队愿意维护 Rust helper 时可选；已有 TS 工程未必因此更简单 |
| [dariofinardi/PaddleOCR-OCR-rs](https://github.com/dariofinardi/PaddleOCR-OCR-rs) / `ppocr-rs` | Rust；版面、表格与公式模块；仍需 ONNX Runtime 与模型 | 结构化备选。文档显示公式 `decoder_enabled` 默认为 false，关闭时返回空 LaTeX，不能看到“有公式模块”就认定默认可用 |
| [privatenumber/mac-ocr](https://github.com/privatenumber/mac-ocr) | Swift 二进制、Apple Vision；npm/Node 包装；图片和 PDF、逐页输出、坐标与置信度；无第三方模型包 | **macOS 基础 OCR 的最轻候选之一**。不应承诺论文公式 LaTeX 和复杂表格等价能力；语言支持依系统版本探测 |
| [tobilg/simpleocr](https://github.com/tobilg/simpleocr) | Swift、Vision、结构化坐标，无第三方依赖 | 小型原生参考实现；维护规模小于 mac-ocr |
| [RapidAI/RapidDoc](https://github.com/RapidAI/RapidDoc) | CPU 默认 ONNX，覆盖版面/公式/表格；但 `requires-python` 与大量 Python 依赖仍在，并基于 MinerU 衍生 | **只去 Torch 的过渡选项**；不符合彻底去 Python，也不符合不保留 MinerU 衍生实现的严格目标 |
| [scribeocr/scribe.js](https://github.com/scribeocr/scribe.js) | JS PDF/OCR/导出，有布局与表格工具；AGPL-3.0 | 不是本项目首选：需要评估许可证适配，且无科研公式等价证据 |

`paddleocr.js` README 明确说明：透视裁切、表格跨度恢复等采用轻量 TS 近似实现，不保证与 OpenCV/pyclipper 位级一致。因此应测试跨栏、斜拍、无线表格、合并单元格及公式，不能直接沿用官方 Python pipeline 的成绩。

`paddleocr.js` 的 npm 清单标 MIT，但此次 GitHub API 未返回可识别的 SPDX 结果；发布前仍须核对锁定提交的 LICENSE。代码、模型权重、字典与字体分别记录来源和许可。

## 包大小核对：小 wrapper 不等于小部署

2026-10-25 查询 npm `dist.unpackedSize`，以下为 registry 元数据，不是本机安装后大小，不含压缩差异。

| 包/组合 | 版本 | 解包大小及解释 |
| --- | --- | --- |
| `mac-ocr` | 1.2.1 | 2,588,749 bytes，约 2.47 MiB；调用系统框架，系统本身不计入 npm 包 |
| `paddleocr` | 1.2.0 | 1,991,545 bytes，约 1.90 MiB；**不含 ONNX Runtime、模型、解码器** |
| `esearch-ocr` | 8.5.2 | 95,163 bytes；同样不是完整运行负载 |
| `@gutenye/ocr-models` | 1.4.2 | 16,176,974 bytes；Node 包另有 ORT、sharp 等依赖 |
| light-ocr Small 模型包 | 0.3.4 | 73,594,252 bytes，约 70.19 MiB |
| light-ocr darwin-arm64 平台包 | 0.5.9 | 56,377,160 bytes，约 53.77 MiB |
| light-ocr Small + 当前 arm64 平台 + 两个 wrapper | 对应上述版本 | 已查询四项元数据合计约 **124.10 MiB**；尚未实装校验全部传递文件 |
| light-ocr Tiny 模型包 | 0.1.0 | 6,377,661 bytes，约 6.08 MiB；**仅模型，预览档**，不能把它写成完整安装大小 |
| `onnxruntime-node` | 1.30.0 | 301,068,136 bytes；包含多平台内容且有 postinstall，不能直接当成单一 macOS arm64 部署大小 |

light-ocr README 的 Small “约 30 MB 模型”与当前 registry 模型包约 70.19 MiB不是同一统计口径；实施预算以锁定版本实际安装/发布产物为准。Tiny 预览档亦不能套用 Small 当前平台包数字推算。

如果最终选择 TS+ORT 作为统一科研推理实现，再叠加另一个自带原生 OCR runtime，可能重复分发推理库和 PDFium。默认只选一条完整实现；Vision 可作系统能力分支。复用 Roc 已有 PDF.js 时，优先评估像素输入接口。

## 推荐的无 Python 内置方案

```text
Roc 科研文档解析模块
  ├─ PDF 原生文字、页码、坐标、页面像素：已有 PDF.js + @napi-rs/canvas
  ├─ 无文字或低质量页：PaddleOCR ONNX 检测/方向/识别
  ├─ 复杂页：版面检测与阅读顺序
  ├─ 表格区域：结构/单元格模型 + 文本对齐
  ├─ 公式区域：独立公式识别模型，输出 LaTeX
  └─ Roc 适配：块、页定位、图片、工件、警告、指纹与缓存
```

首个 PoC 选择 `paddleocr.js + onnxruntime-node`，以验证完整能力链。若它的关键后处理不达标，再评估 Rust/C++ 实现；避免提前维护多种完整解析框架。若产品目标降为“读取文字和来源定位”，则可直接优先 mac-ocr 或 light-ocr，成本更低。

数字 PDF 优先读取原生文字，避免整本无差别转图片再 OCR；不要仅按“是否存在任意文本”判断扫描页，应结合页覆盖、乱码及混合页面情况。模型仅在需要的页或区域运行，保留首次加载与冷启动成本记录。公式、表格模型可能显著大于文字识别模型，使用可校验的按需资源包，不随默认安装包无条件携带全部模型。

推理在受控子进程中运行，主进程负责文件、下载与任务管理；renderer 仅通过现有桥接调用。复用当前取消、超时、资源约束和文件访问控制，避免阻塞 UI 或让 renderer 持有原生能力。

## 其余 Python 功能如何替代

| 当前功能 | 已有可集成实现 | 能力边界 |
| --- | --- | --- |
| pandas 的固定 CSV/表格清洗、聚合、连接 | [DuckDB Node API](https://github.com/duckdb/duckdb-node-neo)、现有 TS/SQL | 固定任务可迁移；不是任意 pandas 源码兼容层。按需引入，当前工程并未安装 DuckDB |
| SciPy 的基础统计 | [simple-statistics](https://github.com/simple-statistics/simple-statistics) | 可覆盖描述统计、部分检验/回归；不能声称覆盖 SciPy 数值优化、信号处理和专业算法全集 |
| Matplotlib 常见二维统计图 | [Vega](https://github.com/vega/vega) / [Vega-Lite](https://github.com/vega/vega-lite) | 声明式数据、图层、尺寸和样式；自定义 Python artist、任意脚本不兼容 |
| 图稿 PNG/SVG/PDF | Vega SVG，已有 canvas，必要时 [vl-convert](https://github.com/vega/vl-convert) 原生 CLI | 分别验证字体嵌入、透明度、物理尺寸、DPI、矢量质量、确定性；普通 Node 导出 PDF 可能引入 node-canvas，不能默认已有 canvas 是无缝兼容替代 |
| PDF 页面渲染、书目、ZIP | 已有 TypeScript/原生实现 | 继续使用，删除仅用于旧解析链的 Python 分发依赖 |
| 任意 Python 科研代码 | 外部用户环境，或删除该能力 | JS、DuckDB、R、Julia 均不能直接执行任意 Python 包生态 |

严格零 Python 模式：移除 Python/uv 实验类型与 Matplotlib 图稿合同；新增数据任务和声明式图表合同，历史源码作为只读材料保留，旧任务明确提示不可原样重跑。允许用户 Python 模式：保留外部解释器选择与环境哈希，删除“必须与 bundled Python 同真实路径”的约束；这只是应用不内置 Python。

Pyodide、Nuitka、PyInstaller、uv 或改用其他 Python 解释器不能满足“全面去 Python”：前者仍携带 Python/WASM 运行时，打包器不消除运行时语义，uv 是环境管理工具。Polars Python 包同理仍需 Python。无需把现有 Electron 再额外嵌入一个通用 JS 运行时。

## 迁移顺序与清理清单

1. **先验证解析能力。** 使用真实论文样本跑 PDF.js 原生路径、OCR、布局、表格、公式；确认完整链路后冻结唯一实现与模型版本。
2. **替换解析合同。** 更新 schema、指纹与缓存；生成同等用途的结构化内容、Markdown、页码/坐标与图片工件；对旧数据做明确版本处理。
3. **清理 MinerU/Torch。** 删除 Python worker 及其调用，重建依赖锁、模型锁、工具版本/哈希清单、下载器、完整性校验、打包白名单与许可证；从干净目录重建，不在旧 site-packages 上手工裁剪。
4. **迁移绘图和固定数据任务。** 新增声明式图表与数据任务接口，保留输出审核和可复现记录；逐项证明后再移除 Matplotlib/pandas/scipy。
5. **处理通用实验，再删除 Python runtime。** 严格零 Python则删除相关能力；若保留外部环境支持，则改写探针和环境合同。R/Julia 当前入口也经过 `experimentRuntime`，须解除与随包 Python 的工具链耦合。
6. **验证最终包。** 排查 Python 动态库、解释器、pip/uv 安装脚本、site-packages、Torch/Transformers/Paddle 及其动态库和安装后下载；核对原生二进制签名、公证、架构和离线启动。

Tectonic、Typst、Vale、CSL 等不依赖这条 Python 解析链的资源不属于连带删除对象。用户项目中的 `.py` 与用户自行安装的环境也不是内置工具链清理对象。

## 验收：达到后才能承诺替代完成

建议样本覆盖中英数字 PDF、双栏论文、扫描文献、旋转页、混合扫描/数字页、低清页、无线/有线表格、合并单元格、行内/行间/多行公式。使用相同机器、文件和输出要求，对当前 MinerU 与候选比较：

- 文字 CER/WER、段落与跨栏顺序、遗漏块；表格 TEDS/单元格内容；公式 CDM 或规范化 LaTeX 一致性。
- 来源定位准确性：原始 PDF 页码、旋转、坐标原点、缩放后的 bbox 能否正确回跳；图片和表格工件可访问。
- 冷启动、热运行、逐页 p50/p95、整篇耗时、峰值 RSS、模型首次下载和加载时间；多次运行，区分 CPU/CoreML。
- 解析缓存版本隔离、取消与超时、损坏/加密 PDF、资源缺失、完全离线和打包应用运行。
- 最终 app/DMG/模型缓存分别测量，不能用 npm wrapper 或单个模型的体积替代。

本次没有运行这些模型对照，因此“可以建设无 Python 方案”是有源码与部署路径支持的工程可行性结论；“和当前科研解析质量相当、快几倍、最终缩小多少”仍待实测。

## 关键上游证据

- [PaddleOCR PP-StructureV3](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-StructureV3/PP-StructureV3.en.md)：版面、表格、公式、阅读顺序属于完整 pipeline。
- [paddleocr.js README](https://github.com/x3zvawq/paddleocr.js/blob/main/README.md)、[公式服务源码](https://github.com/x3zvawq/paddleocr.js/blob/main/src/modules/formula-recognition/service.ts)、[结构 pipeline](https://github.com/x3zvawq/paddleocr.js/blob/main/src/pipelines/structure.ts)：接口与后处理限制。
- [light-ocr README](https://github.com/arcships/light-ocr)、[包清单](https://github.com/arcships/light-ocr/blob/main/packages/light-ocr/package.json)：分发与 OCR 输出范围。
- [mac-ocr README](https://github.com/privatenumber/mac-ocr)：系统框架、Node 包装、预编译二进制和坐标输出。
- [ONNX Runtime Node 官方文档](https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md)：macOS arm64 CPU/CoreML 及 Electron 支持说明。
- [RapidDoc 依赖声明](https://github.com/RapidAI/RapidDoc/blob/main/pyproject.toml)：Python 需求、ONNX 默认与 Torch 可选项。
- [ppocr-rs 公式识别文档](https://docs.rs/ppocr-rs/latest/ppocr_rs/formula_rec/struct.FormulaRecognizer.html)：默认关闭解码的行为。
- npm registry 原始字段已保存到本任务 `.planning/2026-10-25-python-toolchain-alternatives/` 下的 `followup-package-evidence.json`、`followup-platform-sizes.json`；GitHub 检索快照为 `followup-github.json`。使用可变分支和 latest 查询，正式实施时需锁定提交、版本及校验和。
