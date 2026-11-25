# 科研与实验工具链轻量化审查（2026-11-25）

审查基于当前源码的实际导入、调用和打包合同，不把“安装了某个依赖”直接等同于“运行时需要它”。本轮目标是缩小默认执行路径与实验沙箱的依赖范围，同时不降低来源校验、资源隔离和可复现实验的要求。

## 当前路径与依赖

| 工作负载 | 实际实现 | 本轮处理 | 原因 |
| --- | --- | --- | --- |
| HTML / 文本型 PDF | `research-job-cli` → `document-parser` → HTML/PDF.js | ONNX Runtime 延迟加载 | 没有模型会话时不需要初始化原生推理绑定 |
| OCR / 扫描件 / 图片 | PaddleOCR.js + ONNX Runtime + 按需下载的模型包 | 保留 | 是真正的推理执行路径，不应以“轻量化”为由删除 |
| TIFF | `utif` 解码 | 仅 TIFF 请求时导入 | 其他文档格式不需要 TIFF 解码器 |
| TypeScript 实验 | Electron Node + `.mts` runner + CSV/统计接口 | 删去 `d3-dsv` 直接依赖和准入根 | runner 实际只加载 `csv-parse`、`csv-stringify`、`simple-statistics` |
| Python 实验 | 系统 CPython 3.14 / 项目 venv | 保留可选环境 | Roc 本身不分发 Python/uv；需要时才发现、校验与执行 |
| R / Julia 实验 | 用户安装的 R / Julia + 锁定的项目环境 | 保留可选环境 | Roc 不内置语言运行时；移除会直接删除科研能力 |
| 数据图表 | Vega-Lite → Vega + Canvas | 保留 | 图稿实际使用三个组件完成编译与 SVG/PNG/PDF 导出 |
| 论文与报告 | Tectonic（LaTeX）、Typst（报告）、Pandoc（DOCX/HTML）、Vale（写作检查） | 保留 | 四个原生工具有独立的生产消费者，不是重复依赖 |
| 内置科研 Skills | 内置快照及研究阶段 Skills | 保留 | 离线安装、内容哈希、研究角色合同依赖这些快照 |

## 已实施：低风险减负

1. 从 `package.json` 与 lockfile 的直接依赖中移除 `d3-dsv`。它只是被列入 TypeScript 实验的已批准包列表，没有被实验 runner 动态导入。对应更新 `toolchain.ts`、runner、集成测试的环境模拟器和 CSV 回归测试。CSV 输出以固定字节预期断言，避免测试再引入一个仅用于对比的 CSV 包。
2. 将 `onnxruntime-node` 的导入移动到已验证模型内容、即将创建 OCR Session 的位置，并在 Electron 主进程构建中显式 external，确保不被静态打入解析入口。HTML 和无模型的文本型 PDF 仍走原有路径；需要 OCR 的 PDF/图片仍加载同一 ONNX Runtime。
3. 将 `utif` 移至 TIFF 分支的动态导入。没有改变 TIFF 解码行为和输入边界。

这些改动不会移除 `onnxruntime-node`、`paddleocr` 或 `utif` 的发布依赖：OCR/TIFF 功能仍需要它们。`d3-dsv` 也仍由 Vega 生态间接依赖，所以它的直接依赖移除**不等于**安装包完全不含 `d3-dsv`。本轮收益主要是减少不必要的运行时初始化、实验可读目录和版本身份项；未做 Mac 实机测量前不声明体积、启动速度或 RSS 的具体下降数字。

TypeScript 实验的包集合参与 `environment.hash`：改动之后的新运行获得新的环境身份。既有冻结回执不会重写，也不能把新旧运行冒充相同工具链；重新比较需使用明确的新基线。

## 暂不删除的依赖与下一阶段机会

- **原生科研工具链随安装包完整分发。** `electron-builder.yml` 将锁定的 Tectonic/Typst/Pandoc/Vale 和 TeX 子集放入 `research-toolchain`；它们分别服务排版、报告、转换、写作检查。若想显著缩减首次下载体积，可研究“按功能安装、内容寻址缓存、完整哈希校验、断网可读性提示”的可选组件设计，但需先决定离线首装是否必须具备完整论文导出能力。
- **OCR 原生二进制仍随包分发。** 模型权重已按需下载，但 ONNX Runtime 原生库随应用存在。进一步拆分需要处理 macOS 签名、架构、升级版本、离线使用、安装包校验与失败恢复，不能只把 npm dependency 改成 optional。
- **内置 Nature Skills 快照较大。** `resources/builtin-skills/nature-skills.tar.gz` 源码文件约 31 MiB，其中含图稿样例图片。这些文件可能被 Skill 引用，当前是离线快照来源；未做资源引用闭包、许可及升级行为验收前不裁剪。
- **语言环境扫描成本。** Python/R/Julia 环境都涉及安全和可复现的代码身份校验，跳过或缓存未验证的历史身份会破坏运行准入。未来可测量扫描耗时与命中率，再设计可证明等效的增量验证；不能按文件时间戳代替字节校验。

## 验证矩阵

| 检查 | 目标 |
| --- | --- |
| `git diff --check`、`node --check` | 文件和 JavaScript/MTS 语法正确 |
| `pnpm install --frozen-lockfile` | 新的直接依赖与 lockfile 一致 |
| `pnpm typecheck` | 动态 ONNX 类型、实验依赖合同没有退化 |
| `node --test tests/unit/research-typescript-experiment-csv.test.mjs` | CSV 字节内容、预算、并发、取消均符合原合同 |
| `node --test tests/unit/research-ocr-content.test.mjs` | OCR 结构与表格结果不变 |
| PDF/HTML 无模型测试及有模型 OCR 验收 | 确认两条解析路径均可用，且纯文本路径不需要 ONNX 会话 |
| `pnpm build`、`pnpm package:dir`、`pnpm verify:native-packaging` | macOS arm64 构建、外置动态绑定与打包仍正确 |

本次执行环境是 Linux Node 24、没有安装项目依赖，而生产合同明确面向 macOS arm64、Node 26。因此这里可完成静态一致性及语法检查；涉及 Electron、native binding、打包和真实解析的检查需在生产目标平台验收，未通过前不应合并发布。
