# Findings & Decisions

## Requirements
- 用户要求：把 Roc 全面改造成科研助手，覆盖论文查阅、论文管理、头脑风暴、论文写作、画图等科研全流程。
- 用户指定参考并希望内置其能力：`Imbad0202/academic-research-skills`、`Yuan1z0825/nature-skills`、`Haojae/scipilot-figure-skill`。
- 首要用户：个人研究者；默认单用户、本地优先，协作后置。
- 核心组织：项目中心 + 全局文献库；论文可跨项目复用，笔记、想法、草稿、图稿归属研究项目。
- 论文来源：开放学术 API + DOI/PDF 本地导入；首版不以受限站点抓取为基础。
- 可信度约束：严格证据链；摘要、综述、论点和正文绑定来源及页码/段落，假设和待验证内容显式标记。
- 写作格式：LaTeX 为主，实时渲染，支持 PDF 导出。
- 绘图方式：代码优先，实时预览，导出 SVG/PDF/PNG。
- 技能运行方式：全部技能内置，按工作流选择性启用；采用多智能体，每个阶段只暴露对应 Skill。
- 流程控制：阶段化流水线，可暂停、恢复、回退和中途进入；必须持久追踪当前所处流程/阶段。
- 人工审核：证据集、提纲、正文改写、图稿、最终导出等关键产物需要确认；元数据整理等低风险步骤可自动推进。
- 隐私与联网：用户明确允许所有材料发送给已配置模型，全面开放联网。
- 模型编排：按阶段配置模型档位，支持全局默认与手动覆盖，记录实际模型和版本。
- 文献互操作：BibTeX/BibLaTeX、DOI 去重、Zotero 导入导出。
- 阅读输入：PDF、扫描 PDF、HTML、DOI 全支持，含 OCR、图表抽取和公式识别；抽取结果保留页码/段落/图表定位。
- 实现原则：直接使用当前已有的成熟开源项目，避免重写解析、编译、OCR 和绘图核心能力。
- 依赖分发：LaTeX、OCR、Python 绘图及其运行时全部随应用打包；需纳入体积、许可、签名、公证和升级治理。
- 当前按 `grill-with-docs` 执行：先逐题确认决策；共享理解确认前不改应用代码。

