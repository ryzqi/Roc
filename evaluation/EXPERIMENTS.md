# 从失败证据到候选采纳

**状态：Draft / agent-reviewed；精确任务与阈值尚未获得用户批准。**

本流程把 `pnpm evaluate run → inspect → compare` 接成一个手动、本地开发实验。它复用真实 Roc runtime、独立 grader、预算与证据封存，记录 incident、预登记协议、运行 claim、验收和人工决定。`pnpm harness:bench` 是同一 CLI 的兼容别名；决定只写本地记录，不部署或修改生产配置。

## 结果与边界

```text
已封存运行 → incident（观察 + 根因假设）
完成的 development seed + 候选代码 + 验收标准 → 冻结 experiment
fixed-contract → seed 作基线 + 一个 fresh candidate claim
ablation → 两个 fresh baseline/candidate claims；seed 只作合同参考
独立比较 + 绝对质量/资源/预算门槛
人工检查完整轨迹 → adopt / reject 本地记录
新失败 → 新 incident 与下一次 experiment
```

- 支持 QASPER、Science、rag-retrieval 与 rag-paper-qa 的 development 分区；holdout 不能转成优化 incident 或 seed，继续通过 release 流程独立复核。
- fixture、控制模型、未审核或合成 RAG、官方来源未验证的 QASPER 可以演练工程流程，不能成为可采纳质量证据。合成十题 × 三次重复也不能证明质量或 holdout。smoke / fast 不满足至少三次重复的正式比较门槛。
- `eligible` 表示满足本次冻结的开发验收条件，不等于显著提升、独立留出集通过或生产发布批准。精确 Task Specs 当前仍为 Draft。
- 根因分类和 reviewer 名字是操作者的记录，不是自动证实的因果关系或经过认证的身份。seal/hash 检查证据漂移，不提供签名或不可改写存储。
- 默认 `roc-harness` 使用逐场景 gate；离线 `check` 是封存审计，`regressionAcceptance: not_evaluated`、`auditPassRate=1` 只表示审计完成，不代表检索阈值通过，两者都不进入质量实验。
- 已有 [QASPER v3 live full 基线](local/background/qasper-v3-full-20261113T130738Z/RESULT.md)，150/150 scored。早期 aggregate-answer/v2 记录保留在 [VALIDATION.md](VALIDATION.md)。现有 v3 是当时合同的历史完整运行；当前 metricsHash/taskSchemaHash/executionPolicy/permissions/budget 等扩展字段仍需 matched 当前合同的运行，不能补填旧 manifest、改分或重封旧 seal。
- 当前 QASPER 新运行将锁定官方归档/成员与完整确定性文本适配的任务派生校验冻结为 `manifest.qasperQualification`；fixed-contract 与 ablation 都重新读取 `manifest.dataset.path`，核对当前来源合同、保存的 qualification 和所选官方任务。数据目录必须仍可读取；缺失、伪造或未验证的证明返回 `qasper_quality_provenance_unverified`。真实模型、完整 runtime 证据、自报来源或普通 hash seal 都不能替代来源校验。历史缺少现行证明的运行仍可供诊断，不升级其质量资格。
- RAG component 只比较生产检索，要求 production-component（或兼容的 human-reviewed-retrieval）证据和人工审核 provenance；没有生成模型/application checkpoint。E2E 要求 live-model、application 与 RAG 两类独立证据。S01 独立留出集、真实用户任务、MCP 故障服务和语义 judge 需要自己的 Task 与 verifier。
- 当前 Science local recipe 仅能做工程诊断，包括旧 manifest 标为 live-model 的运行。新导入 provenance 为 engineering_fixture，preflight/run evidence 为 engineering-fixture；sourceRevision、操作者提供的哈希、verified 分区或自报官方/人工审核标记均不能赋予质量/采纳资格。合同完整的比较仍为 insufficient / science_quality_provenance_unverified，验收 blocked。官方来源、assets、环境和 grader 的独立审计、审核后的 Task Spec、受验证导入合同及当前 matched runs 尚待建立；旧数据、评分和 seal 保留原样。

## 1. 建立基线并记录观察

