# Roc agent harness 评测

默认套件 `roc-harness` 评测当前 Roc 的真实运行编排、checkpoint 恢复、工具副作用、审批、取消、并发编辑、权限和循环控制。模型响应由本地控制器提供，经过真实 LangChain 模型适配器；不需要配置模型或凭据，不发送推理请求。评分以持久化状态、文件字节和完整事件证据为准。

所有评测由手动命令触发，使用隔离工作区和数据库，不启动 Roc 界面或生产数据库。QASPER 保留为 Roc 论文问答与证据选择的任务表现评测，与默认 harness 行为评测并行；ScienceAgentBench 保留科学任务适配入口，native 保留服务合同回归。精确任务定义见 [harness Task Spec](tasks/roc-harness/Task.md)和 [QASPER Task Spec](tasks/qasper/Task.md)，当前结果见 [VALIDATION.md](VALIDATION.md)。

在仓库根目录执行，使用已安装的 pnpm 依赖和 macOS `sandbox-exec`：

```sh
pnpm harness:bench run                              # 默认 fast：10 个案例
pnpm harness:bench run --profile full               # 10 个案例各重复 3 次
pnpm harness:bench run --task tool-result-replay      # 单独诊断一个案例
pnpm harness:bench inspect /absolute/run-directory
```

| Harness profile | 案例与重复 | 用途 |
|---|---|---|
| smoke | 结果回放、未知副作用阻断、审批拒绝，各 1 次 | 快速检查关键恢复边界 |
| fast | 全部 10 个案例，各 1 次 | 本地开发检查，默认 |
| full | 全部 10 个案例，各 3 次 | 完整 harness 回归 |

`--task CASE_ID` 缩小诊断范围，通过只代表所选案例。控制模型没有质量 holdout 或 `release` profile；它不接受真实 provider、`--fixture` 或质量 experiment 参数。

## Harness 验收

| 维度 | 真实运行中验证的条件 |
|---|---|
| 恢复 | 模型请求未结算时进程退出，原 run/thread/checkpoint 和冻结输入可恢复 |
| 工具副作用 | dispatch 前退出只发布一次；结果存储后退出只回放；持久化 receipt 后结果未知时阻断无人值守恢复 |
| 审批 | 真实 interrupt 在副作用之前；拒绝保留文件，批准删除保留可恢复原始字节；重复决策被拒绝 |
| 取消 | 模型信号收到 abort；run 为 cancelled，用量保持 unknown，后续工作停止 |
| 并发 | 同文件的两个编辑均保留，各有独立操作和有效回执 |
| 权限 | 只读 manifest 拒绝模型提出的写入，不创建副作用 |
| 循环 | 无进展的重复工具调用被生产 harness 在有限请求内终止 |

故障注入在真实副作用存储边界执行进程退出（code 73），恢复使用新进程和原数据库。审批决策由控制器在备份审批前的数据库与文件后释放。每个案例有独立目录、原生沙箱及清理记录。

[Verifier](lib/harness-verifier.mjs) 不导入生产验证函数，只读 SQLite、原始文件和请求响应。它核对操作身份、参数哈希、租约、尝试次数、用量与结果回执，以及事件顺序。助手声称成功不能得分。任一条件失败即失败，维度均值不能抵消它；缺失或损坏证据、环境、传输、超时、源码漂移和清理失败返回 incomplete。

这些案例测量指定条件下的 harness 行为。模型选择工具的质量、context compaction、子代理协作、跨会话记忆、外部 MCP 副作用和注入抵抗仍需独立任务环境与验收定义。

## 目录与隔离

```text
evaluation/
  lib/          CLI、数据导入、运行、评分、报告
  runtime/      独立 worker 与只读模型宿主
  tests/        评测框架自身的测试
  tasks/        Draft Task Specs
  datasets/     按内容哈希缓存的数据
  environments/ 本机 Python venv 与环境清单
  runs/         每轮独立工作区、数据库、轨迹和报告
  comparisons/  两轮对比报告
  local/        本机 recipe、请求配置、incident、experiment 和未导入数据
  .runtime/     构建、模型宿主与 native 临时状态
```

生成目录均被 Git 忽略。每轮、每题、每次重复使用新目录和数据库，不续写历史 run；同一恢复案例在自己的目录中重启。`src/` 中的真实 AgentPluginRuntime、DeepAgent executor、文件工具和执行授权被复用；评测任务、隐藏真值与评分器在 worker 之外。原有 S01 评测保持独立，旧 `.artifacts/harness-bench/` 证据保留。

