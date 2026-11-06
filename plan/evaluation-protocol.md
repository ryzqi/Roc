# S01 评测协议与交付合同

状态：工程协议 v3；科学预注册 Draft。没有真实数据冻结、人工科学双审或 L2 授权。
当前生产评测入口为同一 `runQualityEvaluationWithJournal`，不保留 pilot 专用入口。
实施依据为 [S01](phase-01-evaluation.md) 和 [AC-15/16](acceptance.md)。

## 数据与证据等级

| 模式 | 数据及 split | 执行条件 | 可得结论 |
| --- | --- | --- | --- |
| fixture | `evidence=fixture`、`split=fixture`；原 16 项 | L1、本地无费用 transport 或确定性 verifier | 合同回归；科学状态 insufficient |
| pilot | independent、至少 10 项 dev、独立双审与许可完备 | L2；实际隔离和硬费用上限 | 小样本探索；不能作为 200 项验收 |
| full | independent holdout 满足八族 200 配额、每族至少五簇 | L2；固定输入、两臂 SHA、同一模型、工具、权限和费用 | 客观配对统计；另需人类盲审，不能直接批准发布 |

八族配额是 holdout 接受关口：30 文献核验、30 多论文、25 长记忆、30 文件/报告、
25 实验脚本、20 MCP 恢复、20 权限注入、20 取消/崩溃。train/dev 另行收集，
不消耗或重复计算 holdout 配额。当前独立完成数 **0/200**，原 16 项全为 fixture。
操作家族可以使用独立设计的 synthetic 故障，科学家族必须是真实来源。

manifest schema v1 显式包含来源许可/归属/locator/contentHash、来源簇、split、
任务难度、输入 hash、隐藏期望 ref/hash、双审身份/时间/annotation hash 和仲裁 ref/hash。
同源 contentHash 或 locator 不能分到不同簇，来源簇不得跨 split。
manifest、输入、期望和标注 JSON 均以递归键排序的 canonical JSON SHA-256 固定；
这是内容身份，不能充当人工独立性证明。

私有 corpus 由受控本地目录持有，不提交论文全文或审核者个人信息。
[dataset-manifest.template.json](evaluation/dataset-manifest.template.json) 是待填写模板，
空任务、空来源和空 hash 会被 loader 拒绝，不是可运行 corpus。
来源簇须在标注前完成具体 split 注册；注册时间必须早于 review 时间，review 不晚于冻结时间。
没有来源时不虚构 cluster 名或注册时间。

## 单一执行路径

1. 在可信 host 读取 manifest 和显式 SHA-256，调用 `loadQualityDatasetPackage(path, hash)`。
   loader 实测拒绝 ref 路径穿越、符号链接逃逸、期望和标注 hash 变化。
2. 按 [标注手册](evaluation/annotation-manual.md) 审核；使用
   [双审模板](evaluation/review.template.json) 和 [仲裁模板](evaluation/arbitration.template.json)。
3. 从已提交且干净的两臂 checkout 分别准备 worker：
   `node scripts/harness-eval/prepare-quality-worker.mjs .artifacts/research-harness/S01/<arm>`。
   `worker.json` 固定 bundle SHA、真实 Git SHA、各臂依赖目录、lockfile hash 和 Node 版本。
   baseline 必须含有新评测合同；旧代码本身没有 worker 时，先在基准分支移植相同评测合同，
   然后固定该提交，不能把旧 SHA 贴到新 bundle 上。
4. 创建 `QualityHostTransport`。凭证只在这个 host closure 内持有；
   providerId/pricingVersion 必须与锁一致。所有真实请求、内部 retry 都受同一请求计数和
   硬上限约束；provider 无法保证硬费用上限时不运行。该接口本身不证明真实 provider 的强制能力。
5. 创建 application executor。`protectedPaths` 必须完整覆盖 corpus、标注、期望、验证器及
   任何私有目录；不能让它们通过 runtime dependencies 进入允许读的树。
   `qualityApplicationEnvironmentHash(workers, protectedPaths)` 与 `qualityIsolationHash()` 写入锁。
6. `createQualityProtocolDraft(dataset, id)`，随后 `lockQualityProtocol(dataset, draft, input)`。
   `qualityPromptSetHash(dataset, mode)` 固定所选 split 的全部 AgentTaskView。
   默认三次配对重复、seed 20261030、2,000 次簇 bootstrap、95% 区间、非劣界 0.05。
   锁固定两臂不同 commit、同一 provider/model、temperature、工具/权限/隔离、环境、
   timeout、价格版本、最大请求、每请求/每 trial/总费用和授权引用。
   目前不支持更改这些统计默认值；另拟协议必须先改合同和检查，不能事后重签降低门槛。
