# Roc harness、清理与 QASPER 接入验证 — 2026-11-13

**Verified passing**：默认 `roc-harness` 保留 10 个案例、7 个维度的真实运行验收，当前完整运行 30/30 通过。QASPER 保留为 Roc 论文问答与证据选择的任务表现评测，已接通实际配置模型工厂、生产 graph/文件工具、SQLite checkpoint 独立验证和严格评分。当前 5 项新增回归、64 项既有回归和 typecheck 均通过；同条件的真实 QASPER v2 基线及优化候选均完成 150/150。候选提升了开发集表现，但未通过预设质量门槛，评估为 **rejected**。任务定义与 Roc world knowledge 保持 Draft / unreviewed。

## 本轮优化与真实 QASPER 后台重跑

生产修改仅涉及 `context/prompt-blocks.ts` 和 `context/context-assembler.ts`：严格遵守用户要求的最终格式、简洁回答、限定词与否定判断、直接证据，以及按实际授权工具生成提示。数据、模型、限制、工具 schema、评分器和 v2 最终答案边界保持固定。

后台完整运行使用当前配置的 `group/deepseek`，50 篇论文／50 个问题，每题重复 3 次。两轮原始证据与评分均保留，候选 runtime verified 150/150，invalid 0。

| 指标 | v2 基线 | 优化候选 | 差值的 95% 区间 |
|---|---:|---:|---|
| answerF1 | 0.118390 | 0.190522 | [0.039217, 0.108233] |
| evidenceF1 | 0.277570 | 0.413308 | [0.077375, 0.197399] |
| citationValidity | 0.500000 | 0.820000 | [0.233333, 0.420000] |
| 严格 JSON 失败 | 75/150 | 27/150 | 描述性计数 |

采用论文簇配对 bootstrap，2,000 次采样；比较结论为 `non-inferior`。推理前冻结的门槛为 answerF1 ≥ 0.20、evidenceF1 ≥ 0.45、citationValidity ≥ 0.99，三项均未通过。`experiment assess` 退出码 3 记录该质量拒绝，不能当成基础设施失败，也没有调低门槛。

请求数 578 → 511，输入 token 3,596,246 → 3,161,026，中位单题耗时 8.999 s → 7.977 s。收益主要来自格式恢复；两轮均输出有效 JSON 的 62 个样本没有同步改善证据选择。仍有 27 个原始格式失败，框架追加提示仍提到不可用的 `write_todos` 和 `edit_file`；实际调用始终仅为 `ls` 和 `read_file`。本轮结果只覆盖所选开发集，不构成生产或独立 holdout 验收。

[完整变更与结果](local/analysis/2026-11-13-qasper-optimization/RESULT.md)、
[当前 harness Full](runs/roc-harness-2026-11-13T09-38-37.409Z-7c4f0845/report.md)、
[v2 基线](runs/qasper-2026-11-13T08-03-16.312Z-6756db21/report.md)、
[候选原始报告](runs/qasper-2026-11-13T09-54-21.991Z-3b8d3db7/report.md)、
[后台完成记录与命令](local/background/qasper-20261113-optimized-full/commands.json)、
[独立审计](local/background/qasper-20261113-optimized-full/candidate-evidence-audit.json)
记录全部验证。审计重新验证两轮共 300 个 trial、3,600 项运行条件和全部原始 grade，候选源码 hash 在运行期间始终不变。本文在运行结束后补充结果；生产代码字节仍与已封存候选一致。

优化后的清理另删除 213 个文件、40,108,078 字节（38.25 MiB）：两处失败诊断、重复 Fast 运行和空运行缓存。[清理清单与结果](local/cleanup/2026-11-13-qasper-optimization/result.json)确认 11 个保留运行 seal、官方 QASPER 数据和源码均未变。后台运行结束后只用 `rmdir` 回收重建的三个空运行缓存目录；[复验记录](local/analysis/2026-11-13-qasper-optimization/post-run-empty-runtime-cleanup.json)再次确认两轮 QASPER seal、数据和源码一致。

