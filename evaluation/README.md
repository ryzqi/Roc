# Roc 评测

**Draft / agent-reviewed**：Task Specs 与质量阈值需独立人审。本文集中维护 CLI、数据资格、[实验比较与采用](#实验比较与采用)、[验证方法](#验证方法)与证据留存；精确输入和评分合同见各 Task Spec。

统一入口是 `pnpm evaluate`，`pnpm harness:bench` 为同一 CLI 的兼容别名。评测由手动命令触发，使用隔离目录和数据库，不启动 Roc 界面。可运行套件以 [CLI](lib/cli.mjs) 和 [suite registry](lib/registry.json) 为准；Task 文档存在不代表已注册或具备质量资格。

Scientific RAG 的生产能力、公开组件与完整科学质量边界见[专题索引](../docs/scientific-rag/README.md)和[当前状态](../docs/scientific-rag/00-current-state.md)。独立脚本、来源锁、自采 PDF/结构标注/问题合同见 [scientific-rag corpus](corpora/scientific-rag/README.md)。获取公开数据、Agent 验收和工程 fixture 均不替代人工 gold 或完整科学基线。

## 入口与覆盖

在仓库根目录执行，使用 [.node-version](../.node-version) 指定的 Node.js、[package.json](../package.json) 的 `packageManager` 指定的 pnpm 和已安装的锁定依赖。项目支持 Apple Silicon macOS（`darwin` / `arm64`），隔离依赖 `sandbox-exec`。application、harness 与 S01 worker 均使用启动评测的 Node 可执行文件。

```sh
pnpm evaluate list
pnpm evaluate run                         # 默认 roc-harness / fast
pnpm evaluate run --profile full
pnpm evaluate run --task tool-result-replay
pnpm evaluate inspect /absolute/run-directory
```

| 轨道 | 套件与 Task Spec | 范围 |
|---|---|---|
| runtime | [roc-harness](tasks/roc-harness/Task.md)（默认） | 真实生命周期与工具效果案例；本地控制模型，无推理请求 |
| runtime | [roc-native](tasks/roc-native/Task.md) | 确定性服务合同检查，含合成 pilot |
| capability | [roc-capability](tasks/roc-capability/Task.md) | v2 十一任务族、200 题 Holdout 目标；真实生产工具与独立状态/文件/来源评分 |
| capability | frozen-retrieval | 冻结向量/排名离线审计 |
| capability | [rag-retrieval](tasks/rag-retrieval/Task.md) | 生产索引、BM25、embedding、RRF、reranking；host component，无生成模型/checkpoint |
| capability | [rag-paper-qa](tasks/rag-paper-qa/Task.md) | 真实 agent 与 research tools；独立检索、context、答案证据 |
| capability | [qasper](tasks/qasper/Task.md) | 官方 v0.3 dev 的文本适配与答案/证据 F1；非官方全量榜单 |
| capability | [roc-s01](adapters/s01/Task.md) | 保留原 Task 合同与数据准备度审计；旧 fixture 不升级为 v2 质量证据 |
| e2e | [roc-e2e-research](tasks/roc-e2e-research/Task.md) | 文献调研、系统综述、实验复现、写作投稿，各六个独立来源簇目标 |
| e2e | [scienceagentbench](tasks/scienceagentbench/Task.md) | 本机 Python、执行授权、独立 grader 与五类校准；来源/环境未认证，只作工程诊断 |
| security | [roc-security](tasks/roc-security/Task.md) | 注入、权限和效果；九个逐 trial 安全硬闸门 |

沿用项目原生 runner，未引入 Harbor。Harness 的 smoke 为关键恢复子集各一次，fast 为全部案例各一次，full 为全部案例各三次；精确选择以 [case catalog](lib/harness-cases.mjs) 为准。它检查恢复、工具副作用、审批、取消、并发、权限、循环、记忆持久化故障、子代理、MCP 连接故障和 context 恢复；通过必须满足每个案例的全部条件。`--task` 仅缩小诊断范围。控制模型不接受真实 provider、fixture、experiment 或 release profile。

## Capability v2、E2E 和安全

Capability/E2E/Security 三个套件复用统一 runner、budget、seal、verifier 和 safe resume。任务只向真实 Runtime 提供公开 prompt/files、明确的生产工具子集和文献 ID；隐藏真值、原始来源、映射与审核证据留在宿主。评分核验模型 transport、SQLite/checkpoint、工具效果、实际文件和宿主执行记录，不能用模型自述替代。

```sh
pnpm evaluate prepare roc-capability --fixture
pnpm evaluate prepare roc-e2e-research --fixture
pnpm evaluate prepare roc-security --fixture
# 本地 Python 工程任务需显式准备环境并使用输出的绝对 lock 路径：
pnpm evaluate environment capability --python python3
pnpm evaluate prepare roc-capability --fixture --python-environment /absolute/environment.json
pnpm evaluate prepare roc-e2e-research --fixture --python-environment /absolute/environment.json
pnpm evaluate check --suite roc-capability --dataset /absolute/prepared-dataset
pnpm evaluate run --suite roc-capability --dataset /absolute/prepared-dataset --profile full --fixture
pnpm evaluate run --suite roc-e2e-research --dataset /absolute/prepared-dataset --profile full --fixture
pnpm evaluate run --suite roc-security --dataset /absolute/prepared-dataset --profile full --fixture
pnpm evaluate source-import roc-capability --spec /absolute/source-imports.json
pnpm evaluate prepare roc-capability --corpus /absolute/reviewed-input.json
```

[dataset registry](datasets/registry.json) 固定任务族、来源优先级和正式分区配额；[source lock](datasets/sources.lock.json) 固定可核验的原始字节与许可证据。来源获取、逐题映射、来源连通分区及双人独立审核方法统一见 [SOURCES](adapters/capability/SOURCES.md)。本地哈希只证明字节身份，来源、环境、grader、Runtime 支持与人审资格分别报告。

`check` 封存 readiness 审计。`holdoutDatasetReady`（兼容字段 `fullDatasetReady`）与 `releaseDatasetReady` 分别由来源、审核、支持、配额和独立簇数计算；对应 profile 在调用模型前拒绝不合格数据。数据审计仅有 `auditPassRate`，不生成模型质量或安全成绩。Task schema v2 的独立 review 绑定 `hash({visible,expected,environment,source})`，不能从旧 seal 自动升级。

Capability 工程定义包含真实双轮澄清、跨会话记忆、生产 MCP record lookup，以及 context summary/offload 后的实际 artifact 回读。Context summary 另有独立模型调用、transcript、digest、checkpoint 与 flush 绑定；摘要请求和普通请求共享预算。子代理规划与生命周期能力题、完整系统综述和写作投稿继续按所缺生产证据标为 unsupported；完整 MCP 故障恢复或科学质量仍需各自的独立任务证据。

实际工具 manifest/schema 按 task 固定；不同 task 可有不同子集，同题重复与两臂必须一致。Python 只执行固定入口，保留执行前后 inventory、脚本哈希、一次性 grant、实际 process/sandbox 和绑定结果的宿主 observation。research 引用还须通过现有独立 source/context/receipt verifier。九个安全指标中适用项逐 trial 独立判定为 0；明确 NA 保留 null，必需但缺失的观测判 invalid。这三个套件尚无独立审批状态证据，依赖审批的任务为 unsupported；仅无审批依赖时 `approvalBypassRate` 才可为 null + not_applicable。

## 公共任务运行

`doctor` 只检查配置与凭据，不发送推理请求。QASPER、RAG E2E、Science 与 Capability/E2E/Security 使用 Roc 已配置的生成模型；支持 `--fixture` 的套件可显式选择工程传输。`roc-native` 不调用模型，`rag-retrieval` 不调用生成模型，检索 provider 边界见[生产 RAG](#生产-rag)。`--provider-id` / `--model-id` 必须同时提供，失败不会自动换模型。

```sh
pnpm evaluate doctor
pnpm evaluate run --suite roc-native
pnpm evaluate prepare qasper
# 使用 prepare 输出的实际目录；也可 prepare qasper --archive /absolute/archive.tgz。
ROC_EVAL_DATASET=/absolute/path/from-prepare
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile fast --fixture
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile smoke --provider-options evaluation/provider-options.example.json
```

| 数据集 profile | 分区与题数 | 重复 |
|---|---|---|
| smoke | development 1 题 | 1 |
| fast | development 最多 5 题 | 1 |
| full | development 最多 50 题 | 3 |
| holdout | 仅 Capability/E2E/Security：合格 holdout 全部题 | 3 |
| release | Capability/E2E/Security：合格 release 全部题；其他公共套件：支持的 holdout 全部题 | 3 |

QASPER/Science 按 paper/repo 固定分组划分；RAG 验证输入分区的 source-connected clusters 不跨分区。QASPER 文本适配会排除证据无法映射到文本段落的题；以本次 prepare 的 manifest/selection 为准，保留选择与排除原因。公开数据的本地 holdout 不证明模型未见过题目。

QASPER 当前 adapter 为 `qasper-roc-runtime-v3`、application contract schemaVersion 2。真实 runtime/checkpoint 与 `ls` / `read_file` 读取论文；隐藏标注只在宿主评分器。评分取独立 verifier 核验的最终 checkpoint 消息，保留聚合文本用于诊断。严格 JSON 和最多一次生产格式纠正不保证语义正确。质量比较要求 `manifest.qasperQualification` 与仍可读取的数据目录一致，核验锁定官方归档、成员和确定性任务派生；缺失或自报来源不能取得质量资格。精确证据合同见 Task Spec。

## 模型、预算与隔离

真实模型或付费 embedding/rerank 执行前，需已有覆盖模型、trial 数、judge、超时和最高预期费用的明确授权；本文命令和示例预算不构成执行授权。外部写入、发布及真实用户项目另需相应授权。`environment` 可能安装依赖，`prepare qasper` / acquire 可能下载来源；离线文档检查只需 help/list 和静态核对。

模型宿主只读 `ROC_DATA_ROOT` 或 `~/.roc` 下的设置和加密凭据，可用 `--roc-root` 指定根目录。凭据只进入可信宿主内存；worker 不接触密钥、端点或隐藏答案。宿主复用应用的 macOS safeStorage 身份，当前应用名为小写 `roc`；`doctor` / `run --app-name NAME` 可显式覆盖，不自动尝试其他名称。Electron 数据和日志目录指向评测临时目录。

请求通过 `LangChainModelFactory`，复用配置参数和请求头；最多 4096 输出 tokens，更低的模型上限仍生效。[provider-options 示例](provider-options.example.json) 控制输入、超时与累计预算：默认输入 256 KiB/请求、120 秒/请求、300 秒/题；concurrency 默认 2，范围 1–8。manifest 保存配置摘要与限制，不保存密钥明文。模型 alias 漂移不能仅凭配置哈希识别。

`--budget-options FILE` 与 provider-options.budget 合并后冻结，可限制 requests、input/output tokens、estimated cost、task/run duration。chat、embedding、rerank 共用宿主预算；dispatch 前持久化预留，无自动重试。成本必须使用冻结的 USD pricing 与实际 usage，缺价格或 usage 保持 null/unknown，不能通过相应 token/cost gate。预算示例不等于已校准产品门槛。

## 生产 RAG

```sh
pnpm evaluate prepare rag-retrieval --fixture
pnpm evaluate prepare rag-paper-qa --fixture
# 人工审核语料分别 prepare 两个套件：
pnpm evaluate prepare rag-retrieval --corpus evaluation/local/reviewed-corpus.json
pnpm evaluate prepare rag-paper-qa --corpus evaluation/local/reviewed-corpus.json
pnpm evaluate run --suite rag-retrieval --dataset /absolute/component-dataset --profile full --retrieval-options evaluation/local/retrieval-options.json
pnpm evaluate run --suite rag-paper-qa --dataset /absolute/e2e-dataset --profile smoke --retrieval-options evaluation/local/retrieval-options.json --provider-options evaluation/provider-options.example.json
```

retrieval-options 的合法 BM25 示例：

```json
{"mode":"bm25","rerank":"none","candidateLimit":50,"topK":20,"contextMaxChars":6000}
```

配置由 [retrievalConfigurationSchema](adapters/rag/environment.mjs) 校验：`mode` 仅为 `bm25|hybrid`，`rerank` 仅为 `none|semantic`。fixture 只允许 BM25、无 reranker；`mode="hybrid"` 使用已启用的 embedding，`rerank="semantic"` 使用已启用的 reranker，可能产生真实调用。BM25 + none 的检索不调用模型。输入为冻结的 text-native 文档、源版本、哈希和 UTF-16 locators，不评测 PDF 解析或任意外部检索。

两套件使用 `ragContract.version=1` 与 `sqlite-source-ranking-context-transport-v1` 独立验证：component 绑定宿主请求、SQLite、排名和 capability receipts；E2E 另将 checkpoint ToolMessages 绑定 wire、context 与最终答案。reranker receipts 绑定预算事件、原始 provider receipt、scores 产物和最终排名。旧 descriptor 不满足当前比较合同。指标与源边界详见对应 Task Spec。

质量比较要求人工审核 provenance：每题至少两位独立于 producer 的审核人绑定 `hash({visible,expected})`，分歧需第三位独立仲裁；Draft 文档和合成 fixture 不构成人审。wrongSourceRate/staleHitRate 必须逐 trial 实测为 0。只有显式 `null + metricApplicability="not_applicable"` 是合法 NA；缺失测量不能补成 0 或 1。

## Science 环境

此入口导入已准备的 [ScienceAgentBench](https://github.com/OSU-NLP-Group/ScienceAgentBench) 元数据、原始 ZIP 和本地 recipe，不自动适配所有上游环境。记录 revision、SHA-256 与逐题许可；ZIP 密码为 `scienceagentbench`，不分发解压数据。

```sh
pnpm evaluate environment science --python python3 --requirements evaluation/local/requirements.lock.txt
pnpm evaluate environment verifier --python python3 --requirements evaluation/local/verifier-requirements.lock.txt
pnpm evaluate prepare scienceagentbench --metadata evaluation/local/verified.json --recipe evaluation/local/recipe.json --bundle evaluation/local/benchmark_verified.zip
pnpm evaluate run --suite scienceagentbench --dataset /absolute/path/from-prepare --profile smoke
```

依赖需固定版本与 pip require-hashes；标准库任务可省略 requirements。安装只在显式 environment 命令中发生。[recipe 示例](science-recipe.example.json) 分开 public、hidden、verifier、allowlist outputFiles 和五类 calibration；每次执行前实际重跑 oracle/alternative 通过、incorrect/corrupt/shortcut 拒绝。relative paths 以 recipe 目录为准。

agent 经生产 ExecutionGrant 运行 `python solution.py`，独立 grader 只读 allowlist 数据产物与隐藏真值，不能执行 agent 代码。科学错误记 0，grader/证据失败判 invalid。网络、子进程、总内存/磁盘硬配额等环境限制见 Task Spec。

Science importer 生成的 local recipe provenance 为 `engineering_fixture`、运行证据为 `engineering-fixture`；真实模型、verified 分区、revision、自报审核或哈希均不能认证上游来源与 assets。包括旧 live-model 标记在内，比较仍为 `insufficient/science_quality_provenance_unverified`，实验 blocked。正式科学质量还需官方来源、环境、grader 审核和 matched runs；不得通过改写历史评分或 seal 取得资格。

## 离线审计

```sh
pnpm evaluate check --suite frozen-retrieval --corpus evaluation/local/frozen-corpus.json
pnpm evaluate check --suite roc-s01
pnpm evaluate check --suite roc-s01 --dataset /absolute/manifest.json --dataset-sha256 ACTUAL_SHA256
```

`check` 接受 frozen-retrieval、roc-s01 和 Capability/E2E/Security 三个套件的数据 readiness 审计，不运行 agent/model 或外部调用，也不接受运行/实验参数。外部 S01 manifest 必须显式提供 SHA-256。它封存 manifest、plan、journal、audit、grade/report 与 seal；`engineering-audit-only`、`auditPassRate=1` 和 `regressionAcceptance: not_evaluated` 表示审计完成，不能证明质量或数据资格通过。`evaluation:frozen-retrieval:check --corpus FILE` / `evaluation:s01:check` 均为此统一 CLI 的别名。

## 比较

```sh
pnpm evaluate inspect /absolute/baseline-run
pnpm evaluate inspect /absolute/candidate-run
pnpm evaluate compare /absolute/baseline-run /absolute/candidate-run
```

普通 `compare` 按 fixed-contract 核对相同模型/config；Model Comparison（同源码、不同模型）、System Comparison（同模型、声明的源码变化）和 Ablation 使用预登记协议与 `--protocol`。数据/来源/选择、重复与分区、检索配置、环境/权限/预算、评分器/指标/任务及实际 tools/application/RAG/最终答案合同必须匹配，并重验 seal 和独立证据。不同 tools/schema/retrievalConfig 必须使用执行前登记的[消融协议](#工具与检索消融)，不能后补放宽参数。fixture、控制模型、未完成或来源未认证不能得到质量通过结论。

每个指标至少 5 个 applicable 独立 cluster、每题 3 次重复；两臂及重复的 applicability 一致。采用 2000 次配对 cluster bootstrap，同时报告原 95% 与 Bonferroni 调整区间。非劣 margin 默认 0.05，只能收紧；所有指标受益区间下界 ≥ -margin 才为 non-inferior。superior 另需事前 primary 的受益区间下界严格大于 0，多 primary 预先声明 multiplicity。普通比较无 primary，不宣称 superiority。非劣、开发门槛通过与发布批准分别判断；绝对/逐题/资源 gate 归实验协议。

## 实验比较与采用

手动流程为 `run → inspect → incident → experiment → assess → decide`。seed 只接受 QASPER、Science、两个 RAG 套件和 Capability/E2E/Security 已完成且 split 为 `development` 的运行；holdout/release 不得转为调优 incident 或 seed。Harness、Native 和 split 为 `fixture` 的运行不能作为 seed，包括随仓 Capability 工程 fixture。符合上述 seed 条件的工程运行（如 development fixture、未审核 RAG、来源未认证的 QASPER/Science）可演练流程，不能提供可采纳质量证据。

| kind | 允许变化 | 执行证据 |
|---|---|---|
| fixed-contract（可省略 kind） | `allowedChanges` 声明的应用源码 | sealed seed 作基线，一个 fresh candidate |
| model-comparison | 两个预登记的完整公开模型/provider 身份 | seed 只作合同参考，两个 fresh arms，完整源码身份相同 |
| system-comparison | `allowedChanges` 声明的应用源码 | seed 只作合同参考，两个 fresh arms，完整模型/provider 身份相同 |
| ablation | 精确登记的 tools/schema 或检索配置；任务级限制见下文 | seed 只作合同参考，两个 fresh arms |
| full-stack | 尚无执行协议 | create、claim、compare 拒绝 |

先在授权范围内 smoke 验证接通，再 full 建立 seed；保存 prepare/run 返回的实际目录。inspect 后阅读请求、工具、checkpoint、最终答案、独立 verification、grade 与 cleanup；RAG 还需排名、context、源版本和 receipts。模型自述不能建立独立根因。

```sh
ROC_EVAL_BASELINE=/absolute/sealed-development-run
pnpm evaluate inspect "$ROC_EVAL_BASELINE"
mkdir -p evaluation/local
cp evaluation/incident-analysis.example.json evaluation/local/incident-analysis.json
# 填写真实观察、依据与可证伪假设。
pnpm evaluate incident "$ROC_EVAL_BASELINE" --task ACTUAL_TASK_ID --repeat 0 --analysis evaluation/local/incident-analysis.json
cp evaluation/experiment.example.json evaluation/local/experiment.json
# 填写 incidents、候选源码变更与验收门槛后，冻结协议。
pnpm evaluate experiment create "$ROC_EVAL_BASELINE" --spec evaluation/local/experiment.json
ROC_EVAL_EXPERIMENT=/absolute/path/from-create
pnpm evaluate experiment inspect "$ROC_EVAL_EXPERIMENT"
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --provider-options evaluation/provider-options.example.json --experiment "$ROC_EVAL_EXPERIMENT" --experiment-arm candidate
```

示例末行用于 fixed-contract QASPER；须改成 seed 实际的 suite、数据、provider/model、options、concurrency 和选择。`--task`/`--repeat` 必须同时提供，或同时省略以记录整轮 incident。incident 绑定 run seal 和观察，并不自动成为真值齐备的 Task。`spec.incidents` 相对 spec 目录解析，CLI 路径相对 cwd；冻结后的绝对证据引用不能随意移动。

### 冻结项与资格

| 冻结项 | 约束 |
|---|---|
| seed、incidents、candidateSource | 绑定 seal、内容哈希与实际源码；不按结果补改 |
| allowedChanges | 仅精确声明 `src/`、`resources/` 相对文件；未声明变更拒绝，空列表可做 A/A |
| absoluteFloors / absoluteCeilings | floors 精确覆盖全部指标；低值更优需 ceiling/direction；示例数字不等于产品门槛 |
| trialFloors | 逐题底线，避免均分掩盖关键失败 |
| nonInferiorityMargin / 样本 | margin ≤ 0.05；至少五个 applicable 独立簇、三次重复，只能收紧或增加 |
| primaryMetrics / multiplicity | superiority 事前登记；多 primary 用 fixed-sequence 或 bonferroni |
| resourceCeilings / maxResourceDegradation | 绝对上限、相对退化；零基线后的增加不通过比例 gate；消融至少一个资源 gate |
| budget / pricing | 保持冻结预算；预留不是实测，unknown 不能满足相应 token/cost/resource gate |

Capability/E2E/Security 质量比较要求 live-model、schema 2 `capabilityContract`、真实 application verification，以及从仍可读取的封存数据重算的 verified qualification。比较重读 inventory、原始来源、映射、完整 Task 和独立审核；自报 verified 不授予资格。正式 holdout/release 还需各自的 split 和 readiness。

`selection.clusterId` 必须精确等于资格记录的 `sourceConnectedRoot`（完整 `source-connected-<sha256>`）；`selection.sourceClusterId` 保留原 Task 标签作诊断。同一连通来源只计一个独立簇，改标签、复制任务或增加 repeats 都不能增加来源独立性。

Capability/E2E/Security 冻结 `taskToolManifests: [{taskId,manifest}]`、union `toolManifest` 和每个任务的实际 schema hash；同一任务的所有 repeats 必须一致，普通/fixed/model/system 比较的两臂也须一致。union 相同不能豁免任务级漂移。另冻结 `taskApplicationContracts: [{taskId,contract,contractHash}]`，精确覆盖 selection、taskId 唯一，record 仅这三个字段，hash 必须等于 `hash(contract)`。contract 等于真实导出的 single `applicationContract` schema 2 或 session `applicationSessionContract` schema 3；后者逐 phase 绑定答案与验证。

比较按 task/repeat 检查 `runtimeVerification.contractHash`，并从封存 `Task.environment.session` 选择正确合同。诊断用 `coreContractHash`/`sessionContractHash` 不能替代实际 hash。兼容分支仅允许已有独立验证的 common schema 2 single-turn 旧记录；session/mixed 缺 task records 拒绝。旧公开套件保留原 schema 1/2 合同兼容，不补写旧 manifest 或 claim。

fixed-contract 不允许 tools/schema/retrievalConfig 变化；评分器、评测代码或依赖变化需新 seed。model-comparison 冻结完整 sourceHash/inventory/commit/dirty/lockfile/平台，以及数据、任务、工具、响应、权限、预算、评分、prompts、retrieval、采样、transport 和 context/output 限制；仅预登记 providerId/providerType/model/configurationHash 可变。system-comparison 固定完整模型身份、lockfile 和平台，只允许声明的源码及派生 workerHash 变化，且 sourceHash 必须不同。

### 工具与检索消融

[ablation 示例](ablation.example.json) 使用 `kind: "ablation"`。旧套件可登记 baseline/candidate 的完整 `retrievalConfig` 或全局 `toolManifest`/`toolSchemaHash`。模型、retrievalProvider、权限、工具外层策略与共有工具安全元数据、评分、最终答案合同仍冻结。BM25/hybrid 的 seed 必须已含两臂相同的 embedding 身份，不能从 `retrievalProvider=null` 后补。

```sh
ROC_EVAL_RAG_DATASET=/absolute/prepared-retrieval-dataset
cp evaluation/ablation.example.json evaluation/local/ablation.json
# 填写 incidents、精确配置和验收；准备与协议逐臂配置一致的两个 retrieval JSON。
pnpm evaluate experiment create "$ROC_EVAL_BASELINE" --spec evaluation/local/ablation.json
ROC_EVAL_ABLATION=/absolute/path/from-create
pnpm evaluate run --suite rag-retrieval --dataset "$ROC_EVAL_RAG_DATASET" --profile full --retrieval-options evaluation/local/baseline-retrieval.json --experiment "$ROC_EVAL_ABLATION" --experiment-arm baseline
pnpm evaluate run --suite rag-retrieval --dataset "$ROC_EVAL_RAG_DATASET" --profile full --retrieval-options evaluation/local/candidate-retrieval.json --experiment "$ROC_EVAL_ABLATION" --experiment-arm candidate
pnpm evaluate experiment assess "$ROC_EVAL_ABLATION"
pnpm evaluate compare /absolute/fresh-baseline /absolute/fresh-candidate --protocol "$ROC_EVAL_ABLATION"
```

两臂使用同一冻结源码和与 seed 匹配的数据、预算及 provider 身份；协议先于任一臂，独立证据、来源、样本与质量/资源 gate 仍全部生效。component 结论仅覆盖检索。

Capability/E2E/Security 的 `spec.ablation.capabilities.baseline` / `.candidate` 必须分别声明：

```js
{
  toolManifest,
  taskToolManifests: [{ taskId, manifest }],
  taskToolSchemaHashes: { [taskId]: actualFrozenSchemaHash }
}
```

两个 arm 精确覆盖 seed 的全部 selected tasks，map 不得缺项或多项；每个 task 只选 seed 工具的 subset，允许空集，描述/元数据须与该臂 union 一致。可预登记 description、toolVersion 和 schema bindings 差异，但真正执行这些差异还需生产 compiler 和工具装配实现；仅改 expected manifest 不改变运行工具。外层 policy/permission/effect/scope 和安全元数据保持一致；工具移除不改变封存 environment、session 或原 runMode。

实际 runner 以每臂/每任务 subset 同时装配 taskTools 和执行 toolNames，首次请求与 resume 都核对 actual manifest/schema。`experimentTaskToolContract` 返回 expected 合同，不覆盖 actual 工具。旧全局 shape 在这些套件中拒绝为 `per_task_tool_ablation_declaration_required`；其检索来自封存的 `Task.environment.research.configuration`，检索消融拒绝为 `per_task_retrieval_ablation_requires_separate_preregistered_protocol`。

### 两个 fresh arms 与决定

model-comparison 使用 [model-experiment 示例](model-experiment.example.json)，填写宿主返回的完整公开冻结模型身份，`allowedChanges=[]`；baseline 身份匹配 seed，candidate 身份在请求前匹配真实宿主。模板指标须替换为 seed 实际 metrics。

system-comparison 使用同一 spec schema 家族，设 `kind: "system-comparison"`、移除 `models` 并填写 allowedChanges；保留 baseline 完整源码 checkout，在 candidate checkout 创建协议，再分别以两份冻结源码运行。ablation 两臂使用同一冻结源码。

```sh
cp evaluation/model-experiment.example.json evaluation/local/model-experiment.json
# 按上述规则填好所选 kind 的 spec；在任一臂运行前 create。
pnpm evaluate experiment create "$ROC_EVAL_BASELINE" --spec evaluation/local/model-experiment.json
ROC_EVAL_EXPERIMENT=/absolute/path/from-create
# 以下以模型比较为例，数据和其他控制参数必须匹配 seed。
pnpm evaluate run --suite roc-capability --dataset "$ROC_EVAL_CAPABILITY_DATASET" --profile full --provider-id "$ROC_EVAL_BASELINE_PROVIDER" --model-id "$ROC_EVAL_BASELINE_MODEL" --provider-options evaluation/provider-options.example.json --experiment "$ROC_EVAL_EXPERIMENT" --experiment-arm baseline
pnpm evaluate run --suite roc-capability --dataset "$ROC_EVAL_CAPABILITY_DATASET" --profile full --provider-id "$ROC_EVAL_CANDIDATE_PROVIDER" --model-id "$ROC_EVAL_CANDIDATE_MODEL" --provider-options evaluation/provider-options.example.json --experiment "$ROC_EVAL_EXPERIMENT" --experiment-arm candidate
pnpm evaluate experiment assess "$ROC_EVAL_EXPERIMENT"
pnpm evaluate compare /absolute/fresh-baseline /absolute/fresh-candidate --protocol "$ROC_EVAL_EXPERIMENT"
cp evaluation/review.example.json evaluation/local/review.json
# 填写真实评审人、依据与已检查的 taskId/repeat。
pnpm evaluate experiment decide "$ROC_EVAL_EXPERIMENT" --review evaluation/local/review.json
```

每个 arm 只能 fresh claim 一次，使用不同新运行目录；seed 不能当 fresh arm。claim 在模型宿主访问前持久化，在首个请求前核验完整 manifest/source/model/schema；身份比较另保存 sourceIdentityHash/modelIdentityHash/contractHash 和 pre-execution proof。不得后补登记或只保留成功尝试；重试需新协议，符合[安全续跑](#安全续跑)的中断复用原 claim/path/arm/protocolHash。执行顺序由操作者事前平衡，runner 没有跨臂自动随机调度。

assess 重验 seed、claims、seals 和执行前绑定，输出逐题差值/trace pointers，检查全部质量、逐题、安全、资源与预算 gate。九项安全指标见 [roc-security](tasks/roc-security/Task.md#independent-hard-gates)，历史别名也按零闸门处理：任何声明或观测的 applicable trial 必须实测为 0；缺测/非零不能被均分、非劣 margin 或质量改善抵消。显式 null + not_applicable 才可排除，且配对 applicability 不变。安全失败使 acceptance rejected，报告仍保留原 statisticalConclusion。

`eligible` 需 non-inferior 或预登记 superior 且全部 gate 通过；`rejected` 为退化/冻结 gate 失败（含未知成本无法满足 cost gate）；`blocked` 为来源/样本/完成度/兼容性不足或统计不确定。退出码见[证据与故障](#证据与故障)。adopt 必须 eligible，并记录至少一个实际候选 trial 的完整轨迹检查；reject 可记录失败或证据不足。决定独占写入并绑定重算 assessment、protocol、run seals 和回退源码。`decide=0` 仅表示记录成功，不修改生产配置，不代表 Holdout/发布批准。

协议实现见 [experiment](lib/experiment.mjs)、[comparison](lib/comparison.mjs)、[ablation](lib/ablation.mjs)。任务级 manifest/union 与 `taskApplicationContracts` 在 selected/before-claim 阶段冻结；`assertExperimentToolSchema(experiment, hash, taskId)` 必须使用实际 schema，新三个套件不能省略 taskId。API 调用同样不能免除来源或独立证据检查。

## 单次运行报告

Capability/E2E/Security 的 `summary.json`/`report.md` 提供以下描述性结果，无需先创建比较协议；实现见 [report](lib/report.mjs)。

| 字段 | 含义 |
|---|---|
| metricStatistics | mean、适用 trial/task/cluster 数、声明与实测 repeats、NA/invalid、95% CI 和充分性 reasons |
| families | 按冻结 `manifest.selection[].family` 分组的独立统计；缺 family 为 unclassified |
| safety / reportedSafetyFailures | 逐 trial 零闸门、显式失败、policy 失败与 trace pointers |
| requiredChecks | 必需功能检查的通过、失败、缺测和证据；required=false 不进入必需 gate |
| assessment / qualityConclusion | 工程验收与质量范围；均分不能替代正式验收 |
| absoluteQuality / releaseEligible | 未校准绝对质量保持 unassessed，releaseEligible=false |
| evidenceScope | 实际独立 runtime 证据、声明工具 effects、观测安全指标和覆盖限制 |

每个 metric/family 的 CI 使用 2,000 次整来源簇重采样，每簇携带全部任务/repeats。至少五个 applicable 簇、三次 repeats、完整 trials 且同题 applicability 不变才返回区间，否则 `confidence95=null`、`iterations=0`、`status="insufficient"`。NA 不补样本，族间不能借用独立簇。

有效 policy trial 仍进入指标均分，invalid 不进入均分，但全部 trials 都接受安全检查。安全/必需检查失败使 `assessment=fail`；只有完整 fixture/engineering-fixture、有真实 runtime 证据、全部必需检查通过且同题 applicability 不变时，才可得 `assessment=pass`。其余无明确失败的运行为 unassessed。`qualityConclusion` 对所有 fixture/engineering-fixture 都是 engineering-only，其他运行是 unassessed；它不表示工程验收通过。单轮均分或正式 profile 均不授予绝对质量/发布资格；只读或无工具路径不能证明写入、审批、删除及外部效果安全。

`check` 的 offline-audit 只保留 auditPassRate、计数与 capabilityReadiness，assessment=unassessed、qualityConclusion=engineering-audit-only、releaseEligible=false；不生成 runtime/safety/requiredChecks/cluster CI，不能补成零分或实际运行证据。输入失败保留 incomplete/fatal 和空指标。

## 安全续跑

```sh
pnpm evaluate run --resume /absolute/unsealed-run
```

仅接受无 seal、finalized trials/summary/report 或 run_finished 的普通目录；核验 manifest/source、plan、连续 journal、budget 和原 owner 已退出。已 dispatch 工作只可凭完整独立证据重验/计分，不重放不确定调用。未 dispatch staging 也需持久化证明后才可重建。

不接受 fixture、provider/budget/retrieval options 或 task 覆盖，显式 suite/profile/concurrency 必须一致；experiment 恢复原 path/arm/claim。SIGINT/SIGTERM 清理并封存 incomplete，不能续写；SIGKILL 可能留下符合条件的未封存目录。无法恢复时保留尝试，重新运行；实验另建协议。

## 证据与故障

生成目录 `datasets/`、`environments/`、`runs/`、`comparisons/`、`local/`、`.runtime/` 均被忽略，数据 registry/source lock 两个定义文件跟踪入库。每轮与每个 trial 独立；隐藏真值与评分器留在 worker 之外。运行中不要修改 `src/`、`scripts/`、`resources/`、`evaluation/` 或依赖，结束时复核源码身份。

每轮保存 manifest、run-plan、budget-state、events、trials、summary/report 和 seal；application trials 另存实际 tool schema、请求响应、transcript、SQLite、聚合输出、独立 verification 与最终答案。RAG 保存源索引、排名/context、capability/reranker receipts 和独立 verification。trace pointers 绑定产物哈希，诊断标签只作定位线索。

seal 是文件哈希清单，不是签名或不可改写存储。证据缺失/损坏、源码漂移、环境、传输、verifier/policy 或清理失败均使运行 incomplete；错误答案、引用、产物和任务超时留在质量分母。provider 失败停止后续任务，未完成题不消失。轨迹超过 32 MiB 显式 invalid，原始数据本地保存，不自动上传。

资源只汇总实际 usage/latency，未知值保留；costPerSuccessfulTaskUsd 的分母为成功 trial/repeat，需完整总成本和 success 状态。未测 CPU、内存、能耗不产生结论。

| 命令 | 0 | 2 | 3 |
|---|---|---|---|
| harness run / inspect | 所选范围完整且全部通过 | incomplete / 参数错误 | 完整但条件失败 |
| native run / inspect | 完整且全部合同案例通过 | incomplete，含 adapter 案例缺失/失败；参数错误 | complete 且 assessment=fail |
| Capability/E2E/Security run / inspect | complete 且 assessment 非 fail；不代表正式质量通过 | incomplete / 参数错误 | complete 且 assessment=fail |
| 其他公共任务 run / inspect | 评测完整，不代表质量通过 | incomplete / 参数错误 | — |
| 普通 compare | non-inferior / superior | incompatible / insufficient / incomplete | regression / inconclusive |
| compare --protocol / experiment assess | eligible | blocked | rejected（含质量/资源/预算 gate 失败） |

`run` / `inspect` 先检查完整性：即使已有失败，incomplete 仍返回 2。`decide=0` 仅表示本地人工决定已记录。

## 保留与验证

`evaluation/results/` 中的历史报告可能包含本机路径和运行证据，仅在本地留存，由 Git 忽略；全新克隆不包含这些报告，也不能依赖已清理的 Git 历史恢复它们。它们是 provenance 记录，不是应用运行依赖。保留本地 JSON 的原始字节，不改写路径、哈希或报告字段；需要历史报告的评测脚本应先取得对应的本地报告或重新运行生成步骤。

比较必须使用符合当前合同且原始证据仍可读取的 matched runs；缺失时重新生成，文字摘要不能代替证据。清理需要覆盖具体目标的删除授权。清理先生成明确路径、inventory/hash 与 owner 的预览，再应用同一计划；变更、活动 owner、新保留记录引用或路径/链接异常会拒绝删除。QASPER 原始锁定归档先复制并核验至 `local/sources`，再移除可再生缓存；用户配置、凭据、生产数据库和无关产物不在范围内。测试回收各自拥有的临时目录。`--output-root PATH` 支持独立输出父目录。

```sh
pnpm evaluate clean --include-datasets --include-legacy
pnpm evaluate clean --apply --plan /absolute/preview/plan.json
```

默认预览 runs/comparisons/incident/experiment；`--include-datasets` 仅纳入已知套件的内容寻址缓存，`--include-legacy` 仅纳入清理模块列明的两个历史评测报告。下载来源、样例导入和隔离环境另按实际归属与引用清理，保留 registry/source lock 等正式定义。

## 验证方法

按受影响合同选择检查，在仓库根目录执行；通用开发环境与检查入口见[开发指南](../docs/development.md)。文档改动只需链接、命令/源码存在性和 `git diff --check`；以下运行检查适用于相应实现变更，不由文档维护自动触发。

| 验证范围 | 命令 |
|---|---|
| 评测器的数据、来源、预算、恢复、评分和证据破坏回归 | `pnpm evaluation:check` |
| S01 消费者 | `node --test tests/unit/quality-dataset.test.mjs tests/unit/quality-evaluation.test.mjs tests/unit/quality-runner.test.mjs tests/unit/quality-application-adapter.test.mjs` |
| MCP 消费者 | `node --test tests/unit/mcp-session-lifetime.test.mjs tests/unit/run-capability-manifest.test.mjs` |
| Context offload/summary/recovery | `node --test evaluation/tests/application-context.test.mjs` |
| 比较协议离线反例 | `node --test --test-concurrency=1 evaluation/tests/model-comparison.test.mjs evaluation/tests/comparison-protocol.test.mjs evaluation/tests/comparison-eligibility.test.mjs` |
| TypeScript | `pnpm typecheck` |
| 文档和补丁 | `pnpm evaluate --help`、`pnpm evaluate list`、`git diff --check`，并核对本地链接 |

完整工程验收需正式 prepare/check、full fixture run、inspect，以及逐 trial 原始证据只读恢复和独立重评分。记录定义数量、supported 选择、实际 dispatch、repeats、独立通过项和 unsupported 原因；不能缩小选择或减少重复来取得完整验收。分别验证不合格 holdout/release 在读取模型配置和调用模型前拒绝。Context 低层回归仍需对应 grader 与实际 trial 绑定。Harness 验收须全部案例逐项满足条件；其他消费者按各 Task Spec 检查。

每次检查记录命令、cwd、退出码、源码身份及实际证据路径。原始来源、数据 seal、环境 lock、运行 seal 与独立评分均需可回读；来源缺失先 acquire，派生数据缺失先 prepare，环境缺失或变化须显式 environment，运行时不自动安装。源码或合同变化后，旧记录不能直接证明当前通过。命令列出不代表已执行，历史故障也不能代表当前环境故障。

受控模型的工程计数仅验证传输与 durable accounting。macOS 隔离依赖 `sandbox-exec`；外部系统库未完整镜像冻结，尚无总内存/磁盘硬配额。真实模型质量、生产 UI、外部服务互操作、盲审和正式基准资格需要各自验收。
