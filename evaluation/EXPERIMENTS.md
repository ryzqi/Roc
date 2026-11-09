# 从失败证据到候选采纳

本流程把现有 `run → inspect → compare` 接成一个本地、人工触发的开发实验。它复用真实 Roc runtime、独立 grader、预算与封存机制；新增 incident、冻结协议、候选登记、验收和人工决定。没有自动部署、配置修改、定时运行或轨迹上传。

## 结果与边界

```text
已封存运行 → incident（观察 + 根因假设）
完成的 development 基线 + 候选代码 + 验收标准 → 冻结 experiment
run --experiment → 唯一候选运行 → 独立比较 + 质量底线
人工检查完整轨迹 → adopt / reject 本地记录
新失败 → 新 incident 与下一次 experiment
```

- 仅支持现有 QASPER / Science 的 development 分区；holdout 不能转成优化 incident 或实验基线，继续通过原 release 流程独立复核。
- fixture 可以完整演练流程，但永远不能得到可采纳的模型质量结论。smoke / fast 也不满足正式比较的样本门槛。
- `eligible` 表示满足本次冻结的开发验收条件，不等于显著提升、独立留出集通过或生产发布批准。精确 Task Specs 当前仍为 Draft。
- 根因分类和 reviewer 名字是操作者的记录，不是自动证实的因果关系或经过认证的身份。seal/hash 检查证据漂移，不提供签名或不可改写存储。
- 本阶段没有新增真实用户任务、MCP 故障服务或语义 judge；S01 独立留出集与真实模型质量基线仍需单独完成。

## 1. 建立基线并记录观察

先完成 [README](README.md) 中的数据与模型准备。模型、预算和 Task 范围由操作者明确选择。先 smoke 验证接通，再用 full 建立比较基线；full 的最低请求数可能大于示例预算的 60 次，需要使用明确配置的预算文件。

```sh
pnpm harness:bench run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --budget evaluation/local/full-budget.json

# 将输出的目录填入变量；不要直接使用历史 fixture 作为真实质量基线。
ROC_EVAL_BASELINE=/absolute/path/to/baseline-run
pnpm harness:bench inspect "$ROC_EVAL_BASELINE"
```

查看 `trials.json` 找到 taskId/repeat，再检查该题的请求响应、工具结果、checkpoint、最终输出、独立 grade、退出与 cleanup。记录观察与可证伪假设，不只抄录模型自我解释。

```sh
mkdir -p evaluation/local
cp evaluation/incident-analysis.example.json evaluation/local/incident-analysis.json
# 编辑 incident-analysis.json，填写实际观察；不要保留示例占位文字。
pnpm harness:bench incident "$ROC_EVAL_BASELINE" --task ACTUAL_TASK_ID --repeat 0 --analysis evaluation/local/incident-analysis.json
```

省略 `--task` 和 `--repeat` 可记录整轮观察，包括缺少 trial 的预检故障。两者必须同时提供。incident 保存经过 seal 核验的源运行引用、原始评分观察和人工归因；每次读取都会重新验证源证据。失败、正常成功和随机抽样都可以记录，避免只针对失败集优化。

输出位于 `evaluation/local/incidents/`。它是可追溯的诊断记录，尚不是可复现 Task；新任务仍需定义受控输入、初始状态、独立真值与 verifier。

## 2. 修改候选并在运行前冻结实验

完成一项有明确假设的候选修改和相关本地检查。复制模板到被 Git 忽略的 local 目录，填写 incident 命令输出的绝对目录、实际变更文件和验收标准。

```sh
cp evaluation/experiment.example.json evaluation/local/experiment.json
# 编辑 experiment.json 后冻结。此命令不调用模型。
pnpm harness:bench experiment create "$ROC_EVAL_BASELINE" --spec evaluation/local/experiment.json
ROC_EVAL_EXPERIMENT=/absolute/path/from-experiment-create
pnpm harness:bench experiment inspect "$ROC_EVAL_EXPERIMENT"
```

模板中的 0.7 / 0.05 只是格式示例，**不是已经校准的产品标准**。创建后不能因为候选分数不好而修改阈值。

协议冻结：

