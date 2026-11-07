# 计划编制与执行记录

## 2026-11-06：S02 启动与取消清理修复

开始 SHA `5313b3d411d583e73e2c8903f99d20f010691084`，工作区干净。
S02 阶段页原先要求 Task v3，但迁移台账 M02/M10 明确将 Task v3 留给 S06；
阶段页已与迁移台账对齐，S02 切换 execution v2。未对用户数据执行迁移。

取消或暂停时，清理函数同步抛错曾绕过 `Promise.allSettled`，导致其他清理未被等待、
`research_task_cleanup_failed` 未持久化；现将同步异常转换为拒绝并等待其他清理。
专项 `node --test tests/unit/research-task-cancellation.test.mjs`：7 pass；
`pnpm typecheck`、`git diff --check`：exit 0。该回归重新构造 repository，
不构成磁盘重启恢复验收。

继续检查事件回放与关联：回放末尾使用持久游标识别缺失事件，完整分页仍可继续；
物理 SQLite 文件关闭重开后注入缺尾和全缺失的测试通过。重试 stage 缺少真实父
execution 时显式拒绝，避免误建新根任务；相关 identity/lifecycle 测试通过。
`node --test tests/unit/run-event-log.test.mjs tests/unit/research-task-cancellation.test.mjs`：12 pass；
`node --test tests/unit/research-task-identity.test.mjs tests/unit/research-task-lifecycle.test.mjs`：16 pass；
`pnpm typecheck`、`git diff --check`：exit 0。

归档项目在排队后、模型准备前会重新校验；重复 dispatch 也在关联和排队前拒绝。
新增收据时 effect 成功回放验证已有收据，对账结果额外验证结果 hash；旧无收据结果
仍沿用现有路径，尚未完成迁移台账 M05 的严格切换。预算调用将结算记录与账本更新
放在同一事务，重复相同结算不重复写事件，不一致或记录损坏拒绝；启动时变成 unknown
且没有收据的旧 reservation 仍不能冒充已结算。收据与结果损坏、结算重复测试均关闭
并重新打开真实 SQLite 文件；归档/关联/取消专项共 25 项、effect/预算/事件专项共 20 项
通过，`pnpm typecheck` 通过。LSP 的未捕获 schema 解析告警经核对为预期传播损坏错误，
标记为误报；未屏蔽异常。回放还核对 snapshot 行与内容的 runId、序号和字节数。
取消/暂停在等待 cleanup 时持久化 pending 原因，进程退出后继续操作会被拒绝；
测试使用 SQLite backup 保存等待状态、打开新数据库验证阻断，完成后才恢复普通取消原因。
Stage cleanup 捕获同步抛错并继续等待其他 effect cleanup；取消与进行中的暂停 cleanup
会同时等待。重启后重新取消不会抹去未确认状态。取消及生命周期专项共 17 项、关联的
七组专项共 43 项通过（含上述补充）。
完整单测首次执行 1488 项，1481 通过、7 项因默认 `python3` 为 3.9.6 而失败；使用
本机 Python 3.14 重跑 `research-notebook-python-source.test.mjs`，6 项全部通过，尚未
重跑完整单测。`pnpm check:ipc` 与 `pnpm harness:eval`（94 项）通过。Task 和 execution
读取核对索引列与快照的身份/项目/状态，损坏时拒绝；在 SQLite 备份重开后注入不一致验证，
关联四组 29 项测试及 typecheck 通过。

现有数据库遇到标记为 offline-only 的迁移会拒绝自动升级；空库仍可初始化，历史迁移
checksum 不变。该机制尚未接入 S02 的实际离线转换。Stage 取消及活动 workflow 暂停
统一委托 TaskController，取消清理时保留持久化 fence；关闭阶段运行时也等待 effect 清理，
失败时保留不可继续的状态。删除未使用的 repository.cancel 快捷入口。模拟阶段终止抛错、
关闭清理失败和并发取消/暂停后，四组关联测试 35 项通过，typecheck 通过。

增加 effect store 的只读 recorded replay 入口：核对 operation identity、对账 receipt 及
result hash，不创建 attempt 或调用外部系统；无收据、无结果绑定或旧 identity 显式返回
不可回放。以 SQLite 关闭重开、记录不变和篡改输入/结果/receipt 验证。此入口尚未接入
统一事件合同或 IPC，其他 receipt 类型仍缺结果绑定，不能声称三种 replay 已完成。

Stage run 的读取同时核对项目、状态、任务、阶段、请求和父 run 索引与快照；启动关联
核对 Agent DB 的 execution，已关联但缺失或冲突时失败，不补造关系。Research 与 Agent
两库备份重开后注入阶段状态损坏及跨库关联冲突，identity 专项 12 项通过；此检查仍不
替代跨库 intent 与提交协议。

Task 诊断对清理待完成/失败及归档项目不再显示可继续或恢复审批；实际恢复审批入口也
拒绝归档项目。Stage 清理在某个阶段快照损坏时仍尝试其他关联执行并报告错误。unknown
部分用量在 run/task/project 的预算统计中保留观测值与预留值的较大值，防止提前释放额度；
预算两组专项测试通过；缺少价格预留的 unknown 部分费用会阻止有上限的新增调用，
已结算 token 但实际费用缺失时仍显示 unknown 并保留估算额度。取消清理按关联逐项
验证 execution，单条身份损坏不会阻止尝试其他可信关联的清理；该任务仍保留失败 fence。
最近取消、生命周期和身份三组 33 项测试以及 typecheck 通过。关联 chat 的 effect 处于
reserved/in_progress/unknown 时，任务继续和恢复审批均被拒绝，诊断隐藏对应入口；
该检查只覆盖已有可信 chat 关联，尚不构成所有领域 effect 的完整对账。
完整单测在使用 Python
3.14 的环境中通过 1501 项；运行期间预算代码仍有后续修改，因此不作为最终版本验收。
Recorded replay 仅在对账证据 hash 与输出 hash 一致时
返回记录，不能用互相独立的结果和结果 hash 冒充 receipt 对输出的绑定。

S02 仍在进行：执行合同与消费者整体切换、事件 envelope、跨库对账、三类 replay、
恢复、冷迁移和故障注入等均未完成；不将此局部修复标为阶段验收通过。

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

## 2026-11-06：S01 开始执行

用户“plan 开始执行第2个,完成后提交”授权 S01 本地实施、验证和 Git 提交。
开始 SHA：`424d2b6659a5cb9ffb564f97a9d544a780987da2`；工作区干净。
沿用 `plan/`，不启动 S02，不访问现有 provider 凭证，不执行付费或远端写入。
工程范围为显式冻结数据、统一 runner、隐藏期望隔离、应用 adapter、预算与标注材料。
200 项独立数据和独立双审不能由实施者生成答案替代；科学完成另需数据、审核者和 L2 授权。
Node v26.13.0、pnpm 12.5.1 已实测。

发现/错误：不存在 `plan/evaluation.md` 与根 `quality-evaluation/`，改用阶段列明的实际目录；
zsh 对猜测的不存在源码 glob 报 `no matches found`，后续用 scoped rg 定位。
memory registry 无相关记录。skill resolver 无另一个命名计划，沿用用户指定目录。

## 2026-11-06：S01 实施与收尾验证

已切换显式 dataset/隐藏 expected、protocol v3、单一 runner/统计/CLI/长任务消费者，
新增真实应用 worker/隔离 adapter、准备脚本、标注手册、数据/双审/仲裁/报告/专项模板。
删除旧 `data.ts`、pilot runner 及默认生产 fixture 数据入口。
原三篇文章的许可、归属、locator 保留；16 项全标 fixture，独立数据仍为 0/200。