## Research Findings
- Roc 是 macOS Electron 44 + React 19 桌面应用；Agent 层使用 DeepAgents/LangGraph，数据层使用 SQLite，renderer/preload/main 通过 Zod IPC 合同隔离。
- 现有 ViewId 包含 chat、tasks-board、task-detail、workspace、git、terminal、preview、mcp、skills、memory、settings、diagnostics；适合在现有工作台扩展科研域视图，而非另起应用壳。
- 现有插件职责包含 agent、workspace、mcp、skills、task、memory、app、diagnostics、runtime-tools；SkillService 已支持导入、启用/禁用、删除和文件树读取。
- Agent context 已支持显式 skill 注入：授权清单映射为 `/skills/{id}/SKILL.md`，prompt block、memory_search、session_search、remember、context artifact 均已有扩展点。
- `academic-research-skills` 是大规模科研流程 Skill 集，仓库路径显示包含 `academic-paper`、`academic-paper-reviewer`、`academic-pipeline`、`deep-research`，并配套 agents、references、templates、commands；公开描述为 research → write → review → revise → finalize。
- `nature-skills` 是多组 Nature 风格科研能力，路径显示包含 `nature-reader`、`nature-writing`、`nature-polishing`、`nature-reviewer`、`nature-statistics`、`nature-response`、`nature-paper2ppt`、`nature-paper-to-patent` 等，并有共享规范与校验脚本。
- `scipilot-figure-skill` 聚焦出版级科研绘图，包含数据 profiling、图表选择、plot recipes、期刊规格、视觉检查、导出和 QA 脚本。
- `academic-paper/SKILL.md` 明确提供 12-agent、8 阶段流程：配置、检索、结构、论证、起草、引用/摘要、同行评审、格式化；支持 LaTeX/DOCX/PDF/Markdown、5 种引用格式，并包含 visualization agent（matplotlib/R）和 revision coach。
- `academic-paper` 的阶段边界与用户确认的阶段化流水线高度匹配，可作为内置写作编排的来源规范；其 agent 角色不能直接全部暴露给每个阶段。
- 当前 Roc 打包校验只允许 app.asar 中 `dist`、`node_modules`、`package.json`，原生模块放 `app.asar.unpacked`；完整打包 TeX/OCR/Python 需扩展资源布局、安装包校验、签名/公证和体积预算。
- 工具链治理：版本和校验哈希锁定，随应用发布，维护第三方许可证清单。
- 语言与学科：中文界面、项目级中英双语、跨学科默认；Nature 风格为可选期刊规范。
- 参考仓库许可：实际 LICENSE 核查确认 `academic-research-skills` 为 CC BY-NC 4.0（非商业），`nature-skills` 为 Apache-2.0，`scipilot-figure-skill` 为 MIT。`academic-research-skills` 不能直接随商业应用分发；原样内置前需遵守各仓库 LICENSE/NOTICE。
- 分发约束：用户要求全面开源，但 CC BY-NC 不是 OSI 开源许可；不能把含该内容的整体项目宣称为可商业使用的标准开源项目。推荐核心代码采用 Apache-2.0/MIT，Apache/MIT 技能随包分发，NC 技能独立非商业插件或原创重写。
- 许可决策：核心 Apache-2.0/MIT；Apache/MIT 技能可随包；CC BY-NC 技能独立非商业插件或原创重写。
- 首批检索源：OpenAlex、Crossref、Semantic Scholar、arXiv、PubMed/Europe PMC；统一 DOI、作者、摘要、引用、开放获取链接和来源可信度字段。
- 知识库检索：向量 + 关键词混合检索，使用 Reciprocal Rank Fusion（RRF）排序；提供嵌入模型配置。
- 嵌入模型：接 OpenAI 兼容 Embeddings API；用户自行配置 API 地址、Key、模型等；切换模型需要重建索引。
- 向量存储：SQLite + sqlite-vec，与现有 FTS5 共库；统一单机备份、恢复和权限边界。
- 索引触发：项目目录监听 + 增量索引，支持手动重建、暂停和失败重试；索引状态需在流程面板可见。
- 索引材料：默认纳入 `.tex`、`.bib`、`.md`、`.pdf`、`.csv` 和图片 OCR；支持 include/exclude，构建产物、缓存和敏感目录排除。
- 头脑风暴：使用结构化 Idea Canvas，记录问题、假设、新颖性、证据、实验、风险；可晋升为研究项目，版本与来源自动关联。
- 写作规范：仅提供通用学术写作，不做期刊规范；支持导入用户模板。Nature 能力作为可选阅读、质量和绘图 Skill，不自动施加期刊规则。
- 模板导入：LaTeX 模板目录/ZIP，包含 `.tex`、`.cls`、`.sty`、`.bib` 和图片；自动识别入口并实时编译。
- 标准科研流程：发现、检索、阅读、构思、方案、实验/数据、绘图、写作、审稿、修订、导出，共 11 阶段；每阶段有专属 Agent、Skill、输入输出和审核状态。
- 实验与数据分析：纳入项目工作流，支持 Python/R/Julia 脚本或 Notebook；记录参数、环境、产物和 provenance，并连接图稿、证据、论文段落。
- 实验环境：项目内置锁文件，使用 `uv`、`renv`、Julia 环境探测；运行前校验并记录环境摘要，不为每个项目重复打包完整环境。
- 审稿结构：多角色独立评审 + 综合智能体汇总，最多两轮修订；保留每个角色的证据、分歧和结论。
- 流程可视化：项目页常驻流程轨道、顶部当前阶段、事件时间线；持续显示 Agent、审核、失败和下一步。
- Provenance：主张、段落和图表逐项关联来源片段、代码运行、模型运行和时间；最终稿可反查证据、数据、脚本和生成记录。
- 无证据主张：阻断正文写入和最终导出，降级为“假设”或“待验证”占位。
- 参考仓库均为公开 GitHub 仓库；本轮通过 agent-reach 的 GitHub REST/raw 路由只读核查。GitHub CLI 本地未登录，不能依赖 `gh` 登录态。

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 以内置 Skill 包 + 科研领域插件/视图组合实现 | 复用 Roc 已有 SkillService、显式 skill context、MCP、Agent 与 IPC 边界，降低重写风险 |
| 研究资料、草稿、图稿和 provenance 必须进入可持久化领域模型 | 科研工作流需要可追溯、可恢复、跨会话关联；不能只靠聊天记录 |
| 首要交互默认本地单用户 | 与用户确认的个人研究者场景一致；降低首版账号、同步、权限复杂度 |
| 项目中心 + 全局文献库 | 用户确认；支持跨项目引用同一论文，同时为产物提供明确归属 |
| 开放学术 API + DOI/PDF 导入 | 用户确认；首版可实现可复现检索与本地材料管理，减少站点合规和稳定性风险 |
| 严格证据链 | 用户确认；科研输出必须可回溯，减少无依据内容进入稿件 |
| LaTeX-first 写作 | 用户确认；需要编辑器、编译预览、错误定位和 PDF 导出链路 |
| 代码优先科研绘图 | 用户确认；适配数据 profiling、图表选择、期刊规格、视觉 QA 和可复现导出 |
| 阶段化多智能体 + 角色 Skill 隔离 | 用户确认；每个环节只暴露对应能力，降低越权、上下文污染和输出混淆 |
| 可恢复的阶段状态机 | 用户确认；流程位置是核心产品状态，需支持断点恢复、回退和审计 |
| 关键产物人工审核 | 用户确认；在不可逆或高影响科研输出前保留明确的人类控制点 |
| 全面开放联网 | 用户确认；联网检索和模型处理不再设置项目级默认阻断，仍使用已配置 Provider/密钥 |
| 阶段模型策略 | 用户确认；模型能力与成本按工作流阶段匹配，并保留执行可追踪性 |
| BibTeX/Zotero 互操作 | 用户确认；LaTeX 引用为主，同时支持既有文献库迁移和去重 |
| 成熟开源集成优先 | 用户确认；核心科研能力基于现有成熟项目，Roc 负责编排、权限、状态和证据追踪 |
| 全依赖随应用分发 | 用户确认；优先开箱即用和离线可执行，必须固定版本并保留第三方清单 |
| 锁定并随应用分发工具链 | 用户确认；保证结果可复现，便于审核和升级回归 |
| 项目级双语与跨学科默认 | 用户确认；避免把单一语言或 Nature 规范硬编码为全局默认 |
| 多源学术检索适配器 | 用户确认；以统一文献记录承接不同 API，支持降级和去重 |
| 混合知识库检索 + RRF | 用户确认；同时利用精确词匹配和语义相似度，降低单一召回方式的盲点 |
| 用户配置 OpenAI 兼容嵌入 | 用户确认；复用现有 Provider/Secret 管理，同时允许不同兼容服务 |
| SQLite + sqlite-vec 共库 | 用户确认；减少桌面服务依赖，保持本地数据运维路径一致 |
| 监听式增量索引 | 用户确认；让知识库跟随项目文件变化，同时保留人工控制和可恢复失败路径 |
| 类型化索引范围 | 用户确认；覆盖科研核心材料并避免无关构建文件污染召回 |
| Idea Canvas 领域对象 | 用户确认；把开放式构思变成可评估、可追踪、可转项目的研究对象 |
| 通用写作 + 用户模板 | 用户确认；避免维护脆弱的期刊规则，使用导入模板承接格式约束 |
| LaTeX 模板包导入 | 用户确认；保留完整模板资源，编译错误可定位到源文件和行号 |
| 11 阶段科研状态机 | 用户确认；统一多智能体路由、流程追踪、审核闸门和断点恢复 |
| 实验 provenance 一等记录 | 用户确认；保证数据处理、图表和论文主张可追溯、可复现 |
| 项目锁文件 + 环境摘要 | 用户确认；在应用工具链固定之外，保留项目自身实验依赖的可复现边界 |
| 多角色审稿与综合 | 用户确认；独立意见减少单模型偏差，综合结果提供可执行修订路线 |
| 常驻流程状态 UI | 用户确认；当前阶段和下一步不能隐藏在聊天记录中 |
| 细粒度 Provenance | 用户确认；把科研输出连接回证据、数据、脚本和模型执行，支持审计与复现 |
| 无证据主张硬闸门 | 用户确认；防止未经支持的内容进入可提交稿件 |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| planning hook 拒绝 symlink/reparse-point context | 物理路径与计划文件可直接访问；记录并继续 |
| 两个参考仓库 raw SKILL 请求超时 | 保留已成功的 REST 元数据/目录结果；后续改用分块 API 或本地浅克隆，避免重复超时请求 |
| `academic-research-skills` 为 CC BY-NC 4.0 | 在分发性质确认前不原样打包；商业场景改为独立授权或仅实现兼容的原创流程 |
| “全面开源”与 CC BY-NC 冲突 | 等待许可边界决策；核心许可、第三方技能许可和可选插件需分离 |
| 许可边界已确认 | 核心与 Apache/MIT 能力可随包；NC 能力不进入标准开源核心分发 |
| 底层到界面的六阶段交付 | 先稳定领域模型、索引、状态机和 provenance，再接入生产工具、UI 和打包，降低跨层返工 |
| sqlite-vec + FTS5 + RRF 已实现 | `sqlite-vec` 0.1.9 可加载；知识库支持文献 API 归一化、关键词/向量召回和 RRF 结果 |

## Resources
- `https://github.com/Imbad0202/academic-research-skills`
- `https://github.com/Yuan1z0825/nature-skills`
- `https://github.com/Haojae/scipilot-figure-skill`
- `README.md`、`package.json`、`src/shared/ipc-registry.ts`、`src/renderer/app/types.ts`、`src/main/services/skill-service.ts`、`src/main/services/deep-agent/context/`
