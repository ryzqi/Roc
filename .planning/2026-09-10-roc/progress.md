# Progress Log

## Session: 2026-09-10

### Current Status
- **Phase:** 3 - Implementation（Workflow）
- **Started:** 2026-09-10

### Actions Taken
- 按 `grill-with-docs` 读取并启用 grilling/domain-modeling 约束。
- 运行 CodeGraph，确认现有 ViewId、SkillService、显式技能上下文、Prompt blocks、SQLite 数据库与 IPC 结构。
- 运行 `agent-reach doctor --json`；GitHub 后端环境可用，但 `gh` 账户未登录。
- 通过 GitHub REST/raw 只读核查三个参考仓库元数据、目录和技能覆盖面。
- 创建持久计划目录 `.planning/2026-09-10-roc/`。
- 用户确认首要用户为个人研究者；产品默认单用户、本地优先。
- 用户确认采用项目中心 + 全局文献库；论文跨项目复用，研究产物挂在项目下。
- 用户确认论文来源为开放学术 API + DOI/PDF 本地导入。
- 用户确认严格证据链；生成内容绑定来源与页码/段落，假设与待验证内容显式标记。
- 用户确认 LaTeX 为主要写作格式，要求实时渲染并支持 PDF 导出。
- 用户确认绘图采用代码优先方案，要求实时预览并导出 SVG/PDF/PNG。
- 用户确认全部技能内置并按工作流选择性启用；采用多智能体，每个环节只暴露对应 Skill。
- 用户确认阶段化流水线，要求持久追踪当前流程和阶段。
- 用户确认关键产物人工审核闸门；低风险元数据步骤可自动推进。
- 用户确认全面开放联网，所有材料可发送给已配置模型。
- 用户确认按阶段配置模型档位，支持默认策略、手动覆盖并记录模型版本。
- 用户确认文献管理支持 BibTeX/BibLaTeX、DOI 去重和 Zotero 导入导出。
- 用户确认支持 PDF/扫描 PDF/HTML/DOI，以及 OCR、图表和公式抽取。
- 用户要求直接使用当前已有的成熟开源项目。
- 用户确认所有 LaTeX、OCR、Python 绘图及运行时依赖随应用完整打包。
- 补充核查 `academic-paper/SKILL.md`：其 12-agent/8-phase 设计可映射到 Roc 阶段状态机；Roc 当前打包布局需为完整工具链增加受控资源区。
- 用户确认工具链版本与校验哈希锁定，随应用发布并维护第三方许可证清单。
- 用户确认中文界面、项目级中英双语、跨学科默认，Nature 规范可选。
- 用户确认首批检索适配器为 OpenAlex、Crossref、Semantic Scholar、arXiv、PubMed/Europe PMC。
- 用户确认知识库使用向量 + 关键词混合检索、RRF 排序，并增加嵌入模型配置。
- 用户确认嵌入接入 OpenAI 兼容 Embeddings API，API 地址、Key、模型由用户配置。
- 用户确认向量存储采用 SQLite + sqlite-vec，与 FTS5 共库。
- 用户确认项目目录监听 + 增量索引，支持手动重建、暂停和失败重试。
- 用户确认默认索引 tex/bib/md/pdf/csv/图片 OCR，并支持 include/exclude；排除构建产物和缓存。
- 用户确认头脑风暴采用结构化 Idea Canvas，可晋升研究项目并关联版本与来源。
- 用户确认仅提供通用学术写作，不做期刊规范；通过导入用户模板适配格式。
- 用户确认 LaTeX 模板以目录/ZIP 导入，自动识别入口并实时编译。
- 用户确认 11 阶段标准科研流程：发现、检索、阅读、构思、方案、实验/数据、绘图、写作、审稿、修订、导出。
- 用户确认实验/数据阶段支持 Python/R/Julia 脚本或 Notebook，并记录 provenance。
- 用户确认项目使用锁文件与 uv/renv/Julia 探测，运行前校验并记录环境摘要。
- 用户确认审稿采用多角色独立评审 + 综合智能体，最多两轮修订并保留证据/分歧/结论。
- 用户确认项目页常驻流程轨道、顶部当前阶段和事件时间线。
- 用户确认 Provenance 细化到主张/段落/图表，并关联来源、代码运行、模型运行和时间。
- 用户确认无证据主张阻断正文写入和最终导出，降级为假设/待验证占位。
- 核查参考仓库许可证：`nature-skills` Apache-2.0、`scipilot-figure-skill` MIT、`academic-research-skills` Other；原样分发前需读取 LICENSE/NOTICE。
- 完成 LICENSE 实体核查：`academic-research-skills` CC BY-NC 4.0、`nature-skills` Apache-2.0、`scipilot-figure-skill` MIT；已运行 `agent-reach check-update`，当前版本 v1.5.0。
- 用户要求全面开源；已识别 CC BY-NC 与标准开源/商业分发的许可冲突，等待边界决策。
- 用户确认核心 Apache-2.0/MIT；NC 技能独立非商业插件或原创重写。
- 用户确认从底层全面重构、完成全部功能，并按阶段提交；Phase 1 需求访谈完成，进入 Phase 2 规划与结构设计。
- 创建 `CONTEXT.md` 和 `docs/adr/0001-research-workbench-architecture.md`，固化科研领域词汇与底层架构决策。
- 完成 Phase 2 结构设计，进入 Phase 3 实现：基础 → 知识库 → 工作流 → 生产工具 → renderer → 打包验证。
- 完成基础阶段并提交 commit `2542836`。
- 完成知识库基础：sqlite-vec 加载、FTS5 + 向量 RRF、OpenAI 兼容 Embeddings、OpenAlex/Crossref/Semantic Scholar/arXiv/Europe PMC 适配、论文检索/知识库/嵌入配置面板。

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `agent-reach doctor --json` | 输出渠道能力 | 命令完成；具体输出被合并工具截断 | Passed |
| CodeGraph architecture query | 返回当前符号与调用边 | 返回 ViewId、SkillService、context harness 等 | Passed |
| GitHub REST tree queries | 返回三个公开仓库目录 | 返回成功 | Passed |