实施时错误及处置（原失败日志保留，未弱化检查）：

- 类型检查发现旧 data import、nullable rollback、provider 拼写和 preview schema 不匹配；
  更新消费者并按实际应用 schema 修正，preview 保留 `runnable:false` 及明确原因。
- sandbox 首轮拒绝 OpenSSL 配置/package scope；将 OPENSSL_CONF 指向 `/dev/null`，
  trial 写入模块 package.json，复制已冻结 worker、只读依赖 symlink。
- 手造 executor 初态不足，改走生产 `createAgentDeepAgentExecutor`；补真实 runEventLog；
  stdout 日志污染改 stderr，memory 使用独立库。未修改生产 schema 或绕过预算 snapshot。
- 真应用终态 JSON 失败是产品输出问题，保留原文，测试期待 `output_not_json`。
  首次误期待 `invalid_json` 的断言已改为 validator 实际错误码。
- Task.md 首次补丁的末段上下文未匹配，工具拒绝且未产生部分编辑；随后按完整段落更新，
  原来源信息完整保留。

前一轮已确认 `pnpm typecheck` exit 0、四份专项测试 29 pass/0 fail。
其后 adapter/worker 又有费用分类、依赖一致及 interruption 修正，因此启动最新全量检查。
当前采集器 `node .artifacts/research-harness/S01/capture-verification.mjs`
在仓库根目录运行 typecheck、quality audit、全部 unit 与 harness eval；
保存精确 cwd/SHA/版本/时间/exit/log hash，历史失败日志归档至同目录 earlier-attempts。
尚未以这些正在运行的检查声称通过；最终结果在下一条记录补齐。

收尾补测两臂不同依赖拒绝、provider 异常分类/未知占用与清理，
四份专项最新 exit 0，30 pass/0 fail；其新增测试在全量 unit 启动后加入，因此专项单独记录。
最新 typecheck、quality audit、94/94 harness 已 exit 0，全量 unit 仍在执行。
按验收矩阵的构建要求补 `pnpm build`；未改生产 renderer/IPC/应用源码。
一次误读不存在的 `plan/commands.md` 已改按 `rg --files plan` 找到 `acceptance.md`，
没有依据不存在的文件作验证结论。

## 2026-11-06：S01 工程验收与提交收尾

范围状态：`Verified passing（S01 工程 L0/L1）`。S01 科学仍 `insufficient/not_run`，
独立样本 0/200；RH-05.1/2/5 保持未完成，S02～S09 保持 pending。
没有访问用户 provider 凭证、付费调用、远端写入或发布。

精确工作目录：逻辑 `/Users/Apple_501/Desktop/Roc/Roc`，
物理 `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`。
开始 SHA `424d2b6659a5cb9ffb564f97a9d544a780987da2`，检查期间 HEAD 未变；
被验证的是未提交 S01 差异，源码/fixture hash 与日志 hash 见
[engineering-verification.json](evaluation/engineering-verification.json)。
日志目录 `.artifacts/research-harness/S01/2026-11-06T11-24-16.346Z/`。

| 精确命令（仓库根目录） | 结果 | 日志 |
| --- | --- | --- |
| `pnpm typecheck` | exit 0 | typecheck.log |
| `pnpm harness:quality:check` | exit 0；16 fixture，独立数 0/200，model/network 0 | quality.log |
| `pnpm test:unit` | exit 0；1481 pass，0 fail/skip/cancelled；约 376 秒 | unit.log |
| `pnpm harness:eval` | exit 0；94/94，离线合同 | harness.log |
| `pnpm build` | exit 0；main/preload/renderer 构建 | build.log |
| `node --test tests/unit/quality-evaluation.test.mjs tests/unit/quality-runner.test.mjs tests/unit/quality-dataset.test.mjs tests/unit/quality-application-adapter.test.mjs` | exit 0；30 pass/0 fail | focused.log |
| `node --test tests/unit/quality-dataset.test.mjs` | exit 0；6 pass，补测完整 holdout/缺项/家族回退/非劣区间 | statistics-gates.log |
| `node .artifacts/research-harness/S01/check-deliverables.mjs` | 首次 regex 将 data 匹配到 dataset，校验器误报；加词边界后 exit 0 | deliverables.log / deliverables-corrected.log |

文档检查核对本地链接、JSON 读回、原 16 项 prompt/期望、原 source-records 与三篇文章
来源段落逐字保留、模板不可冒充 corpus、旧 API 零引用、后续阶段未启动和 Git 空白。
收尾写回状态后再执行一次 final 文档检查，结果和 hash 留存。
build 的 plugin timings 提示是现有构建性能信息，exit 0；本轮未改 renderer。

全量 unit 开始后加入一个 provider 回归，并追加 dataset 统计断言；
最新专项已分别通过，未为仅测试文件增补重复跑整套耗时 unit。
所有生产/评测实现均由全量 unit 与真实 worker 回归验证。
应用终态 context 前缀问题仍明确保留，未裁剪输出或启动 S02。

用户已授权完成后提交；提交仅包含本阶段代码、测试和 plan 文档。
准备脚本要求应用源码干净且已提交，提交后将实测实际 commit/bundle/依赖身份与隔离编译图，
证据仅写忽略的工件目录，不改变已提交源码。

## 2026-11-06：S01 科学验收推进

用户“完成S01 科学验收”授权继续本阶段；开始 SHA
`b4acaee6acd52bfff0a7c2c642759b2fecbdfd59`，工作区干净。
沿用 `plan/` 和原接受标准；先修复真实应用输出链路中的非 agent 故障，
保留失败分母与原始输出。未获得具体 provider/model/费用上限，不访问现有凭证或付费。

发现：仓库可定位的数据只有 fixture 和空模板，未发现 independent manifest、
人工审核记录或模型费用授权；文档连接工具返回无 connected sessions。
这仅覆盖仓库和当前连接，不能推断用户其他私有目录无材料。
科学双审及 A/B 盲审须独立人类完成，不用实施模型替代。

真实隔离 worker 修复前复现内部 context JSON 与助手答案拼接。
在生产 `deep-agent-stream-adapter.ts` 按 message-start 原始角色控制可见输出，
修复后终态恰为 `{"ok":true}`，不在 evaluator 裁剪答案。
新增主/子代理角色边界、完成前首 token、usage 与非法角色回归；
保留合法 JSON 的错误事实仍失败、48 个 fixture trial 固定分母和隔离约束。

## 2026-11-06：S01 科学准备核查与运行修复收尾

范围状态：`Verified passing（本地运行修复）`；S01 科学为
`Blocked, not run` / `insufficient`，总体仍 `in_progress`。
RH-05.1/2/5 未完成；没有运行真实 provider、人工双审或 A/B 盲审。
完整科学验收还依赖 S02/S03/S06/S07 的真实 effect、跨会话与故障环境。

以下检查 cwd 均为 `/Users/Apple_501/Desktop/Roc/Roc`，运行时 HEAD 均为
`b4acaee6acd52bfff0a7c2c642759b2fecbdfd59`；被检查的是本次待提交差异。
每项 exact command、起止时间、SHA、exit 和日志 hash 见
[scientific-readiness.json](evaluation/scientific-readiness.json)。
原始日志目录为 `.artifacts/research-harness/S01/scientific-readiness-2026-11-06/`。

