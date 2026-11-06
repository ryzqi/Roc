# 计划编制与执行记录

## 2026-11-06：计划编制

状态：`Verified passing（计划文档）`。计划编制与文档验证完成；业务实施未开始。

已做：

- 定位来源方案与项目规则。
- 读取产品约束、技术栈和仓库检查脚本。
- 初始化用户指定的 `plan/`。
- 完整阅读来源 862 行，使用已有 CodeGraph 与小范围源码核对。
- 固定当前 HEAD `eea2087b5d2d79df3b2fea7764ce48e4975fd764`，实测 Node v26.13.0、pnpm 12.5.1。
- 写入 9 个主阶段和 1 个条件扩展阶段，覆盖 WP-00～WP-12、RH-00～RH-21。
- 写入架构/切换合同、接受标准、命令/证据和科学标注矩阵。
- 将来源中的兼容/旧路径回退改为整体切换、删除代码、有限离线迁移和匹配版本冷恢复。

本轮授权：创建分阶段执行计划。后续业务重构尚未执行。
下一实施阶段：S00，固定实施时 SHA、能力与所有权清单、基线和删改合同。
所有 S00～S09 实施状态仍为 `pending`。

检查记录：

以下命令工作目录均为 `/Users/Apple_501/Desktop/Roc/Roc`，物理路径为
`/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`。

| 工作目录 | 命令 | 结果 |
| --- | --- | --- |
| 仓库根目录 | `git status --short` | 初始仅有未跟踪的 `Roc_Research_Agent_Harness_Plan.md` |
| 仓库根目录 | `git diff --stat` | 初始无已跟踪差异 |
| 仓库根目录 | `node --version` / `pnpm --version` | v26.13.0 / 12.5.1 |
| 仓库根目录 | `python3 .artifacts/research-harness/plan-authoring/check-plan.py`（首轮） | 链接/入口/覆盖/依赖通过；校验器误判 no-index 差异退出码，未通过 |
| 仓库根目录 | `git diff --no-index --check /dev/null plan/README.md` | 退出码 1，输出为空，确认是新增文件差异语义 |
| 仓库根目录 | `git diff --check` / `git diff --cached --check` | 通过；未跟踪 plan 文件另由校验器逐个检查 |
| 仓库根目录 | `python3 .artifacts/research-harness/plan-authoring/check-plan.py`（修正后） | 退出码 0；16 份文档、91 个本地链接、22 个现有测试路径、包脚本入口、13 个 WP、22 个 RH、10 阶段依赖及空白检查通过 |
| 仓库根目录 | `git status --short`（交付核对） | 仅来源文档与新建 `plan/` 未跟踪；无已跟踪业务代码改动 |

本轮没有运行应用、类型检查、单元测试或付费模型评测。

首轮失败报告保存于 `.artifacts/research-harness/plan-authoring/first-report.json`。
通过报告保存于 `.artifacts/research-harness/plan-authoring/report.json`，包含来源与计划文件
SHA-256、HEAD、工作目录、检查计数和错误列表。校验器与报告作为复核材料保留在忽略的工件目录。
校验器只读取文档、核对路径/命令和执行固定 Git 检查，不执行 Markdown 中的命令。

## 2026-11-06：S00 开始执行

用户指令“plan 开始执行第一个”授权本地完成 S00。范围为基线采集、能力/消费者、
目标合同、迁移/删除台账、三个 ADR 和本阶段离线检查；不启动 S01/S02，不提交或发布。
初始工作区只有未跟踪的来源方案和 `plan/`，没有已跟踪业务代码差异。
沿用现有 `plan/`；skill resolver 未发现其他命名计划，用户明确指定的目录优先。

发现记录：

- memory registry 关键词搜索无匹配，不使用历史记忆推断仓库事实。
- 初次猜测 `plan/stages/S00-baseline-contracts.md`、`plan/architecture.md` 不存在；
  按 `rg --files plan` 与入口改为实际 `phase-00-baseline.md`、`contracts.md`。
- 批量读取输出出现截断，后续拆成有界读取；不依据被截断内容声称已完整核对。

下一步：采集环境和数据 schema，检查现有 smoke 的隔离路径后固定六项新基线。

## 2026-11-06：S00 基线与合同交付

授权范围仍为 S00。本轮没有更改生产代码、安装依赖、提交 Git、发布或启动 S01/S02。
新增能力 inventory（17 项）、四条消费者图、12 项删除台账、12 项迁移台账与 ADR 0028～0030。
目标决定不等于后续代码已经实施；所有生产删除/数据迁移行仍为 `pending`。

基线执行时间：2026-11-06 10:35:39.451Z～10:42:15.553Z（UTC）。
开始与结束 SHA 均为 `eea2087b5d2d79df3b2fea7764ce48e4975fd764`。
命令工作目录 `/Users/Apple_501/Desktop/Roc/Roc`；
物理路径 `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`。