先完成 [README](README.md) 的数据、模型和环境准备，明确 Task 范围、请求及预算配置。先 smoke 验证接通，再用 full 建立当前合同的 seed。实际运行默认 concurrency=2，允许 1–8；后续两臂保持相同 executionPolicy。费用 gate 需要冻结适用价格且有真实 usage，unknown 不按零处理。

```sh
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --provider-options evaluation/local/provider-options.json --concurrency 2

# 将输出的目录填入变量；不要直接使用历史 fixture 作为真实质量基线。
ROC_EVAL_BASELINE=/absolute/path/to/baseline-run
pnpm evaluate inspect "$ROC_EVAL_BASELINE"
```

查看 `trials.json` 的 taskId/repeat、分层 failure labels 和 trace pointers，再检查请求响应、工具结果、checkpoint、原始 `output.json`、`final-answer.json`、`runtime-verification.json`、grade、退出与 cleanup。RAG 还要检查排名/context、源版本、capability receipts、宿主关闭后保存的 `reranker-transport-receipts.json` 和 `rag-verification.json`；component 没有 application checkpoint。QASPER 评分取验证后的最终消息，原始聚合文本只供诊断。记录观察与可证伪假设，模型自我解释不能作为独立根因证据。

```sh
mkdir -p evaluation/local
cp evaluation/incident-analysis.example.json evaluation/local/incident-analysis.json
# 编辑 incident-analysis.json，填写实际观察；不要保留示例占位文字。
pnpm evaluate incident "$ROC_EVAL_BASELINE" --task ACTUAL_TASK_ID --repeat 0 --analysis evaluation/local/incident-analysis.json
```

省略 `--task` 和 `--repeat` 可记录整轮观察，包括缺少 trial 的预检故障。两者必须同时提供。incident 保存经过 seal 核验的源运行引用、原始评分观察和人工归因；每次读取都会重新验证源证据。失败、正常成功和随机抽样都可以记录，避免只针对失败集优化。

输出位于 `evaluation/local/incidents/`。它是可追溯的诊断记录，尚不是可复现 Task；新任务仍需定义受控输入、初始状态、独立真值与 verifier。

## 2. 在执行前冻结验收

完成一项有明确假设的候选修改和相关本地检查。复制模板到被 Git 忽略的 local 目录，填写 incident 命令输出的绝对目录、实际变更文件和验收标准。

```sh
cp evaluation/experiment.example.json evaluation/local/experiment.json
# 编辑 experiment.json 后冻结。此命令不调用模型。
pnpm evaluate experiment create "$ROC_EVAL_BASELINE" --spec evaluation/local/experiment.json
ROC_EVAL_EXPERIMENT=/absolute/path/from-experiment-create
pnpm evaluate experiment inspect "$ROC_EVAL_EXPERIMENT"
```

模板中的质量、时延、成本数字都是格式示例，**不是已经校准的产品标准或真实测量**。`experiment.example.json` 为 fixed-contract；既有未带 kind 的 schemaVersion=1 spec 仍合法。消融使用 [ablation.example.json](ablation.example.json) 的 `kind: "ablation"` 与 `ablation` 字段。创建后不能根据分数修改阈值或 primary。

协议冻结：

- 基线目录及 seal、incident 内容哈希、候选源码清单及哈希、实际改动文件。
- `allowedChanges`：仓库相对路径的明确文件列表，仅允许 `src/` 与 `resources/`。未声明变更直接拒绝。空数组可用于无代码改动的 A/A 校准。
- `absoluteFloors`：必须覆盖该套件的全部指标。只有非劣但绝对质量不足时，仍然拒绝采纳。
- `absoluteCeilings` / `metricDirections`：低值更优的指标必须声明 ceiling；RAG wrongSourceRate/staleHitRate 要求每个 trial 实测 0。
- `trialFloors`：指定指标的逐题底线，避免关键失败被均分掩盖。空对象表示没有额外逐题门槛。
- `nonInferiorityMargin`：0 到 0.05，只能维持或收紧；2000 次配对 cluster bootstrap，同时报告原 95% 和全部质量指标的 Bonferroni 调整区间。
- `minimumClusters` / `minimumRepeats`：只能维持或提高至少 5 个 independent clusters、3 次重复的门槛。每个 metric 单独计算 applicable clusters；NA 任务不补样本数。
- `primaryMetrics`：只对事先声明的 primary 判断 superiority，受益 CI 下界必须严格大于 0；多个 primary 必须声明 `multiplicity: "fixed-sequence"` 或 `"bonferroni"`。固定顺序在首个未支持指标处停止；不能从多个探索指标中事后选择“提升”。
- `resourceCeilings`：例如 costUsd、latencyP95Ms、retrievalP95Ms 的固定上限；`maxResourceDegradation` 为相对基线比例，0.1 表示最多增加 10%。baseline 为 0 时增加不能通过比例 gate。ablation 至少需要一个资源 gate。
- manifest 的累计 budget 与冻结 pricing；admission reservation 不是 measured usage。缺少测量或成本未知不能满足相应资源/成本 gate。