| 命令 | 结果 |
| --- | --- |
| `node --test tests/unit/deep-agent-stream-role.test.mjs tests/unit/quality-application-adapter.test.mjs tests/unit/quality-evaluation.test.mjs tests/unit/quality-runner.test.mjs tests/unit/quality-dataset.test.mjs` | exit 0；34 pass，0 fail/skip/cancelled |
| `pnpm test:unit` | exit 0；1486 pass，0 fail/skip/cancelled |
| `pnpm typecheck` | exit 0 |
| `pnpm harness:eval` | exit 0；94/94 |
| `pnpm harness:quality:check` | exit 0；16 fixture，independent 0/200，model/external calls 0 |
| `pnpm build` | exit 0 |
| `node .artifacts/research-harness/S01/check-deliverables.mjs` | exit 0；36 本地 Markdown 链接、JSON、16 fixture 内容与归属、模板及后续阶段状态、旧 API 零引用、diff check |

完整读取真实隔离应用的 14 条轨迹，核对 assistant_block、
run_completed.assistantMessage 和 result.output 一致，进程组清理完成。
这只是 fixture transport 的运行证据，不计为科学模型试验。
修复前失败与两次测试构造错误分开分类并保留日志；旧工程证据不改写。

继续实验需要受控独立数据包及预注册/双审/仲裁记录、两个真实 commit、
固定模型/价格/timeout/请求和硬费用上限及授权、独立盲审协调人安排。
具体清单见 [科学验收准备核查](evaluation/scientific-readiness.md)。
本次提交范围限定为已验证的运行修复、回归与准备核查材料；
提交后仅在忽略的工件目录重建 worker、核对 commit/bundle/lock 身份。

## 2026-11-07：按阶段继续并提交

用户授权继续 S02 剩余任务，完成、验证后提交，再推进后续阶段；授权本地 Git 提交，
不包含远端推送、发布、付费模型调用或真实用户数据迁移。继续使用唯一 `plan/`。
开始 SHA `5313b3d411d583e73e2c8903f99d20f010691084`；已有 83 个已修改文件和 9 个新增
文件属于未完成 S02，保留并核查。resolver 未发现其他计划；memory 查询无相关记录。

恢复后专项：`node --test tests/unit/execution-replay.test.mjs tests/unit/offline-execution-migration.test.mjs tests/unit/research-task-identity.test.mjs tests/unit/research-task-cancellation.test.mjs tests/unit/research-task-events.test.mjs tests/unit/run-event-log.test.mjs tests/unit/tool-effect-store.test.mjs tests/unit/run-budget-ledger.test.mjs tests/unit/research-task-diagnostics.test.mjs`：59 pass；
`pnpm typecheck`：exit 0。工作目录均为仓库根目录；日志暂存 `/tmp/roc-s02-focused.log`、
`/tmp/roc-s02-typecheck.log`，阶段验收时归档。
执行合同、事件、迁移新代码已存在但未记入旧进度；继续核对冻结输入、跨库提交、恢复及消费者。

S02 输入版本补查：批准状态/源内容变化后，stage dispatch、完成和 retry 全部拒绝；
`node --test tests/unit/research-stage-inputs.test.mjs tests/unit/research-task-lifecycle.test.mjs tests/unit/run-budget-events.test.mjs`：14 pass；
加 `tests/integration/research-review-workflow.test.mjs` 的组合：15 pass；typecheck exit 0。
上次全量单测失败为 run-budget-events 夹具缺 agent_runs，已更新生产 schema 初始化，专项通过。

新增 `agent-cold-resume.test.mjs` 通过真实 runtime/executor 在模型请求进行时保存 SQLite，
关闭原连接后重开备份，沿同 runId/threadId/checkpoint 和冻结输入恢复；旧请求 unknown
预算不丢，新请求单独结算，重复恢复被拒绝。首轮夹具误以为 shutdown 会 abort 导致超时，
改为备份后先 cancel 再 shutdown；第二轮补齐生产启动的 ledger.reconcileStartup。
`node --test tests/unit/agent-cold-resume.test.mjs` exit 0，日志 `/tmp/roc-s02-cold-resume-final.log`。
以上 cwd 均为仓库根目录，尚未构成本阶段完整验收。

S02 诊断收尾：加入历史不可恢复、未确认 intent、缺 receipt、输入失效与 outbox 投递状态；
现有管理抽屉读取当前 envelope，脱敏导出保留 gap、pending 和 unknown，不含原文 payload。
恢复人工审批也验证原 Stage 输入；首次测试夹具没有合法 planning 输出，修正为真实
`ready` 产物后，`research-stage-inputs/research-task-diagnostics/research-task-lifecycle`
共 14 项通过；`tests/renderer/research-tasks.test.mjs` 16 项通过，typecheck exit 0。
专项日志为 `/tmp/roc-s02-diagnostics-final.log`、`/tmp/roc-s02-ui-final.log`、
`/tmp/roc-s02-diagnostics-types-final.log`；失败夹具日志保留。

首轮全量采集位于 `.artifacts/research-harness/S02/2026-11-06T17-33-29.412Z/`。
IPC、94 项 harness、build、chunks、13 项 smoke 与 workflow integration 通过；
unit 为 1514 pass / 3 fail（provider dispatch 等待、下载失败清理及修正前审批夹具），
renderer 为 416 pass / 34 fail，多项发生并行超时。首个实验结果 Renderer 失败项
单独复现通过，日志 `/tmp/roc-s02-renderer-repro.log`。
没有放宽超时或业务检查；改为顺序运行完整 unit 与失败的七份 Renderer 文件。
最终采集器 `.artifacts/research-harness/S02/capture-final-verification.mjs`
记录源码 hash、精确命令/cwd/SHA/时间/exit/log hash；运行过程中不再编辑业务源码。
此处仅记录已观察结果，最终验收仍待采集完成。


## 2026-11-07：S02 工程验收通过

范围状态：`Verified passing（S02 工程 L0/L1）`。完成 RH-02.1～02.5、RH-03.1～03.5；
完整合同、删除边界与迁移限制见 [S02 执行报告](s02-execution-report.md)。
最终采集器在仓库根目录执行，开始/结束 HEAD 均为
`5313b3d411d583e73e2c8903f99d20f010691084`，检查未提交差异；源码 hash 无变化。
精确命令、cwd、版本、时间、退出码与日志 hash 见
[最终 verification.json](../.artifacts/research-harness/S02/2026-11-06T17-44-18.620Z/verification.json)。

| 命令 | 结果 |
| --- | --- |
| `pnpm test:unit` | exit 0；1517 pass，0 fail/skip/cancelled |
| `node --test --test-concurrency=1 tests/renderer/experiment-results.test.mjs tests/renderer/idea-outcomes.test.mjs tests/renderer/lifecycles.test.mjs tests/renderer/paper-reader.test.mjs tests/renderer/research-tasks.test.mjs tests/renderer/review-quality-assessment.test.mjs tests/renderer/review-quality-plan.test.mjs` | exit 0；114 pass，0 fail/skip/cancelled |
| `pnpm check:ipc` | exit 0 |
| `pnpm harness:eval` | exit 0；94/94 |
| `pnpm build` | exit 0；包含 typecheck |
| `pnpm check:renderer-chunks` | exit 0 |
| `node scripts/smoke-electron.mjs` | exit 0；13/13，dist-main-fallback，full=false |