基线采集命令：
`node .artifacts/research-harness/S00/capture-baseline.mjs`，退出码 0。
采集器读取全部 75 项直接安装依赖、实际 Electron binary 的 process.versions，
在内存 SQLite 上运行七库真实 schema 函数，再依次执行以下固定命令。

| 精确命令（仓库根目录） | 结果 | 当前日志 |
| --- | --- | --- |
| `pnpm typecheck` | exit 0 | [typecheck.log](../.artifacts/research-harness/S00/2026-11-06T10-35-39.451Z/typecheck.log) |
| `pnpm check:ipc` | exit 0 | [ipc.log](../.artifacts/research-harness/S00/2026-11-06T10-35-39.451Z/ipc.log) |
| `pnpm test:unit` | exit 0；1469 pass、0 fail/skip/cancelled | [unit.log](../.artifacts/research-harness/S00/2026-11-06T10-35-39.451Z/unit.log) |
| `pnpm harness:quality:check` | exit 0；16 pilot offline audit、0 model/external calls | [quality.log](../.artifacts/research-harness/S00/2026-11-06T10-35-39.451Z/quality.log) |
| `pnpm build` | exit 0；现有 main/preload/renderer 构建 | [build.log](../.artifacts/research-harness/S00/2026-11-06T10-35-39.451Z/build.log) |
| `node scripts/smoke-electron.mjs` | exit 0；13/13、rendererErrors 空 | [smoke.log](../.artifacts/research-harness/S00/2026-11-06T10-35-39.451Z/smoke.log) |

上述命令的独立开始/结束时间、SHA、退出码、日志 SHA-256 见 [baseline.json](baseline.json)；
原始副本保留在 evidence 目录。空库 schema probe 的 integrity/FK 全部通过。
smoke 使用 mkdtemp 数据/工作区和 loopback provider，实际覆盖冷启动门户、项目画布、
同壳检查器、真实文件/Git/PTY、助手 run 和设置保存。report 为
`target=dist-main-fallback`、`full=false`，不是打包应用验收。

unit 等待期间一次 `sample 10333 1 1 -file
.artifacts/research-harness/S00/2026-11-06T10-35-39.451Z/unit-slow-process.sample.txt`
确认仍在执行 JS/SQLite；最终 unit 正常结束。现有质量用例单项约 32～67 秒，
未改 timeout、跳过或替换测试。采样保留作耗时证据。

文档验证：

- 新 ADR 未被忽略；`!docs/adr/` 已生效，没有修改 `.gitignore`。
- 初次 S00 预检把 `pnpm list` 当成项目 script 报错，其他项通过；该命令是 pnpm
  内置读取命令。校验器将内置命令与 scripts 区分，保留
  `deliverables-first-preflight.json`，不修改历史 plan-authoring 报告。
- `python3 .artifacts/research-harness/S00/check-deliverables.py` 检查文档链接、
  31 个现有测试路径、17 项能力、49 个源码符号、七库表名/完整性、
  四图与依赖、WP/RH 覆盖、baseline 副本/输入/log hash、Git 空白与跟踪规则。
  修正后 exit 0：22 份 Markdown、215 个本地链接，其余上述项全部通过。
- 完成状态写回后使用 `python3 .artifacts/research-harness/S00/check-deliverables.py --final`
  再核对 S00 八项清单完成、S01～S09 均 pending，并将最终文档 hash 固定至
  `.artifacts/research-harness/S00/2026-11-06T10-35-39.451Z/deliverables-report.json`。

保留的采集器、校验器、schema/log/sample、smoke report/screenshots、Mermaid 副本与
consumer source map 都是 S00 复核材料，位于忽略的 `.artifacts/`，没有进入生产执行图。
工作区生产代码与来源文档保持原样；没有 task-only 生产调试分支。

限制：未验证真实用户库转换/冷恢复、独立科研语料/盲审/质量收益、付费模型、外部服务、
真实新导出闭包、完整 renderer/integration 全集、打包/签名/发布。
这些限制对应 S01～S08 的独立验收；当前没有阻断 S01/S02 本地实施的工程基线失败。

完成状态：`Verified passing（S00 文档与当前工程基线）`。
S00 八项任务完成；下一阶段为 S01 工程合同，S02 可独立进入，均未自动启动。
最终文档校验命令 `python3 .artifacts/research-harness/S00/check-deliverables.py --final`
在上述仓库根目录执行，exit 0：22 份 Markdown、216 个本地链接、31 个现有测试路径、
17 项能力、49 个符号、四图、七库及全部证据 hash/状态检查通过。
通过结果与精确文件 hash 留存于 `deliverables-report.json`。
