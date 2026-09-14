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
- Idea Canvas：构思阶段现在要求七字段结构化快照和证据引用；批准后才能晋升，来源三字段必须同时存在。晋升与来源事件同一事务，失败回滚。旧运行上下文在 v15 补 language/origin/ideaCanvas。
- 科研 Agent 接线：4g3 已让实验/绘图/导出阶段 complete() 绑定本次运行链已发布的真实工件，并追加模型 provenance；未发布则失败并保留模型版本。失败/重试留下已发布记录，重试成功后把输出写到这些工件。人工批准和最终 ZIP 仍不向模型开放。
- 最终导出实际发现：Tectonic 按嵌套入口目录解析 input/bibliography；只在 source 根层生成内容会成功编译旧占位正文。BibTeX crossref 父条目须随引用一起收集并位于子条目之后；Tectonic 可在 BibTeX 出错时仍返回 0。均有真实 PDF 先失败后通过的回归，导出边界另拦截“错误被忽略”的报告。
- 最终导出预研：现有 evidence.exportBundle 返回已批准正文、主张和证据；正文是含内联 thebibliography 的 LaTeX 片段。review.requireForStage 对 export 要求 accepted 的审稿周期。模板服务会冻结源文件后编译并记录 PDF 哈希，但当前没有把批准正文、图稿、引用文件与最终交付文件绑定的导出作业；4f 需在这些既有边界上接线。
- 绘图：Context7 的 Matplotlib 官方文档确认 Figure.savefig 可对同一对象导出 PNG/SVG/PDF；PDF 使用 CreationDate=None 去掉时间戳，SVG 使用 Date=None 和固定 svg.hashsalt。当前固定 Matplotlib 3.11.1 已实际验证连续两次渲染的全部输出字节相同，PNG 为 600×450，PDF/SVG 为 288×216 pt；图稿内容正确性仍由关联证据和人工审核判断。
- R/Julia 实际运行已验证：R 的 libc popen/system 经 fork/exec 适配后可保持 syscall 82/147/244 禁止，普通 popen 与 DARWIN_EXTSN 入口都需适配；R_LIBS_SITE 必须设为 NULL，空值会恢复系统库。Julia 按 Base.preferences_names 与 Pkg.Artifacts.artifact_names 收集冻结配置，避免丢失优先文件。两项环境差异均经真实 red-green 回归确认；项目环境不自动安装或改写。
- Python 实验环境：uv 在查询解释器时会加载项目 `.pth`；仅 `-I/-B` 不能阻止它。当前流程在禁止脱离进程组的 Python 中探测真实包，再让固定 uv 检查独立的安装元数据副本；uv 环境必须共享内置 Python，且不继承系统包。实际 `.pth`、wheel、Notebook 取消和完整工具链验证均已通过。
- R/Julia 预备验证：Julia 官方 versions.json 当前稳定版 1.13.0，arm64 TAR SHA-256 `c8546ad39de9df9edd74b8104066fb23be0ece60890bb2dbfffadd24e73ba2c2`；已下载并私有解包，Pkg 当前接口可用。CRAN R 4.6.1 arm64 pkg 官方 SHA1 `fc9f4ada15589e8e037b9bf05563d21e97181635`，下载后的 SHA-256 `67f6eea4ced4ce48f0a0d4fa3a1cac43d1859a05a88993ee3dff7c52e7edbc4b`，Apple 签名/公证通过；私有解包的 R 仍需处理硬编码 Framework 动态库路径。没有修改系统安装。
- 实验环境接线：已安装 uv 的帮助明确支持 `sync --check`（环境与项目同步检查）和 `--locked`；Context7 官方 uv 文档确认 `lock --check` 对项目元数据过期返回错误。后续运行前需同时验证环境和锁文件，不能用 `--no-sync` 代替环境一致性验证。
- 文献互操作：Context7 的 Zotero 官方文档确认 BibTeX、BibLaTeX 与 CSL JSON 均支持导入/导出。已安装 Bibtexparser 2.0.0 提供默认字符串宏展开、失败块、SeparateCoAuthors/SplitNameParts；名称拆分应在 LaTeX 解码之前，以保留机构作者。4c 优先完成文献库与互操作，再接文档/目录索引。
- 下一增量的 macOS 进程隔离预检：手写 deny-default profile 即使放开文件读取仍使 Python 启动 SIGABRT；当前系统 `/System/Library/Sandbox/Profiles/system.sb` 包含必要 dyld/系统初始化规则。引入 system.sb 并允许 mach-bootstrap/syscall 后受限 Python 启动通过。应用接线时仍须验证项目外读写拒绝与子进程取消，尚未把该原型作为已完成能力。
- 离线打包：Tectonic 0.17.0 `ZipBundle` 按文件名直接读取，bundle 内须包含 SHA256SUM；旧官方 TAR 本身是扁平资源布局。私有 Python 使用 standalone 基础解释器及由 `uv.lock` 导出的带哈希依赖，直接安装进私有 prefix，避免依赖开发 venv 的外部解释器路径。
- Production 续作：Tectonic 最新正式发布为 0.17.0；官方 arm64 SHA-256 为 `a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667`，x64 为 `7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80`。来源：`https://api.github.com/repos/tectonic-typesetting/tectonic/releases/latest`（2026-09-11）。
- Python 源包已核实：Docling 2.126.0（MIT）、PDFium2 5.13.0（BSD/Apache + dependency notices）、Matplotlib 3.11.1、RapidOCR 3.9.2（Apache-2.0）；需先核查 Intel wheel 及模型许可，再固定工具链锁文件。
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
| Idea Canvas 独立领域对象，批准后晋升并复制项目语言 | 头脑风暴产物可评估、可追踪、可转项目；界面语言仍中文，内容语言按项目设置 |
| 实验/绘图/导出阶段输出绑定已发布真实工件，并追加模型 provenance | 避免 complete() 另造 path=null 空产物；失败/重试保留已发布记录，模型不能批准或最终交付 |
| 生产输入通过实际执行/发布关联读取，模型只提交捕获输入中的 artifactId 与登记 area/path | 不依赖模型描述或工件路径推断执行结果；读取前后验证人工批准、运行有效性和内容哈希 |
| 已批准导出读取冻结内容，最终发布/审核/交付仍验证当前来源 | 历史批准输入需要可复查，不能因当前源文件变化失去冻结证据；交付继续采用原有严格闸门 |
| Python 3.12.14 + 双架构 uv.lock（149 包），Docling PDFium 后端与 Vision OCR | Intel PyTorch 官方 wheel 限于 Python <=3.12；当前 Docling 声明兼容 torch>=2.2.2，架构锁保留 Intel 支持，ARM 使用当前版本；OCR 不依赖无 Intel wheel 的新 ONNX Runtime |
| 审稿/修订循环以当前已批准正文为输入，回到审稿时保留该稿，旧报告独立存档 | 线性阶段顺序不能把修订稿误当成需作废的下游输出；报告互盲，综合阶段显式读取三份结果 |
| 证据快照与索引记录分离；来源元数据参与版本摘要 | 重建/删除索引不丢失已引用原文，同一 chunk 的来源更正形成新证据 |
| 主张修订保存版本历史、写入需 expectedVersion；正文保存段落引用和摘要 | 拦截并发旧写入，保留修订来源，阻止过期正文直接审核/导出 |
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
| CSL/DOI 互操作的真实字段形状与数据保留 | Crossref 的 journal-article 与 ISSN/ISBN 数组在 API 边界映射；来源保存完整书目快照；期刊字段与日期字段成组合并，避免静默覆盖 |
| 验证时额外 .pyc 使完整性清单失败 | 私有解释器使用 -B，搬迁测试子进程显式继承 PYTHONDONTWRITEBYTECODE=1；最新工具链在全套测试及真实导入后完整性校验通过 |
| 文献元数据初始实现缺少边界回归 | 新增批量索引中途失败回滚、旧引用证据保留及 shutdown 迟到结果测试；已复现并修正仓储 4 项问题 |
| Bib 字段顺序改变导致无 DOI 文献重复导入为新记录 | 本地内容身份采用排序后的字段，保留 source/externalId 与 DOI 的去重层级 |
| 续作盘点：Workflow 只有 start/pause/resume/complete/approve/reject；Artifact 无 IPC、创建与关联未使用事务、审批版本可被原地改写 | 第一部分补齐导航与产物生命周期；独立验证并 review 后提交 |
| Context7 未注册到当前 MCP / mcporter | 尝试官方远程 MCP；已安装类型与仓库代码仍作为本地 API 依据 |
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