首轮 Renderer 其余文件通过，失败文件逐一顺序复核；未放宽断言或超时。
首轮 workflow integration 通过；最终 unit 覆盖同版 stage 输入和恢复审批。
只读 replay CLI exit 0、DB hash 不变；离线迁移仅隔离 fixture，原始备份保留。
真实 provider、独立人工科学评价、用户数据迁移、远端写入和发布未运行。
首轮采集器没有 sourceHashes 字段，一次摘要脚本错误读取该字段报 TypeError；
改为仅核验最终采集器的 hash，结果 changedSources=[]，原验证日志未修改。

提交本阶段代码、测试与计划；S03 随后实施。S01 科学仍缺独立样本/双审/费用授权，
S09 仍按原计划作为独立条件阶段，不把这些关口标为已完成。

## 2026-11-07：S03 开始

S02 提交 `7120421`，39 个更新文档本地链接有效，旧 snapshot 符号零引用；
最终源码和日志 hash 再核验一致。S03 开始于同一提交，工作区干净。
沿用 planning-with-files、agent-development、typescript，当前只改项目内合同与资源。
11 个阶段以现有项目原创内容为基础，保留 Roc 内部使用和权利保留状态；
未获开源许可选择，不宣称 MIT/Apache 或第三方再许可。
Manifest 将 pin 资源、输出 schema 与运行合同，变更后旧执行不能静默恢复；
上下文按权限/来源当前状态重新装配，压缩不能授予权限或补造证据。
科学 A/B 和长任务真实模型评价仍等待 S01 独立材料/费用授权。

S03 当前增量：Manifest registry、11 阶段资源与 catalog、check:skills 已落地，
Stage context 固定 skillPin，retry/执行/完成复核版本与权限。
新增 research-context-assembly；阶段与聊天共用事实装配，逐次模型调用加载当前账本，
过期/已替代正文不入 prompt，保留来源和 not_verified 原因；supersedes/contradicts
为有界可选关系，检查缺失目标、状态与环，旧无关系条目仍表示无关系。
压缩失败不再生成空摘要继续，原始待压缩 transcript 在可恢复时持久化；
工具待响应调用保持保护，原证据按 thread/workspace/hash 重读；事件新增不含正文的
trigger/sourceHash/summaryHash/artifactRefs/risks。尚需专项攻击/恢复与完整阶段验收。

cwd 均仓库根：
- `node --test tests/unit/research-task-facts.test.mjs tests/unit/research-task-budget.test.mjs tests/unit/context-compaction-pipeline.test.mjs`：25 pass，日志 `/tmp/roc-s03-context-1.log`。
- 加 `tests/unit/context-contract-audit.test.mjs` 同命令：34 pass，日志 `/tmp/roc-s03-context-2.log`。
- `pnpm typecheck`：exit 0，日志 `/tmp/roc-s03-types-2.log`、`/tmp/roc-s03-types-3.log`。
恢复时工具 backend 无法读取 notes/history，改按本项目已选 plan 与同会话本地记录核对。

S03 权限与恢复专项补充：工具工厂每次调用核对持久化工具列表、Skill hash 和完整上下文；
现有 ExecutionGrantBroker 新增 stage 授权，复核同库 Task/execution 的项目、状态、
确认关联及冻结 manifest。子角色须属于同 Task/stage 且工具为父角色子集；
context assembler 的 allowedToolNames 改必填并筛选 baseTools，删除默认授权。
待审批未完成 tool call 与同批已完成响应在确定性裁剪和摘要两段均保留。
新 Manifest 回归覆盖 11 阶段、缺字段、路径逃逸、未知/非商业许可、hash/schema/版本、
伪造上下文、工具扩权及读取前拒绝；恢复时原证据不可读明确失败。

cwd 均仓库根：`node --test tests/unit/research-skill-registry.test.mjs tests/unit/context-compaction-pipeline.test.mjs tests/unit/context-contract-audit.test.mjs tests/unit/research-stage-inputs.test.mjs tests/unit/research-task-lifecycle.test.mjs`：52 pass，exit 0，
日志 `/tmp/roc-s03-security-3.log`；`pnpm typecheck` exit 0，日志 `/tmp/roc-s03-types-5.log`；
`git diff --check` exit 0。
初轮测试错误把仅支持 chat 外键的 fence 表用于 stage，修正为真实 execution 关联撤销；
第二轮把已被确定性删除的全部旧 assistant 文字误当作可摘要片段，调整夹具使两段均实际执行。
失败日志 `/tmp/roc-s03-skills-1.log`、`/tmp/roc-s03-security-2.log` 保留。
尚未完成旧无 skillPin 执行的离线转换与阶段全量验收，不提交 S03。

S03 离线转换已补齐：research 62 为 offline-only，缺 skillPin 的新 INSERT 拒绝；
转换器只接受 agent19/research60 或 agent20/research61 两组来源，校验完整 schema。
S02 来源保留已有事件、原始 context 和未关联研究 Task 的聊天；研究 Task 与其执行
标历史不可恢复，关联聊天撤销授权，未结算预算保留 unknown，原库和备份不改。
冷重开后拒绝 continue/retry，允许新合同任务启动。`getContext` 对历史运行返回明确错误。

cwd 仓库根：`node --test tests/unit/offline-execution-migration.test.mjs`：3 pass，
日志 `/tmp/roc-s03-migration-3.log`；`pnpm typecheck` exit 0，日志 `/tmp/roc-s03-types-6.log`。
初两轮失败来自新测试重开连接未注册 SQL 函数，以及误写 schema 函数名称；
已按生产初始化函数修正夹具，失败日志 `/tmp/roc-s03-migration-1.log`、`-2.log` 保留。
全量验收正在 `.artifacts/research-harness/S03/2026-11-06T18-39-12.928Z/` 顺序采集，
包括源码/资源/package hash；采集时不更改业务源文件。

## 2026-11-07：S03 工程验收通过

范围状态：`Verified passing（S03 工程 L0/L1）`；RH-08.1～08.5、RH-09.1、
RH-12.1～12.4 与 M07 完成。三阶段/长任务真实模型科学评价未运行。
详见 [S03 执行报告](s03-execution-report.md)。

cwd 均仓库根，HEAD 为 `71204210f35ed3592ad8ca7d2f4f9b5c3e4ad80f`。
[首轮采集](../.artifacts/research-harness/S03/2026-11-06T18-39-12.928Z/verification.json)
记录精确命令、起止时间、退出码、源码与日志 hash：unit 1546/1546、IPC、workflow 1/1、
build、renderer chunks、Electron smoke 13/13 均通过，采集期间源码无变化。
smoke 为 dist-main-fallback / full=false，未运行完整应用包验收。

首轮 Harness 的 context-compaction/context-summary-failure 夹具仍期待旧摘要恢复行为，
分别收到 `context_summary_budget_exhausted` 与 `context_summary_failed`。
只改两份 harness context 脚本，验证失败直接暴露、无成功 digest、原约束不变和显式重试。
生产源码和 unit 未变；失败原报告及日志保留。
[补验采集](../.artifacts/research-harness/S03/2026-11-06T18-46-37.350Z/verification.json)
中 `pnpm harness:eval` 94/94、`pnpm typecheck`、`pnpm check:skills` 全 exit 0，
源码 hash 无变化。已核对首轮至补验仅这两份脚本发生变化，各日志 hash 匹配。

接下来提交 S03 并实施 S04。S01 独立科学材料、双审与费用授权仍缺失，
不把工程 fixture 当作科学收益，也不将 S09 的独立立项条件视作已满足。

## 2026-11-07：S04 开始

