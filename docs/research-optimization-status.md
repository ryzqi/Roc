# 科研优化实施与验收账本

核对日期：2026-11-06。实现核对点：`6268012b`；原始计划基线：`c4bb3276`。

本地工程交付已推进到 §22.3。下表的 `Verified passing` 限于各领域文档记录的实际工程检查；真实模型、独立科研质量及真实外部环境的验收仍未完成，因此整个计划不能标记为全部验收通过。原始计划及领域文档中的早期“下一步”描述属于当时记录，当前状态以本账本和后续提交为准。

用户授权按计划依次实施、验证并逐项提交本地变更，且要求不保留兼容层、过时代码或掩盖失败的回退。原始计划中有关兼容实现的建议由该指令取代。来源归属、权限、版本、预算及真实未知状态仍是实现合同。没有执行付费模型试验、外部发布或外部 Trace 上传。

## 核心交付

提交列是可定位的实施里程碑，完整变更及逐步检查记录见对应文档和 Git 历史。

| 工作项 | 本地实现与验证范围 | 提交 | 合同与证据 |
| --- | --- | --- | --- |
| M0 / ROC-PR-01 | 图稿 owned 查询、轮询、发布、取消和幂等回归，Verified passing | `9ba15a00` | [图稿](research-figures.md) |
| ROC-PR-02A | 可信项目/任务/执行树身份，Verified passing | `61da107f` | [工作流](research-workbench.md) |
| ROC-PR-02B | 项目、任务、阶段的调用预留与结算，未知消耗不归零，Verified passing | `b66e8cf6`, `1101c313` | [任务观测](research-task-observability.md) |
| ROC-PR-02C / P0 | 取消、恢复、审批还原、诊断和故障矩阵，Verified passing | `87452047`, `09e7ce57`, `ced4ee46` | [工作流](research-workbench.md)、[任务观测](research-task-observability.md) |
| ROC-PR-03A | 冻结的配对 pilot runner、协议及离线审计，Verified passing；完整独立数据及真实模型运行未验收 | `09925332` | [评测协议](../scripts/harness-eval/quality-evaluation/Task.md) |
| ROC-PR-04 | 多来源排名融合、身份/冲突、受控分页、持久回执及离线排名评价，Verified passing | `3e783ca4`, `8ff51c53` | [文献融合](research-literature-fusion.md) |
| ROC-PR-05 | Zotero 本地只读、增量核对、原始对象与附件授权/收录及现有界面，Verified passing | `526cf3a0`, `8823c965`, `6086a079` | [Zotero](research-zotero.md) |
| X-UI | 唯一 shell 内的按需工件检查器、来源读取、刷新和替换历史，Verified passing | `65af1f9e`, `21195f5a` | [工件检查器](research-artifact-inspector.md) |
| ROC-PR-06 | 来源定位、Evidence/Claim 关系、人工审核、失效与迁移、导出封存，Verified passing | `49e6b15b`, `d5b40648` | [证据关系](research-evidence-relations.md) |
| ROC-PR-07 | 原 PDF/解析双向定位、版本绑定、真实区域投影、注释及实际 OCR 夹具，Verified passing | `64cf597e`, `9bdfb840`, `05ae7d4c` | [PDF 定位](research-pdf-positioning.md)、[阅读导航](research-pdf-navigation.md) |
| X-SAFE | 准入、采样限额、离线/文件边界、真实资源及代码回执、宿主崩溃后进程清理，Verified passing | `c6077ee7`, `474fe250`, `0f135390`, `defe549e` | [执行资源](research-execution-resources.md) |
| ROC-PR-08 | 显式环境、固定启动、源码/输入/输出、受控 CPython 3.14/macOS 执行和恢复重放，Verified passing | `8693d34d`, `985e6c63` | [Python 环境](research-python-environment.md)、[实验执行](research-experiments.md) |
| X-NB / X-EXP | Notebook 有界静态导入、冻结支持的 cell 子集、受控执行、真实指标比较及 Evidence 回溯，Verified passing | `2d092de4`, `9985c50a`, `8c983150`, `6fd0a12e` | [Notebook](research-notebooks.md)、[结果比较](research-experiment-results.md) |
| ROC-PR-09 | 冻结协议/检索/去重、两轮筛选/裁决、提取、设计匹配质量评价、计数守恒及助手到审核闭环，Verified passing | `859a7d2b`, `4ca9d9cc` | [系统性综述](research-systematic-review.md) |
| X-IDEA | 冻结方法计划、观察前/后历史、负结果及人工结局判定，Verified passing | `31e952d6`, `3df5920c`, `2790ca1b` | [方法计划](research-idea-plans.md) |
| X-WRITE | 引用覆盖/直接性、数值/图稿来源映射、审稿回复矩阵和期刊规则；审批及导出重新验证，Verified passing | `a5de97f0`, `2a142502`, `a073b037` | [写作检查](research-writing-checks.md)、[回复矩阵](research-response-matrix.md)、[期刊规则](research-journal-compliance.md) |
| ROC-PR-10 | 固定 RO-Crate 1.2、公开投影、许可审查、实际 ZIP/字节闭包及人工出版审查，Verified passing | `dd706879`, `3bff93c8`, `bbe8af31` | [RO-Crate](research-ro-crate.md) |

