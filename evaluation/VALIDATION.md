# Roc harness 重设计与清理验证 — 2026-11-13

**Verified passing**：默认入口已改为真实生产运行的 `roc-harness`，10 个案例覆盖 7 个维度。完整运行 30/30 通过，failed / invalid / unattempted 均为 0；评测器和补充轨道回归通过。任务定义与 Roc world knowledge 保持 Draft / unreviewed。

## 命令与结果

工作目录均为 `/Users/Apple_501/Desktop/Roc/Roc`，macOS ARM64。全部本机手动触发。

| 命令 | 结果 | 退出码 |
|---|---|---:|
| `node --test evaluation/tests/roc-harness.test.mjs evaluation/tests/harness-bench.test.mjs evaluation/tests/harness-bench-application.test.mjs evaluation/tests/roc-model.test.mjs evaluation/tests/experiment.test.mjs tests/unit/quality-application-adapter.test.mjs` | 51/51，通过，无跳过 | 0 |
| `pnpm harness:bench run --profile fast` | 10/10，通过，invalid 0，控制请求 18，推理请求 0 | 0 |
| `pnpm harness:bench run --profile full` | 30/30，通过，invalid 0，控制请求 54，推理请求 0 | 0 |
| `pnpm harness:bench inspect /Users/Apple_501/Desktop/Roc/Roc/evaluation/runs/roc-harness-2026-11-13T06-24-40.254Z-3f6587f1` | 完整 seal 校验通过，gate pass | 0 |
| `python3 .planning/2026-11-13-roc-harness-redesign/review-evidence.py` | 独立读取原始证据；30 个不同 run/thread、42 个进程组已退出、54 次请求与 journal 一致 | 0 |
| `node .planning/2026-11-13-roc-harness-redesign/finish-checks.mjs` | 七轮 seal 有效；CLI 参数拒绝路径、无泄漏产物、35 个本地文档链接和 diff 校验通过 | 0 |
| `pnpm harness:bench run --suite roc-native` | 94/94 合同通过，模型请求 0 | 0 |
| `pnpm typecheck` | 通过 | 0 |

[Full 报告](runs/roc-harness-2026-11-13T06-24-40.254Z-3f6587f1/report.md)逐维度通过：恢复 3/3、工具副作用 9/9、审批 6/6、取消 3/3、并发 3/3、权限 3/3、循环 3/3。[Fast 报告](runs/roc-harness-2026-11-13T05-52-59.001Z-160cbaf3/report.md)和[native 报告](runs/roc-native-2026-11-13T06-00-56.588Z-9ccbac06/report.md)也保留完整原始证据。Fast 原始证据已用加强后的独立 verifier 重新校验，十个案例均通过；没有改写原 run 的 grade 或 seal。

最终回归日志保留在 [evaluation-tests-final.log](../.planning/2026-11-13-roc-harness-redesign/verification/evaluation-tests-final.log)，完整运行与校验见 [harness-full.log](../.planning/2026-11-13-roc-harness-redesign/verification/harness-full.log)、[harness-full-inspect.log](../.planning/2026-11-13-roc-harness-redesign/verification/harness-full-inspect.log)和 [typecheck-final.log](../.planning/2026-11-13-roc-harness-redesign/verification/typecheck-final.log)。检查涵盖真实运行、工具结果回放、审批前数据库与文件备份、删除恢复点、取消信号、两次同文件编辑、manifest 拒绝和循环终止。

[原始证据复核](../.planning/2026-11-13-roc-harness-redesign/verification/harness-evidence-review.json)直接读取 SQLite 和完整阶段轨迹，没有导入生产实现或 verifier。复核了全部 trial 的请求哈希、独立 run/thread、进程退出和依赖链接清理，并逐一检查十个代表案例的状态：dispatch 前的 reserved 操作恢复后仅一次发布；已存结果恢复后不重复 dispatch；未知副作用阻断恢复；批准删除保留原始恢复字节；取消传播模型 abort；两个编辑都保留。运行封存时 1,300 个源码条目与 manifest 一致，worker 与 scorer 哈希匹配。文档结果在封存后补充，未重写运行证据。

评测器审计在原证据的副本上进行，验证替代助手措辞可通过，错误文件字节、额外文件、重复操作/dispatch、缺失结果回执、错误工具参数哈希、伪造未知副作用的成功、损坏的删除恢复字节、错误用量回执、缺失/损坏的数据库和请求响应均不能得分。重复或缺失 trial 身份使 gate incomplete。

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

[最终产物检查](../.planning/2026-11-13-roc-harness-redesign/verification/final-checks.json)确认只保留七轮有用运行和官方 QASPER 数据缓存，environment / incident / experiment / comparison 根目录为空，无活动评测 worker。复测重新创建的四个空 `.runtime` 目录已逐个 `rmdir`，没有删除额外文件。公共套件误传 harness 专用 `--task` 的真实 CLI 检查返回 2 / `task_filter_requires_harness_suite`，模型请求 0，临时测试运行已清理。

## 保留的历史真实质量证据

以下报告在本次清理后全部重新通过 `inspectRun` 的完整 seal 校验；它们早于本次重设计，未重新发送推理请求。

| 记录 | 实际结果 | 保留用途 |
|---|---|---|
| [QASPER full](runs/qasper-2026-11-13T04-42-44.960Z-4d519e26/report.md) | 150/150 scored，invalid 0，agent failure 122，模型请求 578 | 真实模型任务质量基线 |
| [QASPER 中断](runs/qasper-2026-11-13T03-38-03.267Z-586b6df4/report.md) | attempted 86，scored 85，provider transport failure，unattempted 64 | 传输故障与未完成分母证据 |
| [QASPER smoke](runs/qasper-2026-11-13T03-30-57.226Z-fa4723be/report.md) | 1/1 scored，agent failure 1，模型请求 10 | 模型接通的历史证据 |
| [Native 修复前](runs/roc-native-2026-11-13T03-38-12.150Z-42d5ba6e/report.md) | incomplete / native_contracts_failed | 过时 pilot fixture 的故障证据 |

真实 full 的 answerF1 为 **0.0397542761**，evidenceF1 为 **0.0957753358**，citationValidity 为 **0.1866666667**。这些是固定文本适配子集的历史测量，不是官方榜单成绩，也不证明本次模型质量改善。官方锁定 QASPER 数据缓存继续保留。

Native 的 pilot fixture 已改为检查当前 breaker 原因与 failure streak 的持久化，并拒绝已废弃或损坏字段；生产实现未改动。旧 budget/allowance 迁移断言与当前严格 schema 不一致，是 fixture 失效。

## 验证边界

新套件使用真实 AgentPluginRuntime、DeepAgent executor/graph、文件工具、审批、用量账本、原子写入后端、工具副作用存储和 SQLite checkpointer。模型响应受控，故障在指定边界触发；通过表示这些条件下的运行行为符合验收。

尚未覆盖模型自主工具选择质量、context compaction、子代理协作、跨会话记忆、外部 MCP 副作用、注入抵抗、官方 Science 环境或生产 Electron UI。没有付费推理、真实凭据预检、部署、提交或远程写入。本机隔离依赖 `sandbox-exec`；无总内存/总磁盘硬配额，系统库未完整镜像冻结。Seal 是文件哈希清单，不是数字签名或不可改写存储。

[更早的验证历史](validation-history/2026-11-08-before-local-isolation.md)仅描述当时实现。当前入口、限制和覆盖以 [README](README.md)及 [Task Spec](tasks/roc-harness/Task.md)为准。文档在运行完成后可以补充结果，已封存 manifest 仍对应实际执行时的源码。