S03 提交 `f62ce04`，提交后工作区干净；53 个本地文档链接与两轮证据 hash 核对通过。
S04 先完成确定性合同、冻结语义建议、独立 finding 与人工修订关联；独立 claim pilot
和真实模型盲审依赖 S01 材料，当前没有新增科学/外部调用授权。
当前审稿三子角色已分别实例化、只读且不能读取其他报告，保留此执行路径。
缺口为结构化输出、输入绑定记录及来源/稿件变化失效；将接到现有 run complete、
工件检查器和 response matrix，不创建第二个审核事实源。

S04 已接通冻结 scientificInput、typed verifier/reviewer、准确原文定位、反证覆盖、
版本失效、独立只读工具、finding 与 response matrix 的人工处置及跨修订追踪。
必要 UI 已同步到原工件检查器；未新增壳或路由。既有引用/证据/矩阵专项 51 项、
新科学审查 6 项通过；矩阵旧 UI 8 项与新增独立意见 UI 1 项分别通过。
新增 UI 首轮在原生 details 展开动画结束前断言失败，改为等待可见内容后通过；
截图仍可能处于 160ms 展开动画中，完整验收后需补稳定截图。
完整 S04 验收正在串行运行，目录
`.artifacts/research-harness/S04/2026-11-06T19-16-40.659Z/`，尚不能标为通过。

S04 全量验收结果已回收：unit 1552/1552，typecheck、skills、IPC、Harness 94/94、
review workflow、build、renderer chunks、Electron smoke 13/13 全 exit 0。首轮
renderer 为 446/450，四项失败位于 lifecycles 与 review-quality-assessment；
日志含超时和 browser closed，耗时约 6.5 小时，不能据此断定业务根因。
正以 `node --test --test-concurrency=1 tests/renderer/lifecycles.test.mjs tests/renderer/review-quality-assessment.test.mjs`
串行复核，cwd 仓库根，日志 `/tmp/roc-s04-renderer-isolated.log`；尚未结束。
已核对原采集全部日志 hash，生产源码未变；仅 response-matrix renderer 用例新增
等待 details 展开动画完成与截图前滚动到可见处，随后补验该文件。
原始报告保留为 failed；不改写首轮失败结论。
恢复期间 notes/history 后端仍不可用，按本项目计划与同会话本地记录恢复；
S05 查询误用不存在 glob 与 `src/main/services/literature-tools.ts`，后续按 scoped rg 定位。

S04 renderer 补验完成：两份失败文件串行 40/40，通过日志收录至
`.artifacts/research-harness/S04/renderer-recheck/isolated.log`；矩阵专项 9/9、exit 0。
浅色/深色 560px 展开详情截图已复核：原文、反证、条件、替代解释与键盘焦点可见，
无横向溢出。补验 report 验证原采集日志 hash，生产源码未变，仅矩阵测试等待动画变化。
首轮 renderer 446/450 的超时/关闭原因未在串行复测复现，保留环境稳定性限制。

S04 工程交付报告 `s04-execution-report.md` 完成；工程范围 Verified passing。
原 renderer 全量失败与串行复测结果分别登记，科学盲审仍未运行；随后提交并进入 S05。

## 2026-11-07：S05 开始

S04 已提交 `4381104`，提交后工作区干净。继续用户授权的全部阶段及逐阶段提交。
S05 先切换稳定 query ID、version 与 perspectives，保留最多 3 查询/60 候选；
复用现有人工 approval hash、每页 assertCurrent、transport ledger 和不可变 pool。
RRF 的 provider 原始排名、identity alias/冲突和覆盖回执已存在，不重造所有者。
Evidence rerank 尚需审查当前本地知识检索合同与独立评测边界，不在缺少独立质量证据时
直接替换生产排序。此次查询误猜 `research-search-strategy.test.mjs` 与 renderer/features，
实际为 research-search-plan.test.mjs，按 scoped rg 修正。

S05 查询合同已切换 schemaVersion 1、稳定 queryId、视角及显式请求/候选预算；
所有视角引用必须合法，最多 3 queries/60 candidates 不变。实际调度复用 transport ledger，
按 artifact/hash/queryId 持久化唯一占用，阻止工具重建重置预算；审批后内存计划被修改也拒绝。
新增 research63 离线门与唯一索引，转换器纳入 research62 来源；尚未完成 S05 冷迁移回归。
审批界面沿用 desktop-agent-ui、React 与 TS 规范，展示视角理由、预期证据和含重试请求 cap。
11 阶段共享 output schema 更新为 v3，manifest/catalog 一起重算，技能检查通过。
初轮专项因 catalog 合同 hash 过期全部失败，重算后原 7 个 query 专项通过；
随后增加预算/身份/内存变更回归，正在跑关联专项。首次 typecheck 已通过，非最终验收。

本轮恢复中 notes/history 后端不可用，按项目计划与同会话记录恢复；
若干猜测路径不存在，已用实际目录清单修正。首次 manifest 工具异常输出 data URL，
改为捕获错误消息后确认 schema_changed；外置 zod 的 data URL bundle 不可解析，
改用 registry 自有 hash 工厂。初次 literal 补丁未匹配精确行，按真实行修正。

S05 专项补齐：query-contract-v2 98/98，ranking-v3 6/6，migration-v4 4/4，
search-plan renderer 5/5，typecheck-v3 exit 0，日志均在 `.artifacts/research-harness/S05/`。
首轮新增篡改测试污染共享 sources 数组，改 fixture 深拷贝；冷迁移夹具重开后缺 SQL
hash 函数，按生产迁移初始化注册，失败日志保留。
本地知识检索新增 RRF 回执，包含输入 hash、索引版本、chunk hash/locator、channel rank、
分数理由、输出位置与 no_results/not_searched；来源或定位变化可检测，损坏内容拒绝返回。
转换器保留旧 query plan 原文审计与历史文本，撤销旧计划和下游工件批准，将受影响项目
回 discovery 重新生成和批准；原库/备份 hash 保持不变。
未实现或采纳无独立数据支持的新语义重排算法；RH-11.3/11.5 科学评价仍待 S01 数据，
保留现有 RRF 为唯一生产排序。此限制必须进入 S05 最终交付报告，不能声称全部科学完成。
全量采集启动：`.artifacts/research-harness/S05/2026-11-07T02-24-12.563Z/verification.json`，
脚本 `.artifacts/research-harness/S05/capture-verification.mjs`；进度日志
`/tmp/roc-s05-verification.log`，运行 session 79607。renderer 本次使用
`node --test --test-concurrency=1 tests/renderer/`，其它包含 unit、IPC、Harness、workflow、
local retrieval、network benchmark、build/chunks/smoke。采集期间不改源码；尚未验收完成。

S05 全量结果已回收：unit 1555/1555、串行 renderer 450/450、Harness 94/94、
workflow 1/1、build/chunks/smoke 13/13、IPC、typecheck、skills、local retrieval 和
network benchmark 全通过。精确命令与 hash 见原采集 verification.json，采集期间源码未变。
最终复核修复 archived 项目错误激活与历史 queryIndex 结果/pool 读取失败。
历史结果转当前只读标记、原 JSON 留审计，无策略 pool bytes/hash 不变；旧批准不可继续。
关联专项 109/109；最终 `.artifacts/research-harness/S05/2026-11-07T03-07-01.178Z/`
补验迁移/evaluator 14/14、IPC、build（含 typecheck/skills）通过，原日志 hash 匹配。
补验首次 typecheck 发现 evaluator 未区分历史策略，修正并补历史实际查询的回归。
S05 工程 Verified passing，独立科学 rerank/50 问比较未运行。随后提交并进入 S06。