### Errors
| Error | Resolution |
|-------|------------|
| `gh repo view` 要求登录 | 使用 GitHub REST/raw 只读 API |
| `zsh -f` 下 curl/head 不在 PATH | 后续使用绝对路径或非 login shell |
| planning hook 拒绝 symlink/reparse-point context | 用显式物理工作区路径和计划文件继续 |
| 两个参考仓库 raw SKILL 请求超时 | 后续使用分块 API 或本地浅克隆；不重复同一 raw 请求 |
| `academic-research-skills` 非商业许可 | 等待分发性质决策；商业场景不原样打包该仓库内容 |
| 全面开源与 CC BY-NC 冲突 | 推荐核心许可与 NC 插件分离，或获取额外授权/原创重写 |
| 许可边界决策完成 | 核心与 Apache/MIT 随包；NC 技能独立或重写 |

- Phase 3 Artifact Domain 第二步：补充 listArtifacts()/updateArtifact()，形成 Artifact 基础 CRUD 骨架。
- Phase 3 Artifact Domain 第三步：完成 create/get/list/update Artifact 仓储接口，并建立 workflow stage 与 artifact_ids_json 关联。

- Phase 3 Artifact Domain Review：补充仓储层测试用例，验证 Artifact 与 Workflow Stage 的关联关系。
- Phase 3 Artifact Domain Review 修正：审批闸门回归测试已移入统一测试生命周期；既有审批流程测试补齐 `source_corpus` 阶段产物，并验证审批同步更新 Artifact 状态。仓储测试 8 项、类型检查与差异检查通过。