## 受控 QASPER 接入验证

工作目录均为 `/Users/Apple_501/Desktop/Roc/Roc`，macOS ARM64。全部本机手动触发。

| 命令 | 结果 | 退出码 |
|---|---|---:|
| `node --test evaluation/tests/roc-harness.test.mjs evaluation/tests/harness-bench.test.mjs evaluation/tests/harness-bench-application.test.mjs evaluation/tests/roc-model.test.mjs evaluation/tests/experiment.test.mjs tests/unit/quality-application-adapter.test.mjs` | 64/64，通过，无跳过 | 0 |
| `pnpm typecheck` | 通过 | 0 |
| `pnpm harness:bench run --suite qasper --dataset evaluation/datasets/qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0 --profile fast --fixture` | 5/5 scored，invalid / unattempted 0，控制请求 10，推理请求 0 | 0 |
| `pnpm harness:bench inspect /Users/Apple_501/Desktop/Roc/Roc/evaluation/runs/qasper-2026-11-13T07-45-12.387Z-d40d7bf3` | 完整 seal 校验通过，fixture-only | 0 |
| `node evaluation/local/validation/2026-11-13-qasper-integration/audit-evidence.mjs evaluation/runs/qasper-2026-11-13T07-45-12.387Z-d40d7bf3` | 独立读取 5 题原始状态与 150 题历史响应/checkpoint；9 轮保留运行 seal 有效 | 0 |
| `pnpm harness:quality:check` | S01 离线结构审计有效，16 个 fixture；scientificStatus=insufficient，模型/外部请求 0 | 0 |

日志保留在 [evaluation-tests.log](local/validation/2026-11-13-qasper-integration/evaluation-tests.log)、[typecheck.log](local/validation/2026-11-13-qasper-integration/typecheck.log)、[qasper-fixture.log](local/validation/2026-11-13-qasper-integration/qasper-fixture.log)、[qasper-inspect.log](local/validation/2026-11-13-qasper-integration/qasper-inspect.log)、[evidence-audit.log](local/validation/2026-11-13-qasper-integration/evidence-audit.log)和 [quality-check.log](local/validation/2026-11-13-qasper-integration/quality-check.log)。[原始证据审计](local/validation/2026-11-13-qasper-integration/audit-evidence.json)记录逐题 run/thread/checkpoint、请求索引、冻结模型/限制、工具 schema、最终答案/验证哈希和清理结果。

受控的配置模型集成测试使用临时 llama.cpp provider 和本地 SSE 响应，依次通过 `runBenchmark → Electron 模型宿主 → LangChainModelFactory → AgentPluginRuntime/DeepAgent → read_file → checkpoint verifier → QASPER scorer`。两次请求均使用实际 model、temperature 0.3 和 128-token 上限；冻结快照中的 provider/model/限制一致。公开论文出现在真实工具结果中，隐藏标注没有进入模型请求，临时配置和凭据文件未改写。末次响应不提供 usage 时，runtime 仍有效并保留 unknown 账本。

回归证明带过程叙述的工具轮次可以保留，评分只取与末次模型响应一致的最终 checkpoint 消息。最终消息带 Markdown 围栏时仍返回 `output_not_json`。十种证据变更分别被拒绝：伪造输出、两份结果中的错误请求数量、checkpoint 答案不一致、缺失 checkpoint、缺失模型账本、损坏数据库、缺失/损坏响应、论文改写、清理未确认。每次变更只发生在测试拥有的目录中，恢复原始字节后仍可验证。

[官方数据 fixture 报告](runs/qasper-2026-11-13T07-45-12.387Z-d40d7bf3/report.md)的 5 题各有独立 run/thread，10 次请求索引与宿主响应、账本一致，SQLite 最终消息与末次响应逐字一致，全部 runtime 检查通过，论文字节和 cleanup 有效。seal SHA-256 为 `4d6a1942da9cbdc2e1925c90787c7735d5bef85e9fa71b03e763d40246014781`。fixture 固定返回 Unanswerable；其分数只用于验证评分与接线，不能当成模型表现。

