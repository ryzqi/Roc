# 科研工具链优化验收记录

状态：**Verified passing**，范围为用户调整后的实现、安装、功能回归和本地打包验收。
本次没有宣称原方案的全部质量和性能门槛通过。用户将 OCR 样本缩为 20 页，随后决定直接
采用 8-bit、停止精度和后端比较，并要求从 Hugging Face 下载现成 MLX 权重；扫描论文、
跨页表格补充金标准和人工核验已按要求跳过。原始失败记录保持不变。

所有命令在 `/Users/Apple_501/Desktop/Roc/Roc` 运行。设备为 Apple M1 Pro、32 GiB、
macOS 27.2.1；Node 26.13.1、pnpm 12.21.0。没有使用子代理、发布远程版本或迁移真实资料库。

## 已交付实现

| 阶段 | 结果与主要提交 |
| --- | --- |
| P0 | 冻结现有 45 份 PDF / 46 张标注页面的组件基线，见[基线报告](research-toolchain-baseline.md) |
| P1 | 删除 R/Julia 新建、执行和对应模型合同，不保留兼容层；`43c649f` |
| P2 | 固定 CPython 3.14.10 和 uv，项目 `.venv`、依赖锁、自动准备、取消、完整性及恢复；`3fd4dcf`、`4022b8e`、`25c6aa4` |
| P3 | 用户直接采用 8-bit；专用生产解码器与固定 HF 下载合同；`7b900de`、`f2ae92c` |
| P4 | 完整解析进入生产路由、模型设置、Paper IR 和索引；无旧完整模型回退；`98009f1` |
| P5 | 删除旧 FormulaNet/tokenizer、转换分支和无用直接依赖；完成按需模型打包；`0122402`、`6bd73ae` |
| P6 | 本报告、机器可读证据摘要、本地 `.app`、回归结果和明确的未验收项 |

核心修改位于 `src/main/plugins/research/production-models.ts`、`toolchain.ts`、
`document-parser.ts`、`index-service.ts`、安装管理器，以及模型设置和共享合同。
基础解析继续使用五个 compact 资产，合计 18,967,109 B；HTML 使用基础路线。
完整 PDF/图片路线要求已核验的 Ovis 安装，缺少或损坏时明确失败。
模型只在解析 Worker 内加载，状态查询不启动 Python/MLX。

已接通真实原文、解析代次、SQLite、Paper IR、FTS/sqlite-vec、检索上下文、Paper Card
及 Wiki。端到端下游夹具的 OCR、embedding 和卡片生成有受控替身；历史真实 OCR 链路
与这次 HF 生产解析单独记录，不能将所有测试描述为线上大模型调用。
未核验的公式、表格和区域保留 review 状态与页级引用，不生成精确区域可信度。

## 已安装的 Hugging Face 模型

