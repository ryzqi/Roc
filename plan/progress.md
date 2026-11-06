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