## 已保留的 harness 与 native 验证

先前的 `pnpm harness:bench run --profile fast` 得到 10/10、18 次控制请求；`--profile full` 得到 30/30、54 次控制请求；`--suite roc-native` 得到 94/94 合同通过。推理请求均为 0。本次 64 项回归继续覆盖真实 harness 案例和独立验收器。

[Full 报告](runs/roc-harness-2026-11-13T07-07-40.659Z-65e53a7c/report.md)逐维度通过：恢复 3/3、工具副作用 9/9、审批 6/6、取消 3/3、并发 3/3、权限 3/3、循环 3/3。[较早的 Full](runs/roc-harness-2026-11-13T06-24-40.254Z-3f6587f1/report.md)、[Fast](runs/roc-harness-2026-11-13T05-52-59.001Z-160cbaf3/report.md)和 [native](runs/roc-native-2026-11-13T06-00-56.588Z-9ccbac06/report.md)也保留完整原始证据；当前审计重新验证全部 seal，没有改写 grade 或 seal。旧重设计的临时规划脚本与日志现已不在工作区，本文改为引用保留的运行证据和本轮日志。

Harness 评测器审计验证替代助手措辞可通过，错误文件字节、额外文件、重复操作/dispatch、缺失结果回执、错误工具参数哈希、伪造未知副作用的成功、损坏的删除恢复字节、错误用量回执、缺失/损坏的数据库和请求响应均不能得分。重复或缺失 trial 身份使 gate incomplete。

## 清理结果

先生成并核对精确清单，再执行；确认无活动评测进程，目标均为 `evaluation/` 下未跟踪的生成目录，删除不跟随符号链接。

| 产物 | 删除数量 | 原因 |
|---|---:|---|
| runs | 41 | 重复 fixture、已过时的零请求预检失败、本次评测器调试 run |
| experiments | 74 | 69 个测试目录记录、5 个明确的 fixture CLI 生命周期记录 |
| incidents | 89 | 84 个测试目录记录、5 个 fixture CLI 记录 |
| Science 数据缓存 | 21 | provenance 全部为 `synthetic-test-only` |
| Python 环境 | 24 | 22 个测试 venv、2 个无保留消费者的标准库演示/未完成环境 |
| comparison | 1 | fixture 对比，结论为 insufficient |
| .runtime | 1 | 无活动进程的 build、模型宿主、native scratch 与泄漏测试状态 |

合计 **251 个目录、31,676 个文件、2,863,280,128 分配字节（约 2.67 GiB）**。[清单](local/cleanup/2026-11-13/manifest.json)记录路径、删除理由、大小和证明文件哈希；[执行结果](local/cleanup/2026-11-13/result.json)确认删除及保留证据哈希未变。没有删除用户配置、凭据、生产数据库、正式外部输入或 `evaluation/` 之外的 S01/历史证据。

测试现在拥有独立 output root，并在失败时也回收 run、experiment、incident、Science 缓存和 venv。模型宿主在确认进程清理后删除临时 build/state，包括初始化失败路径。

清理时保留的证据、后续完整 harness 运行和本轮 QASPER fixture 共 9 轮，全部 seal 在本轮审计中有效。官方 QASPER 数据缓存继续保留。本轮测试的临时 run、incident、experiment、Science 缓存与 venv 由各自 cleanup hook 回收；小型验证日志和审计记录集中在 `evaluation/local/validation/2026-11-13-qasper-integration/`。

[最终产物检查](local/validation/2026-11-13-qasper-integration/final-checks.json)确认无活动评测进程，environment / incident / experiment / comparison 根目录为空；仅用 `rmdir` 回收四个空 `.runtime` 目录。修改文档的本地链接和 `git diff --check` 均通过。