冻结比较字段包括 suite/evidence、dataset identity/provenance/review、QASPER 的 `qasperQualification`、selection（任务 ID 与 cluster；RAG 另有 `contentHash=hash({visible,expected})`，其他套件由 dataset identity/inventory 冻结任务字节）、repeats/profile/split、provider/retrievalProvider、permissions、environment/executionPolicy、budget、scorerHash、metrics/metricsHash/taskSchemaHash、toolManifest/实际 toolSchemaHash，以及 grader/metric/task/application/RAG/final-answer/response contracts。同任务、各重复、两臂的 metricApplicability 必须一致；只有显式 `null + not_applicable` 合法，无标记 null/unknown 是 invalid。各 metric 只用 applicable 值和独立 clusters。

源码身份覆盖 src/scripts/resources/evaluation/package/lockfile。`allowedChanges` 仅允许明确列出的 src/resources 文件；评分器、评测代码、依赖和文档变化要求当前合同的新 seed/matched runs，不能把这些文件加入允许列表规避冻结条件。fixed-contract 不允许 tools/schema/retrievalConfig 变化。ablation 也只允许下节声明的精确差异，permissions、模型、评分与答案合同不变。

创建 seed 时工具/schema 证据必须完整。application 套件缺失逐题验证返回 `application_runtime_evidence_missing`；RAG 还需匹配独立 ragContract/ragVerification，verification 必须为 `sqlite-source-ranking-context-transport-v1`。旧 descriptor 即使重新计算 hash 也不能满足新合同；历史证据保留原样。原始 reranker provider receipt/correlation 必须独立绑定 journal budget dispatch/settlement/completion、内容寻址的 scores 产物及最终排名。component 使用独立 host 边界，不要求或声称 checkpoint 验证。RAG 质量验收需要 reviewed provenance：每题两个独立于 producer 的审核人绑定 contentHash，分歧需第三位独立仲裁；agent-reviewed 文档不能满足此条件。

`spec.incidents` 的相对路径以 spec 文件目录为基准，其余命令行路径以当前目录为基准。创建后所有证据引用均保存为绝对路径；移动证据目录会使引用失效。

## 3. 固定合同：执行唯一候选

```sh
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --provider-options evaluation/local/provider-options.json --concurrency 2 --experiment "$ROC_EVAL_EXPERIMENT" --experiment-arm candidate
```

所选模型、profile、数据、请求配置、评分器、环境和工具必须与基线一致。若基线显式选择了模型，候选也应传相同的 `--provider-id` / `--model-id`。模型配置变化会触发合同不匹配。

runner 在打开模型宿主前核对源码及基础条件，通过独占、fsync 的 pre-execution claim 绑定 fresh 运行路径；首个推理请求前核对完整 manifest，实际 tool schema 必须满足协议。manifest 保存 `{path,protocolHash,arm}` binding，结果由原独立 grader 评分并封存。fixed-contract 可省略 arm，默认 candidate；主线集成应显式传入。

每个协议的 candidate 只能 fresh claim 一次。登记后的失败或中止保留该尝试；新尝试需新 experiment。符合安全条件的 unsealed resume 是恢复原 claim，不是重试登记。`experiment inspect` 遇到未封存候选返回 `awaiting-sealed-candidate` 和退出码 2。执行期间不修改源码、合同或协议。

## 4. 消融：协议先于两个 fresh arms

`spec.ablation` 只允许以下差异，可同时声明：

- `retrievalConfig: {baseline: EXACT_CONFIG, candidate: EXACT_CONFIG}`，覆盖精确检索参数。
- `capabilities: {baseline: {toolManifest,toolSchemaHash}, candidate: {toolManifest,toolSchemaHash}}`，覆盖精确 tool/schema 差异；完整 schema 哈希必须是实际 schema 的哈希。

