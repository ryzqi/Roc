# 文档索引

产品简介与启动入口见根 [README](../README.md)，统一术语见 [CONTEXT](../CONTEXT.md)，开发命令见[开发指南](development.md)。本目录按专题维护当前合同；架构取舍保留在 ADR，评测方法集中在 [evaluation](../evaluation/README.md)。

## 工作台与执行

| 文档 | 内容 |
| --- | --- |
| [任务导航与组件设计契约](design-system.md) | 四个目的地及子视图、对象打开、状态与视觉约束、官方设计参考 |
| [UI 重构验证](ui-refactor-validation.md) | 阶段工程证据、验收缺口与回滚范围 |
| [UX 与动效合同](ux-motion/README.md) | 全界面状态清单、动效生命周期、阶段交付和当前生产采样 |
| [科研工作台](research-workbench.md) | 壳层、路由、助手输入与停止确认、文稿编辑和异步表单 |
| [终端会话](terminal-sessions.md) | PTY 所有权、显示分离、输出回放与窗口清理 |
| [科研工件检查器](research-artifact-inspector.md) | 工件快照、生产文件与人工审核版本 |
| [Idea Canvas、方法计划与结果评估](research-ideas.md) | 构思晋升、方案批准与结果裁决 |
| [科研实验运行](research-experiments.md) | TypeScript、R、Julia、Python 实验执行 |
| [Python 环境自动准备、预检与执行](research-python-environment.md) | CPython 自动发现、冻结检查与执行边界 |
| [Notebook 导入与执行合同](research-notebooks.md) | Notebook 导入、预览与 Python 子集执行 |
| [实验指标、审核与比较](research-experiment-results.md) | 结构化结果、指标 Evidence 与可比性 |
| [科研执行资源治理](research-execution-resources.md) | 计算准入、资源采样、原生隔离与崩溃清理 |
| [ResearchTask：任务事实、执行观测与离线诊断](research-task-observability.md) | 任务上下文、用量、日志、Trace 与诊断 |
| [Agent 最终响应合同](agent-response-contract.md) | 显式 JSON 要求、一次纠正、终轮验收与能力提示 |
| [Agent 记忆](agent-memory.md) | 项目隔离、运行快照、长期记忆与验证边界 |
| [Agent harness 工具与提示词](agent-harness.md) | 能力指引、截断保护、纠正/追加输入、文件效果恢复与长输出合同 |
| [Codex / Pi 源码研究与 harness 优化](codex-pi-harness-analysis.md) | 固定源码对照、P0 实现与后续优先级 |

## 文献、阅读与综述

| 文档 | 内容 |
| --- | --- |
| [学术检索融合](research-literature-fusion.md) | 多源检索、融合、原始池与执行回执 |
| [文献自动入库](research-literature-acquisition.md) | PDF、解析、全文索引、Wiki 就绪状态与恢复合同 |
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
| [工作稿同步](research-manuscript-sync.md) | `.tex` / `.bib`、逐段采纳和导出核对 |
| [证据矩阵与论证大纲](research-argument-outline.md) | 论证结构、正文生成和小样本提取检查 |
| [变更影响与定向修复](research-impact.md) | 记录依赖、修复输入与新运行 |
| [科研图稿](research-figures.md) | Vega 定量图稿、Mermaid 方法图与人工数据映射 |
| [Review Response Matrix](research-response-matrix.md) | 审稿意见与回复矩阵 |
| [外部反馈与实验回流](research-collaboration.md) | Word/PDF 意见、持久等待和外部报告证据 |
| [Journal Compliance](research-journal-compliance.md) | 版本化期刊规则与符合性报告 |
| [投稿配置与投稿包](research-submissions.md) | 复用规则、实际 PDF 预检、署名与匿名变体 |
| [科研最终导出](research-exports.md) | 冻结正文、审核快照、DOCX/HTML 与 arXiv 候选包 |
| [科研 RO-Crate 合同](research-ro-crate.md) | RO-Crate 侧车、实体关系与公开投影 |

## 科研资源与外部服务

| 文档 | 内容 |
| --- | --- |
| [科研资源与 DataCite 元数据观察](research-resources.md) | 资源注册、来源快照与 OSF 访问政策 |
| [Hugging Face fixed revision resources](research-huggingface.md) | Hub 元数据、固定 revision 与用户批准下载 |
| [OpenReview public observations](research-openreview.md) | OpenReview 只读导入与来源政策 |
| [Reviewed Zenodo publication](research-zenodo.md) | Zenodo 草稿、独立发布批准与 DOI 回执 |

## 开发与评测

| 文档 | 内容 |
| --- | --- |
| [数据库存储](database-storage.md) | 当前结构初始化、维护与不兼容库处理 |
| [开发指南](development.md) | 构建、测试选择、smoke 替代行为与运行产物 |
| [科研工作流实施验收](research-workflow-validation-2026-11-23.md) | 八项优化提交、原生闭环、回归命令及验证边界 |
| [评测指南](../evaluation/README.md) | 套件、输入资格、运行、对照与证据保留 |
| [文献检索与获取评测](literature-evaluation.md) | 公网捕获、独立标注、排名与获取指标及受控工程检查 |
| [macOS GitHub 发布](github-releases.md) | main 自动预发布、版本标签发布、本地预演与失败重试 |
| [科研性能测量](research-performance.md) | 测量入口、协议边界与固定测量文件 |
| [Scientific RAG 当前实现](scientific-rag/00-current-state.md) | 生产能力、版本来源与科学质量边界 |
| [Scientific RAG 专题索引](scientific-rag/README.md) | 架构、数据合同、抽取协议与评测方法 |
| [科研运行时](../resources/research-runtime/README.md) | OCR 模型、原生工具链、准备与 smoke 环境 |
| [内置技能源（Built-in skills）](builtin-skills.md) | 随包技能来源、安装、固定提交同步与许可 |
| [RTK 集成](rtk-integration.md) | 随包 RTK、显式压缩与生产命令工具边界 |

## 架构决定

ADR 记录决定、理由与代价，功能操作由上面的专题维护。阶段能力与工件检查器的关系见 ADR 0024。

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

## 文档分工

专题以一份主文档维护：方法计划归入 Idea，任务上下文归入任务观测，PDF 坐标归入阅读导航，Vale 归入写作检查，OSF 政策归入资源。跨专题通过链接引用，具体版本、枚举与资源摘要以链接的源码或锁文件为准。

旧实施日志、逐次验证结果和清理流水不作为维护文档；需要追溯时查看 Git 历史。固定测量数据保留各自来源，解释见[性能测量](research-performance.md)。[Vale 入口](research-prose.md)仅供随包规则引用，正文统一在写作检查。

## 测试 seam

源码中 `ROC_SMOKE` 注释所指的替代行为清单统一维护在[开发指南](development.md#测试替代行为)。
