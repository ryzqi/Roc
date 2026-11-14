# Roc 评测流程重构与遗留清理验证 — 2026-11-14

**Verified passing（工程验收）**：按照 `评测优化.md` 完成统一评测入口、四轨注册、真实科研 RAG、独立评分与诊断、预算与安全续跑、固定合同及预登记消融实验，并迁移旧 native/S01/optimizer/离线检索实现。最终 342 项评测器检查、35 项迁移消费者检查和七轮受控/离线 CLI 验收通过；完整原始证据审计和历史保留复验通过。

本轮没有新增付费或 live-model 推理，也没有真实质量对照、holdout 或发布批准。受控响应和合成任务只证明工程流程；QASPER 的 150/150 表示全部 trial 已验证并计分。Task Specs 与 [Roc world knowledge](../../.agents/skills/roc-world/SKILL.md) 保持 Draft / agent-reviewed / 未经人工批准。

当前使用方式见 [README](../README.md) 和 [实验协议](../EXPERIMENTS.md)。2026-11-13 的原验证正文完整保留在 [VALIDATION.md](../VALIDATION.md)，其中日期、命令、合同及质量结论仍属于历史记录。

## 最终实现与证据边界

| 范围 | 实现与验收 |
|---|---|
| 统一执行 | `pnpm evaluate` 与兼容别名 `pnpm harness:bench` 共用同一 CLI；registry 按运行可靠性、RAG 质量、Agent 能力和科研工作流组织套件。native、S01、optimizer 和 frozen-retrieval 移至 `evaluation/adapters/`，消费者和包脚本同步迁移。 |
| 生命周期与恢复 | 冻结 plan、稳定 run/trial/request/trace 身份、隔离并发、连续 fsynced journal、独占恢复所有权。完整 dispatched 证据只能独立复核后复用；未知结算不得重新调用模型或工具。真实子进程检查覆盖 committed/orphan grade、未知 dispatch 和 proven-undispatched staging。 |
| 预算与资源 | generation/embedding/rerank 共用可信宿主预算；准入预留与实测 usage 分开，unknown 保留为未知。报告保留逐请求检索时延、逐 trial 端到端分位数、冻结价格下的成本和成功分母；缺失测量不能满足对应 gate。 |
| RAG component | 通过真实 SQLite research repository/embedding service 建索引，执行生产 BM25、embedding/RRF/reranker 路径；源版本、UTF-16 locator、候选/重排/选择及原始 provider receipt 独立验证。组件不宣称 application checkpoint 验证。 |
| RAG E2E | 真实 AgentPluginRuntime/DeepAgent 调用生产 research search/context 工具，绑定 checkpoint ToolMessage、宿主 receipt、模型可见上下文和最终响应。修复同名只读工具并发时的 proposal/request 关联，新增两论文/两 context 的真实 graph 回归及交换回执反例。 |
| 数据与评分 | 首批十个明确标记 synthetic Draft 的 RAG 任务覆盖五类场景，包含过期版本和未授权来源干扰；隐藏答案留在宿主。稳定源定位映射、ranking/evidence/answer/abstention graders、失败阶段和 trace pointers 共用报告合同。QASPER 官方 F1 公式保持不变。 |
| 对照与消融 | 普通 compare 保持固定工具、数据、模型、权限、预算和评分合同；消融必须在 dispatch 前冻结协议并 claim 两个 fresh arms。逐指标 applicability、独立 cluster/重复数、配对 bootstrap、多指标校正、绝对/逐题质量和资源门槛均有反例检查。协议验收退出码为 eligible=0、blocked=2、rejected=3。 |
| 来源资格 | QASPER 独立绑定锁定官方 archive、实际 member、完整确定性 adapted tasks、当前 derivation code、保存的 qualification 和所选支持任务。compare 需要可读的 `manifest.dataset.path`；缺失/伪造/自报 provenance 均不能取得质量资格。当前及历史 Science local recipes 仍为工程诊断，不能通过自报来源或 live-model 标签升级为可采纳质量证据。 |

主要实现位于 [runner](../lib/runner.mjs)、[execution](../lib/execution.mjs)、[budget ledger](../lib/budget-ledger.mjs)、[RAG adapter](../adapters/rag/run.mjs)、[RAG verifier](../adapters/rag/verification.mjs)、[graders](../graders/rag.mjs)、[report](../lib/report.mjs)、[comparison](../lib/comparison.mjs) 和 [ablation](../lib/ablation.mjs)。反例检查没有放宽既有证据边界。