两臂的 retrievalProvider 身份、permissions、tool manifest 外层策略，以及共有工具的 effects/scopes/approvals/reconciliation 等安全元数据仍冻结。工具差异不能改权限或最终答案要求。种子必须预先冻结两臂会使用的相同 retrievalProvider；例如 BM25/hybrid 需要已有 embedding 身份的 seed，不能用 retrievalProvider=null 的纯 BM25 seed 声称匹配 hybrid。运行前确认 seed 与两臂合同，不根据结果补声明。

```sh
cp evaluation/ablation.example.json evaluation/local/ablation.json
# 按审核数据填写精确配置、incidents 和验收标准，然后 create。
pnpm evaluate experiment create "$ROC_EVAL_BASELINE" --spec evaluation/local/ablation.json
ROC_EVAL_ABLATION=/absolute/path/from-ablation-create
# local/baseline-retrieval.json 与 candidate-retrieval.json 必须等于 spec.ablation 对应臂。
pnpm evaluate run --suite rag-retrieval --dataset "$ROC_EVAL_RAG_DATASET" --profile full --concurrency 2 --retrieval-options evaluation/local/baseline-retrieval.json --experiment "$ROC_EVAL_ABLATION" --experiment-arm baseline
pnpm evaluate run --suite rag-retrieval --dataset "$ROC_EVAL_RAG_DATASET" --profile full --concurrency 2 --retrieval-options evaluation/local/candidate-retrieval.json --experiment "$ROC_EVAL_ABLATION" --experiment-arm candidate
pnpm evaluate experiment assess "$ROC_EVAL_ABLATION"
pnpm evaluate compare /absolute/fresh-baseline-run /absolute/fresh-candidate-run --protocol "$ROC_EVAL_ABLATION"
```

协议必须在**任一匹配臂执行前**创建；baseline/candidate 使用同一冻结候选源码，但两个新目录、两个不同 fresh claims。seed 只是合同与 incident 参考，不是被计分的 baseline arm。既有 completed/未登记运行、seed 自身或同一个目录不能成为匹配臂。claim 只能在空目录或仅有初始 run_started journal 的 pre-execution 状态登记；先跑完再加 flag、改 manifest 或补 claim 均不成立。

普通 `compare` 仍严格拒绝不同 tools/schema/retrievalConfig；`--protocol` 路由到已预登记的专属消融比较，只豁免声明中的精确字段。独立证据、样本/NA、数据审核、源边界、预算、绝对质量和资源 gate 均保留。component superior 仅指所选检索任务，不表示 E2E agent 或 release。

## 5. 安全恢复原尝试

```sh
pnpm evaluate run --resume /absolute/unsealed-experiment-arm
```

