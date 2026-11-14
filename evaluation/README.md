# Roc agent harness 评测

**状态：Draft / agent-reviewed；精确 Task Specs 与验收阈值尚未获得用户批准。** 下文说明当前接口和证据边界，不代表新增质量基线、人工数据审核或发布批准。

默认套件 `roc-harness` 评测当前 Roc 的真实运行编排、checkpoint 恢复、工具副作用、审批、取消、并发编辑、权限和循环控制。模型响应由本地控制器提供，经过真实 LangChain 模型适配器；不需要配置模型或凭据，不发送推理请求。评分以持久化状态、文件字节和完整事件证据为准。

统一入口是 `pnpm evaluate`；`pnpm harness:bench` 保留为同一 CLI 的兼容别名。所有评测由手动命令触发，使用隔离工作区和数据库，不启动 Roc 界面或生产数据库。[Registry](lib/registry.json) 分为 runtime、rag、agent、research 四条轨道，套件可运行与质量证据充分是不同条件。QASPER、生产 RAG、harness 和 Science 的精确边界见各自 Task Spec；历史结果保留在 [VALIDATION.md](VALIDATION.md) 与 [QASPER v3 full 记录](local/background/qasper-v3-full-20261113T130738Z/RESULT.md)。

在仓库根目录执行，使用已安装的 pnpm 依赖和 macOS `sandbox-exec`：

