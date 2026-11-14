# Roc 评测

**Draft / agent-reviewed**：Task Specs 与验收阈值尚未获得用户批准。本文说明现行接口；历史结果见 [VALIDATION](VALIDATION.md)，预登记实验见 [EXPERIMENTS](EXPERIMENTS.md)。

统一入口是 `pnpm evaluate`，`pnpm harness:bench` 为同一 CLI 的兼容别名。评测由手动命令触发，使用隔离目录和数据库，不启动 Roc 界面。套件可运行与质量证据充分是不同条件。

## 入口与覆盖

在仓库根目录执行；需已安装的 pnpm 依赖及 macOS `sandbox-exec`。

```sh
pnpm evaluate list
pnpm evaluate run                         # 默认 roc-harness / fast
pnpm evaluate run --profile full
pnpm evaluate run --task tool-result-replay
pnpm evaluate inspect /absolute/run-directory
```

| 轨道 | 套件与 Task Spec | 范围 |
|---|---|---|
| runtime | [roc-harness](tasks/roc-harness/Task.md)（默认） | 10 个真实运行案例、7 个维度；本地控制模型，无推理请求 |
| runtime | [roc-native](tasks/roc-native/Task.md) | 94 项确定性服务合同检查，含合成 pilot |
| rag | frozen-retrieval | 冻结向量/排名离线审计 |
| rag | [rag-retrieval](tasks/rag-retrieval/Task.md) | 生产索引、BM25、embedding、RRF、reranking；host component，无生成模型/checkpoint |
| rag | [rag-paper-qa](tasks/rag-paper-qa/Task.md) | 真实 agent 与 research tools；独立检索、context、答案证据 |
| rag | [qasper](tasks/qasper/Task.md) | 官方 v0.3 dev 的文本适配与答案/证据 F1；非官方全量榜单 |
| agent | [roc-s01](adapters/s01/Task.md) | Task 合同与数据准备度审计；真实质量数据集尚未建立 |
| research | [scienceagentbench](tasks/scienceagentbench/Task.md) | 本机 Python、执行授权、独立 grader 与五类校准；来源/环境未认证，只作工程诊断 |

沿用项目原生 runner，未引入 Harbor。Harness 的 smoke 为 3 个关键恢复案例各一次，fast 为全部 10 个案例各一次，full 为全部案例各三次。它检查恢复、工具副作用、审批、取消、并发、权限和循环；通过必须满足每个案例的全部条件。`--task` 仅缩小诊断范围。控制模型不接受真实 provider、fixture、质量 experiment 或 release profile。

## 公共任务运行

`doctor` 只检查配置与凭据，不发送推理请求。不带 `--fixture` 的公共套件使用 Roc 已配置模型；`--provider-id` / `--model-id` 必须同时提供，失败不会自动换模型。

```sh
pnpm evaluate doctor
pnpm evaluate run --suite roc-native
pnpm evaluate prepare qasper
# 使用 prepare 输出的实际目录；也可 prepare qasper --archive /absolute/archive.tgz。
ROC_EVAL_DATASET=/absolute/path/from-prepare
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile fast --fixture
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile smoke --provider-options evaluation/provider-options.example.json
```

| 公共 profile | 分区与题数 | 重复 |
|---|---|---|
| smoke | development 1 题 | 1 |
| fast | development 最多 5 题 | 1 |
| full | development 最多 50 题 | 3 |
| release | 支持的 holdout 全部题 | 3 |

QASPER/Science 按 paper/repo 固定分组划分；RAG 验证输入分区的 source-connected clusters 不跨分区。QASPER 281 篇论文、1005 题中有 233 题证据无法映射到文本段落，明确排除；支持 development 611 / holdout 161。报告保留选择与排除原因，公开数据的本地 holdout 不证明模型未见过题目。

QASPER 当前 adapter 为 `qasper-roc-runtime-v3`、application contract schemaVersion 2。真实 runtime/checkpoint 与 `ls` / `read_file` 读取论文；隐藏标注只在宿主评分器。评分取独立 verifier 核验的最终 checkpoint 消息，保留聚合文本用于诊断。严格 JSON 和最多一次生产格式纠正不保证语义正确。质量比较要求 `manifest.qasperQualification` 与仍可读取的数据目录一致，核验锁定官方归档、成员和确定性任务派生；缺失或自报来源不能取得质量资格。精确证据合同见 Task Spec。

## 模型、预算与隔离

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

fixture 只允许 BM25、无 reranker；hybrid/semantic 使用已启用的 embedding/reranker，可能产生真实调用。输入为冻结的 text-native 文档、源版本、哈希和 UTF-16 locators，不评测 PDF 解析或任意外部检索。

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

当前 local recipe 的 provenance 为 `engineering_fixture`、运行证据为 `engineering-fixture`；真实模型、verified 分区、revision、自报审核或哈希均不能认证上游来源与 assets。包括旧 live-model 标记在内，比较仍为 `insufficient/science_quality_provenance_unverified`，实验 blocked。官方来源、环境、grader 审核和 matched runs 尚待建立，不升级历史评分与 seal。

## 离线审计