## 科研生态与计划末尾交付

| 工作项 | 本地实现与验证范围 | 提交 | 合同与证据 |
| --- | --- | --- | --- |
| X-ECO 学术关系 | Provider 来源关系的不可变观测及原阅读器 UI，Verified passing | `73829669`, `84d8f2a9` | [学术关系](research-scholarly-relations.md) |
| X-ECO DataCite | DOI 元数据、显式论文/实际实验版本关联及原阅读器 UI，Verified passing | `f6ded243`, `c7a8b4dd`, `7ea86dca` | [资源](research-resources.md) |
| X-ECO Hugging Face | 固定 revision 元数据、独立人工授权的有界下载及原阅读器 UI，Verified passing | `5a479234`, `d43a93c0`, `57a71f8d` | [Hugging Face](research-huggingface.md) |
| X-ECO OpenReview | 公开 v2 Note/论坛/修订观测和有界分页 UI，Verified passing | `07141638`, `c3e10f47` | [OpenReview](research-openreview.md) |
| X-MON | 版本化查询、调度检查点、更新提示及历史 UI，Verified passing | `1069bed5`, `ccc8f6e4` | [监控](research-monitors.md) |
| OSF | 完成官方政策核查，决定不启动 Projects 写入同步；可选只读导入/独立注册未立项，Located | `5c0d2c6f` | [政策决定](research-osf-policy.md) |
| X-ECO Zenodo | 本地包准备、受控连接器、独立发布授权及原导出抽屉 UI，Verified passing（本地） | `96736851`, `4e2c8e1f`, `892a9cba` | [Zenodo](research-zenodo.md) |
| §22.1 A1/A1B | 1万/10万/100万 chunk 隔离基准、窄 FTS 排名后加载文本，Verified passing | `c0cd1437`, `ffddb21d` | [性能记录](research-performance.md) |
| §22.1 A2 | 当前合同长 PDF 解析、缓存和真实 Electron 阅读测量，Verified passing | `cfa887a9` | [PDF 基准](research-pdf-performance.json) |
| §22.1 A3 | 线性图谱关系索引与有界节点/邻域分页，Verified passing | `c976a9c4` | [图谱基准](research-graph-performance.json) |
| §22.1 A4 | 固定中英混合本地检索评价工具，Verified passing；独立标注验收未运行 | `7e666b4e` | [性能记录](research-performance.md) |
| §22.1 A5 | 实际多项目原生准入、前台优先和公平性基准，Verified passing | `7486731c` | [准入基准](research-admission-performance.json) |
| §22.1 A6 | 注入延迟/429/失败的生产网络治理、缓存、恢复和取消基准，Verified passing | `5615ff84` | [网络基准](research-network-performance.json) |
| §22.1 A7 | 按项目/类型/保留属性的只读存储清单和基准，Verified passing | `a72c4fc0` | [存储基准](research-storage-performance.json) |
| §22.2 X-CONTEXT | 有出处的不可变任务事实、人工纠正、过期来源、重启和临时模型上下文重建，Verified passing | `b222170f` | [事实账本](research-task-context.md) |
| §22.3 X-OBS | 真实调用观测、执行/资源/当前工件版本、明确未知及主进程人工离线诊断导出，Verified passing | `6268012b` | [任务观测](research-task-observability.md) |

## 当前整合检查