## 冻结源码与自动化检查

全部命令工作目录为 `/Users/Apple_501/Desktop/Roc/Roc`，macOS ARM64；验收时记录的另一目录拼写为 `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`。本次清理复核确认两种路径指向同一仓库目录。使用本地锁定工具链，未升级依赖。

[最终冻结清单](../local/refactor-2026-11-14/frozen-source-v4.json) 于 `2026-11-14T10:44:59.148Z` 保存 1,396 个 source entries：

```text
95994255aef4cec7e54330fef2b5316a90d32cc3d1b4c1a061524cb61c30f410
```

所有 worker 在最终检查前停止写入；检查和七轮验收开始/结束时源码身份一致。[精确检查命令记录](../local/refactor-2026-11-14/final-check-commands-v4.json) 保存 argv、cwd、exit、耗时和日志路径。

| 检查 | 实际结果 | 退出码 |
|---|---|---:|
| `pnpm evaluation:check` | 342/342，fail/skipped/cancelled 均为 0 | 0 |
| 下列五个迁移消费者文件的 `node --test --test-concurrency=2` | 35/35，fail/skipped/cancelled 均为 0 | 0 |
| `pnpm typecheck` | TypeScript 编译合同通过 | 0 |
| `pnpm check:skills` | 11 stages / 33 resources，valid | 0 |
| `node --check`，逐文件检查 70 个 evaluator MJS | 全部通过；精确文件/命令在检查记录中 | 0 |
| `git diff --check` | 源码冻结后的改动检查通过 | 0 |

迁移消费者的实际命令：

```sh
node --test --test-concurrency=2 tests/unit/local-retrieval-evaluation.test.mjs tests/unit/quality-application-adapter.test.mjs tests/unit/quality-dataset.test.mjs tests/unit/quality-evaluation.test.mjs tests/unit/quality-runner.test.mjs
```

日志：[评测器](../local/refactor-2026-11-14/evaluation-check-final-v4.log)、[消费者](../local/refactor-2026-11-14/consumer-tests-final-v4.log)、[类型](../local/refactor-2026-11-14/typecheck-final-v4.log)、[技能](../local/refactor-2026-11-14/check-skills-final-v4.log)、[语法](../local/refactor-2026-11-14/syntax-final-v4.log)。配置 embedding/reranker 及原始 transport receipt 路径由自动化检查实际执行；这些测试使用本地受控 provider，不产生付费推理。

## 七轮规范 CLI 验收

[精确 CLI 命令记录](../local/refactor-2026-11-14/acceptance-commands-v4.json) 保存每条实际 argv、cwd、sourceHash、exit、日志、完整运行目录和 summary。所有命令使用 `--output-root /Users/Apple_501/Desktop/Roc/Roc/evaluation/local/refactor-2026-11-14/runs-v4`，全部退出 0。