公共质量套件的模型宿主只读 Roc 的 `config/settings.json` 和加密凭据。默认根目录是 `ROC_DATA_ROOT` 或 `~/.roc`，可传 `--roc-root`。不初始化配置迁移，不轮转或回写凭据，Electron 的 userData/sessionData/logs/crashDumps 全部指向评测临时目录。明文凭据只在可信模型宿主内存中使用；worker 不接触密钥、模型端点或隐藏答案。

## 当前覆盖

| 套件 | 当前能力 | 证据边界 |
|---|---|---|
| roc-harness（默认） | 10 个真实运行案例，7 个维度，独立证据验收 | 控制模型下的运行行为，非模型质量 |
| roc-native | 94 项执行、权限、恢复、工具副作用等确定性合同检查 | 含合成 pilot 任务；补充回归 |
| qasper | 官方 v0.3 dev 文本数据、真实 Roc agent 流程、独立 checkpoint 验证、答案/证据 F1 | 论文文本问答表现，非官方全量榜单 |
| scienceagentbench | verified 数据导入、本机 Python、真实执行授权、独立 grader 与五类自动校准 | 本地合成任务链路已验证；官方任务环境尚未导入 |

[Registry](lib/registry.json) 只列可运行或需要 verified 环境的适配器，已移除七个未实现的占位套件。[Harness](tasks/roc-harness/Task.md)、[QASPER](tasks/qasper/Task.md)、[Science](tasks/scienceagentbench/Task.md)、[native](tasks/roc-native/Task.md) 的精确任务定义均为 Draft / unreviewed，不能视为已经批准的发布门槛。沿用项目原生 runner，未引入 Harbor。

## 公共质量套件

以下命令用于公共任务表现评测。`doctor` 无推理请求；不带 `--fixture` 的公共套件会使用 Roc 已配置模型。

```sh
pnpm harness:bench list
pnpm harness:bench doctor
pnpm harness:bench run --suite roc-native
pnpm harness:bench prepare qasper
```

`doctor` 只检查所选模型配置与凭据可用性，不发送推理请求。它使用 Roc 的默认模型；可用 `--provider-id ID --model-id ID` 选择已配置且启用的模型。两个参数必须一起传。不会在失败时自动切换模型。

模型宿主在 `app.whenReady()` 前按项目 `package.json` 的 `productName` / `name` 设置应用名，复用应用的 macOS safeStorage 钥匙串身份。当前身份是小写 `roc`，与应用显示名 `Roc` 不同；直接启动独立脚本会继承 `Electron`，导致已有凭据无法解密。`doctor` 和 `run` 均支持 `--app-name NAME` 显式覆盖，不自动尝试其他名称。就绪后的报告记录 `applicationName`，配置、凭据和应用数据目录仍保持只读。

`prepare qasper` 下载锁定归档并校验归档及成员 SHA-256；可用 `--archive /path/qasper-train-dev-v0.3.tgz` 导入本地副本。把输出的实际目录作为后续 `--dataset` 参数：

```sh
ROC_EVAL_DATASET=evaluation/datasets/qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0
# 无模型请求：验证真实文件工具、评分与归档
pnpm harness:bench run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile fast --fixture
# 使用 Roc 默认模型：先小规模试跑
pnpm harness:bench run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile smoke --provider-options evaluation/provider-options.example.json
```

模型配置或钥匙串失败会封存 incomplete 报告，未完成题目保留在分母中。已保留 11 月 13 日的真实 QASPER smoke、150-trial 历史运行和一次 provider 中断记录，见 [VALIDATION.md](VALIDATION.md)。历史运行使用聚合助手文本评分，其中包含过程叙述，不能作为新评分边界的质量基线；原分数与 seal 保留，需要用当前实现重新建立真实模型基线。

### QASPER 的实际 Roc 流程

`run --suite qasper` 把冻结的论文与问题送入独立 worker，创建真实 `AgentPluginRuntime`、`DeepAgent` graph、会话、SQLite checkpointer、用量账本和生产文件工具。worker 的模型请求经宿主桥接到 Roc 的 `LangChainModelFactory` 与所选已配置模型；官方答案和证据标注只留在宿主评分器。每题只开放 `ls` / `read_file`，可以分页读取完整论文。