S06 从 `9d16212d`、干净工作区开始。继续已有授权逐阶段完成并提交。
沿用 planning-with-files、TypeScript 与 agent-development 技能。notes/history 后端仍不可用，
从本项目计划与同会话用户记录恢复；不派发子代理，不新增外部授权。
先前误猜 task-repository/阶段文档路径，已按文件清单修正。
目标：同一 agent DB 持久节点/CAS lease、同一 stage scheduler、审稿 children→reducer，
工具与结果边界拒绝过期 lease；人工 gate 持续拥有批准，实际资源仍归既有 coordinator。

S06 初步接通持久节点与统一调度；结果与人工接受增加两库提交回执，
用于启动时核验并完成中断的提交。重试保留逻辑操作身份并递增节点版本；
审稿子节点完成后 reducer 才可领取，等待人工审核释放租约。
此实现尚未运行竞争、冷恢复或完整专项测试，稳定 effect 重试、迁移与读侧仍待完成。
`pnpm typecheck` 首轮仅因两个新增事件缺少 UI 文案失败；补齐后
`.artifacts/research-harness/S06/typecheck-receipts-v2.log` exit 0，`git diff --check` exit 0。
当前为 `Changed, unverified`，类型检查不代表调度和恢复已验证。

S06 DAG 首轮专项 5/5，关联专项 34/39，日志 `S06/dag-initial.log`。5 项失败
来自复制父 nodeBinding 的旧夹具和 v2 快照，已开始更新。广泛 research 专项
启动后暴露多处旧测试直接执行受租约保护的仓储/工具，无 worker 上下文；需明确
在夹具里领取租约并运行，而不放松生产边界。该轮正在运行，不能算最终证据。
读侧开始加入 graph 与原任务抽屉的依赖/等待/版本详情；迁移器补 S05 来源，
旧执行仅保留历史审计。补充发现 retry 不应删上游依赖，现仅替换审稿子面板边；
已接受输入工件自动形成同 Task 前置边，reducer 校验子节点结果 hash。

S06 首轮 research 全集已结束：879 项、733 pass、146 fail，日志
`.artifacts/research-harness/S06/research-initial.log`，exit 1。大部分失败是旧夹具直接
调用受保护 run/role/effect 入口缺少 Worker 上下文；生产边界不放松。
复制父 DAG binding 的预算/event 夹具已改独立未绑定快照；聊天夹具明确 none。
历史 DDL 测试改直接核对旧快照保持、当前 reader 拒绝，离线转换由 migration 专项验收。
预算/lifecycle/events 31 项复测 30 pass，剩余 budget 用例在重试创建时提前收到
`run_model_call_budget_exhausted`；当前调度已在注册节点时拒绝预算耗尽。
日志 `S06/budget-lifecycle-v2.log`，cwd 仓库根；events 历史用例在采集后又修正，需补验。
本轮继续按项目计划与同会话用户原文恢复；notes/history 后端不可用。

S06 后续专项收敛：research-v2 仍有 14 项失败；对应迁移、工件批准、输入版本和
权限修复后的 contracts-v3、gate-v4 已通过。冷迁移覆盖 S02/S04/S05，保留原库、
备份与历史记录；新仓储不读取旧合同。结果 schema 统一解析解决字段顺序误判。
审稿 DAG 单槽/双槽调度与关闭 4/4（dag-runtime-v3）；关闭先 fence 根任务，
再停止活动、排队子节点和 reducer，避免误走公开父任务取消入口。
production-retry-v2 17/17：真实 SQLite worker 抢占仅一方成功、过期返回拒绝、
双库提交崩溃冷恢复不调用模型、人工接受核对 hash、真实文件重试不新增修订。
重试工件只允许同一冻结节点查询/发布；其他节点/项目/旧 Worker 拒绝。
首轮 production-retry-v1 15/17，两个失败为新增夹具缺启动步骤和表名错误，已修复。
任务抽屉 renderer 17/17（task-renderer-v1），浅/深色依赖、等待、租约与键盘可达。
最新 typecheck-production-retry exit 0。仍需 30 任务调度对照和最终全量采集；
工程状态仍为 Changed, unverified。notes/history 不可用，按本会话本地记录恢复。
本轮误猜 run-budget.ts（真实为 run-budget-ledger.ts），已按文件清单定位。

S06 调度对照已完成：30 个受控场景 × 3 次配对 × 2 个并行度，共 180 次；
`scheduler-benchmark-v2.json` 全部通过，输出投影与预算 digest 一致，每次 4 calls/320 tokens。
单槽 p50 156.95ms、p95 167.84ms；双槽 p50 138.14ms、p95 153.01ms。
这是 synthetic engineering，独立科研任务 0、真实 provider dispatch 0、真实费用 null；
不能据此宣称科学质量或生产收益。最终默认采用同一 scheduler 的 concurrency=1，
待独立质量/费用证据后再采纳 2；当前源码尚待此调整。
全量采集 `.artifacts/research-harness/S06/2026-11-07T04-21-18.193Z/` 正在运行，
初轮 typecheck/skills pass；发现 literature-import 自建 bundle 漏导出 withResearchWorker，
单例复现 `shutdown-diagnosis.log` exit 1。最终复核还需从逻辑 effect 身份剔除请求尝试 ID，
补跨请求编号重试回归，并核对清理期间同项目写入准入。采集结束后修复/补验。

S06 全量首轮 unit 1517/1575，58 fail；57 个为 literature-import/Zotero 自建 bundle
未导出 withResearchWorker，1 个预算用例创建无 research 行的账本 child 导致 shutdown
失败，单例 budget-diagnosis-v2 已复现。renderer 串行仍在运行，采集期间未改业务源码。
最终修复还包括 project cleanup pending/failed 阻止同项目新写入，以及清理完毕唤醒
统一 scheduler；默认并发降到 1，测试双槽场景显式指定 2。
本窗口恢复时 notes/history 仍失败；只读本会话原始用户记录确认授权为
“plan 继续s02剩下的任务,完成后提交，进入下一任务，直到全部任务完成为止”。
误猜 execution/scheduler.ts、phase-07-safety-ui.md 后已按目录清单纠正。

S06 首轮全量 renderer/build 采集仍在运行；期间仅改测试文件和 plan，未改生产源码。
已修 literature-import/zotero-import/zotero-preview/zotero-sync 自建 bundle 导出，
budget 的 setup 增加 includeChild，真实 executor 用例不再创建无研究行的伪 child。
新增两条回归先复现：requestId 改变重复 effect、清理期间同项目 writer 仍可领取。
命令 `node --test tests/unit/research-task-dag.test.mjs tests/unit/research-task-budget.test.mjs tests/unit/literature-import.test.mjs tests/unit/zotero-import.test.mjs tests/unit/zotero-preview.test.mjs tests/unit/zotero-sync.test.mjs`
在仓库根运行，163/165 pass，仅上述两条预期失败；日志 `S06/final-regressions-before.log`。
因此原采集 changedSources 会包含本次测试修订；最终补验需记录差异，不宣称原源码完全未变。
已创建 s06-execution-report.md 草稿，仍标 Changed, unverified。