| 实际命令主体（公共 output-root 见上文） | 结果与报告 |
|---|---|
| `pnpm evaluate run --profile full` | [Harness 30/30](../local/refactor-2026-11-14/runs-v4/roc-harness-2026-11-14T10-48-04.255Z-b0867611/report.md)，scenarioPassRate=1，assessment=pass |
| `pnpm evaluate run --suite roc-native` | [Native 94/94 合同](../local/refactor-2026-11-14/runs-v4/roc-native-2026-11-14T10-48-04.255Z-5ab6513c/report.md)，一个 wrapper trial，contractPassRate=1 |
| `pnpm evaluate run --suite rag-retrieval --dataset evaluation/datasets/rag-retrieval-9b2c41dc6d95a9a195582474ea893ec0d776de7772d05efb3fbe2a6325f73b39 --profile full --fixture --budget-options evaluation/local/refactor-2026-11-14/rag-fixture-budget.json` | [RAG component 30/30](../local/refactor-2026-11-14/runs-v4/rag-retrieval-2026-11-14T10-48-28.821Z-ab01555d/report.md)，recall20/ndcg10/evidenceChainRecall20=1，wrongSourceRate/staleHitRate=0 |
| `pnpm evaluate run --suite rag-paper-qa --dataset evaluation/datasets/rag-paper-qa-a4b0ef70949ae9417cec516aba6014d810b58f2d6111d1cb6f620fbbfef1d236 --profile full --fixture --budget-options evaluation/local/refactor-2026-11-14/rag-fixture-budget.json` | [RAG E2E 30/30](../local/refactor-2026-11-14/runs-v4/rag-paper-qa-2026-11-14T10-48-28.821Z-08b56525/report.md)，所有 applicable 确定性质量指标=1，wrongSourceRate/staleHitRate=0 |
| `pnpm evaluate run --suite qasper --dataset evaluation/datasets/qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0 --profile full --fixture --budget-options evaluation/local/refactor-2026-11-14/qasper-fixture-budget-v3.json` | [QASPER 150/150 verified/scored](../local/refactor-2026-11-14/runs-v4/qasper-2026-11-14T10-48-53.168Z-9ffdde2d/report.md)，answerF1=.08，evidenceF1=.14，citationValidity=1 |
| `pnpm evaluate check --suite frozen-retrieval --corpus tests/fixtures/local-retrieval-quality-context-role-v2.json` | [8 query 的 frozen-ranking 审计](../local/refactor-2026-11-14/runs-v4/frozen-retrieval-2026-11-14T10-50-24.860Z-72ebde7b/report.md)完成，regressionAcceptance=not_evaluated |
| `pnpm evaluate check --suite roc-s01` | [16 fixture 的 S01 就绪审计](../local/refactor-2026-11-14/runs-v4/roc-s01-2026-11-14T10-50-24.859Z-f71534a4/report.md)完成，scientificStatus=insufficient，fullDatasetReady=false |

七轮均 complete，invalid/unattempted 为 0，releaseEligible=false。Harness 的模型响应受控；RAG full 使用真实生产 BM25 建索引/搜索/上下文和受控生成，没有启用 configured embedding 或 reranker。检索与 E2E 各十题、三次重复。QASPER 使用原官方数据缓存和受控 Unanswerable 响应；低 F1 是实际 fixture 评分，不能解释为模型能力或答案通过率。两个 `check` 命令均为零模型/外部调用的工程审计，auditPassRate=1 不代表质量阈值验收。

## 完整原始证据审计

验收时实际执行的单次审计命令：

```sh
node evaluation/local/refactor-2026-11-14/audit-final-v4.mjs acceptance-audit-v4.json
```

退出 0；[审计结果](../local/refactor-2026-11-14/acceptance-audit-v4.json) 和 [日志](../local/refactor-2026-11-14/acceptance-audit-v4.log) 保留逐运行 seal、独立检查和汇总。审计只读原始证据，model/worker dispatches=0，originalEvidenceWrites=0，errors=[]。该单次脚本随后按本次清理要求移除；保留运行的封存完整性可继续通过 `pnpm evaluate inspect <run-directory>` 复核。

| 审计对象 | 实际数量 |
|---|---:|
| 封存运行 / trials / unique traces | 7 / 243 / 243 |
| 独立条件 | 2,926 |
| 原始文件 / SQLite 文件检查 | 5,493 / 690 |
| transcript records | 4,938 |
| 请求 / durable responses | 444 / 438 |
| 唯一 runtime runs / threads / workspaces | 210 / 210 / 210 |
| 唯一 research databases | 60 |

Harness、RAG E2E 和 QASPER 均有实际两个独立 worker 同时运行的时间证据。Harness 的六个 unknown requests 对应故意触发的 crash/cancel 条件；所有运行 pendingRequests=0，没有把未知结算补成零用量。没有冻结适用价格的模型成本保持 null。

QASPER 来源资格独立复核得到 qualification hash `90b3bd761052e3c30c9811ad9e87bbb76b1b674db66e37146d3aa95e84c6cdbb`、source contract hash `8cb410ee741d2e23c3704f4bc45fd86a3e85b73c9bfe289d41c56f8da81466e4`、dataset identity `6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0`。完整 1,005 题、772 支持题和所选 50 题的 ID/cluster/split 均与锁定来源对应；本轮 fixture 仍不取得 live quality 资格。

## 遗留实现清理与历史保留

删除 34 个旧实现文件，目标仅为 `scripts/harness-eval/` 及两个旧离线检索脚本 `scripts/evaluate-local-retrieval.mjs`、`scripts/lib/local-retrieval-evaluation.mjs`。native/S01/optimizer/检索功能迁移至统一 adapter 后保留；活动代码、测试和包脚本已切换，历史命令作为 dated records 保留。两个 11-08 历史文档中九个早已不存在的临时 `.artifacts` Markdown 目标改为明确的历史路径文本，原结果保留。

