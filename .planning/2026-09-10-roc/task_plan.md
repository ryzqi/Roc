# Task Plan: Roc 科研助手全面改造

## Goal
在保留 Roc 本地 Agent、插件、IPC 与安全边界的前提下，形成并实现覆盖论文检索/阅读、文献管理、头脑风暴、论文写作、评审修订和科研绘图的科研工作台。

## Next Step
从提交 `86405a4` 继续，先补齐 Workflow；后续依次完成 Production、Renderer、Packaging。每个独立增量完成后执行 Standards/Spec review、相关验证，再单独提交。

## Current Phase
Phase 3 — Implementation（Workflow）

## Phases

### Phase 1: Requirements & Discovery
- [x] Understand initial user intent
- [x] Identify repository and reference constraints
- [x] Document initial findings
- **Status:** complete

### Phase 2: Planning & Structure
- [x] Define approach
- [x] Create project structure
- **Status:** complete

### Phase 3: Implementation
- [x] Foundation: research domain schema, migrations, IPC contracts
- [x] Knowledge base: source adapters, parsing, FTS5 + sqlite-vec, embeddings, RRF
- [ ] Workflow: 11-stage state machine, role-scoped multi-agent runs, provenance, gates
- [ ] Production: LaTeX templates/live PDF, experiments, figures, exports
- [ ] Renderer: project dashboard, pipeline rail, library, reader, ideas, editor, figures
- [ ] Packaging: bundled toolchain, licenses, resource verification
- **Status:** in_progress

### Phase 4: Testing & Verification
- [ ] Verify requirements met
- [ ] Document test results
- **Status:** pending

## Implementation increments
- [x] Workflow 1：阶段回退/中途进入、产物审批生命周期、项目归属、产物/事件 IPC；review 与定向验证通过。
- [x] Workflow 2：证据片段、主张/段落/图稿关联、正文/导出数据包硬闸门；review 与定向验证通过。
- [ ] Workflow 3：阶段模型策略、角色 Skill 隔离、持久运行、独立审稿与最多两轮修订。
- [ ] Production：文献解析与增量索引、模板编辑/编译、实验环境/运行、图稿/导出。
- [ ] Renderer：科研各视图、流程轨道、时间线、审核交互。
- [ ] Packaging & Delivery：固定工具链、许可证、资源校验、构建/测试/smoke。

