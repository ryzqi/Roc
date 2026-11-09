# Roc 本机手动评测

所有评测由人运行命令触发。触发后自动完成配置预检、数据与源码冻结、真实 harness 执行、独立评分、证据封存及版本比较。使用当前仓库的 Roc 实现和已配置模型；不需要 Docker，也不启动 Roc 界面或生产数据库。

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
  local/        本机 recipe、预算、incident、experiment 和未导入数据
  .runtime/     构建、模型宿主与 native 临时状态
```

生成目录均被 Git 忽略。每轮、每题、每次重复使用新目录和数据库，不续写历史 run。`src/` 中的真实 AgentPluginRuntime、DeepAgent executor、文件工具和执行授权被复用；评测任务、隐藏真值与评分器在 worker 之外。原有 S01 评测保持独立，旧 `.artifacts/harness-bench/` 证据保留。

模型宿主只读 Roc 的 `config/settings.json` 和加密凭据。默认根目录是 `ROC_DATA_ROOT` 或 `~/.roc`，可传 `--roc-root`。不初始化配置迁移，不轮转或回写凭据，Electron 的 userData/sessionData/logs/crashDumps 全部指向评测临时目录。明文凭据只在可信模型宿主内存中使用；worker 不接触密钥、模型端点或隐藏答案。

## 当前覆盖

| 套件 | 当前能力 | 证据边界 |
|---|---|---|
| roc-native | 94 项预算、权限、恢复、工具副作用等确定性检查 | harness 可靠性，非模型质量 |
| qasper | 官方 v0.3 dev 文本数据、真实文件工具、答案/证据 F1 | Roc 文本适配子集，非官方全量榜单 |
| scienceagentbench | verified 数据导入、本机 Python、真实执行授权、独立 grader 与五类自动校准 | 本地合成任务链路已验证；官方任务环境尚未导入 |

BEIR-SciFact、LongMemEval、BFCL V4、AgentDojo 为 planned；RULER、GAIA、CORE-Bench 为 deferred，没有可运行适配器。详见 [registry](lib/registry.json)。[QASPER](tasks/qasper/Task.md)、[Science](tasks/scienceagentbench/Task.md)、[native](tasks/roc-native/Task.md) 的精确任务定义均为 Draft / unreviewed，不能视为已经批准的发布门槛。沿用项目原生 runner，未引入 Harbor。

## 首次运行

在仓库根目录执行，使用项目已安装的 pnpm 依赖。真实 worker 与 Python 隔离当前需要 macOS `sandbox-exec`。

```sh
pnpm harness:bench list
pnpm harness:bench doctor
pnpm harness:bench run --suite roc-native
pnpm harness:bench prepare qasper
```

`doctor` 只检查所选模型配置与凭据可用性，不发送推理请求。它使用 Roc 的默认模型；可用 `--provider-id ID --model-id ID` 选择已配置且启用的模型。两个参数必须一起传。不会在失败时自动切换模型。

`prepare qasper` 下载锁定归档并校验归档及成员 SHA-256；可用 `--archive /path/qasper-train-dev-v0.3.tgz` 导入本地副本。把输出的实际目录作为后续 `--dataset` 参数：

```sh
ROC_EVAL_DATASET=evaluation/datasets/qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0
# 无模型请求：验证真实文件工具、评分与归档
pnpm harness:bench run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile fast --fixture
# 使用 Roc 默认模型：先小规模试跑
pnpm harness:bench run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile smoke --budget evaluation/budget.example.json
```

未传 `--fixture` 的公共套件会调用所选模型。模型配置或钥匙串失败会封存 incomplete 报告，未完成题目保留在分母中。11 月 8 日记录曾出现默认模型缺少 credentialRef、另一模型在钥匙串可用性检查阶段超时；这是历史结果，当前可用性以重新运行 `doctor` 为准，无需在评测中复制密钥或配置第二套 provider。

## 每次更新的流程

针对有明确失败假设的优化，使用[实验闭环](EXPERIMENTS.md)：从 sealed run 记录 incident，运行前冻结候选源码和验收阈值，使用 `run --experiment` 登记唯一候选，独立比较后记录人工采纳或拒绝。除非劣检查外，还要求绝对质量底线和可选逐题底线；fixture、未完成或证据不足不能被采纳。所有记录位于本地，不自动发布。

下面的独立 run/compare 入口保留，用于首次基线、一般诊断与 release 留出集复核：

1. 更新前手动跑 native 和所需公共套件，保存输出目录作为 baseline。
2. 更新后用相同数据、模型配置、预算、环境、profile 再跑，得到 candidate。
3. 分别 `inspect`，再 `compare`；查看总体差值、失败题和完整轨迹。
4. 人工决定是否接受更新。没有 push、PR、定时或应用启动触发器。

```sh
pnpm harness:bench run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --budget evaluation/local/full-budget.json
pnpm harness:bench inspect /absolute/baseline-run
pnpm harness:bench inspect /absolute/candidate-run
pnpm harness:bench compare /absolute/baseline-run /absolute/candidate-run
```

`full-budget.json` 需由操作者按任务数量配置；示例只适合试跑。

| Profile | 分区与题数 | 重复 | 用途 |
|---|---|---|---|
| smoke | development 1 题 | 1 | 模型接通与小额试跑 |
| fast | development 最多 5 题 | 1 | 快速诊断 |
| full | development 最多 50 题 | 3 | 版本比较 |
| release | 支持的 holdout 全部题 | 3 | 手动阶段复核 |

按 paper/repo 分组后固定 hash 划分 development/holdout，同组不跨分区。QASPER 共 281 篇论文、1005 题；233 题包含不能映射到文本段落的证据，明确排除，支持的 development 611 / holdout 161。报告记录全部未选和排除原因。公开数据的本地 holdout 不意味着模型未见过这些数据。

比较要求数据、选择、重复、模型配置哈希、预算、评分代码、环境、split、完整 capability manifest 和实际请求的工具 schema 一致；harness 源码及 worker bundle 可变化。每个 trial 必须保留实际工具 schema 哈希，缺失时返回 `insufficient/tool_contract_evidence_missing`；两轮工具或权限不同、schema 不同均为 `incompatible`。旧记录不能通过补填字段升级为质量证据，需要重新运行。工具增删、参数或描述变化的消融实验需要单独设计协议，不能套用当前固定工具比较。lockfile 变化要求新基线。只对完整的真实模型运行、至少 5 个 cluster 且每题至少 3 次重复，计算 2000 次配对 cluster bootstrap 的 95% 区间。非劣界限为 -0.05；所有指标区间下界均不低于此值才判 non-inferior，上界仍低于该值判 regression，其余为 inconclusive。这是初始工程判据，尚未做统计功效校准。fixture、smoke、fast 不能生成质量通过结论。

## 模型与预算

实际请求通过 Roc 的 `LangChainModelFactory` 构造，复用已配置的模型、采样、推理参数及请求头，并请求最多 4096 输出 tokens；更低的模型配置上限仍生效。worker 的兼容协议字段不覆盖实际工厂配置。manifest 记录 provider/model ID、配置摘要和实际输出/上下文限制，不保存端点、请求头或密钥明文。

[预算示例](budget.example.json) 不包含模型配置。默认每题 12 次、每轮 60 次请求，单请求 120 秒、单题 300 秒，单请求输入最多 256 KiB。请求发出前先 fsync 预算预留，无自动重试。运行前根据实际选题数 × 重复数计算最低请求数，若超过 `maxTotalRequests`，在打开模型宿主前以 `budget/request_budget_infeasible` 拒绝，并封存 `budgetPlan`、零次 trial 和 `not-dispatched` 费用状态。例如 full 选满 50 题时至少需要 150 次请求，默认 60 不可行；请明确配置预算或减小 profile。最低值按每 trial 一次请求计算，不保证多轮工具调用能完成；运行中的预算耗尽仍为 incomplete，不会被当成低质量答案，也不会自动增加预算。

默认费用为 unknown。需要估算时，同时添加 `maxTotalEstimatedUsd` 与 `pricing: { version, inputPerMillion, outputPerMillion }`。金额是按自填版本价格和输入字节数估算的准入限制，不是供应商账单硬上限；请求数量有硬限制。失败/未知用量保留预算预留。模型 alias 漂移无法靠配置哈希完全检测。

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

每轮有 `manifest.json`（源码/数据/选择/模型/环境）、`events.jsonl`（预算/请求/任务事件）、`trials.json`、`summary.json`、`report.md` 和 `seal.json`。每题保留请求响应、工具事件、`tool-schema.json`（实际工具定义及哈希）、checkpoint、SQLite、最终输出、独立 grade、进程退出与清理记录。模型请求在运行时按当前 scope 的 manifest 过滤；宿主在转发前再次检查固定工具集合、重复项与 schema 结构，并拒绝 trial 内 schema 漂移。runner 拒绝不同 trial 之间的 schema 漂移；已发出请求的 agent 失败也保留 schema 哈希。native 原始普通文件归档；隔离测试故意产生的符号链接仅记录路径/目标，不跟随目标。

证据文件独占创建，事件 fsync，seal 保存文件清单哈希，`inspect`/`compare` 重新核验。seal 能检测修改，不是数字签名或不可改写存储。worker 轨迹超 32 MiB 显式 invalid；不会静默截断后通过。原始数据/轨迹可能含任务内容，保存在本地且不自动上传。

| 失败类别 | 处理 |
|---|---|
| agent：错误答案、无效引用、缺产物、任务超时 | 留在质量分母中 |
| harness/state：运行合同失败、源码变化 | incomplete |
| data/environment：哈希错误、环境/凭据不可用 | incomplete，不算 agent 错误 |
| provider/budget：API 失败、预算耗尽 | 停止后续任务，保留已预留和未完成分母 |
| verifier/policy/infrastructure：评分器、隔离、证据、清理失败 | incomplete，不能通过质量比较 |
| operator：SIGINT/SIGTERM | 清理并封存 incomplete；SIGKILL 可能留下无 seal 目录 |

模型预检给出固定错误码；例如 `provider_credential_missing`、`roc_model_host_timeout_credential_availability`。不记录可能包含密钥的原始 provider 错误。执行期间不要修改 src/scripts/resources/evaluation 源码或依赖，结束时会复核身份。

退出码：0 = 完整 run / 有效完整 inspect / 非劣比较；2 = incomplete、incompatible、insufficient 或参数错误；3 = regression 或 inconclusive。`run=0` 只表示评测完整，不能单独证明更新质量通过。

## 验证

```sh
node --test evaluation/tests/harness-bench.test.mjs evaluation/tests/harness-bench-application.test.mjs evaluation/tests/roc-model.test.mjs tests/unit/quality-application-adapter.test.mjs
node --test evaluation/tests/experiment.test.mjs
node --test tests/unit/database-migrations.test.mjs tests/unit/tool-effect-store.test.mjs tests/unit/execution-grant-broker.test.mjs
pnpm typecheck
pnpm harness:quality:check
```

上述检查无需付费模型。实际结果与剩余限制见 [VALIDATION.md](VALIDATION.md)。