### 续作：逐部分 review 与提交
- 起点：`86405a4`；`main` 比 `origin/main` 领先 16 个提交，工作区原本干净。
- 用户要求：接续本计划；每部分实现后 review、验证并本地提交。
- 已通过显式 `PLAN_ID=2026-09-10-roc`、`PWF_PLAN_ROOT=/Users/Apple_501/Desktop/Roc/Roc` 解析计划，目录及三份计划文件均无符号链接。
- 以当前代码、`CONTEXT.md`、架构 ADR 与本计划的已确认决策为验收依据；旧的访谈等待记录已不构成阻塞。
- 验证路径：每部分定向 Vitest → 类型检查；IPC 变更生成并检查；界面/打包阶段增加构建和实际 smoke。
- 基线验证：`rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test tests/main/plugins/research`，4 文件 / 14 测试通过。
- 第一部分范围：可恢复阶段导航、产物不可变审批版本、原子创建与项目归属校验、产物/时间线 IPC；补充生命周期回归测试。
- 第一部分 red/green：新增 8 个生命周期测试在原实现全部失败；修复后科研域 5 文件 / 22 测试通过，`typecheck`、`git diff --check` 通过。已生成 Artifact CRUD 与 workflow events 的 IPC；开始双轴 review。
- Context7 官方远程 MCP 可用；通过 `mcporter` 解析 `/langchain-ai/deepagentsjs`，用于后续角色运行 API 核查。
- IPC 扩展验证发现旧 domain 列表漏掉 research；补齐 domain 与新增接口路由断言。Review 提醒原子性测试提前在 INSERT 前失败，改为数据库 trigger 在关联 UPDATE 时抛错，验证产物、关联及事件一同回滚。
- Standards review：回滚测试修正后 0 项未解决问题。Spec review 发现 artifact 类型 subjectId 可跨项目而 artifactId 为空的旁路；补齐 subject 所属项目及两个 Artifact ID 一致性校验与回归测试。
- 第一部分完成：Standards / Spec 均 0 项未解决问题；科研域与 IPC 9 文件 / 39 测试、类型检查、IPC 漂移检查通过。Review 记录：`reviews/01-workflow-lifecycle.md`。状态：Verified passing，准备独立提交。
- 第一部分已提交：`26fd981`，提交后工作区干净。
- 第二部分设计：证据从真实知识库 chunk 捕获不可变内容/定位/来源版本；主张引用本项目证据；正文由已关联证据的段落组成，假设与待验证保留在草稿对象；审核及导出重新验证正文和证据快照。数据库增加新 migration，不改旧 migration 校验和。
- 第二部分已实现：不可变证据、主张版本与并发校验、LaTeX 正文和可见引用/参考文献、审批/导出摘要检查、九条 IPC；增加注册插件到 IPC adapter 的完整证据→正文→审核→导出测试。
- 第二部分初审：两轴均发现主张修订会误删非 model_run 原始审计边。改为仅追加并去重派生关系，主张历史保留每版 evidenceIds；新增审计保留回归。另明确 figure 实体与 figure_claim 图稿主张的来源类型，保留已有图稿记录接口语义。
- 第二部分复查：Standards / Spec 均 0 项未解决问题；11 文件 / 68 测试、typecheck、check:ipc 通过。Review 记录 `reviews/02-evidence-manuscripts.md`。状态：Verified passing，独立提交。
- 第二部分已提交：`a38e684`。
- 第三部分实现选择：复用已安装 LangChain createAgent 与 Roc 模型工厂；每个科研角色是独立受限工具循环，阶段协调器持久保存输入、技能、模型、状态与产物。写入统一在结果验证后的事务中提交；中断从角色边界重试，取消后的迟到结果不得产生工件。保持现有通用 DeepAgents runtime 不变。
- 用户中断后继续：前两部分提交保持不变；第三部分当前未提交内容为运行 schema、v3 migration、角色配置和 11 份原创内置技能。未发现遗留 Vitest/tsc/mcporter 进程，继续执行层实现。
- 续作基线：科研域 41 测试通过。接入运行仓储后旧迁移测试使用新版仓储写 v1 数据库，缺少 stage_policies；夹具改为按 v1 实体结构插入项目/阶段，升级后验证策略与原数据保留。
- 执行层已新增：运行仓储、角色执行器、按项目绑定的工具和取消/超时运行管理。再次中断后续作；类型检查指出 LangChain response_metadata 为 unknown，改为边界类型校验后读取实际模型版本。
- 运行生命周期初测发现模型句柄整体展开把 execute 函数带入严格持久快照，3 项测试在执行前失败；改为只写 providerId/modelId，保留严格 schema。阶段运行已注册 IPC，并接入主应用模型工厂。
- 8 项执行生命周期测试通过，覆盖幂等、项目隔离、取消迟到结果、未支持正文回滚、快照重试、重启、超时和暂停。真实 LangChain 测试发现末尾 ToolMessage 不带模型版本，改为向前读取最后一个有模型元数据的消息。
- 实际已安装 LangChain createAgent + toolStrategy 的集成测试通过，确认结构化结果、角色工具面和模型版本记录。Workflow 3 拆为 3a 执行基础与 3b 独立审稿/两轮修订；先完成 3a review/提交。
- 3a 提交前验证：19 文件 / 115 测试、build（含 typecheck）、check:ipc 通过。Standards review 发现 requestId 幂等未比较 retryOfRunId，重试可能误返回另一失败运行；已补重试来源身份比较及 start/retry 碰撞回归。
- 3a Spec review 另发现拒绝无证据正文时事务回滚会丢失已返回模型版本；改为先独立记录响应模型版本，再事务校验/提交产物。无证据输出仍回滚，失败运行保留实际模型身份。Standards 幂等问题复查关闭。
- 3a 完成：两轴复查均 0 项未解决；最终 19 文件 / 116 测试、build（含 typecheck）、check:ipc 与差异检查通过。记录 `reviews/03a-stage-execution.md`，状态 Verified passing，独立提交。