生产完成事件会聚合多个工具轮次的助手文本。评测保留该原始文本在 `output.json`，由宿主侧[独立 verifier](lib/application-verifier.mjs)读取最后一个 root checkpoint 的无工具助手消息，并与最后一次模型响应逐字核对；验证通过后才写入 `final-answer.json` 供 QASPER 评分。最终消息仍必须是严格 JSON；Markdown 围栏、额外叙述、无效引用和错误答案按原评分规则处理。

`runtime-verification.json` 核对完成的 run/thread、冻结问题/模型/限制/manifest、顺序请求响应、实际工具 schema、持久化事件、会话聚合输出、用量回执、工具参数、论文原始字节、进程退出与清理。缺失或损坏证据使 trial invalid、run incomplete。provider 未提供 usage 时保留 unknown 用量，不能假定为零。

当前 adapter 为 `qasper-roc-runtime-v2`，manifest 冻结最终答案边界，逐题 grade 绑定 runtime evidence 和最终答案哈希。这证明所测答案经过当前 Roc 文本工具流程；PDF、检索、界面交互和子代理需要单独任务环境。

## 每次更新的流程

Harness 改动先跑 `fast`，完成后跑 `full` 并 `inspect`；检查逐案例失败条件、原始状态和完整恢复轨迹。故障假设应对应具体边界，补充案例需更新 Task Spec 和独立 verifier。控制模型报告不产生统计模型质量结论。

针对公共质量轨道的明确失败假设，使用[实验闭环](EXPERIMENTS.md)：从 sealed run 记录 incident，运行前冻结候选源码和验收阈值，使用 `run --experiment` 登记唯一候选，独立比较后记录人工采纳或拒绝。除非劣检查外，还要求绝对质量底线和可选逐题底线；fixture、未完成或证据不足不能被采纳。所有记录位于本地，不自动发布。

公共套件的 run/compare 入口用于首次基线、一般诊断与 release 留出集复核：

1. 更新前手动跑 native 和所需公共套件，保存输出目录作为 baseline。
2. 更新后用相同数据、模型配置、请求配置、环境、profile 再跑，得到 candidate。
3. 分别 `inspect`，再 `compare`；查看总体差值、失败题和完整轨迹。
4. 人工决定是否接受更新。没有 push、PR、定时或应用启动触发器。

```sh
pnpm harness:bench run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --provider-options evaluation/local/provider-options.json
pnpm harness:bench inspect /absolute/baseline-run
pnpm harness:bench inspect /absolute/candidate-run
pnpm harness:bench compare /absolute/baseline-run /absolute/candidate-run
```

`provider-options.json` 可按任务所需的输入大小和超时配置。

| 公共套件 profile | 分区与题数 | 重复 | 用途 |
|---|---|---|---|
| smoke | development 1 题 | 1 | 模型接通与小额试跑 |
| fast | development 最多 5 题 | 1 | 快速诊断 |
| full | development 最多 50 题 | 3 | 版本比较 |
| release | 支持的 holdout 全部题 | 3 | 手动阶段复核 |

按 paper/repo 分组后固定 hash 划分 development/holdout，同组不跨分区。QASPER 共 281 篇论文、1005 题；233 题包含不能映射到文本段落的证据，明确排除，支持的 development 611 / holdout 161。报告记录全部未选和排除原因。公开数据的本地 holdout 不意味着模型未见过这些数据。

比较要求数据、选择、重复、模型配置哈希、请求配置、评分代码、环境、split、完整 capability manifest、实际请求的工具 schema 和 runtime/最终答案合同一致；harness 源码及 worker bundle 可变化。每个 trial 必须保留实际工具 schema 哈希，缺失时返回 `insufficient/tool_contract_evidence_missing`。QASPER / Science 还要求逐题已验证的 runtime 证据，缺失时返回 `insufficient/application_runtime_evidence_missing`；即使任务超时仍计为 agent 失败，缺少该证据也不能进入质量比较。两轮工具、权限、schema 或答案边界不同均为 `incompatible`。旧记录不能通过补填字段升级为质量证据，需要重新运行。工具增删、参数或描述变化的消融实验需要单独设计协议，不能套用当前固定工具比较。lockfile 变化要求新基线。只对完整的真实模型运行、至少 5 个 cluster 且每题至少 3 次重复，计算 2000 次配对 cluster bootstrap 的 95% 区间。非劣界限为 -0.05；所有指标区间下界均不低于此值才判 non-inferior，上界仍低于该值判 regression，其余为 inconclusive。这是初始工程判据，尚未做统计功效校准。fixture、smoke、fast 不能生成质量通过结论。

## 模型与请求配置