## 保留的历史真实质量证据

以下报告在本次清理后全部重新通过 `inspectRun` 的完整 seal 校验；它们早于本次重设计，未重新发送推理请求。

| 记录 | 实际结果 | 保留用途 |
|---|---|---|
| [QASPER full](runs/qasper-2026-11-13T04-42-44.960Z-4d519e26/report.md) | 150/150 scored，invalid 0，agent failure 122，模型请求 578 | 过时的聚合答案边界诊断证据 |
| [QASPER 中断](runs/qasper-2026-11-13T03-38-03.267Z-586b6df4/report.md) | attempted 86，scored 85，provider transport failure，unattempted 64 | 传输故障与未完成分母证据 |
| [QASPER smoke](runs/qasper-2026-11-13T03-30-57.226Z-fa4723be/report.md) | 1/1 scored，agent failure 1，模型请求 10 | 模型接通的历史证据 |
| [Native 修复前](runs/roc-native-2026-11-13T03-38-12.150Z-42d5ba6e/report.md) | incomplete / native_contracts_failed | 过时 pilot fixture 的故障证据 |

真实 full 的原始 answerF1 为 **0.0397542761**，evidenceF1 为 **0.0957753358**，citationValidity 为 **0.1866666667**。完整读取全部 150 题的模型响应与最终 checkpoint，得到以下分类：

| 原评分状态 | 最终消息为 JSON | 聚合文本含额外过程叙述 | 数量 |
|---|---|---|---:|
| scored | 是 | 否 | 28 |
| output_not_json | 是 | 是 | 60 |
| output_not_json | 否 | 是 | 53 |
| output_not_json | 否 | 否 | 9 |

60 题证明聚合答案边界造成格式误判，不能据此证明其答案正确。其余 62 题的最终消息本身无法严格解析为 JSON，仍是实际格式问题。原始评分与 seal `6d0aaedde73818b5cd329a1e2466b6044172d2daa7c689febf0380c0e878e140` 均未修改；上述分类是接入诊断，不是重新计分。

当前 `qasper-roc-runtime-v2` 冻结了新的最终答案与 runtime 证据合同，旧运行不能作为 compare 或 experiment 基线。本轮已另行完成兼容 v2 合同的真实 full 基线和源码优化候选，见本文首节。保留的旧分数不是官方榜单成绩；本轮增益来自两轮兼容的 v2 运行对比。

Native 的 pilot fixture 已改为检查当前 breaker 原因与 failure streak 的持久化，并拒绝已废弃或损坏字段；生产实现未改动。旧 budget/allowance 迁移断言与当前严格 schema 不一致，是 fixture 失效。

## 验证边界

新套件使用真实 AgentPluginRuntime、DeepAgent executor/graph、文件工具、审批、用量账本、原子写入后端、工具副作用存储和 SQLite checkpointer。默认 harness 的模型响应受控，故障在指定边界触发；通过表示这些条件下的运行行为符合验收。QASPER 真实模型轨道另行测量论文问答表现。

受控验证不建立真实模型质量结论；本轮真实 QASPER 补充了所选论文问答和自主文件工具选择的证据。仍未覆盖 context compaction、子代理协作、跨会话记忆、外部 MCP 副作用、注入抵抗、官方 Science 环境或生产 Electron UI。真实模型轨道只读取当前 Roc 配置，凭据留在模型宿主；没有配置写回、部署、提交或远程写入。本机隔离依赖 `sandbox-exec`；无总内存/总磁盘硬配额，系统库未完整镜像冻结。Seal 是文件哈希清单，不是数字签名或不可改写存储。

[更早的验证历史](validation-history/2026-11-08-before-local-isolation.md)仅描述当时实现。当前入口、限制和覆盖以 [README](README.md)及 [Task Spec](tasks/roc-harness/Task.md)为准。文档在运行完成后可以补充结果，已封存 manifest 仍对应实际执行时的源码。