7. 调用 `runQualityEvaluationWithJournal({ dataset, expectations, protocol, executor, signal, artifactsRoot })`。
   一个 lockHash 只有一个 `wx` journal；协议和每次 dispatch/request 都 fsync 后才执行。
   重启不自动重跑；先人工对账，再以独立授权创建新协议。

纯离线入口：

```bash
pnpm harness:quality:check
node scripts/harness-eval/quality-check.mjs /controlled/corpus/manifest.json <canonical-sha256>
```

无参 CLI 明确选择仓库 fixture；底层 loader、protocol、runner 均没有默认数据回退。
离线 audit 不 dispatch、不使用 provider 凭证，不能把 audit exit 0 当成科学完成。

## 实际隔离与应用 adapter

macOS `sandbox-exec` 默认拒绝网络和文件访问，只允许冻结 worker、Node/系统运行依赖、
对应 node_modules 和每个 trial 的新 workspace。显式拒绝 protectedPaths，
只能启动指定 Node，禁止改变进程组后逃逸。stdin/stdout 是唯一模型传输。
不继承宿主 env；HOME/TMPDIR 指向 trial，tracing 关闭。
隐藏 schema 与验证器不进入 worker 编译图；worker 只导入 AgentTaskView 和 hash helper。

worker 走真实 `AgentPluginRuntime → createAgentDeepAgentExecutor → buildRunHarness`，
使用应用自身预算 ledger、checkpointer、事件日志、session history、memory DB 和 effect store。
每次请求统一在 host admission 后调用 transport；SDK retries=0，内部 retry 仍消耗请求计数。
应用本地 stream 由一次非流式、有上限的 host completion 转成 SDK chunks；不据此测真实流式延迟。
模型、summary、child 的请求都走同一 transport；verifier 是 host 确定性检查，不调用模型。

当前 adapter 配置没有连接 MCP、Skill 或外部 workspace，保留应用默认 backend；
不把结构化输出中声称的 receipt/effect 当成真实操作证明。
八族真实 effect、跨会话恢复和长任务专项仍需 S02/S03/S06/S07 的环境及观察器。
本轮发现应用终态文本会包含 context contract 前缀，造成 JSON 失败；
保留原输出和轨迹，不裁剪成成功答案，科学运行前需修复该产品行为。

host transcript/stderr/cleanup 位于 trial workspace 之外，agent 无法读写。
每 trial 保存真实 DB、完整有界事件/请求轨迹和进程组清理证据。
取消或 timeout 未确认时停止整个实验，未知费用继续占用；
报价超限、请求合同改变、journal 失败、隔离/完整性异常也停止后续 dispatch。
实际 provider 账单和预算强制未验证；本轮只使用无费用本地 transport。

## 报告与授权关口

机器报告包含 paired trials、所有失败/未调用的固定分母、校验详情、
失败分类、pass rate、P95、已知/未知费用、持有预算、stopReason、配对区间和任务族回退。
只有完整冻结 holdout 身份和配额匹配才有充分的客观样本量；
任何家族显著退步阻止收益结论，整体收益还要求每族区间满足非劣界。
家族比较为 exploratory-unadjusted，不能充当经多重校正的确认结论。
统计器始终报告 `subjectiveReviewStatus=not_run`；人类报告独立附在
[report.template.json](evaluation/report.template.json)，不能以模型自评替代。

专项索引：300 claim、50 retrieval、25 context、30 DAG、100～200 attacks，
使用 [experiment-index.template.json](evaluation/experiment-index.template.json) 记录父任务、
来源簇、抽样和重复关系。数量不与 200 项相加；按独立统计单位重新审计。

L2 仍缺：合规 corpus、两位独立审核者及仲裁者、具体 split 注册、两臂应用 SHA、
实际 provider/model/价格版本、硬上限实现、每请求/trial/总上限、请求次数、
授权目标/凭证范围、operator、盲审安排和对账流程。
L3 额外要求明确 L3 授权和 rollback 引用；发布及远端写入另有授权。
当前协议状态 Draft；没有付费或外部实验，科学结果为 `insufficient`。