- 基线目录及 seal、incident 内容哈希、候选源码清单及哈希、实际改动文件。
- `allowedChanges`：仓库相对路径的明确文件列表，仅允许 `src/` 与 `resources/`。未声明变更直接拒绝。空数组可用于无代码改动的 A/A 校准。
- `absoluteFloors`：必须覆盖该套件的全部指标。只有非劣但绝对质量不足时，仍然拒绝采纳。
- `trialFloors`：指定指标的逐题底线，避免关键失败被均分掩盖。空对象表示没有额外逐题门槛。
- `nonInferiorityMargin`：0 到 0.05，只能维持或收紧已有非劣界限；仍使用原配对 cluster bootstrap、2000 次重采样、95% 区间。

源码身份覆盖 src/scripts/resources/evaluation/package/lockfile。评分器、工具合同、数据、依赖、评测代码和说明文档的变更不属于本协议允许的候选变量；需要先在新评测协议上重新建立基线。不要通过把这些文件加入允许列表规避固定实验条件。实际工具 schema 发生变化也会被拦截，工具消融需要另行设计协议。

`spec.incidents` 的相对路径以 spec 文件目录为基准，其余命令行路径以当前目录为基准。创建后所有证据引用均保存为绝对路径；移动证据目录会使引用失效。

## 3. 用现有 runner 执行唯一候选

```sh
pnpm harness:bench run --suite qasper --dataset "$ROC_EVAL_DATASET" --profile full --budget evaluation/local/full-budget.json --experiment "$ROC_EVAL_EXPERIMENT"
```

所选模型、profile、数据、预算、评分器、环境和工具必须与基线一致。若基线显式选择了模型，候选也应传相同的 `--provider-id` / `--model-id`。模型配置变化会触发合同不匹配。

runner 在打开模型宿主前核对候选源码及基础条件，并以独占、fsync 的记录登记候选路径。在首个推理请求前核对完整条件；每次请求还核对实际工具 schema。运行 manifest 保存协议哈希，结果仍由现有独立 grader 评分并封存。

每个协议只登记一次候选。登记后的预检失败、运行中止和 SIGKILL 都保留该尝试；重试需建立新 experiment，不能覆盖旧结果后挑选最好的一轮。`experiment inspect` 遇到未封存候选返回 `awaiting-sealed-candidate` 和退出码 2；不会声称完成。执行期间不要修改代码或协议。

## 4. 验收与人工决定

```sh
pnpm harness:bench experiment assess "$ROC_EVAL_EXPERIMENT"
cp evaluation/review.example.json evaluation/local/review.json
# 检查完整轨迹后编辑 review.json，填写真实评审人、依据和看过的 taskId/repeat。
pnpm harness:bench experiment decide "$ROC_EVAL_EXPERIMENT" --review evaluation/local/review.json
pnpm harness:bench experiment inspect "$ROC_EVAL_EXPERIMENT"
```

assess 重新加载源证据和已封存候选，验证候选在运行前绑定了该协议，再运行固定条件比较和底线检查。它不接受手工填入的分数或任意候选目录。

| 验收状态 | 含义 | assess 退出码 |
|---|---|---|
| eligible | 非劣、全部均值底线和逐题底线通过 | 0 |
| rejected | 退化或绝对/逐题底线不满足 | 3 |
| blocked | fixture、样本不足、未完成、不兼容或统计结论不确定 | 2 |

`adopt` 必须 eligible，且至少记录一条真实存在的候选 trial 的完整轨迹检查。建议优先查看来源失败、所有新退化和代表性成功；小规模 pilot 应逐条检查。工具无法证明操作者实际读过轨迹，记录内容仍需人工负责。`reject` 可记录失败或证据不足的决定。尚未决定时保留 assessment 即可。

决定绑定重新计算的 assessment hash、协议、两份 run seal 和基线源码作为回退参考；写入后不能覆盖。`decide` 退出 0 仅表示决定已记录，具体结论看 `review.decision`。它不修改应用配置、不接通生产 HarnessReleaseStore，也不执行部署。

通过且人工认可的能力任务可进入下一版回归集；新生产案例进入下一版开发集。数据集/评分器更新需要新基线。公开数据的本地 holdout 仍不能证明模型未见过题目。

## 本地验证

```sh
node --test evaluation/tests/experiment.test.mjs
```

包含 synthetic sealed records 的门槛校准，以及通过真实 CLI、真实 Roc worker 和固定模型响应完成的 incident → experiment → candidate → assessment → reject 链路。覆盖错误来源、未声明改动、合同漂移、重复登记、低分非劣、逐题底线、fixture/incomplete 拒绝采纳、证据改写和人工记录绑定。所有这些是流程验证，不是模型质量测量。

日志、精确执行命令和证据路径见 [VALIDATION.md](VALIDATION.md)。
