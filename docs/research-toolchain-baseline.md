# 科研工具链优化基线

本报告固定 `科研工具优化.md` 的 P0 输入与测量方法。测量源码为
`f3bbc7207bf4ff2917fab2e3a126eaf10be66f23`，本阶段不改变产品行为。
原始结果保存在 `.artifacts/research-toolchain-p0/`，属于后续比较和独立评分的验收证据。

## 范围与环境

用户确认使用现有 45 份完整 PDF 和 46 张具有上游标准答案的 OmniDocBench 页面推进 P0。
完整 PDF 尚无独立结构金标准；不少于 200 页、官方 CDM/TEDS 与人工引用区域验收仍属于 P3/P6。
组件基线完成不表示完整科研质量已通过。

固定输入位于 `evaluation/corpora/scientific-rag/public-sources.lock.json`，对象哈希为
`c5fcc8bc26c9fea05ad7693bea30a9dcc61f61b4b7cca7203286f5efb0ffeacc`。
清点脚本逐一验证所有 95 个源文件及现有 7 个模型文件的字节数和 SHA-256。

测量设备为 Apple Silicon arm64、32 GiB 统一内存、macOS 27.2.1，Node 26.13.1、
pnpm 12.21.0、uv 0.13.9。原 Python 基线使用 CPython 3.14.7；后续新环境目标为 3.14.10。
各性能任务串行执行；没有清空操作系统缓存。

## 已测结果

启动为隔离资料根的全新应用进程，每场景 20 次；不是清空系统缓存后的物理冷启动。

| 历史事件数 | 启动 P50 / ms | 启动 P95 / ms |
| --- | ---: | ---: |
| 0 | 1302.31 | 1336.79 |
| 1000 | 1306.32 | 1332.00 |
| 10000 | 1314.60 | 1330.62 |

空闲采样各持续 1 分钟。窗口可见时主进程 RSS 为 362,971,136 B，进程工作集总和
674,267,136 B；隐藏时分别为 366,362,624 B 和 677,838,848 B。

基础模型下载量 18,967,109 B；完整模型 329,850,264 B，已包含基础模型，不能相加。

46 张真实页面中 44 张解析成功，2 张因 `research_image_too_large` 失败；失败保留在分母中。
单页耗时 P50/P95 为 2,100.86 / 7,825.87 ms，采样峰值 RSS 为 2,027,656,368 B。
采样可能遗漏同步执行期间的瞬时峰值。

| 组件评分 | 基线 |
| --- | ---: |
| CER | 0.748424 |
| WER | 0.813179 |
| 布局 micro F1 | 0.500000 |
| 阅读顺序 pair recall | 0.311623 |
| 表格自定义 TEDS 均值 | 0.268316 |
| 公式归一化精确匹配 | 0.117647 |

上述公式指标不是 CDM；表格指标使用现有自定义规范化，不能与上游官方 TEDS 直接比较。

45 份完整 PDF 全部解析成功，429 页来源和产物校验通过。每篇 P50/P95 为
29,475.88 / 47,623.24 ms，总计 1,397,638.08 ms，采样峰值 RSS 为 2,377,071,680 B。
完整 PDF 没有逐页独立计时，因此不能将每篇分位数称为每页分位数。
来源和几何合法性校验不代表人工引用定位准确率。

Paper IR 对全部 91 个输入的已存产物重建两次，并在新 repository 实例重开读取。
两轮哈希均为 `ef27f70eca6be45b0194407d551e3ccf951e312be8a51072d195fc45fa33f2b0`。
保留 2 个失败输入；成功产物含 13,564 个块、195 张表格、8,151 个单元格、212 张图片、
503 个公式和 704 个引用。这是产物确定性及存储回归，不是重新识别或质量提升。

Python 空环境准备测量 5 次，结果如下。解释器和依赖已在本地，不含下载或科学包安装。

| 操作 | P50 / ms | P95 / ms |
| --- | ---: | ---: |
| 外部创建空 `.venv` | 40.16 | 42.87 |
| 产品首次检查 | 1727.74 | 2499.22 |
| 产品重复检查 | 1718.79 | 1764.61 |

