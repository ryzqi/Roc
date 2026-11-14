# 从失败证据到候选采纳

**Draft / agent-reviewed**。本地手动流程为 `run → inspect → incident → experiment → assess → decide`，复用真实 runtime、独立评分、预算和证据封存。运行准备、数据资格、普通比较和恢复条件统一见 [README](README.md)；精确任务与门槛仍待用户批准。

fixed-contract 使用已完成的 development seed 作基线，只登记一个 fresh candidate；ablation 在任一臂执行前冻结协议，再登记两个 fresh baseline/candidate，seed 仅作合同参考。holdout 不转为优化 incident/seed。fixture、控制模型、未审核 RAG、来源未认证的 QASPER/Science 可演练工程流程，不能成为可采纳质量证据。

旧运行与关联记录已于 2026-11-14 清理，历史摘要见 [VALIDATION](VALIDATION.md)；新实验需当前合同的 matched runs。eligible 表示满足冻结的开发验收，不等于独立 holdout 或发布批准。根因、reviewer 与已读轨迹由操作者负责，hash 不认证身份或因果关系。

## 1. 基线与观察

先 smoke 验证接通，再 full 建立当前合同的 seed。模型、预算、数据和 concurrency 后续保持匹配。

```sh
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --provider-options evaluation/provider-options.example.json --concurrency 2
ROC_EVAL_BASELINE=/absolute/path/from-run
pnpm evaluate inspect "$ROC_EVAL_BASELINE"
mkdir -p evaluation/local
cp evaluation/incident-analysis.example.json evaluation/local/incident-analysis.json
# 填写真实观察、依据与可证伪假设。
pnpm evaluate incident "$ROC_EVAL_BASELINE" --task ACTUAL_TASK_ID --repeat 0 --analysis evaluation/local/incident-analysis.json
```

查看 trials 的 taskId/repeat、failure labels 和 trace pointers，再核对请求、工具、checkpoint、最终答案、独立 verification、grade 与 cleanup；RAG 另看源版本、排名/context 和 receipts。模型自我解释不能作为独立根因证据。

`--task` / `--repeat` 同时提供，或均省略以记录整轮（含预检故障）。incident 位于 `evaluation/local/incidents/`，绑定原 run seal 与观察，每次读取重验。成功与抽样也可记录；incident 尚不是受控输入、独立真值齐备的 Task。

## 2. 执行前冻结协议

完成候选代码与相关检查后填写模板；示例数字不是已校准的产品门槛。

```sh
cp evaluation/experiment.example.json evaluation/local/experiment.json
pnpm evaluate experiment create "$ROC_EVAL_BASELINE" --spec evaluation/local/experiment.json
ROC_EVAL_EXPERIMENT=/absolute/path/from-create
pnpm evaluate experiment inspect "$ROC_EVAL_EXPERIMENT"
```

| 冻结项 | 约束 |
|---|---|
| seed、incident、candidateSource | 绑定 seal/内容哈希与实际变更；创建后不按结果改写 |
| allowedChanges | 明确列出 `src/`、`resources/` 中允许变更的相对文件；未声明变更拒绝，空列表可做 A/A |
| absoluteFloors / Ceilings | 覆盖全部指标；低值更优需 ceiling/direction，RAG 源错误逐 trial 为 0 |
| trialFloors | 额外逐题底线，避免均分掩盖关键失败 |
| nonInferiorityMargin / 样本 | margin ≤ 0.05；至少 5 个 applicable clusters、3 次重复，只能收紧或增加 |
| primaryMetrics / multiplicity | superiority 事前登记；多 primary 用 fixed-sequence 或 bonferroni |
| resourceCeilings / maxResourceDegradation | 绝对上限与相对退化；基线为 0 后增加不能通过比例 gate；消融至少一个资源 gate |
| budget / pricing | 保留冻结预算；预留不是实测，unknown 无法满足对应 token/cost/resource gate |