工作目录：`/Users/Apple_501/Desktop/Roc/Roc`（物理路径为 `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`）。检查针对 `6268012b` 的实现；本账本只改文档。环境：macOS 27.0.1 arm64、Node v26.13.0、pnpm 12.5.1；项目声明 Electron 45.0.0。

证据目录：`.artifacts/research-optimization/`。下表结果来自实际日志，早期失败没有删去或计作通过。

| 命令 | 实际结果 | 日志 |
| --- | --- | --- |
| `pnpm build` | 通过，含 typecheck | `observability-build-final.log` |
| `pnpm test:unit` | 1469/1469 通过 | `observability-all-unit.log` |
| `pnpm harness:eval` | 94/94 通过；确定性工程评价 | `observability-harness.log` |
| `node scripts/run-research-p0.mjs` | 19/19 通过 | `observability-native.log` |
| `node scripts/smoke-electron.mjs` | 13/13 通过，零 renderer error | `observability-startup.log` |
| `pnpm check:ipc` | 生成合同一致 | `observability-ipc.log` |
| `pnpm check:renderer-chunks` | 通过，eager 1,134,468 字节 / 6 文件 | `observability-chunks.log` |
| `node --test tests/renderer/research-tasks.test.mjs` | 16/16 通过 | `observability-renderer-first.log` |
| `node --test --test-concurrency=1 tests/renderer/` | 449/449 通过，零失败/取消/跳过，1,493,361ms，exit 0 | `closure-renderer-serial.log` |

§22.3 另有 44/44 专项单元检查、6/6 最终取消夹具检查以及明暗 720/380px 的 12 条 `cut: 0` 布局记录，具体命令和证据见任务观测文档。没有因文档整理重复已经通过的昂贵构建和原生检查。

历史完整 renderer 曾因 transcript prepend/retention 锚点和质量评价保存超时而出现 `310/312` 结果；对应独立测试通过，原并发失败原因未确认。本次完整串行运行包括该 transcript 锚点以及质量评价场景，全部通过；结果只说明该运行条件下的覆盖情况。历史较广 P3 workspace refresh 实测为 474ms，超过 200ms 门槛；Notebook 工作没有修改该子系统，本账本不宣称 P3 全面通过。

账本文档检查：在上述物理工作目录运行 `python3 .artifacts/research-optimization/check-closure-ledger.py`，核对本页的本地链接、提交引用、命令入口、证据文件和完整串行检查摘要；结果保存在 `closure-ledger-check.json`。提交前另运行 `git diff --cached --check` 并核对仅暂存本账本。既有用户 README 改动、六份 Harness 文档移动和原始执行计划均保留在暂存区之外。

## 未完成验收及解除条件

| 范围 | 状态 | 尚需的具体输入或证据 |
| --- | --- | --- |
| ROC-PR-03 完整数据 | Blocked, not run | 200 项满足任务族配额、独立来源簇、split、许可和独立审核的冻结数据；工程 fixture 不充当独立科学样本 |
| L2 pilot / 完整真实模型 / L3 | Blocked, not run | 隔离 Provider 凭证、可信价格或可证明硬费用上限、固定协议/模型/环境/目标及明确费用授权；L3 还需独立操作与放量授权 |
| 检索、长期上下文、注入/反证、综述和论证质量 | Blocked, not run | 独立人工标注、原始资料和领域盲审；本地统计工具与确定性测试不能替代 |
| Zotero | Blocked, not run | 实际 Zotero 客户端、原生文件选择框及附件互操作记录 |
| 外部 Provider / Hub / OpenReview | Blocked, not run | 真实环境的有界集成记录，以及具体数据/模型的访问与许可决定；已有官方合同探测不等于全面互操作 |
| Zenodo | Blocked, not run | 官方 sandbox 隔离账号与目标授权、真实 native safeStorage 集成；实际公开发布另需具体包/作者/许可/远端目标的独立批准 |
| 外部 Trace | Blocked, not run | 明确接收目标、字段范围及传输授权；现有导出只写受管本地文件 |
| 更广性能/科学代表性 | Blocked, not run | 代表性扫描 OCR、真实用户库/模型缓存、真实 Provider 延迟及科学 PDF 标注；P3 refresh 的历史性能缺口仍保留 |

OSF Projects 写入同步已按政策核查作出不实施决定，不计作等待实现的功能。可选只读导入或独立预注册服务需另行明确目标。本地提交与测试已经覆盖上表标明的工程范围；剩余验收条件未满足前，保持总体计划未全部完成。