仅允许[README 安全续跑](README.md#安全续跑)中的 unsealed run。原 manifest.experiment、arm、协议哈希、源码、claimVersion=1 与 claim path 必须一致，runner 使用 `resumeExperiment`，不调用 fresh claim。模型/provider/budget/retrieval/task 参数不能覆盖；显式 suite/profile/concurrency 必须一致。dispatched 工作只能用完整独立 sealed trial evidence 重验/重计分，不重放不确定调用。正常中断已 seal 的 incomplete run 不可继续；恢复不了的尝试保留，下一次新尝试建立新协议。

## 6. 验收与人工决定

```sh
pnpm evaluate experiment assess "$ROC_EVAL_EXPERIMENT"
cp evaluation/review.example.json evaluation/local/review.json
# 检查完整轨迹后编辑 review.json，填写真实评审人、依据和看过的 taskId/repeat。
pnpm evaluate experiment decide "$ROC_EVAL_EXPERIMENT" --review evaluation/local/review.json
pnpm evaluate experiment inspect "$ROC_EVAL_EXPERIMENT"
```

assess 重新加载 seed、协议和已封存的 claimed runs，验证 pre-execution binding，再执行配对比较、全部 absoluteFloors/ceilings、trialFloors、资源退化/上限与 frozen budget。它不接受手填分数或任意 candidate 目录。报告给出逐题/逐重复 diff、两臂的 receipt/verification trace pointers、各 metric applicable n 与 cluster 数，以及未知资源。成本未知不能通过 cost gate。

| 验收状态 | 含义 | assess / compare --protocol 退出码 |
|---|---|---|
| eligible | non-inferior 或 preregistered superior，且全部质量/逐题/资源/预算 gate 通过 | 0 |
| rejected | 退化，或冻结的绝对/逐题/资源/预算 gate 不满足 | 3 |
| blocked | fixture、未认证的 Science local recipe、样本不足、未完成、不兼容或统计结论不确定 | 2 |

带 `--protocol` 的 compare 以 acceptance 决定退出码；即使统计为 non-inferior/superior，冻结绝对/逐题底线或资源/预算 gate 不满足仍返回 rejected=3。未知成本不能通过 cost gate。普通 compare 保留统计退出码：non-inferior/superior=0，incompatible/insufficient/incomplete=2，regression/inconclusive=3。

`non-inferior` 只表示没有超过冻结 margin 的退化，不能宣称 improvement；`superior` 要求全部质量指标非劣且所有预登记 primary 的受益 CI 下界严格大于 0，仍需全部 absolute/resource gates。两者都不等于发布批准。

`adopt` 必须 eligible，且至少记录一条真实存在的候选 trial 的完整轨迹检查。建议优先查看来源失败、所有新退化和代表性成功；小规模 pilot 应逐条检查。工具无法证明操作者实际读过轨迹，记录内容仍需人工负责。`reject` 可记录失败或证据不足的决定。尚未决定时保留 assessment 即可。

决定绑定重新计算的 assessment hash、协议、两份 run seal 和基线源码作为回退参考；写入后不能覆盖。`decide` 退出 0 仅表示决定已记录，具体结论看 `review.decision`。它不修改应用配置、不接通生产 HarnessReleaseStore，也不执行部署。

通过且人工认可的能力任务可进入下一版回归集；新生产案例进入下一版开发集。数据集/评分器更新需要新基线。公开数据的本地 holdout 仍不能证明模型未见过题目。

## 本地验证

```sh
node --test --test-name-pattern='pure:' evaluation/tests/experiment.test.mjs evaluation/tests/comparison-protocol.test.mjs
node --test evaluation/tests/comparison-eligibility.test.mjs
node --test evaluation/tests/experiment.test.mjs evaluation/tests/comparison-protocol.test.mjs
```

并行源码编辑期间可执行前两条：pure tests 和离线 Science/CLI 资格反例；后者使用测试专属 stdlib Python 沙箱校准及 CLI，不调用 worker/model/sourceIdentity。第三条包含 source identity、真实 CLI/worker 和固定模型响应集成，应在源冻结后运行。反例覆盖 posthoc/重复 claims、resume binding、精确消融差异、tool/schema/runtime 证据、不同 applicability、不足 applicable clusters、multiplicity、未知成本、绝对/逐题底线、fixture/incomplete 不采纳及 trace pointers；新增资格反例还覆盖合成 Science、自报官方/审核标记及统计通过但 acceptance rejected 的退出码。合成 sealed records 是协议反例，不是人工审核数据或质量测量。命令列在这里不表示本次全部运行。

日志、精确执行命令和证据路径见 [VALIDATION.md](VALIDATION.md)。

## Runner 与比较 API

`createExperiment({baselinePath,spec,specDirectory?,outputRoot?})` 返回 directory/protocolHash/kind/requiredArms。`claimExperiment(path,runPath,manifest,{arm})` 在执行前创建独占持久化 claim；`resumeExperiment(path,runPath,manifest,{arm})` 复用已存在的 claim 并返回 resumed=true。两者返回 context.binding、arm 和 expected 合同，runner 将 binding 写入 manifest.experiment。

`assertExperimentManifest(context,manifest)` 检查完整冻结 manifest；`assertExperimentToolSchema(context,toolSchemaHash)` 检查实际 schema；`assertExperimentUnchanged(context)` 重载并核对协议与已有 claim 的内容哈希，源码身份由 runner 另行复核。`compareRuns(baseline,candidate,{margin,protocol?})` 接受 `inspectRun` 返回的已封存 run 对象，protocol 可引用 experiment 目录；ablation 路由到 `compareAblation`。缺省普通比较仍严格，不能用 API 参数免除独立证据或 pre-execution claim。