```sh
pnpm evaluate check --suite frozen-retrieval --corpus evaluation/local/frozen-corpus.json
pnpm evaluate check --suite roc-s01
pnpm evaluate check --suite roc-s01 --dataset /absolute/manifest.json --dataset-sha256 ACTUAL_SHA256
```

`check` 仅接受这两个套件，不运行 agent/model 或外部调用，也不接受运行/实验参数。外部 S01 manifest 必须显式提供 SHA-256。它封存 manifest、plan、journal、audit、grade/report 与 seal；`engineering-audit-only`、`auditPassRate=1` 和 `regressionAcceptance: not_evaluated` 表示审计完成，不能证明检索质量通过。`evaluation:frozen-retrieval:check` / `evaluation:s01:check` 是直接适配器入口，统一封存用 `evaluate check`。

## 比较

```sh
pnpm evaluate inspect /absolute/baseline-run
pnpm evaluate inspect /absolute/candidate-run
pnpm evaluate compare /absolute/baseline-run /absolute/candidate-run
```

普通比较要求数据/来源/选择、重复与分区、模型/检索配置、环境/权限/预算、评分器/指标/任务及实际 tools/application/RAG/最终答案合同匹配，重新核验 seal 和独立证据。源码可变；不同 tools/schema/retrievalConfig 必须使用执行前登记的[消融协议](EXPERIMENTS.md)，不能后补放宽参数。fixture、控制模型、未完成或来源未认证不能得到质量通过结论。

每个指标至少 5 个 applicable 独立 cluster、每题 3 次重复；两臂及重复的 applicability 一致。采用 2000 次配对 cluster bootstrap，同时报告原 95% 与 Bonferroni 调整区间。非劣 margin 默认 0.05，只能收紧；所有指标受益区间下界 ≥ -margin 才为 non-inferior。superior 另需事前 primary 的受益区间下界严格大于 0，多 primary 预先声明 multiplicity。普通比较无 primary，不宣称 superiority。非劣、开发门槛通过与发布批准分别判断；绝对/逐题/资源 gate 归实验协议。

## 安全续跑

```sh
pnpm evaluate run --resume /absolute/unsealed-run
```

仅接受无 seal、finalized trials/summary/report 或 run_finished 的普通目录；核验 manifest/source、plan、连续 journal、budget 和原 owner 已退出。已 dispatch 工作只可凭完整独立证据重验/计分，不重放不确定调用。未 dispatch staging 也需持久化证明后才可重建。

不接受 fixture、provider/budget/retrieval options 或 task 覆盖，显式 suite/profile/concurrency 必须一致；experiment 恢复原 path/arm/claim。SIGINT/SIGTERM 清理并封存 incomplete，不能续写；SIGKILL 可能留下符合条件的未封存目录。无法恢复时保留尝试，重新运行；实验另建协议。

## 证据与故障

生成目录 `datasets/`、`environments/`、`runs/`、`comparisons/`、`local/`、`.runtime/` 均被忽略。每轮与每个 trial 独立；隐藏真值与评分器留在 worker 之外。运行中不要修改 `src/`、`scripts/`、`resources/`、`evaluation/` 或依赖，结束时复核源码身份。

每轮保存 manifest、run-plan、budget-state、events、trials、summary/report 和 seal；application trials 另存实际 tool schema、请求响应、transcript、SQLite、聚合输出、独立 verification 与最终答案。RAG 保存源索引、排名/context、capability/reranker receipts 和独立 verification。trace pointers 绑定产物哈希，诊断标签只作定位线索。

seal 是文件哈希清单，不是签名或不可改写存储。证据缺失/损坏、源码漂移、环境、传输、verifier/policy 或清理失败均使运行 incomplete；错误答案、引用、产物和任务超时留在质量分母。provider 失败停止后续任务，未完成题不消失。轨迹超过 32 MiB 显式 invalid，原始数据本地保存，不自动上传。

资源只汇总实际 usage/latency，未知值保留；costPerSuccessfulTaskUsd 的分母为成功 trial/repeat，需完整总成本和 success 状态。未测 CPU、内存、能耗不产生结论。

| 命令 | 0 | 2 | 3 |
|---|---|---|---|
| harness run / inspect | 所选范围完整且全部通过 | incomplete / 参数错误 | 完整但条件失败 |
| 公共任务 run | 评测完整，不代表质量通过 | incomplete / 参数错误 | — |
| 普通 compare | non-inferior / superior | incompatible / insufficient / incomplete | regression / inconclusive |
| compare --protocol / experiment assess | eligible | blocked | rejected（含质量/资源/预算 gate 失败） |

`decide=0` 仅表示本地人工决定已记录。

## 保留与验证

2026-11-14 旧运行及关联生成记录（含历史基线原始证据）已清理，摘要见 [VALIDATION](VALIDATION.md)、范围见 [cleanup/latest.json](local/cleanup/latest.json)。当前比较必须重建 matched runs，文字摘要不能代替证据。清理时核对活动进程、消费者及 comparison/incident/experiment 引用；测试回收各自拥有的临时目录。`--output-root PATH` 支持独立输出父目录。

评测器检查用 `pnpm evaluation:check`，消费者检查见 [项目验证](../docs/verification.md)。命令列出不代表已执行；历史工程验收也不代表当前模型质量、UI、context compaction、子代理、记忆、外部 MCP 或注入抵抗通过。
