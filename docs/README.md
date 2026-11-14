# 文档索引

产品简介与启动入口见根 [README](../README.md)，统一术语见 [CONTEXT](../CONTEXT.md)。本目录的专题说明当前合同；架构取舍保留在 ADR，历史研究与性能测量明确标注基线。

## 工作台与执行

| 文档 | 内容 |
| --- | --- |
| [科研工作台](research-workbench.md) | 壳层、路由、助手工具与阶段入口 |
| [科研工件检查器](research-artifact-inspector.md) | 工件快照、生产文件与人工审核版本 |
| [Idea Canvas、方法计划与结果评估](research-ideas.md) | 构思晋升、方案批准与结果裁决 |
| [科研实验运行](research-experiments.md) | TypeScript、R、Julia、Python 实验执行 |
| [Python 环境选择、预检与执行](research-python-environment.md) | CPython 环境选择、冻结检查与执行边界 |
| [Notebook 导入与执行合同](research-notebooks.md) | Notebook 导入、预览与 Python 子集执行 |
| [实验指标、审核与比较](research-experiment-results.md) | 结构化结果、指标 Evidence 与可比性 |
| [科研执行资源治理](research-execution-resources.md) | 计算准入、资源采样、原生隔离与崩溃清理 |
| [ResearchTask：任务事实、执行观测与离线诊断](research-task-observability.md) | 任务上下文、用量、日志、Trace 与诊断 |
| [Agent 最终响应合同](agent-response-contract.md) | 显式 JSON 要求、一次纠正、终轮验收与能力提示 |

## 文献、阅读与综述

| 文档 | 内容 |
| --- | --- |
| [学术检索融合](research-literature-fusion.md) | 多源检索、融合、原始池与执行回执 |
| [Zotero 本地只读接入](research-zotero.md) | Zotero 本地只读同步、检查点与附件导入 |
| [原 PDF 与解析定位](research-pdf-navigation.md) | 原文/解析导航、坐标、批注与证据定位 |
| [结构化阅读、笔记与学术雷达](research-reading-radar.md) | 结构化阅读、笔记、翻译与学术雷达 |
| [证据来源与关系审核](research-evidence-relations.md) | 固定来源、主张关系、人工审核与来源替代 |
| [科研 RAG 与持久 Wiki](research-rag-wiki.md) | 论文语义结构、精排、卡片、修订与章节导航 |
| [学术关系来源快照](research-scholarly-relations.md) | 引文网络、来源关系与数据边界 |
| [系统性综述](research-systematic-review.md) | 协议、筛选、提取、质量评价与综述报告 |
| [文献持续监控](research-monitors.md) | 保存检索、增量监控与用户确认 |

## 写作与交付

| 文档 | 内容 |
| --- | --- |
| [科研写作检查](research-writing-checks.md) | 文献字段、正文一致性、数值映射、引文审核与 Vale |
| [科研图稿](research-figures.md) | Vega 定量图稿、Mermaid 方法图与人工数据映射 |
| [Review Response Matrix](research-response-matrix.md) | 审稿意见与回复矩阵 |
| [Journal Compliance](research-journal-compliance.md) | 版本化期刊规则与符合性报告 |
| [科研最终导出](research-exports.md) | 冻结正文、审核快照、DOCX/HTML 与 arXiv 候选包 |
| [科研 RO-Crate 合同](research-ro-crate.md) | RO-Crate 侧车、实体关系与公开投影 |

## 科研资源与外部服务

| 文档 | 内容 |
| --- | --- |
| [科研资源与 DataCite 元数据观察](research-resources.md) | 资源注册、来源快照与 OSF 访问政策 |
| [Hugging Face fixed revision resources](research-huggingface.md) | Hub 元数据、固定 revision 与用户批准下载 |
| [OpenReview public observations](research-openreview.md) | OpenReview 只读导入与来源政策 |
| [Reviewed Zenodo publication](research-zenodo.md) | Zenodo 草稿、独立发布批准与 DOI 回执 |

## 开发与验证

| 文档 | 内容 |
| --- | --- |
| [数据库存储](database-storage.md) | 当前结构初始化、维护与不兼容库处理 |
| [验证入口](verification.md) | 开发命令、测试范围与尚需独立验收的边界 |
| [Research performance baselines](research-performance.md) | 历史性能协议、基线与复现入口 |
| [内置技能源（Built-in skills）](builtin-skills.md) | 随包技能来源、安装、同步与许可 |
| [RTK 集成](rtk-integration.md) | 随包 RTK、显式压缩与生产命令工具边界 |

## 架构决定

编号按时间递增，保留原决策背景。已删除阶段页与现有工件检查器的区别见 ADR 0024。

| ADR | 决定 |
| --- | --- |
| [0001](adr/0001-research-workbench-architecture.md) | Research workbench architecture |
| [0002](adr/0002-project-list-entry.md) | 项目列表作为入口，科研服务只在项目内 |
| [0020](adr/0020-conversation-drives-stages.md) | 对话驱动阶段 |
| [0021](adr/0021-three-column-workbench-ia.md) | 三栏工作台 IA |
| [0022](adr/0022-single-frontend-after-cutover.md) | 切换后仓库里只有一套前端 |
| [0023](adr/0023-visual-and-motion-spec.md) | 视觉与动效口径 |
| [0024](adr/0024-stage-surface-removed.md) | 阶段面已删除 |
| [0025](adr/0025-typst-report-engine.md) | 导出附带报告用 Typst，不替换 LaTeX 主链 |
| [0026](adr/0026-async-secret-storage.md) | 密钥存储只有异步一条路 |
| [0027](adr/0027-retain-roc-context-compaction.md) | Retain Roc’s Context Compaction Pipeline |
| [0028](adr/0028-execution-task-ownership.md) | 执行协议共享，根任务与节点事实归一个持久所有者 |
| [0029](adr/0029-scientific-verification-boundaries.md) | 科研核验建议与人工证据决定分开保存 |
| [0030](adr/0030-required-skill-contracts.md) | 十一阶段 Skill 必填 Manifest，共用上下文装配 |

视觉与动效的实现规范是 [tokens.css](../src/renderer/styles/tokens.css) 和 [motion.ts](../src/renderer/shared/motion.ts)；文档不复制一套 token。工具链与许可证见 [research-runtime](../resources/research-runtime/README.md)，阶段技能见 [research-skills](../resources/research-skills)。

## 历史报告与测量产物

[2026-11-07 写作生态调研](reports/2026-11-07-scientific-writing-ecosystem.md)和 [2026-11-08 Agent 审计](agent-harness-evaluation-audit-2026-11-08.md)保留当时的观察，不作为当前待办清单或命令指南。当前评测入口见 [evaluation](../evaluation/README.md)。性能协议和基线 JSON 保留原始测量与来源，由[性能文档](research-performance.md)解释；更新文档不代表重新执行基准。

专题以一份主文档维护：方法计划归入 Idea，任务上下文归入任务观测，PDF 坐标归入阅读导航，Vale 归入写作检查，OSF 政策归入资源。[Vale 旧入口](research-prose.md)仅保留跳转，供随包规则引用。过期实施流水账已移除，验证入口和未完成的独立验收范围集中在[验证说明](verification.md)。