S06 最终修复已落地：三类生产启动工具的逻辑 identity 排除 requestId，业务参数变化仍为新操作；
任一同项目根任务 cleanup pending/failed 阻止新节点领取，Controller 清理落盘后唤醒调度器。
默认并发 1，双槽取消用例显式指定 2。final-regressions-after 182/183，唯一失败来自该
旧用例隐含默认 2；明确配置后 cleanup-wakeup-final 19/19 通过，新增实际排队根任务自动唤醒回归。
原始全量采集仍在 renderer 阶段时已改上述生产代码，changedSources 将如实包含差异；
不把原报告当作单一源码快照通过。最终单测/typecheck 独立冻结采集于
`.artifacts/research-harness/S06/2026-11-07T04-40-55.340Z/`，session 30567。
原采集随后执行的 build/harness 等会读取最终源码，完成后逐项核对时间与 hash。

S06 最终冻结单测补验已完成：`2026-11-07T04-40-55.340Z/verification.json` 中
unit 1577/1577、typecheck exit 0，源码 hash 采集期间未变。随后收尾发现调度前校验失败
分支清理结束未唤醒同项目下一根任务；隔离回归 `scheduler-cleanup-before.log` 稳定复现
0 次实际 executor 调用（预期 1）。已在清理完成后重新 pump，并纳入正式 DAG runtime 回归；
受影响 DAG/取消/生命周期专项正在补验。该补丁在最终单测后，需明确两轮源码差异。
原始全量 renderer 仍在执行，未发现新失败。误猜 S08 阶段路径已纠正为 phase-08-export-release.md。

S06 收尾补验：scheduler-cleanup-after 39/39。renderer-worker-recheck 83/85，
两项旧用例直接 SQL 改写已冻结 output 后期待批准/退回，违反新结果 hash 合同。
改用实际 updateArtifact 标题修订继续验证 stale approval/重新确认，并增加独立 UI
回归确认篡改正文即使重读仍不可批准；完整 inspector 补验正在执行。原失败日志保留。
该窗口误猜 phase-07-safety-desktop-ui/artifact-repository/gate-review glob，已按真实路径纠正。

S06 工程验收完成：最终 inspector 26/26；上次两项的 updateArtifact 尝试因审批等待
不可编辑失败，现用隔离 SQL 元数据漂移验证重读确认，正文篡改单独断言拒绝。
首轮全量 failed 保留（unit 1517/1575、renderer 374/451）；最终 unit 1577/1577、
清理补验 39/39 与受影响 renderer 补验分轮登记，未拼成单次通过。
admission/IPC/Harness 94/workflow/build/chunks/smoke 13 均在最终生产修复后 exit 0。
所有报告/log hash 核对，汇总 final-verification.json；工程 Verified passing。

S06 已提交 `3647317`，提交后工作区干净。S07 开始；继续沿用 agent-development、
TypeScript、desktop-agent-ui 与 planning-with-files，复用既有原生资源/环境检查。
先固定权限/威胁矩阵和实际到达层，再运行组合攻击与单壳窗口检查。
不把 schema 拒绝称为 OS sandbox，不把未知 effect 记为零；不读取真实用户目录。

S07 已发现并修复 consumed shell grant 的执行前状态缺口。6 条真实 sentinel 回归
覆盖 revoke/terminal/expiry/frozen input/approval/grant 变化；修前全部能写文件，
修后 grant+IPC 21/21（`S07/grant-after.log`）。初版重定向夹具被 policy 早拒绝，
不算有效复现；`grant-before-v2.log` 才是实际文件改写证据。
原生四文件 integration 串行 36/36（`S07/native-boundaries.log`），exit 0。
新增 `s07-permission-matrix.md`；完整攻击目录、UI 和最终检查尚未完成。
本窗口误猜 actor-context.ts、research-production-effects.test.mjs；已通过文件清单定位
research-human-context.ts、research-workspace-files.test.mjs/production test kit。
notes/history 后端继续不可用；已核对本会话原始用户消息授权继续并逐阶段提交。

## 2026-11-07 S07 恢复续作

从用户指定会话 `01a1b1b3-93c8-7a10-abab-2ea92a6e6065` 恢复。原授权为逐阶段
实现、验证、提交；S02～S06 已提交，当前 HEAD 为 S06。恢复时保留 S07 grant
生产补丁、6 条 sentinel 回归与权限矩阵。S08 尚待本地导出/E2E/打包，S09 未立项。
本轮继续攻击目录和桌面检查；外部账号、付费模型、独立科学数据仍无可用验收条件。
使用现有 CodeGraph 定位 grant/role tools；未刷新索引。首次原始日志 tail 输出过大，
随后按 JSON message 类型有界提取用户授权和最后进展。误猜 scripts/research-harness
目录，实际入口为 scripts/harness-eval 与各 tests。未修改 memory。

S07 续作：版本化安全目录首轮 153/153 通过，其中攻击 123、控制 30（修正此前口头
124/29 计数）；独立结果在 security-2026-11-07T05-27-29.065Z/report.json。
新增网页/MCP description/result 注入经真实工具协议拦截，单文件 20/20；将三例纳入
目录后仅补验 S07-154～156。八个 renderer 文件 94/94 通过。
构建 UI audit 已真实复现 720px 浅色设置 modal 左右阴影各裁 3.2px；修前 JSON/截图
已保留 S07/layout-before。根因 max-width 92vw 未给阴影 blur 留余量；同根因影响共用
ModalShell。加入随主题的 inline/block gutter token，保留圆角内容裁切，并扩展任务
抽屉键盘捕获/返回审计。当前补丁待 build 与布局复验。生产最小宽度 1184，窄测为
一次性 Electron 窗口 override，不宣称产品支持 380px 原生窗。

S07 最终补验：网页/MCP 注入目录 3/3；156 场景为 126 攻击 + 30 控制，分轮记录。
720px modal、380px drawer 阴影与设置表单挤压均已修复，失败截图分别保留，最终
layout-verified 50 状态、cut=0；设置焦点回归 1/1。最终 build exit 0。
真实 hostile PDF/MCP P0 首轮因旧 queryIndex 与错误 result receipt hash 0/2；
按当前 queryId/规范化结果更新 fixture 后 2/2，生产拒绝边界未弱化。
IME 合成事件 + 助手/终端/设置 smoke 14/14；真实 OS IME 未运行。
final-verification.json 固定源码与证据 hash；S07 工程 Verified passing，进入 S08。
本次恢复重新读取原始会话用户授权和 plan，pending session 34096/2696 均 exit 0。

## 2026-11-07 S08 恢复与导出实施

再次从指定 JSONL 核对原授权：逐阶段完成、验证、提交。HEAD 0734156e，恢复时干净。
采用 validation v1 公共投影和 manifest v4；在现有审核/交付边界同时复核人工快照与
语义报告 currentness，不增加兼容 decoder。历史 Skill 来源为 immutable run context，
复现层级明确 not_run/not_verified，metadata-only 与本地 prepare 不代表外部发布。
使用既有 CodeGraph 查询调用方，未更新索引。组合读取曾截断，后按相关范围读取；
误猜 runs/、*context*.ts 和 research-export-service fixture 已纠正，真实 context
位于 run-repository.ts；不再用不存在的路径作为依据。

S08 首轮 build 通过，validation + semantic-publication 单测 10/10。typecheck 初次误用
artifact.version，改为精确 artifactHash 后通过。真实 P0 首轮在 review 缺少 S04 typed
output 失败；已更新固定 provider 的逐主张核验、finding 与人工处置，第二轮成功到导出
后在旧 event.executionKind 断言失败，现按 envelope.payload 读取并完整分页，第三轮运行中。
离线转换 report 的 targetApp 仍写 S05，已修正为 S08-export-validation1-task-dag1。
恢复读取曾遇到输出截断和错误 capabilities glob/task-repository 路径，已定位真实文件。