```sh
pnpm evaluate run                              # 默认 fast：10 个案例
pnpm evaluate run --profile full               # 10 个案例各重复 3 次
pnpm evaluate run --task tool-result-replay      # 单独诊断一个案例
pnpm evaluate inspect /absolute/run-directory
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
  adapters/     native、S01、冻结检索与生产 RAG
  graders/      独立答案、排名和源证据评分
  analysis/     各任务族的故障诊断
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

生成目录均被 Git 忽略。新运行、每题和每次重复使用独立目录和数据库；harness 恢复案例在自己的目录中重启。只有符合[安全续跑条件](#安全续跑)的未封存运行可继续，历史 sealed run 不续写。`src/` 中的真实 AgentPluginRuntime、DeepAgent executor、文件工具和执行授权被复用；评测任务、隐藏真值与评分器在 worker 之外。S01 接入统一审计入口，旧 `.artifacts/harness-bench/` 证据保留。

公共质量套件的模型宿主只读 Roc 的 `config/settings.json` 和加密凭据。默认根目录是 `ROC_DATA_ROOT` 或 `~/.roc`，可传 `--roc-root`。不初始化配置迁移，不轮转或回写凭据，Electron 的 userData/sessionData/logs/crashDumps 全部指向评测临时目录。明文凭据只在可信模型宿主内存中使用；worker 不接触密钥、模型端点或隐藏答案。

## 当前覆盖

| 轨道 | 套件 | 当前能力与证据边界 |
|---|---|---|
| runtime | roc-harness（默认） | 10 个真实运行案例、7 个维度；控制模型下的运行行为 |
| runtime | roc-native | 94 项确定性服务合同检查，含合成 pilot；补充回归 |
| rag | frozen-retrieval | 冻结向量/排名离线审计；没有生产 agent 或模型质量结论 |
| rag | rag-retrieval | 真实生产索引、BM25、embedding、RRF 与 reranking；host-only component，无生成模型/checkpoint |
| rag | rag-paper-qa | 真实 Roc agent + 生产 research tools；独立检索、context 与最终答案证据 |
| rag | qasper | 官方 v0.3 dev 文本适配、真实文本工具、答案/证据 F1；非官方全量榜单 |
| agent | roc-s01 | Task 合同与数据准备度审计；真实质量数据集尚未建立 |
| research | scienceagentbench | 本地 recipe 导入、本机 Python、真实执行授权、独立 grader 与五类校准；工程诊断，官方来源与任务环境尚未认证 |

[Harness](tasks/roc-harness/Task.md)、[QASPER](tasks/qasper/Task.md)、[RAG component](tasks/rag-retrieval/Task.md)、[RAG E2E](tasks/rag-paper-qa/Task.md)、[Science](tasks/scienceagentbench/Task.md)、[native](tasks/roc-native/Task.md) 的精确任务定义均为 Draft，不能视为已经批准的发布门槛。沿用项目原生 runner，未引入 Harbor。

## 离线合同审计

```sh
pnpm evaluate check --suite frozen-retrieval --corpus evaluation/local/frozen-corpus.json
pnpm evaluate check --suite roc-s01
pnpm evaluate check --suite roc-s01 --dataset /absolute/manifest.json --dataset-sha256 ACTUAL_SHA256
```

`check` 不运行 agent/model，模型及外部调用均为 0；它封存标准 manifest、run-plan、budget 状态、journal、`audit.json`、grade、summary/report 和 seal。证据是 `engineering-fixture`，结论是 `engineering-audit-only`。`regressionAcceptance: not_evaluated` 表示尚未执行检索质量阈值验收；`auditPassRate=1` 只表示审计完成，不能当作 recall/nDCG 门槛通过。S01 外部 manifest 必须显式提供 SHA-256，默认使用仓库 fixture 的已知哈希。

`check` 只接受这两个审计套件，拒绝 profile、fixture、resume、provider/budget/retrieval options、experiment、task 和 concurrency 等运行参数。`pnpm evaluation:frozen-retrieval:check` / `pnpm evaluation:s01:check` 保留为直接适配器审计；需统一封存时使用 `pnpm evaluate check`。

## 公共质量套件

以下命令用于公共任务表现评测。`doctor` 无推理请求；不带 `--fixture` 的公共套件会使用 Roc 已配置模型。

```sh
pnpm evaluate list
pnpm evaluate doctor
pnpm evaluate run --suite roc-native
pnpm evaluate prepare qasper
```

`doctor` 只检查所选模型配置与凭据可用性，不发送推理请求。它使用 Roc 的默认模型；可用 `--provider-id ID --model-id ID` 选择已配置且启用的模型。两个参数必须一起传。不会在失败时自动切换模型。

模型宿主在 `app.whenReady()` 前按项目 `package.json` 的 `productName` / `name` 设置应用名，复用应用的 macOS safeStorage 钥匙串身份。当前身份是小写 `roc`，与应用显示名 `Roc` 不同；直接启动独立脚本会继承 `Electron`，导致已有凭据无法解密。`doctor` 和 `run` 均支持 `--app-name NAME` 显式覆盖，不自动尝试其他名称。就绪后的报告记录 `applicationName`，配置、凭据和应用数据目录仍保持只读。

`prepare qasper` 下载锁定归档并校验归档及成员 SHA-256；可用 `--archive /path/qasper-train-dev-v0.3.tgz` 导入本地副本。把输出的实际目录作为后续 `--dataset` 参数：

QASPER 每次新运行在 `manifest.qasperQualification` 冻结官方来源与任务派生校验：锁定归档、实际归档成员及完整确定性文本适配的任务字节必须一致。质量比较重新读取 `manifest.dataset.path`，核对当前来源合同、保存的 qualification 和所选官方任务，因此需要保留该数据目录；缺失、伪造或未验证的证明返回 `qasper_quality_provenance_unverified`。自行封存的数据、合成来源或自报官方标记不能获得质量资格。真实配置模型可以用于本地合成数据的工程验证，完整运行与来源资格分别记录。缺少现行来源证明的历史运行保留原评分与 seal，不补填或升级。

```sh
ROC_EVAL_DATASET=evaluation/datasets/qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0
# 无模型请求：验证真实文件工具、评分与归档
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile fast --fixture
# 使用 Roc 默认模型：先小规模试跑
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile smoke --provider-options evaluation/provider-options.example.json
```

模型配置或钥匙串失败会封存 incomplete 报告，未完成题目保留在分母中。11 月 13 日已建立 `qasper-roc-runtime-v3` 的 [live full 记录](local/background/qasper-v3-full-20261113T130738Z/RESULT.md)：50 题 × 3，150/150 scored，answerF1 约 0.2532、evidenceF1 约 0.5040、citationValidity 1；成本未计算。这是当时合同下的完整基线，不能据此宣称质量改善。早期聚合文本/v2 记录仍见 [VALIDATION.md](VALIDATION.md)。各历史运行保留原分数和 seal；当前增加的 metrics/task schema、execution policy、permissions 和预算冻结字段要求重新运行 matched 当前合同的比较臂，不能给旧记录补字段升级。

### QASPER 的实际 Roc 流程

`run --suite qasper` 把冻结的论文与问题送入独立 worker，创建真实 `AgentPluginRuntime`、`DeepAgent` graph、会话、SQLite checkpointer、用量账本和生产文件工具。worker 的模型请求经宿主桥接到 Roc 的 `LangChainModelFactory` 与所选已配置模型；官方答案和证据标注只留在宿主评分器。每题只开放 `ls` / `read_file`，可以分页读取完整论文。

adapter 从公开 `paper.json` 的段落 ID 生成显式 [responseContract](../docs/agent-response-contract.md)，冻结答案/证据字段、类型、ID 枚举与唯一性。生产模型循环检查完整终轮文本，首次失败最多追加一次错误反馈；纠正计数随 checkpoint 恢复，超过一次保留失败原文。该反馈继续使用相同工具集合和模型调用链，不新增 schema 工具。答案范围和证据支持仍由模型判断，JSON 校验不能证明语义正确。

生产完成事件会聚合多个工具轮次的助手文本。评测保留该原始文本在 `output.json`，由宿主侧[独立 verifier](lib/application-verifier.mjs)读取最后一个 root checkpoint 的无工具助手消息，并与最后一次模型响应逐字核对；验证通过后才写入 `final-answer.json` 供 QASPER 评分。最终消息仍必须是严格 JSON；Markdown 围栏、额外叙述、无效引用和错误答案按原评分规则处理。

`runtime-verification.json` 核对完成的 run/thread、冻结问题/响应合同/模型/限制/manifest、顺序请求响应、实际工具 schema、持久化事件、会话聚合输出、用量回执、工具参数、论文原始字节、进程退出与清理。缺失或损坏证据使 trial invalid、run incomplete。provider 未提供 usage 时保留 unknown 用量，不能假定为零。纠正耗尽后 run 可为 completed、生产响应验收为 failed；独立运行证据通过后仍按原生错误回答评分。

当前 adapter 为 `qasper-roc-runtime-v3`，application contract schemaVersion 为 2；manifest 冻结最终答案边界与响应要求，逐题 grade 绑定 runtime evidence 和最终答案哈希。框架提示按能力清单装配，已知文件可直接读，未授权的 todo/记忆写入指导不再追加；原始记忆内容保留。响应合同和工具描述与 v2 不兼容，历史结果保留。原生 QASPER grader 保持原样，现有 v3 full 不取代当前合同 matched comparison。这证明所测答案经过 Roc 文本工具流程；PDF、检索、界面交互和子代理需要单独任务环境。

## 生产 RAG

```sh
pnpm evaluate prepare rag-retrieval --fixture
pnpm evaluate prepare rag-paper-qa --fixture
pnpm evaluate prepare rag-retrieval --corpus evaluation/local/reviewed-corpus.json
pnpm evaluate prepare rag-paper-qa --corpus evaluation/local/reviewed-corpus.json
pnpm evaluate run --suite rag-retrieval --dataset /absolute/component-dataset --profile full --retrieval-options evaluation/local/retrieval-options.json
pnpm evaluate run --suite rag-paper-qa --dataset /absolute/e2e-dataset --profile smoke --retrieval-options evaluation/local/retrieval-options.json --provider-options evaluation/provider-options.example.json
```

两套件分别 prepare，使用输出的实际 dataset 路径。`--fixture` 运行只允许 BM25、无 reranker 的配置。下面是 retrieval-options 的合法 BM25 示例；hybrid/semantic 使用 Roc 已启用的 embedding/reranker 配置，可能产生真实模型调用：

```json
{"mode":"bm25","rerank":"none","candidateLimit":50,"topK":20,"contextMaxChars":6000}
```

`rag-retrieval` 在独立 host SQLite 中调用真实 `ResearchKnowledgeRepository` / `ResearchEmbeddingService`，不运行生成模型或 application checkpoint。正常证据为 `production-component`；BM25 无生成/embedding 调用，hybrid/semantic 的调用进入共享宿主预算。独立 component verifier 绑定冻结 request、capability schema、SQLite 源版本、排名产物及 receipts。它使用 `host-component-request-bound-to-capability-receipt-v1` 边界，不能声称验证了 E2E agent。

`rag-paper-qa` 用真实 agent 的 `research_search_knowledge` / `research_read_knowledge_context` 狭窄 stdio capability。独立 verifier 将 checkpoint ToolMessages 与 wire 内容绑定到 host 排名/context 产物及数据库快照，并复用 application verifier 验证最终答案。其边界是 `checkpoint-tool-message-bound-to-host-capability-receipt-v1`，正式比较要求 `live-model`。两套件的 `ragContract.version=1`，verification 为 `sqlite-source-ranking-context-transport-v1`，hash 绑定 runtime、源映射、tool boundary 与独立验证描述。旧 `sqlite-source-ranking-context-v1` 即使重新计算 hash 也不满足当前比较合同；component 使用独立 component contract。

并发 RAG capability 回执按显式 operation ID（若提供）及生产 request schema 归一化后的 proposal 参数绑定；没有 operation context 的同名只读调用可反序执行，不能仅按名称或顺序关联。

宿主关闭后将 `runtime.transportReceipts` 快照保存到 `reranker-transport-receipts.json`，包含取消后收到的迟到回执。独立 verifier 重建 query/documents 的请求哈希，把原始 provider receipt/correlation 与 `events.jsonl` 的 `budget_dispatched`、settlement 和 `retrieval_model_completed` 绑定，再核对 `rag-artifacts/<responseHash>.json` 中按 JSON 内容哈希保存的 scores/receipt/correlation 与最终排名。成功重排必须按实测分数降序，同分按 RRF 分数排序；最终 hits 和 outputRank 从候选及已持久化的论文多样性信息独立重建。无 reranker 时保留空 receipts 数组。receipt 的状态或 elapsedMs 不提供缺失的 token/cost 测量。

输入是 `text-native` 的冻结文档、源版本、SHA-256、parser version 与 UTF-16 evidence locators，包含单篇、证据链、不可回答、跨篇与旧版本冲突任务。关联源和多篇问题先组成独立 source cluster，同一源的旧版本和相关问题不跨 development/holdout。它不评测 PDF 解析质量或任意外部检索。

| 套件 | 质量指标 |
|---|---|
| rag-retrieval | recall20、ndcg10、evidenceChainRecall20、wrongSourceRate、staleHitRate |
| rag-paper-qa | answerF1、evidenceF1、citationValidity、retrievalRecall20、evidenceChainRecall20、contextCoverage、evidenceReadCoverage、abstentionAccuracy、wrongSourceRate、staleHitRate |

`wrongSourceRate` / `staleHitRate` 从实际 search hits、project scope 和 state/candidate indexedVersion 计算；RAG 质量比较要求每个 trial 两项均实测为 0。无 gold 的不可回答任务，component 的 recall20/ndcg10/evidenceChainRecall20，以及 E2E 的 retrievalRecall20/evidenceChainRecall20/contextCoverage 合法为 `null`，同时必须标记 `metricApplicability[metric]="not_applicable"`。没有标记的 null/unknown 是 invalid；不得填成 0 或 1。RAG evidenceF1 按源区间与实际提供的 chunk 计算，独立于官方 QASPER evidence score。

质量比较还要求 `datasetProvenance.kind="human_reviewed"`、review.draft=0 与 `datasetReview.status="reviewed"`。每题至少两位独立于 producer 的不同审核人，分别绑定 `hash({visible,expected})`；judgmentHash 不同需第三位独立仲裁人。只有写入并核验这些证明的人工审核数据能满足该门槛。这里的 Draft / agent-reviewed 文档和合成 fixture 均不构成人审。合成十题 × 三次重复只能验证工程流程，不能证明质量、holdout 或采纳。

## 每次更新的流程

Harness 改动先跑 `fast`，完成后跑 `full` 并 `inspect`；检查逐案例失败条件、原始状态和完整恢复轨迹。故障假设应对应具体边界，补充案例需更新 Task Spec 和独立 verifier。控制模型报告不产生统计模型质量结论。

针对任务表现的明确失败假设，使用[实验闭环](EXPERIMENTS.md)：从 sealed run 记录 incident，运行前冻结源码和验收阈值；固定合同登记唯一候选，消融协议在任一臂执行前登记协议、再分别 claim 两个 fresh arms。`experiment assess` 同时检查非劣、绝对/逐题底线、资源退化和预算/成本上限；unknown 资源不能满足对应 gate。fixture、未完成或证据不足不能被采纳。所有决定位于本地，不自动发布。

研发质量验收只接受按对应任务合同核验的官方来源，或具有独立人工审核证明的数据，并要求匹配的独立运行证据；任意 sourceRevision、操作者提供的哈希、自报审核、offline audit 完成或统计非劣都不能替代来源资格。当前 Science local recipe 不满足该资格，仍可用于工程诊断。

公共套件的 run/compare 入口用于首次基线、一般诊断与 release 留出集复核：

1. 更新前手动跑 native 和所需公共套件，保存输出目录作为 baseline。
2. 更新后用相同数据、模型配置、请求配置、环境、profile 再跑，得到 candidate。
3. 分别 `inspect`，再 `compare`；查看总体差值、失败题和完整轨迹。
4. 人工决定是否接受更新。没有 push、PR、定时或应用启动触发器。

```sh
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --provider-options evaluation/local/provider-options.json
pnpm evaluate inspect /absolute/baseline-run
pnpm evaluate inspect /absolute/candidate-run
pnpm evaluate compare /absolute/baseline-run /absolute/candidate-run
```

`provider-options.json` 可按任务所需的输入大小和超时配置。

| 公共套件 profile | 分区与题数 | 重复 | 用途 |
|---|---|---|---|
| smoke | development 1 题 | 1 | 模型接通与小额试跑 |
| fast | development 最多 5 题 | 1 | 快速诊断 |
| full | development 最多 50 题 | 3 | 版本比较 |
| release | 支持的 holdout 全部题 | 3 | 手动阶段复核 |

QASPER/Science 按 paper/repo 分组后固定 hash 划分 development/holdout；RAG 使用输入指定分区并验证 source-connected clusters 不跨分区。QASPER 共 281 篇论文、1005 题；233 题包含不能映射到文本段落的证据，明确排除，支持的 development 611 / holdout 161。报告记录全部未选和排除原因。公开数据的本地 holdout 不意味着模型未见过这些数据。

普通比较冻结数据 identity/inventory、QASPER 的 `qasperQualification`、selection（任务 ID 与 cluster；RAG 另含每题 contentHash）、repeats、profile/split、模型和 retrievalProvider、环境、executionPolicy、permissions、budget、scorerHash、metricsHash、taskSchemaHash、完整 capability manifest、实际 schema，以及 application/RAG/final-answer/response contracts。源码和 worker bundle 可变，冻结合同仍必须一致。`metricsHash` 绑定 metrics、显式 NA 规则和 scorerHash。不同 tools/schema/检索配置的普通比较仍是 `incompatible`；只有预登记 `spec.kind="ablation"`、`spec.ablation` 中精确声明的两个 fresh arms 可通过专属协议比较。后补 permissive flag 或旧运行不能成为已登记消融证据。

缺失工具证据返回 `insufficient/tool_contract_evidence_missing`。QASPER/Science/RAG E2E 要求每个 trial 的 application runtime evidence；QASPER 另需官方来源与适配任务的一致性资格，RAG 另需独立 ragVerification 和已审核 provenance；component 只检查其独立 component contract。旧 applicationContract 版本不放宽。缺失/损坏证据、fixture、控制模型、来源未验证的 QASPER、合成或未审核 RAG 不能得出质量通过结论。

比较对每个指标单独检查至少 5 个有 applicable 值的独立 cluster、每题至少 3 次重复，使用 2000 次配对 cluster bootstrap。任务内、重复间、两臂的 applicability 必须一致；NA 不参与该指标的样本门槛。报告同时列原 95% CI 和全部质量指标的 Bonferroni 调整区间。非劣 margin 默认 0.05，协议只能保持或收紧，不能放宽；所有指标受益区间下界至少为 -margin 才是 `non-inferior`。只有预登记 primary metric 的受益 CI 下界严格大于 0，且全部质量指标非劣，才能判 `superior`；多个 primary 必须事先指定固定顺序或 Bonferroni 校正。没有 primary 的普通比较不宣称 superiority。`non-inferior` 不等于质量改善或发布，统计设置尚需功效校准。绝对质量和资源门槛见 experiment assessment。

## 模型与请求配置

实际请求通过 Roc 的 `LangChainModelFactory` 构造，复用已配置的模型、采样、推理参数及请求头，并请求最多 4096 输出 tokens；更低的模型配置上限仍生效。worker 的兼容协议字段不覆盖实际工厂配置。manifest 记录 provider/model ID、配置摘要和实际输出/上下文限制，不保存端点、请求头或密钥明文。

[请求配置示例](provider-options.example.json) 配置输入大小、超时和累计 budget。默认单请求输入最多 256 KiB、单请求 120 秒、单题 300 秒；输出上限由生产模型工厂限制。任务默认 concurrency=2，可显式传 `--concurrency 1` 至 `8`，每个 slot 仍使用独立 trial 状态。模型 alias 漂移无法靠配置哈希完全检测。

`--budget-options FILE` 读取原始 budget 对象，在冻结 manifest 前与 provider-options.budget 合并。可配置 `maxModelRequests`、`maxInputTokens`、`maxOutputTokens`、`maxEstimatedCostUsd`、`maxTaskDurationMs` 和 `maxRunDurationMs`。例如先在 local 文件中保存如下工程预算，再传入 run；这些数字只是示例：

```json
{"maxModelRequests":1000,"maxInputTokens":10000000,"maxOutputTokens":1000000,"maxTaskDurationMs":300000,"maxRunDurationMs":3600000}
```

```sh
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --concurrency 2 --budget-options evaluation/local/budget-options.json --provider-options evaluation/local/provider-options.json
```

费用限制需要冻结真实适用的 `pricing`：schemaVersion=1、version、currency="USD"，rates 中每项为 providerId/model/inputUsdPerMillionTokens/outputUsdPerMillionTokens。没有价格或 provider usage 时成本保持 null/unknown，不推测价目。chat、embedding、rerank 共用可信宿主 budget；准入预留与已测量 usage 分开记录。dispatch 前持久化预留和事件，无自动重试。模型用量未知时不能宣称满足 token/cost gate；完整运行也可能有未知资源。

## 安全续跑

```sh
pnpm evaluate run --resume /absolute/unsealed-run
```

只接受普通目录、没有 seal、没有 finalized trials/summary/report 和 run_finished 的运行。manifest/source、冻结 plan、连续 journal 前缀、budget ledger、原 owner 已退出等必须核验。已 dispatch 的工作只能从完整独立证据验证/重新计分；不确定 dispatch 或不完整证据不得重新调用模型/工具。未 dispatch 的 staging 也只有在持久化状态证明后才可丢弃重建。

resume 不接受 fixture、provider-options、budget-options、retrieval-options 或 task 覆盖；显式 suite/profile/concurrency 必须与原运行一致。experiment 从持久化 binding 恢复原 path/arm，复用原 claim，不能重新登记 fresh attempt。正常 SIGINT/SIGTERM 会清理并封存 incomplete，不能续跑；SIGKILL 可能留下符合条件的未封存目录。sealed incomplete 也不能续写，需新运行/新协议。

## Science 本机环境

准备官方 verified 元数据、原始 `benchmark_verified.zip`、对应上游 revision 和文件 SHA-256。参考 [ScienceAgentBench](https://github.com/OSU-NLP-Group/ScienceAgentBench)；ZIP 密码为 `scienceagentbench`。逐题记录许可（部分任务有上游例外），不分发解压数据。此入口导入已准备的数据与 grader，不会自动改写所有上游环境或评分器。

先创建评测专用 Python 环境：

```sh
pnpm evaluate environment science --python python3 --requirements evaluation/local/requirements.lock.txt
pnpm evaluate environment verifier --python python3 --requirements evaluation/local/verifier-requirements.lock.txt
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
pnpm evaluate prepare scienceagentbench --metadata evaluation/local/verified.json --recipe evaluation/local/recipe.json --bundle evaluation/local/benchmark_verified.zip
pnpm evaluate run --suite scienceagentbench --dataset /path/from-prepare --profile smoke
```

模型使用真实 `write_file`/`edit_file`/`run_shell_command`，命令限定为 `python solution.py`，必须消费生产 ExecutionGrant。文件工具使用 `/workspace` 虚拟路径，Python 使用实际 workspace 为 cwd，所以脚本中用相对路径。Python 进程禁止网络和子进程，仅能读取依赖与本题输入、写本题目录。执行继承 grant 限制，最多 120 秒和 1 MiB 输出；另设 CPU 时间、64 MiB 单文件大小、128 文件描述符限制。

独立 grader 在另一 scratch 目录运行 `python grade.py OUTPUT_DIR TRUTH_DIR`，最多 120 秒；仅挂入冻结的 verifier、隐藏真值和 allowlist 产物，不包含 agent workspace/source。stdout 输出 `{"success":true|false,"evidence":"非空判定依据"}`。grader 必须按数据解析产物，不能导入或执行 agent 代码。缺产物或科学结果错误记 0；grader 崩溃/协议损坏判 invalid。需要网络、子进程、超出本机限制或付费 judge 的上游任务需排除或另行设计。

导入记录原始文件哈希、revision、license 和全部 omitted IDs，但操作者提供的哈希只验证本地字节完整性，不能认证上游来源或 prepared assets 与 bundle 的对应关系。`prepareScience` 的新数据清单记录 `provenance.kind="engineering_fixture"`，runner 将其保留为 `manifest.datasetProvenance`；preflight 的 `evidenceKind` 和新 run 的 `evidence` 均为 `engineering-fixture`。仍可使用配置中的真实模型执行、独立计分并检查工程诊断；`split="verified"`、任意 `sourceRevision`、哈希或自报审核不能赋予官方/质量资格。每次计分再取均值，不能当成上游 best-of-three 分数。

当前和旧版 Science local recipe 都不能提供可采纳质量证据，即使旧 manifest 标为 `live-model`。合同与证据完整时，比较保留逐题差值、资源和轨迹，返回 `insufficient` / `science_quality_provenance_unverified`；登记实验的验收为 blocked。五个 cluster、三次重复或 release profile 不能改变这个边界。官方源、assets、环境和 grader 的独立审计以及审核后的 Task Spec、受验证导入合同和当前合同 matched runs 仍待建立；手工改标记不能激活资格。新 provenance 会生成新的 dataset identity，不回写旧数据、run、report 或 seal。

## 报告与故障定位

每轮有 `manifest.json`（源码/数据/选择/模型/环境）、`run-plan.json`、`budget-state.json`、`events.jsonl`（带 sequence 的 durable 请求/任务事件）、逐题 lifecycle/grade、`trials.json`、`summary.json`、`report.md` 和 `seal.json`。Harness 每题保留阶段请求响应、审批决策、工具事件、崩溃前/最终 SQLite、文件字节、逐条件 grade、进程退出与清理记录。请求正文保留实际工具 schema。

QASPER、Science 与 RAG E2E 另保留 `tool-schema.json`（实际工具定义及哈希）、`transcript.jsonl`、带请求/响应哈希的 `responses.jsonl`、SQLite checkpoint、`output.json`（原始聚合文本）、`runtime-verification.json` 和 `final-answer.json`（验证后的最终消息）。Science 也通过该 runtime verifier，科学正确性仍由独立 grader 读取数据产物决定。模型请求在运行时按当前 scope 的 manifest 过滤；宿主在转发前再次检查固定工具集合、重复项与 schema 结构，并拒绝 trial 内 schema 漂移。runner 拒绝不同 trial 之间的 schema 漂移；已发出请求的 agent 失败也保留 schema 哈希。native 原始普通文件归档；隔离测试故意产生的符号链接仅记录路径/目标，不跟随目标。

RAG component 保存 component schema/result/cleanup、源索引、ranking artifacts、capability receipts、`reranker-transport-receipts.json` 和 `rag-verification.json`，没有 application checkpoint/final-answer。E2E 同时保留 application 与 RAG 独立证据。报告接受 `trial.tracePointers`、`trial.artifacts` 或 runner 的 `trial.traces.artifacts`，保留 `{artifact,sha256}` 以追踪 receipt/verifier 产物；比较列出逐题/逐重复两臂差值和 trace 引用。

summary/report 给出分层 diagnostics、failure labels、first abnormal stage 与 trial drilldown；RAG 可区分 ingestion、retrieval、context、answer/citation/abstention 等阶段。标签用于定位，不能代替人工根因审核。每项 metric 的均值仅汇总 applicable 值，并报告 n/notApplicable；未知指标不能伪装成合法 NA。

资源汇总列出 requests、input/output tokens、已知 subtotal 与未知数量、每 trial 的 P50/P95，以及记录到的端到端/检索时延。检索 P50/P95 汇总各 trial 的 `retrievalLatenciesMs` 实际请求样本；缺失、null 或空样本不能满足检索时延 gate，历史单次测量仍可读取。费用只由冻结价格和真实 usage 计算；complete host 总量不能补出缺失的 trial 分位数。`costPerSuccessfulTaskUsd` 实际分母是明确成功的 trial/repeat 数，只有完整总成本、全部 success 状态已知且成功数大于 0 才给值。unknown cost 不能满足成本 gate；未测 CPU、内存和能耗不出测量结论。

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

退出码：Harness 的 `run/inspect` 返回 0 表示所选范围完整且全部通过，3 表示完整但有 harness 条件失败，2 表示 incomplete 或参数错误。任务表现套件的 `run=0` 只表示评测完整。普通 `compare` 的 0 表示 non-inferior/superior，2 表示 incompatible/insufficient/incomplete，3 表示 regression/inconclusive。`compare --protocol` 与 `experiment assess` 按冻结验收返回 eligible=0、blocked=2、rejected=3；统计非劣但绝对/逐题底线或资源/预算 gate 失败仍退出 3，成本未知不能满足 cost gate。`decide=0` 仅表示人工决定已记录。不能单凭 run、check、非劣结论或开发验收退出码证明质量改善或发布批准。

## 产物保留与清理

保留可复核的近期真实质量基线、重要中断证据和当前 harness/native 验证。重复 fixture、已解决的零请求预检失败、合成测试缓存和无消费者的测试 venv 可清理；正式 Science 环境与外部导入数据需先核对消费者。删除 run 时一起检查关联 comparison、incident 和 experiment，不留下指向已删目录的记录。

11 月 13 日按审计清单删除了 251 个生成目录，释放约 2.67 GiB；[清单](local/cleanup/2026-11-13/manifest.json)与[执行结果](local/cleanup/2026-11-13/result.json)记录路径、理由、大小和保留证据哈希。没有修改已保留 run 的内容或 seal。S01 与 `evaluation/` 之外的旧证据不在本次清理范围。

测试使用各自拥有的输出根目录，在失败时也运行清理 hook，回收 run、incident、experiment、Science 缓存和 venv。模型宿主在确认进程退出后删除临时状态。`--output-root PATH` 可为 run、compare、incident 和 experiment 指定独立输出父目录。`.runtime/` 是可重建状态，清理前必须确认没有评测进程。

## 验证

```sh
node --test --test-name-pattern='pure:' evaluation/tests/experiment.test.mjs evaluation/tests/comparison-protocol.test.mjs
node --test evaluation/tests/comparison-eligibility.test.mjs
pnpm evaluation:check
node --test tests/unit/database-schema.test.mjs tests/unit/tool-effect-store.test.mjs tests/unit/execution-grant-broker.test.mjs
pnpm typecheck
```

这些命令用于本地验证，不需付费模型。并行源码编辑期间可跑前两条：pure 协议检查，以及不调用 model/worker/sourceIdentity 的离线 Science 资格与 CLI 退出码反例；后者仅使用测试专属 stdlib Python 环境和本地沙箱校准。worker/model/source-identity 集成与全量检查应在源冻结后执行。列出命令不表示本次已执行；精确历史结果与剩余限制见 [VALIDATION.md](VALIDATION.md) 和各次验收记录。