仓库：[fwgpiyawudk/OvisOCR3-mlx-8bit](https://huggingface.co/fwgpiyawudk/OvisOCR3-mlx-8bit/tree/702a71f233a208be050b12779ee29fdd1eb2dab3)。
固定 revision 为 `702a71f233a208be050b12779ee29fdd1eb2dab3`，权重 SHA256 为
`9fd155c8fbd83af37007e736099a60e927de72e52b6634758d0e4b0d97391fd8`。
187 个语言模块使用 affine 8-bit / group64；153 个视觉张量为 BF16。
不下载远程 Python 源码，加载时关闭 remote code，不执行本机量化。

安装位于 `~/.roc/research-models/ovisocr3`，活动代次为 `ovis-install-e6PFz0`，
receipt SHA256 为 `9fe9b4f990b0e01bd0dd56472886a1a366937cad365729f16677ba6761ee8a8d`。
16,591 个清单条目验证通过。开发启动沿用 `.runtime/research-models`，打包应用使用
资料根下的 `research-models`；此次实际安装供后者使用。

| 资源 | 字节 |
| --- | ---: |
| HF 模型下载（30 个文件） | 1,020,807,733 |
| 67 个固定 wheel 下载 | 199,429,047 |
| 合计下载，不含缺失的共享 CPython/uv | 1,220,236,780 |
| 已安装私有运行时 | 688,490,772 |
| 已安装规格文件 | 185,886 |
| 已安装 uv | 28,309,040 |
| 代次有效载荷，不含 receipt/共享 CPython | 1,737,793,431 |

生产环境为 CPython 3.14.10、MLX 0.32.5、MLX-VLM 0.8.1。轮子约束要求 arm64、
macOS 15+，实际只在上述 32 GiB 机器验证。首次安装暴露 uv 删除临时目录与审计并发的
ENOENT；`29ece5b` 用确定性红绿回归修复。重试复用本次 HF 下载的已验哈希文件，
成功安装并发布；离线 wheel 安装、原生导入、中途取消和损坏 wheel 拒绝均通过。

实际生产入口单页 PDF 解析通过：37 个 Paper IR 块、来源集合校验和稳定模型身份，
`quality.status = review`，带 `research_ovis_content_unverified`。该功能检查不计算
精度指标，没有独立记录耗时与峰值 RSS。临时项目已清理。
此前 20 页有效输出和 20 页结构回放针对历史本机转换模型，不能充当本次 HF 权重的
20 页质量成绩。详见[适配记录](research-ovis-adaptation.md)。

## 回归与打包检查

| 检查 | 结果 | P6 证据文件 |
| --- | --- | --- |
| `pnpm build`、`pnpm check:ipc` | 通过（含类型、renderer chunks） | `build-final.log`、`ipc.log` |
| 下载、安装代次、租约、Worker 和生产模型服务 | 27/27 | `ovis-lifecycle.log` |
| uv 临时目录审计竞态 | 3/3，保留首次失败 | `installer-race-{red,green}.log` |
| 最终安装事务 | 11/11 | `installation-final.log` |
| 解析、来源、Paper IR、索引、Card/Wiki 和取消 | 37/37 | `downstream-final.log` |
| Electron 原生科研生产流程 | 20/20 | `production-electron.log` |
| Python 自动准备、环境、实际实验与 Notebook | 42/42 | `python-regression.log` |
| 设置页写入、删除、进度与取消 | 6/6 | `settings-final.log` |
| 实际安装的 HF 模型生产解析 | 单页通过，37 块 | P4 `prequantized-production-verified/report.json` |
| arm64 打包、原生模块、签名、隔离启动 | 通过 | `package-final.log`、`smoke-final/result.json` |

对应命令如下；再次运行功能脚本需要新的输出目录，避免覆盖证据。

```sh
pnpm build
pnpm check:ipc
node --test tests/unit/research-ovis-downloads.test.mjs \
  tests/unit/research-ovis-installation-manager.test.mjs \
  tests/unit/research-ovis-installation.test.mjs \
  tests/unit/research-ovis-model-store.test.mjs \
  tests/unit/research-ovis-worker.test.mjs \
  tests/unit/research-production-models.test.mjs
node --test tests/unit/research-ovis-package-installer.test.mjs
node --test tests/unit/research-ovis-installation-manager.test.mjs \
  tests/unit/research-ovis-installation.test.mjs
node --test tests/unit/research-document-process-lifecycle.test.mjs \
  tests/unit/research-incremental-index.test.mjs \
  tests/unit/research-index-process-lifecycle.test.mjs \
  tests/unit/research-ovis-document-parser.test.mjs \
  tests/unit/research-ovis-downstream.test.mjs \
  tests/unit/research-ovis-paper-content.test.mjs \
  tests/unit/research-ovis-parsed-document.test.mjs \
  tests/unit/research-ovis-project-index.test.mjs
node scripts/run-research-p0.mjs
node --test --test-concurrency=1 tests/integration/research-python-automatic.test.mjs \
  tests/integration/research-python-environment.test.mjs \
  tests/integration/research-python-process.test.mjs \
  tests/integration/research-python-experiments.test.mjs
node --test tests/renderer/settings-write-guards.test.mjs
node scripts/research/verify-ovis-production.mjs \
  --models /Users/Apple_501/.roc/research-models \
  --python /Users/Apple_501/.roc/research-python \
  --source .artifacts/research-toolchain-p3/pdf-artifact-formula/source.pdf \
  --output .artifacts/research-toolchain-p4/prequantized-production-verified
```

新安装使用同一功能脚本加 `--install`。本次诊断重试脚本已清理；它复用经过固定哈希
验证的 HF 文件，最终功能脚本直接读取已发布代次，未绕过安装或解析完整性检查。

本地候选包为 `.artifacts/research-toolchain-p6/package/mac-arm64/Roc.app`。
打包使用 `scripts/lib/native-packaging.mjs` 的 `createPackagingEnvironment()`，并先执行
`assertLiveResearchToolchainForPackaging()`，随后通过 `runCommand` 调用：

```sh
pnpm exec electron-builder --mac --dir --arm64 --publish never \
  --config electron-builder.yml \
  --config.directories.output=.artifacts/research-toolchain-p6/package
node scripts/research-toolchain-inventory.mjs \
  .artifacts/research-toolchain-p6/package-inventory-final.json \
  .artifacts/research-toolchain-p6/package/mac-arm64/Roc.app
node scripts/smoke-mac.mjs .artifacts/research-toolchain-p6/package/mac-arm64/Roc.app
```

Smoke 使用隔离 `ROC_DATA_ROOT`，不代表默认资料根已测试迁移。设置页在 1440×900 的
亮/暗主题均检查；保留截图早于最后一次错误文案调整，最终文案有 renderer 回归覆盖。
包内只新增四个 Ovis 规格文件，没有权重、MLX 环境或转换器；main bundle 与最终 dist
字节相同。包制作时 HEAD 为 `29ece5b` 且有未提交修改；这些生产修改随后提交为
`98009f1` / `6bd73ae`。清点报告不将主 bundle 一致冒充完整 Git 来源认证。

| 逻辑字节 | P0 | 最终包 | 变化 |
| --- | ---: | ---: | ---: |
| `.app` | 866,350,807 | 866,543,640 | +192,833 |
| ASAR | 117,302,854 | 117,308,781 | +5,927 |
| ASAR unpacked | 86,588,988 | 86,588,988 | 0 |
| 写作工具链 | 360,029,869 | 360,029,869 | 0 |
| 原生库（上列子集） | 95,009,792 | 95,009,792 | 0 |

这些是目录逻辑大小，不是压缩包下载量或 APFS 独占空间。默认包没有变小。
Pandoc、Tectonic、Typst、Vale 和基础 OCR 依赖有真实调用，保留理由与工具体积见
[清理记录](research-toolchain-cleanup.md)。

## 启动与资源观察

| 历史事件数 | P0 P50 / P95（ms） | 有并行负载复测 | 停止本任务并行负载后 |
| --- | ---: | ---: | ---: |
| 0 | 1302.31 / 1336.79 | 1298.97 / 1320.19 | 1217.80 / 1229.60 |
| 1000 | 1306.32 / 1332.00 | 1312.66 / 1558.94 | 1209.08 / 1233.31 |
| 10000 | 1314.60 / 1330.62 | 1495.02 / 1608.22 | 1216.91 / 1233.36 |

停止本任务下载、安装、打包负载后，三个场景的小样本未重现此前变慢；未控制其他系统
后台负载，不能推断长期性能。可见/隐藏各 1 分钟后的主进程 RSS 分别为
357,285,888 / 360,955,904 B，P0 为 362,971,136 / 366,362,624 B。
有并行负载那轮分别为 363,806,720 / 367,394,816 B；保留全部原始观测。

P0 每场景 20 次，最终小样本每场景 5 次；均为新进程、隔离资料根，系统文件缓存未清空。
首轮复测在第 14 次启动遇到 Playwright inspector 超时，失败文件 `startup.json` 保留。
`startup-final.json` 的完整复测期间存在并行安装/打包负载；其大历史结果偏慢，不能据此
宣称没有回归。后来停止这些任务后，使用相同命令另存 `startup-isolated.json`。
小样本 P95 实际接近最大值，不能替代长期或多机统计。

```sh
ROC_PERF_IDLE_VISIBILITY=both node scripts/performance/bench-macos-app.mjs \
  .artifacts/research-toolchain-p6/startup-isolated.json --samples 5 --idle-minutes 1
```

新 HF 代次只进行单页生产功能检查，没有新增每页耗时分位数、峰值内存或质量统计。
历史转换模型的耗时、内存与失败率保留在适配报告，不能直接归给新下载权重。

## 清理与验收边界

清除了本次重试缓存、两个诊断脚本及 SHA256 与旧目录一致的 FormulaNet/tokenizer，
共 1,531,129,515 逻辑字节；七份临时日志已归档。实际安装代次、历史失败证据和本地
候选包保留。用户的 `科研工具优化.md` 保持原样，未纳入本次提交。
机器可读摘要 [research-toolchain-validation.json](research-toolchain-validation.json)
记录证据哈希、安装身份、检查结果与范围；原始资料在 `.artifacts/research-toolchain-p6/`。

未宣称完成的验收：新 HF 权重的 CER/CDM/TEDS、全面区域定位准确率、扫描/跨页独立金
标准、8/16/24 GiB 设备实测、长期内存/热压力、每页性能分位数，以及无回归的启动性能
结论。旧评测中出现过无效页、公式定位与图注召回失败，均未改写成通过。
用户的直接采用决定允许接入；结果的 review 状态和页级引用约束继续生效。