S08 续作核对：真实 P0 第三轮因向已是交付目标的 export.zip 自拷贝触发 EACCES，
改为断言交付路径同一性，第四轮 standard offline task 1/1 通过（export-p0-fourth.log）。
迁移 sentinel 与 validation 专项 10/10（migration-validation.log）。冻结采集
2026-11-07T06-12-06.038Z 已有 IPC/build exit 0、unit 1588/1588；renderer 继续运行。
本轮重新核对原 JSONL 授权、计划与 Git；未使用相关 memory。一次读取完整 sourceHashes
导致输出截断，后仅提取 checks/status 与日志尾部。S05 旧版本隔离源码已从 9d16212d
归档到 .runtime/s08-old-9d16212d，独立构建用于真实应用迁移/恢复演练。

冻结采集完成且 changedSources=[]：unit 1588、renderer 452、Harness 94、IPC/build/quality/
workflow/chunks 通过；native 35/36（500ms timeout 场景未读到启动 marker），P0/smoke
因 Electron dist/path.txt 缺失而未启动。独立 cancellation 原样补验 1/1；未弱化检查。
本地 electron-v45.0.0-darwin-arm64.zip SHA256 与安装包 checksums.json 一致
（896c3a50b148e89a158dca08a6996a022ddf39b23aac871e107f5b4087f8caa9），已恢复 dist。
安装缺失原因尚未定位，不归因于产品代码；自动下载 fetch failed 日志保留。
迁移应用第一轮漏设预算触发 research_project_budget_missing，第二轮遇同一 Electron
环境缺失；已补预算与真实 plugin-data 路径、外层配置复制，第三轮执行中。
恢复期间误猜 files.ts/paths.ts/knowledge-capabilities.ts 已改为 scoped rg 定位。

S08 续接（2026-11-07）：P0 恢复 Electron 后 17/19 通过，失败均为冷重开夹具绕过
configureRocDatabaseConnection，research.db 的触发器缺少 roc_payload_hash；改用
生产连接初始化，保留事件完整性断言。迁移第 3～6 轮分别暴露没有 Task、预算不足、
聊天/阶段完成时序、历史执行迁移增加 task_status 事件；失败报告全部保留。
第六轮已证实 1 条 effect receipt 与 6 条 budget call 转换前后 hash 一致；原事件
16 条原样保留，第 17 条为 historical_execution_not_resumable，正在补精确校验与旧版恢复。
P4 smoke 已补项目预算并删除 chat.startRun 的旧 workspacePath 参数；待打包运行验证。

S08 本地 package:dir exit 0；verify:native-packaging、arm64-only --strict（20/20）、
verify:paths 均通过。mac smoke 首轮 shell IPC 失败：脚本仍传 source:'terminal'，
当前严格 wire schema 已移除此主进程权限字段；删除旧夹具参数，等待原样路径补验。
打包产物采用 ad-hoc 签名，未 notarize/发布。完整 packaged smoke 已开始。
迁移第七轮通过：原事件逐字节保留，转换追加历史不可续跑状态；新/旧应用冷启动、
证据/Task/receipt/预算和 sentinel 均通过。记录见 findings。

S08 续作恢复：完整 packaged smoke 在保存本地测试 secret 时停住，sample 明确显示
SecItemCopyMatching / SecKeychainItemCopyContent，SecurityAgent 同时运行。已请用户
处理系统钥匙串提示；未修改系统权限或绕过 safeStorage。可独立继续 PDF、布局、
mac-native smoke 和文档。使用原 plan/，不新建计划目录。

Packaged PDF protocol、真实正文/图表截图及键盘关闭通过，证据
packaged-pdf-2026-11-07T06-57-20.415Z。mac smoke 第二轮已通过 shell IPC 与
原生库/资源检查，随后发现 redundantPackages=['highlight.js']；pnpm why 指向
production lowlight，正在核对调用方后修复依赖分类。layout packaged 执行中。
删除审计符号/queryIndex 零命中；linkAndSchedule 名称保留，但内部已委托同一 DAG
pump，不是旧调度器，最终台账需按行为描述而不是声称名称删除。

S08 当前源码 full smoke exit 0：基础 14/14、P4 62/62；默认播种250轮，累计516条
消息、2439事件，检查点恢复与工具恰好一次通过。报告已复制到 S08/dist-full-smoke。
lowlight 分类修正后的独立候选包 release/s08/mac-arm64/Roc.app 构建、原生 smoke、
native packaging 和 arm64严格20/20通过。首包50状态布局检查通过；已目视复核
浅色任务抽屉和最终候选包设置焦点/布局。完整 packaged smoke 仍停在钥匙串授权，
没有将 dist 结果冒充最终候选包结果。补齐阶段勾选、最终验收矩阵与材料，S08保持
in_progress，不提交。一次文档 patch 因整行匹配不足失败，后按精确文本修正。

### S08 续接：六种结论合同与用户系统授权
已重读原会话，继续实施并逐阶段提交的授权仍有效。用户于本轮回复已允许本次
钥匙串访问；原 packaged full smoke 已退出1，越过 safeStorage，但崩溃后
checkpoint dispatch 未进入 running。失败日志/报告保存在 first-package-full-smoke。
六结论回归先红：node --test --test-name-pattern='survives persisted review'
tests/unit/research-export-validation.test.mjs，2/2因遗漏枚举失败，日志 six-verdict-red.log。
已补齐 schema/UI/ADR，正在验证持久化、封存、人工关系与界面消费者。

六结论首轮 green 被 research_skill_schema_changed 拦截：11阶段共享输出 schema，
必须同步合同 hash。已更新全部 manifest 到1.3.0/output v4及 catalog，正文/许可
与科学 rules v1未改。catalog第一次生成因manifest schema仍要求v3失败；同步
字面量后 check-research-skills --write 通过。初轮日志保留为 before-manifests。

六结论定向回归42/42、ArtifactInspector/response matrix10/10、IPC通过；
已目视核对无法核验截图：中文结论、缺少条件、0/1覆盖、未检查原因与键盘焦点均显示。
当前源构建/typecheck及canonical arm64包完成；首包已移至release/s08-first/mac-arm64，
上一候选仍在release/s08/mac-arm64，最终包为release/mac-arm64/Roc.app。

### S08 工程收尾（2026-11-07）

用户确认新包钥匙串本次访问并逐次处理重启弹窗。session75329完成exit0：最终包
基础14/14、P4 62/62，恢复一次且ls不重做；first-package-full-smoke失败证据保留。
session76518全量unit1590/1590，P0最终19/19，harness94、IPC/chunks、package/build/typecheck、
native和arm64严格20/20通过。最终mac smoke及真实PDF/键盘关闭通过。

布局首轮exit1（1099请求变为1184），以隔离display事件probe复现；修正测试驱动为
viewport模拟、保留native约束和实际显示器纠正，原样完整布局入口exit0：50状态，
cut0、viewport overflow0。最终浅色任务抽屉/深色窄设置截图与PDF截图已目视核对。
本轮保留准确命令、失败/补验和最终包hash，更新final-acceptance/阶段/迁移/删除台账。

S08本地工程状态为Verified passing，按既有授权提交；独立科学0/200、双审/live A/B、
真实外部互操作与正式发布未完成，OS IME仅有合成事件覆盖。S09未立项，不启动。

最终文档检查：python3 .artifacts/research-harness/S08/docs-check.py，13份文档、74个
本地链接均有效，git diff --check通过。final-evidence.py汇总1538个源码hash、
36项后续命令、329份证据，冻结基线之后24个原路径变化均单独记录；本地工程通过。