比较统计与冻结 manifest 字段见 [README 的比较](README.md#比较)。同题、重复和两臂的 applicability 一致；NA 不补样本数。fixed-contract 不允许 tools/schema/retrievalConfig 变化；评分器、评测代码或依赖变化需新 seed，不能放进 allowedChanges 规避。实际工具 schema、application/RAG 独立证据及来源资格须完整。

spec.incidents 相对路径以 spec 目录为准，CLI 路径以 cwd 为准；冻结后保存绝对证据引用，移动目录会使引用失效。

## 3. 固定合同的唯一候选

```sh
pnpm evaluate run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --provider-options evaluation/provider-options.example.json --concurrency 2 --experiment "$ROC_EVAL_EXPERIMENT" --experiment-arm candidate
```

参数与基线匹配，包括显式选择的 provider/model。runner 在模型宿主访问前创建独占、持久化的 pre-execution claim；首个请求前核验完整 manifest，实际 schema 满足协议，manifest.experiment 保存 path/protocolHash/arm。fixed-contract 默认 arm=candidate。

每个 candidate 只能 fresh claim 一次；失败/中止保留尝试，新尝试需新协议。未封存候选 inspect 返回 awaiting-sealed-candidate / 2。执行中不修改源码或协议。

## 4. 消融的两个 fresh arms

[ablation 示例](ablation.example.json) 设置 kind=ablation，仅精确声明以下差异：

- retrievalConfig：baseline/candidate 的完整配置。
- capabilities：两臂的 toolManifest 与实际 toolSchemaHash。

模型、retrievalProvider 身份、权限、工具外层策略、共有工具的安全元数据、评分与最终答案合同仍冻结。BM25/hybrid 消融的 seed 必须已含两臂相同的 embedding 身份，不能用 retrievalProvider=null 的 seed 后补。

```sh
cp evaluation/ablation.example.json evaluation/local/ablation.json
# 先填写 incidents、精确配置和验收，再创建协议。
pnpm evaluate experiment create "$ROC_EVAL_BASELINE" --spec evaluation/local/ablation.json
ROC_EVAL_ABLATION=/absolute/path/from-create
pnpm evaluate run --suite rag-retrieval --dataset "$ROC_EVAL_RAG_DATASET" --profile full --retrieval-options evaluation/local/baseline-retrieval.json --experiment "$ROC_EVAL_ABLATION" --experiment-arm baseline
pnpm evaluate run --suite rag-retrieval --dataset "$ROC_EVAL_RAG_DATASET" --profile full --retrieval-options evaluation/local/candidate-retrieval.json --experiment "$ROC_EVAL_ABLATION" --experiment-arm candidate
pnpm evaluate experiment assess "$ROC_EVAL_ABLATION"
pnpm evaluate compare /absolute/fresh-baseline /absolute/fresh-candidate --protocol "$ROC_EVAL_ABLATION"
```

两臂使用同一冻结源码、不同新目录与不同 claim；协议必须先于任一臂。seed、旧运行或已完成后补 claim 均不可计分。普通 compare 仍拒绝合同差异；协议只豁免预登记的精确字段，独立证据、来源、样本、预算和质量/资源 gate 全部保留。component 的结论仅覆盖检索。

## 5. 恢复与验收

`pnpm evaluate run --resume /absolute/unsealed-arm` 仅适用 [安全续跑](README.md#安全续跑)。核对原 path/arm/protocolHash/source/claimVersion=1，复用原 claim；不覆盖模型、budget、retrieval 或 task。已 dispatch 工作凭完整独立证据重验，不重放未知副作用；sealed incomplete 不续写。

```sh
pnpm evaluate experiment assess "$ROC_EVAL_EXPERIMENT"
cp evaluation/review.example.json evaluation/local/review.json
# 填写真实评审人、依据与已检查的 taskId/repeat。
pnpm evaluate experiment decide "$ROC_EVAL_EXPERIMENT" --review evaluation/local/review.json
pnpm evaluate experiment inspect "$ROC_EVAL_EXPERIMENT"
```

assess 重验 seed/claims/seals/pre-execution binding，比较逐题差值与 trace pointers，并检查全部质量、逐题、资源和预算 gate，不接受手填分数或任意 candidate。

| assess / compare --protocol | 条件 | 退出码 |
|---|---|---:|
| eligible | non-inferior 或预登记 superior，且全部 gate 通过 | 0 |
| rejected | 退化或冻结 gate 不满足（含未知成本无法满足 cost gate） | 3 |
| blocked | fixture、来源未认证、样本不足、未完成、不兼容或统计不确定 | 2 |

non-inferior 仅表示未超过 margin 的退化；superior 另需全部 primary 的受益 CI 下界 > 0，全部其他指标非劣。普通 compare 的退出码见 README，不以协议 acceptance 替代。

adopt 必须 eligible 且至少记录一个存在的候选 trial 完整轨迹检查；优先看新退化、来源失败与代表性成功。reject 可记录失败或证据不足。决定绑定重算 assessment、protocol、两份 run seal 与回退源码，独占写入；decide=0 仅表示记录成功，不修改生产配置或部署。数据/评分器更新需新基线，认可后的能力任务可进入下一版回归集。

## 开发入口

实现见 [experiment.mjs](lib/experiment.mjs)、[comparison.mjs](lib/comparison.mjs)。create 返回 protocolHash/requiredArms；claim 在执行前绑定，resume 复用；runner 用 assertExperimentManifest/ToolSchema/Unchanged 核验，compareRuns 路由 fixed-contract/ablation。API 同样不能免除独立证据或预登记。

本地检查统一见 [评测验证](README.md#保留与验证)；历史结果见 VALIDATION。pure 协议反例和 comparison-eligibility 离线检查不调用模型；worker/source-identity 集成应在源码冻结后运行。合成 records 用于反例，不是人审数据或质量测量。