首次空缓存清理和保留复验实际命令均在上述仓库根目录执行并退出 0。以下为历史命令记录，单次辅助脚本已在后续清理中移除：

```sh
node evaluation/local/refactor-2026-11-14/final-preservation-v4.mjs cleanup
node evaluation/local/refactor-2026-11-14/reverify-history.mjs historical-seals-final-v4.json
node evaluation/local/refactor-2026-11-14/final-preservation-v4.mjs verify
```

[空缓存清理记录](../local/refactor-2026-11-14/empty-cache-cleanup-v4.json) 确认无活动评测进程，目标为普通目录且解析路径一致，在 `rmdir` 前再次核验为空。只删除 `evaluation/.runtime/imports`、`evaluation/.runtime/model-hosts`、`evaluation/.runtime/tests` 三个空目录。

[历史复验](../local/refactor-2026-11-14/historical-seals-final-v4.json) 验证 18 个历史 full seals、72 个 metadata 文件、46 处 JSON seal 引用和三个原 fixture/report 哈希保持有效。验收结束时也完整复核了七个 source-v3 运行和首次 RAG E2E 失败运行（12 scored、1 invalid、17 unattempted）。用户随后明确要求清理本轮中间产物；这两批被最终 v4 验收替代的运行已整体移除，原来源版本、seal 哈希、结果摘要及已修复的 context 回执关联问题保存在下文清理清单中。对应反例与真实生产 graph 回归测试继续保留。

原官方 QASPER 数据缓存、既有真实 v3 基线、历史 v2/中断运行、incident/experiment/analysis 引用、早期任务验收证据以及用户的 `评测优化.md` 均保留。来源修复的 [独立数据保留与交接](../local/refactor-2026-11-14/qasper-data-preservation-v4.json) 已原字节移至最终验收目录，确认原始官方 inventory 未变。旧 manifests 不回填新来源资格或评分合同。

验证记录是在工程验收结束后补写。首次收尾检查通过 17 份文档、178 个本地链接，且 [源码变化记录](../local/refactor-2026-11-14/post-acceptance-source-delta-v4.json) 只包含本文和 `evaluation/VALIDATION.md`；原 VALIDATION 正文以冻结 SHA-256 核验原字节保留。单次文档辅助脚本及过期链接扫描已移除，本次清理后的链接、源码与保留证据复验集中写入下文清理清单；没有因文档补写重复推理或重跑已通过的工程验收。

## 本次中间产物清理

按用户追加要求清理 `evaluation/local/refactor-2026-11-14/runs/`、`runs-v3/`、被替代的检查日志和源码快照、六个单次辅助脚本、已完成的 provenance worker 调试目录、闲置 `evaluation/.runtime/`，以及本轮测试生成的三个 `pr04-metrics-*.json`。任务临时计划笔记在清理检查结束后移除。删除均按精确路径核对普通目录、文件哈希和无活动评测进程后执行。

[清理清单与复验结果](../local/cleanup/2026-11-14-refactor-intermediates/manifest.json) 保存删除理由、数量、字节和目录 inventory 哈希、11 个移除运行的 seal/来源/摘要、保留与迁移清单及实际检查结果。最终七轮 `runs-v4/` 保持完整封存；精确验收命令及所指向的日志、预算配置、最终原始审计和历史保留证明继续可读。本次只移除本轮产物并更新本文引用，评测实现、回归测试、当前 Task Specs 和历史原始数据保持原字节。

## 仍未建立的质量结论

RAG 的独立人工审核、60 题正式数据规模、20 题 holdout、语义/claim-support judge 校准和功效校准仍待完成。S01 真实质量任务集未就绪；Science 官方来源、assets、环境和 grader 仍需受验证导入合同及独立审计。当前基础设施会对这些缺失条件返回 insufficient/blocked，而不是把工程成功升级为质量或发布通过。

本轮没有生产 Electron UI 验收、全系统库镜像、总内存/总磁盘硬配额或新的真实质量/费用对照。隔离依赖 macOS `sandbox-exec`；seal 是文件哈希清单，不是数字签名或不可改写审计存储。没有提交、部署、远程写入或生产配置/数据库改写。