实际请求通过 Roc 的 `LangChainModelFactory` 构造，复用已配置的模型、采样、推理参数及请求头，并请求最多 4096 输出 tokens；更低的模型配置上限仍生效。worker 的兼容协议字段不覆盖实际工厂配置。manifest 记录 provider/model ID、配置摘要和实际输出/上下文限制，不保存端点、请求头或密钥明文。

[请求配置示例](provider-options.example.json) 仅配置输入大小和超时：单请求输入最多 256 KiB、单请求 120 秒、单题 300 秒。请求发出前先持久化调用事件，无自动重试；没有累计请求/token 配额、价格表或费用统计。模型 alias 漂移无法靠配置哈希完全检测。

## Science 本机环境

准备官方 verified 元数据、原始 `benchmark_verified.zip`、对应上游 revision 和文件 SHA-256。参考 [ScienceAgentBench](https://github.com/OSU-NLP-Group/ScienceAgentBench)；ZIP 密码为 `scienceagentbench`。逐题记录许可（部分任务有上游例外），不分发解压数据。此入口导入已准备的数据与 grader，不会自动改写所有上游环境或评分器。

先创建评测专用 Python 环境：

```sh
pnpm harness:bench environment science --python python3 --requirements evaluation/local/requirements.lock.txt
pnpm harness:bench environment verifier --python python3 --requirements evaluation/local/verifier-requirements.lock.txt
```

依赖文件需固定版本并带 pip `--require-hashes` 所需哈希；纯标准库可省略 `--requirements`。安装只发生在显式 environment 命令中。返回的 `environment.json` 记录解释器、venv 清单、依赖哈希及平台；每次使用重新核验。系统动态库和外部 Python 标准库未做完整镜像冻结，跨机器/升级解释器需重建环境和基线。当前不提供容器式总内存或总磁盘硬配额。

按 [recipe 示例](science-recipe.example.json) schemaVersion 2 为每题准备：

- `publicDir`：可见输入，不含答案、参考代码或 grader。
- `hiddenDir`：隐藏真值；`verifierDir/grade.py`：独立评分器。
- `calibrationDir`：`oracle/`、`alternative/`、`incorrect-output/`、`corrupt-output/`、`shortcut/` 五组产物。前两组必须通过，后三组必须拒绝。
- `pythonEnvironment`、`verifierEnvironment`：environment 命令返回的清单路径，可复用同一环境。
- `outputFiles`：最终数据产物的相对路径，与任务输出约定一致；不得包含 agent 源码或可执行模块。

recipe 中相对路径以 recipe 文件目录为基准。导入复制并哈希 public、hidden、verifier、calibration；每次运行在任务执行前重新执行五类校准，保存实际结果。仅提供声称通过的校准 JSON 不足以通过预检。

```sh
pnpm harness:bench prepare scienceagentbench --metadata evaluation/local/verified.json --recipe evaluation/local/recipe.json --bundle evaluation/local/benchmark_verified.zip
pnpm harness:bench run --suite scienceagentbench --dataset /path/from-prepare --profile smoke
```

模型使用真实 `write_file`/`edit_file`/`run_shell_command`，命令限定为 `python solution.py`，必须消费生产 ExecutionGrant。文件工具使用 `/workspace` 虚拟路径，Python 使用实际 workspace 为 cwd，所以脚本中用相对路径。Python 进程禁止网络和子进程，仅能读取依赖与本题输入、写本题目录。执行继承 grant 限制，最多 120 秒和 1 MiB 输出；另设 CPU 时间、64 MiB 单文件大小、128 文件描述符限制。

独立 grader 在另一 scratch 目录运行 `python grade.py OUTPUT_DIR TRUTH_DIR`，最多 120 秒；仅挂入冻结的 verifier、隐藏真值和 allowlist 产物，不包含 agent workspace/source。stdout 输出 `{"success":true|false,"evidence":"非空判定依据"}`。grader 必须按数据解析产物，不能导入或执行 agent 代码。缺产物或科学结果错误记 0；grader 崩溃/协议损坏判 invalid。需要网络、子进程、超出本机限制或付费 judge 的上游任务需排除或另行设计。

导入记录原始文件哈希、revision、license 和全部 omitted IDs，但无法自动证明人工整理的目录对应原始 bundle 的正确内容，仍需核对来源。每次独立计分再取均值，不能当成上游 best-of-three 分数。当前仅有明确标注的合成任务测试，尚无官方 Science 质量结论。

## 报告与故障定位

每轮有 `manifest.json`（源码/数据/选择/模型/环境）、`events.jsonl`（请求/任务事件）、`trials.json`、`summary.json`、`report.md` 和 `seal.json`。Harness 每题保留阶段请求响应、审批决策、工具事件、崩溃前/最终 SQLite、文件字节、逐条件 grade、进程退出与清理记录。请求正文保留实际工具 schema。

公共套件另保留 `tool-schema.json`（实际工具定义及哈希）、`transcript.jsonl`、带请求/响应哈希的 `responses.jsonl`、SQLite checkpoint、`output.json`（原始聚合文本）、`runtime-verification.json` 和 `final-answer.json`（验证后的最终消息）。Science 也通过该 runtime verifier，科学正确性仍由独立 grader 读取数据产物决定。模型请求在运行时按当前 scope 的 manifest 过滤；宿主在转发前再次检查固定工具集合、重复项与 schema 结构，并拒绝 trial 内 schema 漂移。runner 拒绝不同 trial 之间的 schema 漂移；已发出请求的 agent 失败也保留 schema 哈希。native 原始普通文件归档；隔离测试故意产生的符号链接仅记录路径/目标，不跟随目标。

证据文件独占创建，事件 fsync，seal 保存文件清单哈希，`inspect`/`compare` 重新核验。seal 能检测修改，不是数字签名或不可改写存储。worker 轨迹超 32 MiB 显式 invalid；不会静默截断后通过。原始数据/轨迹可能含任务内容，保存在本地且不自动上传。

| 公共质量套件失败类别 | 处理 |
|---|---|
| agent：错误答案、无效引用、缺产物、任务超时 | 留在质量分母中 |
| harness/state：运行合同失败、源码变化 | incomplete |
| data/environment：哈希错误、环境/凭据不可用 | incomplete，不算 agent 错误 |
| provider：API 失败 | 停止后续任务，保留未完成分母 |
| verifier/policy/infrastructure：评分器、隔离、证据、清理失败 | incomplete，不能通过质量比较 |
| operator：SIGINT/SIGTERM | 清理并封存 incomplete；SIGKILL 可能留下无 seal 目录 |

模型预检给出固定错误码；例如 `provider_credential_missing`、`roc_model_host_timeout_credential_availability`。不记录可能包含密钥的原始 provider 错误。执行期间不要修改 src/scripts/resources/evaluation 源码或依赖，结束时会复核身份。

退出码：Harness 的 `run/inspect` 返回 0 表示所选范围完整且全部通过，3 表示完整但有 harness 条件失败，2 表示 incomplete 或参数错误。公共套件的 `run=0` 只表示评测完整；compare 的 0 表示非劣，2 表示 incompatible/insufficient，3 表示 regression/inconclusive，不能单凭 run 退出码证明质量改善。

## 产物保留与清理

保留可复核的近期真实质量基线、重要中断证据和当前 harness/native 验证。重复 fixture、已解决的零请求预检失败、合成测试缓存和无消费者的测试 venv 可清理；正式 Science 环境与外部导入数据需先核对消费者。删除 run 时一起检查关联 comparison、incident 和 experiment，不留下指向已删目录的记录。

11 月 13 日按审计清单删除了 251 个生成目录，释放约 2.67 GiB；[清单](local/cleanup/2026-11-13/manifest.json)与[执行结果](local/cleanup/2026-11-13/result.json)记录路径、理由、大小和保留证据哈希。没有修改已保留 run 的内容或 seal。S01 与 `evaluation/` 之外的旧证据不在本次清理范围。

测试使用各自拥有的输出根目录，在失败时也运行清理 hook，回收 run、incident、experiment、Science 缓存和 venv。模型宿主在确认进程退出后删除临时状态。`--output-root PATH` 可为 run、compare、incident 和 experiment 指定独立输出父目录。`.runtime/` 是可重建状态，清理前必须确认没有评测进程。

## 验证

```sh
node --test evaluation/tests/roc-harness.test.mjs evaluation/tests/harness-bench.test.mjs evaluation/tests/harness-bench-application.test.mjs evaluation/tests/roc-model.test.mjs evaluation/tests/experiment.test.mjs tests/unit/quality-application-adapter.test.mjs
node --test tests/unit/database-schema.test.mjs tests/unit/tool-effect-store.test.mjs tests/unit/execution-grant-broker.test.mjs
pnpm typecheck
pnpm harness:quality:check
```

上述检查无需付费模型。实际结果与剩余限制见 [VALIDATION.md](VALIDATION.md)。