### Phase 5: Delivery
- [ ] Review outputs
- [ ] Deliver to user
- **Status:** pending

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 暂不编辑应用代码，先完成 grilling 访谈 | `grilling` 明确要求共享理解确认前不行动 |
| 首要用户为个人研究者 | 用户已确认；默认单用户、本地优先，协作能力后置 |
| 采用项目中心 + 全局文献库 | 用户确认；论文可跨项目复用，项目承载研究产物 |
| 使用开放学术 API + DOI/PDF 本地导入 | 用户确认；首版检索边界清晰，避免依赖受限网站抓取 |
| 采用严格证据链 | 用户确认；内容绑定来源及页码/段落，假设与待验证内容显式标记 |
| LaTeX 为主、实时渲染、支持 PDF 导出 | 用户确认；论文源文件与编译产物分离，适配期刊模板与版本管理 |
| 代码优先科研绘图 | 用户确认；实时预览并导出 SVG/PDF/PNG，保证可复现和出版质量 |
| 全部技能内置，按工作流选择性启用；多智能体按阶段暴露对应 Skill | 用户确认；隔离上下文和能力面，控制 token、权限与阶段职责 |
| 阶段化流水线并持久追踪当前阶段 | 用户确认；支持暂停/恢复/回退/中途进入，明确当前流程状态 |
| 关键产物设置人工审核闸门 | 用户确认；证据集、提纲、正文改写、图稿和最终导出需确认，低风险步骤可自动化 |
| 全面开放联网，材料可发送给已配置模型 | 用户确认；不做默认本地材料外发限制，沿用已配置 Provider/密钥边界 |
| 按阶段配置模型档位，支持默认与覆盖 | 用户确认；检索/阅读/写作/审稿/绘图可使用不同模型，并记录实际模型版本 |
| 文献互操作采用 BibTeX/BibLaTeX、DOI 去重、Zotero 导入导出 | 用户确认；服务 LaTeX 引用并支持既有库迁移 |
| 阅读支持 PDF/扫描 PDF/HTML/DOI，含 OCR、图表公式抽取 | 用户确认；抽取结果进入带定位的证据链 |
| 优先直接集成成熟开源项目 | 用户确认；减少自研解析、编译和绘图核心逻辑 |
| 科研工具链依赖全部随应用打包 | 用户确认；LaTeX、OCR、Python 绘图及运行时开箱可用 |
| 使用 `academic-paper` 的 12-agent/8-phase 角色与阶段规范作为写作流程参考 | 与已确认的阶段化、多智能体、角色 Skill 隔离一致 |
| 锁定工具链版本与校验哈希，随应用发布并维护许可证清单 | 用户确认；保障 LaTeX/OCR/绘图可复现并满足分发治理 |
| 中文界面、项目级中英双语、跨学科默认 | 用户确认；Nature 风格作为可选期刊规范 |
| 首批检索源为 OpenAlex/Crossref/Semantic Scholar/arXiv/PubMed/Europe PMC | 用户确认；统一 DOI、作者、摘要、引用和开放获取元数据 |
| 知识库采用向量 + 关键词混合检索，RRF 排序，并提供嵌入模型配置 | 用户确认；统一检索论文、全文、笔记、证据和项目材料 |
| 嵌入接入 OpenAI 兼容 Embeddings API，由用户配置地址、Key、模型 | 用户确认；不内置默认远程凭据，索引记录模型维度/版本并支持重建 |
| 向量存储使用 SQLite + sqlite-vec，与 FTS5 共库 | 用户确认；单机部署、备份恢复和权限边界统一 |
| 项目目录监听 + 增量索引，支持手动重建/暂停/重试 | 用户确认；索引状态纳入流程面板 |
| 默认索引 tex/bib/md/pdf/csv/图片 OCR，支持 include/exclude | 用户确认；排除构建产物、缓存和敏感目录 |
| 头脑风暴采用结构化 Idea Canvas，可晋升研究项目 | 用户确认；记录问题/假设/新颖性/证据/实验/风险并关联版本与来源 |
| 仅提供通用学术写作，不内置期刊规范；支持导入用户模板 | 用户确认；Nature 能力仅作为可选阅读/质量/绘图 Skill，不自动施加期刊规则 |
| LaTeX 模板以目录/ZIP 导入，自动识别入口并实时编译 | 用户确认；支持 `.tex/.cls/.sty/.bib` 与图片资源 |
| 标准流程为发现→检索→阅读→构思→方案→实验/数据→绘图→写作→审稿→修订→导出 | 用户确认；每阶段有专属 Agent、Skill、输入输出和审核状态 |
| 实验/数据阶段纳入 Python/R/Julia 脚本或 Notebook，并记录 provenance | 用户确认；实验结果连接图稿、证据和论文段落 |
| 项目用锁文件 + uv/renv/Julia 探测，运行前校验并记录环境摘要 | 用户确认；不为每个项目重复打包完整科研环境 |
| 审稿采用多角色独立评审 + 综合智能体，最多两轮修订 | 用户确认；保留评审证据、分歧和结论 |
| 项目页常驻流程轨道 + 顶部当前阶段 + 事件时间线 | 用户确认；持续显示 Agent、审核、失败和下一步 |
| 主张/段落/图表逐项绑定来源片段、代码运行、模型运行和时间 | 用户确认；最终稿可反查证据、数据、脚本和生成记录 |
| 无证据主张阻断正文/最终导出，降级为假设或待验证占位 | 用户确认；未经支持的内容不能进入可提交稿件 |
| 用户要求全面开源 | 需在 CC BY-NC 参考内容与 OSI 开源/商业分发之间做许可边界决策 |
| 核心 Apache-2.0/MIT；NC 技能独立非商业插件或原创重写 | 用户确认；分离许可边界，避免把 CC BY-NC 内容误宣称为标准开源 |
| 从底层全面重构，完成全部功能，按阶段提交 | 用户确认；采用阶段化实现与验证，每阶段形成可审阅交付 |
| 先底层后界面，按六个阶段提交 | 用户确认；依次交付基础、知识库、工作流、生产工具、界面、打包验证 |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| IPC adapter 测试的 domain 预期漏掉已存在的 research | 补齐 research 与本部分五条接口映射覆盖，重跑 IPC 测试 |
| 续作首次生命周期回归：8 项失败，复现导航缺失、孤立产物、跨项目来源与审批版本可修改 | 完成实现后 22 项科研域测试及类型检查通过，进入双轴 review |
| `mcporter list context7`：Unknown MCP server | 使用官方 `https://mcp.context7.com/mcp`，resolve-library-id 成功 |
| GitHub CLI 未登录 | 改用 agent-reach 路由下的 GitHub REST/raw 只读访问 |
| planning hook 拒绝 symlink/reparse-point context | 当前工作目录物理路径可读；继续使用显式 `.planning/2026-09-10-roc/` 路径 |