当前源码经 `pnpm build` 后生成独立 arm64 候选包，包内 main bundle 与本次构建一致。
构建、打包和 smoke 日志保存在同一证据根；清点器自身不将 main 字节一致视为完整 Git 来源认证。

| 包组成 | 逻辑字节数 |
| --- | ---: |
| Roc.app | 866,350,807 |
| app.asar | 117,302,854 |
| app.asar.unpacked | 86,588,988 |
| research-toolchain | 360,029,869 |
| 原生 `.node` / `.dylib` 常规文件 | 95,009,792 |

`.app` 磁盘占用为 865,480 KiB。原生文件是上列目录的子集，不能再相加。
符号链接不重复计数，磁盘分配量受 APFS 共享区块影响。

97 项文档、Paper IR、引用、RAG、Wiki、TypeScript CSV 合同测试通过；19 项真实生产链
测试通过；候选包 smoke 通过，覆盖启动、窗口关闭/激活恢复和资源加载。
Python 集成测试首次 39 项中 30 通过、9 失败。失败来自测试仍使用旧数据库版本、旧实验目录，
以及缺少现行 worker lease；后续恢复测试还暴露重开数据库时缺少连接初始化。
仅修正测试前置条件，产品权限检查保持原样。最终实验整文件 19/19 通过（237.49 秒），
加上首轮未改动的其他 20 项，共 39/39 通过。首次失败、定向复现和最终通过日志全部保留。
P0 按用户确认的组件基线范围通过。

## 复测入口

所有命令从仓库根运行。输出路径必须使用新的批次，保留源文件、模型和原始输出。

```sh
pnpm build
ROC_PERF_IDLE_VISIBILITY=both node scripts/performance/bench-macos-app.mjs \
  .artifacts/research-toolchain-p0/startup.json --samples 20 --idle-minutes 1
node scripts/benchmark-scientific-public-parser.mjs .artifacts/research-toolchain-p0
node scripts/benchmark-scientific-public-pdf.mjs .artifacts/research-toolchain-p0
node scripts/verify-scientific-public-pdf.mjs <完整 PDF 运行根>
node scripts/research-toolchain-inventory.mjs <新的清点 JSON> <候选 Roc.app>
node scripts/benchmark-python-project-preparation.mjs <新的 Python 测量 JSON> <CPython 3.14.7 绝对路径> 5
node scripts/benchmark-scientific-paper-ir.mjs <输出父目录> <页面评分 JSON> <完整 PDF 验证 JSON>
node --test tests/unit/research-paper-ir-v2.test.mjs \
  tests/unit/research-document-coordinates.test.mjs tests/unit/research-citation-integrity.test.mjs \
  tests/unit/scientific-evidence.test.mjs tests/unit/scientific-retrieval.test.mjs \
  tests/unit/literature-wiki-pipeline.test.mjs tests/unit/wiki-scientific-pages.test.mjs \
  tests/unit/research-typescript-experiment-csv.test.mjs
node scripts/run-research-p0.mjs
node --test --test-concurrency=1 tests/integration/research-python-automatic.test.mjs \
  tests/integration/research-python-environment.test.mjs \
  tests/integration/research-python-process.test.mjs \
  tests/integration/research-python-experiments.test.mjs
ROC_SMOKE_ARTIFACT_DIR=<新的 smoke 证据根> ROC_SMOKE_RUNTIME_DIR=<新的 smoke runtime 根> \
  node scripts/smoke-mac.mjs <候选 Roc.app>
```

页面评分使用 `scripts/score-scientific-public-parser.mjs` 导出的
`scoreScientificPublicParserRun`。Python 测量明确区分外部创建空 `.venv` 的时间、
产品首次环境检查及重复检查；原产品只发现环境，不会自动创建 `.venv`。
这项基线不包含 Python 下载、依赖解析或科学计算包安装。

打包采用[开发文档](development.md)的独立候选根流程，不覆盖已有 `release/`。
本项目发布目标为 `.app` 目录，没有 DMG/ZIP；因此报告目录逻辑大小和磁盘占用。
单个主进程 bundle 字节相等不能证明整个已有安装包来自当前提交。

候选包及其隔离运行目录在完成测量后清理；保留清点哈希、构建日志和 smoke 证据。
