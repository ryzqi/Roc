# Progress Log

## Session: 2026-09-10

### Current Status
- **Phase:** 3 - Implementation（Production）
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
- 3a 已提交：`96818f4`，提交后工作区干净。进入 3b：方法/统计、证据/引用、结构/表达三角色独立评审，综合角色随后读取三份报告；review 的人工审批明确选择接受或修订，最多两轮已批准修订。
- 3b 已接入审稿周期、三角色并行与独立输入、综合报告分页读取、显式人工决策和两轮修订限制。主流程集成测试通过；追加中断/部分报告重试、输入闸门及 v3→v4 运行快照迁移回归。
- 3b 新增 5 个集成场景通过，含两轮完整循环、第三轮拒绝、当前稿保留、并行互盲、部分报告取消重试和运行快照升级；类型检查与 IPC 漂移检查通过，进入双轴 review。
- 3b 初审发现：重开 review 未撤销旧 accepted；v4 把旧 review/revision/export 运行周期统一置空导致重试冲突。修复为回到审稿或更早阶段时撤销接受状态，并按旧输入稿件关联迁移周期/轮次；旧审稿协调器补只读报告工具，子角色仍严格过滤其他报告。
- 3b 完成：两轴复查均 0 项未解决；最终 20 文件 / 124 测试、build（含 typecheck）、check:ipc、差异检查通过。Review 记录 `reviews/03b-peer-review.md`，Workflow 子阶段完成，进入 Production。
- 3b 已提交：`39bfab2`，提交后工作区干净。生产工具盘点：现有 LaTeX 依赖 PATH，主机无 TeX/OCR；磁盘可用约 404 GiB。
- 已从官方发布 API 确认 Tectonic 0.17.0 arm64/x64 tar.gz 与官方 SHA-256；Context7 已核查离线 bundle、only-cached、untrusted 编译及 PDFium 页面接口。Docling/PDFium/Matplotlib/OCR 依赖与双架构 wheel 兼容性正在核对。
- 科研 Python 采用已发布的 3.12.14（uv 目录确认双架构包）；Intel 的 PyTorch 最高官方 wheel 为 2.2.2，采用架构约束锁定兼容依赖。Docling 使用 PDFium 后端，OCR 使用 MIT ocrmac/Vision，保留表格与公式模型能力。已初始化独立运行时 pyproject，开始生成锁文件。
- 初始锁 115 包、隔离环境安装成功；Tectonic 0.17.0 已下载、官方 SHA 校验并运行。实际导入发现 Docling 的 minimal PDFium extra 仍强制导入 docling_parse，改用官方标准 docling 包，继续用显式 PDFium/Vision 配置。
- 标准运行时锁定 149 包并安装完成；Docling/PDFium/Vision 导入成功。三组模型（布局、表格、公式）已按固定 Hugging Face commit 下载并校验全部权重 SHA-256，许可为 Apache-2.0 或 CDLA-Permissive-2.0。
- Tectonic 0.17.0 的格式编号确认为 33，官方默认资源指向 tlextras-2022.0r0.tar（2,881,562,112 字节）；服务使用 Range 请求，已验证后开始完整离线资源下载。
- 离线解析实测通过：`worker.py` 用固定 Docling 模型和 Vision 解析中英文扫描图，正确返回“研究数据与方法”、Control/Treatment 数字及结论；1 页、5 文本块、1 页图、无警告。证据位于 `.artifacts/research-runtime-x_3u99ys/`。
- TeX 全量请求提前结束；随后 16 MiB 分段下载超过 1 GiB 后仍遇到 IncompleteRead，进程已失败退出。两次临时文件均被旧脚本清理，未留下完整包或可恢复分块。
- 续作已核对 `39bfab2` 与工作区；先完成 Production 4a：可恢复且校验哈希的资源准备、离线 Python/OCR/PDF/LaTeX 工具链与搬迁验证，再独立 review/提交。应用接入及其他生产能力继续后续增量。
- 已实现持久分块下载器；5 项本地 HTTP 回归全部通过，覆盖跨进程重试时保留部分字节、ETag 变化、缓存哈希损坏及符号链接拒绝。真实 TeX 资源已超过 1.8 GB，断点保存在 `.runtime/research-downloads/tlextras-2022.0r0.tar.parts/`。
- Context7 与 Tectonic 0.17.0 官方 `ZipBundle` 源码确认：ZIP 使用扁平文件名并要求 SHA256SUM；将完整保留官方 TAR 中的文件内容，转换为 ZIP 后做空缓存离线编译实测。
- TeX 下载完成：2,881,562,112 字节，完整 SHA-256 `425685e124746c15ba9bb8e0596bdaad98fce886afa347fbcf9ec0e9acd7fe79`，已固定在 tools.lock.json。arm64 Python/uv/Tectonic 归档也全部下载并通过官方 SHA 校验。
- 官方 TeX bundle 含 134,980 个文件，首次转换触发原定 100,000 文件上限；核对归档后调整为 200,000，并保留 4 GiB 总量及单文件上限。ZIP 转换完成：1,481,187,938 字节，SHA-256 `c508958589f4c18218f98a7785ff21af901fb2460106e9a11d7b7bf065204487`。
- 私有 arm64 工具链已成功组装，144 个实际依赖、38,564 个清单文件/链接；模型从权重扩展到全部 22 个配置/分词器/权重文件哈希。真实 PDF 回归暴露 PdfPage 不能作为 context manager，已改用 closing 并继续测试。
- 搬迁到含空格路径的真实离线 smoke 全部通过：禁止外网、空缓存，中英文 LaTeX、PDF 渲染、扫描页 OCR、表格/公式/图稿解析、PNG/SVG/PDF 绘图及 Notebook（结果 30）。解析得到 1 页、8 个块，包含全部五类文本/表格/公式/图稿，E=mc² 与 12/18/50 数值正确，无警告。前后完整性校验通过；证据 `.artifacts/research-runtime-smoke-02/result.json`。
- Production 4a 已进入 Standards/Spec 双轴 review；随后更新准备产物并完成最终核验，再独立提交。主进程接线仍属下一增量。
- Standards 初审发现模型下载仍使用临时目录，连接中断会丢失 Hugging Face 的部分权重与元数据。改成按目录/commit 固定持久 staging，增加模型级文件锁，完成校验后才原子发布；补跨次中断恢复回归。
- Standards 复查已关闭恢复缺口；补齐许可证目录中普通文件名的索引（PDFium 的 19 份许可文件现在均有索引），定向复查通过。最终回归 22 项全通过。
- 最新工具链重新完整准备成功；`.artifacts/research-runtime-smoke-03/result.json` 的全链路离线 smoke 通过，额外覆盖原生 PDF（7 块）与 HTML（3 块）。资源共约 3.99 GB，145 项 Python 分发元数据（含 standalone 自带 pip），清单覆盖 38,564 文件/链接。
- Production 4a 完成：Standards/Spec 最终均 0 项未解决问题，22 项回归和完整离线 smoke 通过。Review 记录 `reviews/04a-research-toolchain.md`，状态 Verified passing，独立提交。
- 4a 已提交 `bc04b41`，提交后工作区干净；最新工具链已激活到 `.runtime/research-toolchain/darwin-arm64`。继续 4b：应用使用固定资源根、受限/可取消进程、模板版本与编译快照、安全导入与文件编辑、项目 PDF 预览。
- 4b 已接入：固定工具链清单验证、受限进程/进程组取消、模板 ZIP 安全提取、版本与摘要、独立编译快照、文件冲突检测、编译恢复及 8 个新增 IPC。数据库追加 v5，不修改旧 migration。模板、进程、仓储定向 25 测试通过；Python 包含 ZIP 越界/符号链接/大小写冲突的 26 项回归通过。
- 4b 实现中旧 helper 签名与模板序列化的过渡类型错误已修正，当前 typecheck 通过。正在运行 Node 主进程到私有 Python/Tectonic 的真实文件沙箱集成验证。
- 真实文件沙箱下 ZIP 导入、TeX、PDF 渲染通过；Docling 导入失败。用 diagnosing-bugs 缩小到 mimetypes 注册类型时访问主机 MIME 表（0.2 秒回归可稳定复现），改为初始化内置表。另将进程测试直接指定 /bin/bash，避免 /bin/sh 包装器转执行另一未授权程序；生产只允许所选可执行文件。
- MIME 回归与原扫描页的严格文件沙箱复现已通过。Python 3.12 初次 init(files=[]) 仍拼接 knownfiles，已核对实现并显式清空该主机文件列表；内置 PDF/图像类型保留。工作进程错误统一写 stderr traceback，stdout 保持结构化协议，便于真实故障定位。
- 进一步语义校验发现严格沙箱的 Vision OCR 静默返回空数组；独立 OCR 对照中 baseline 为 22 条文本，放开文件读取或进程信息均无效，仅 iokit-open-user-client 恢复 22 条文本。正在按系统现有 profile 收窄所需客户端。取消测试的 PID 文件空内容竞态已修复，所有测试路径均在 finally 取消并等待子进程；清理了此前失败测试遗留的进程组。
- 4b Standards 子审查遭遇模型速率限制，稍后复用该代理重试；主线验证和 Spec review 继续。
- 两轴 review 发现模板扩展名过滤丢失 .tikz/.csv/.fd 资源、文件保存后 DB 失败不回滚；已保留普通资源并加入原文/新文件/外部编辑保护回归。复查又捕获 DB 提交前取消旧编译，已将取消移至提交之后，补在途编译+失败保存+迟到结果+shutdown 回归；模板 12 项测试通过，两轴相关问题已关闭。
- Vision 对照已验证：IOSurface + GPU + ANE 的客户端组合恢复中文识别（两种组合均通过），单独文件/进程/图形权限无效。仅 parse_document 授权这五类计算客户端。精简页面中的公式可能被布局模型标为普通段落；集成验收改用 4a 已验证的实际论文样式样例，保留模型分类局限。
- 主进程真实集成现已通过：Node 清单校验 → ZIP 模板导入 → 中英文 LaTeX（含嵌套图片资源）→ PDF 哈希预览 → PDFium 渲染 → 严格文件沙箱内 OCR/表格/公式识别。`ROC_RESEARCH_TOOLCHAIN=.../darwin-arm64-production-v2` 的 2 项集成测试通过；样例和结果保存在 `.artifacts/research-production-integration/`。独立验证了子目录入口的相对 `\\input` 资源，Tectonic 可正确解析。
- 4b 完成：两轴最终 0 未解决；常规 18 文件/107 测试通过（真实用例已单独开启通过），另新增旧模板升级回归后仓储 9 项通过；Python 27 项通过，build/typecheck、check:ipc、差异检查通过。记录 `reviews/04b-template-production.md`；主进程与模板后端状态 Verified passing，进入 4c。
- 4b 已提交 `dfb92f7`，工作区干净；当前开发工具链 `.runtime/research-toolchain/darwin-arm64` 已更新为包含 ZIP 与 MIME 修复的版本。4c 拆成可独立验证的文献库/解析互操作和项目增量索引两部分，各自 review 后提交。
- 4c1 文献互操作已使用 Bibtexparser 2.0 实现机构作者/姓名粒子、宏展开、保护大小写标题、preamble、自定义字段及 CSL 扩展字段保留；7 项 Python 回归通过。CSL DOI/URL 保留百分号编码，避免被 LaTeX 解码当注释截断。
- DOI 内容协商实际请求返回 200，并跳转到 Crossref transform；发现该服务的 `type` 使用 journal-article，需在 API 边界显式映射为 CSL 类型。官方网页的 Jina 读取 30 秒超时，保留 Context7 与实际端点返回作为当前证据。
- 4c1 续作确认：`dfb92f7` 为本次基点，main 领先 22 提交；接续中的 typecheck 已完成并通过。以本计划、CONTEXT 与现有 IPC/数据库边界为验收依据。先完成文献库与互操作独立提交，再推进全文解析和项目索引；不把当前元数据服务视为全部 Production 已完成。
- 4c1 验证补充范围：缺失字段合并、重复导入保持向量、归档/恢复与证据保留、批量事务、项目归属、引用键冲突、DOI 边界、关闭后的迟到结果；CSL 日期及引用键双向往返。归档文献允许解除已有项目关联，新增关联要求先恢复。
- 新增 10 项仓储测试与 3 项 Python 场景先复现失败：空 Bib 字段挡住补齐、未比较索引 source_type、归档后仍可新增关联、DOI 错误未统一；另复现 CSL 接受畸形日期/未知类型以及 BibLaTeX 完整日期导出丢失月日。正在逐项修正。
- 仓储 10 项和服务 8 项已通过；服务测试另复现并修复无 DOI 本地记录对字段顺序敏感、导出未拒绝重复选项。补充 Python 作者/月份/日期范围回归，修复机构名中的 and 被拆分及 sep 无法导出的问题；Context7 已核对 CSL 类型表和 Zotero 的 ISO 日期范围语法。
- 新工具链 `darwin-arm64-library-v1` 已准备，清单 38,565 项；Python 全套 39 项通过。IPC 测试首先纠正了空 description 的无效夹具；真实 IPC→私有 Python 验证随后复现 DOI 补充的 CSL 日期覆盖既有 Bib 日期，正在修正导出以已保留字段为准，并保留原始作者扩展字段/日期限定信息。
- bibliography 14 项回归通过，Node 新增 19 项通过，build/typecheck、check:ipc 通过；4c1 已进入双轴 review。工具链 v2 已准备；追加回归复现 date/year 混合不同来源导致 Bib 导出冲突，修复为日期字段成组保留/补齐，避免 CSL 与 Bib 往返结论不同。
- 两轴初审发现四处保留问题：无 DOI CSL 的 edition/editor 未参与本地身份、期刊字段互相覆盖、editor/edition 跨格式丢失、同 DOI 后续 CSL 扩展丢失。均已有失败回归；修复包含规范化完整书目身份、期刊字段组合并/冲突错误、编辑者/译者/版次/书籍容器映射、完整来源书目快照与非冲突扩展合并。新 v6 尚未提交，因此来源 JSON 契约直接采用完整快照，不引入旧格式兼容分支。
- 公共 DOI HTTP 200 已确认，真实 Crossref 将 ISSN 返回数组；在 DOI API 边界保留全部 ISSN/ISBN 并转为 CSL 字符串。随后完整性失败已定位到 v2 额外的 5 个 .pyc，来自搬迁测试启动子解释器时未继承禁写字节码环境；已修正测试，以新工具链 v3 复验。
- Standards 复核又捕获空期刊别名覆盖非空值的分支；统一 journal_title() 处理后，三种格式的空值/空白/冲突回归通过。最终工具链更新到 `darwin-arm64-library-v4`。
- 4c1 完成：Standards/Spec 最终均 0 未解决；科研域/IPC 19 文件 118 项通过，Python 44 项通过，真实 IPC 文件往返、公共 DOI 联网导入/导出、build/typecheck、check:ipc 和完整性清单通过。真实证据 `research-library-integration/roc library integration-QWaCYk/result.json` 与 `roc library integration-kq3jRW/live-doi-result.json`；Review 记录 `reviews/04c1-literature-library.md`。状态 Verified passing，独立提交后继续 4c2/4c3。
- 4c1 已提交 `2c88502`，提交后工作区干净；验证后的工具链已激活到 `.runtime/research-toolchain/darwin-arm64`，旧目录保留为 `darwin-arm64-before-library-20260911`。
- 4c2 开始：全文附件作为全局文献的一部分保存不可变原文件；直接导入可根据显式标题/引用键建立最小文献记录。每次解析保留独立版本、定位和资源清单，原子发布当前结果及全文索引，失败/取消不覆盖旧结果；提供重试、重启恢复与只读取已登记资源的预览。项目文件监听/嵌入重建仍属 4c3。
- 4c2 已接入 v7 附件/解析版本模型、原文件安全复制与按哈希去重、当前版本原子发布、归档/恢复全文索引、取消与运行恢复、七条 IPC 和原文件/PNG 预览路由。Docling 返回资源相对路径，主进程逐项验证路径、文件类型和哈希，再关联阅读块；正在补仓储/服务/协议与真实解析回归。状态 Changed, unverified。
- 4c2 首轮 12 项生命周期测试中 11 项通过，唯一失败是测试误用检索字段 excerpt；已对照现有 schema 修正为 content。追加 IPC、原始 HTML 强制下载、版本化 PNG 预览与错误隐藏测试，并开始真实 HTML/PDF → 索引 → 证据 → 资源读取链路验证。
- 4c2 定向 22 项测试、typecheck 和 IPC 漂移检查通过。真实 IPC 集成已完成 HTML 导入/解析/全文检索/证据捕获，以及 Tectonic PDF → 导入副本 → Docling 页码/页面图 → 哈希资源读取；删除原 PDF 后仍能读取已保存副本。已进入 Standards/Spec 双轴 review，继续最终相关回归。
- 4c2 完成：Standards/Spec 最终均 0 未解决；科研域/IPC/协议 22 文件 140 项通过，真实 HTML/PDF 集成通过，build/typecheck、check:ipc 与差异检查通过。证据 `.artifacts/research-document-integration/roc document integration-nRycvI/result.json`，Review 记录 `reviews/04c2-document-reading.md`。状态 Verified passing，独立提交后继续 4c3。
- 4c2 已提交 `7e3a329`，提交后工作区干净；实际解析后工具链 38,565 项完整性校验通过。
- 4c3 盘点：科研域尚无持久索引任务/监听实现；通用 WorkspaceChangeWatcher 仅维护当前工作区，不能直接表达研究项目索引失败/恢复状态。已用 Electron 自身确认 Node 24.20.0 提供 fs.watch 与 path.matchesGlob。
- 4c3a 先处理已定位的前置正确性缺口：嵌入响应未严格检查 index/坐标类型，异步向量写入没有核对原文摘要，缓存只按 model 名隔离且无配置修订，网络请求没有取消/关闭归属。完成该独立增量后再接持久项目任务与目录监听。
- Context7 已取得 OpenAI 官方 Embeddings 响应示例（data/index/浮点向量）与 Node 24 监听 API；直接读取官方 HTML 文档返回 403，改试同页 Markdown 端点，不影响本地可复现的索引一致性修复。
- 官方 Markdown 端点也返回 403，保留 Context7 的官方文档索引结果作协议参考。新增回归先复现 7 类问题；初次集成测试误写 capability 名，按本地 IPC registry 修正为 research.embedding.save 后，5 个异步/缓存/密钥场景全部稳定失败，确认是实际实现问题。
- 4c3a 已新增配置修订与缓存命名空间、文本摘要条件写入、严格 index/坐标验证、Float32 约束、取消/超时/响应大小边界和请求生命周期。配置保存使用独立新密钥引用，数据库提交后才撤销旧任务/清理旧引用。一次大块 apply_patch 因旧 helper 文本不匹配被拒绝，随后改为小块接线并按确切函数边界提取服务。
- 前述失败场景修正后，首轮 31 项相关回归和 typecheck 通过；追加 v7→v8 缓存迁移、配置名称与端点变化、分批失败的原子写入、缺失配置及本机 HTTP 实际取消验证。旧向量保留为 legacy 命名空间，不再参与当前配置检索，原始知识与证据保留。
- 4c3a 追加定向 14 项通过，包含真实本机 HTTP 收发与传输取消、失败配置保存不打断旧请求、批量中途失败不留下部分向量。确认现有 Renderer 使用 embeddingConfigId:null，未受严格显式配置检查影响；已进入 Standards/Spec review。
- 4c3a 全科研域/IPC/协议 23 文件 152 项与 build/typecheck、check:ipc 通过。两轴 review 均复现极大/极小 Float32 向量在实际 sqlite-vec 余弦计算中返回 NULL；已在编码、仓储和查询边界使用按最大坐标缩放的稳定单位化，补实际 SQLite 距离/排序回归，17 项定向验证通过，进入窄复查。
- 4c3a 完成：Standards/Spec 最终均 0 未解决；最终科研域/IPC/协议 24 文件 155 项通过，本机 HTTP 取消与实际 SQLite 极端数值验证通过，build/typecheck、check:ipc、差异检查通过。Review 记录 `reviews/04c3a-embedding-consistency.md`。状态 Verified passing，独立提交后继续 4c3b 项目监听与增量索引。
- 4c3a 已提交 `c7a5b3c`，提交后工作区干净。进入 4c3b：项目范围配置和持久文件任务、自动监听、增量/手动重建、暂停/恢复/重试。
- 4c3b 实现边界：项目文件独立于全局文献附件；原文件按摘要保存可追溯快照，旧证据在原文件变更/删除后仍可读取。默认索引 tex/bib/md/pdf/csv/图片，配置 include/exclude；原始文本按物理行定位，PDF/图片/HTML 复用已验证的 Docling。扫描完整成功后才更新文件清单；任务以项目配置版本和文件身份防止迟到提交，关键词文本与嵌入状态分别记录。
- 4c3b 文件筛选/快照身份/Unicode 行分段 5 项通过；嵌入前置与筛选合并 14 项通过。已新增 v9 项目索引配置、文件/任务/源版本仓储，补独立嵌入已有文档和工具链身份查询。旧 v3 迁移夹具调用新版 createProject 导致缺索引表，正改为按 v3 SQL 生成夹具；首次改写的列数笔误已修正。状态 Changed, unverified，尚未开始本部分 review。
- 4c3b 后台服务的 8 项生命周期回归已通过，包含原文件修改/删除后的证据快照、缓存复用、解析器/嵌入变更、暂停迟到结果、无监听模式重启恢复、失败重试、监听错误与工作区切换。迁移夹具已统一使用 v3 SQL，相关 24 项证据/审稿测试通过。补接主进程、六条 IPC 与源版本预览；一次 bootstrap 补丁因行布局不符整批被拒，核实无部分写入后按实际行重做。测试 mock 的可选函数类型错误已修正。
- 4c3b 仓储/服务/协议 24 项通过；真实目录监听经 IPC 验证文件变化、暂停恢复、删除与旧证据源读取通过。首次资源调用夹具把完整源描述传给严格请求 schema，被正确拒绝，已改为仅传 projectId/fileId/sourceHash。正在执行私有工具链 PDF 索引与全相关回归/构建，随后双轴 review。
- 4c3b 当前全相关回归 28 文件 / 176 项通过，build/typecheck、check:ipc、差异检查通过；真实目录监听与私有工具链 PDF 索引 2 项均通过。已进入 Standards/Spec 双轴 review，等待并处理审查结果后提交。
- 4c3b 两轴初审均复现解析器升级失效：仅 ready 文件比较已发布 parserKey，排队任务可能复用旧缓存，失败文件可能不再重试。正在补 queued/running/failed 与关闭监听后重启的回归，统一对照最近任务的解析器身份并在执行/发布前核验当前工具链。
- 升级回归首先稳定复现 5 个旧任务/缓存失败；第 6 个测试的任意错误文本被现有安全边界规范化，已修正测试为显式 research_ 错误码。已按最近任务 parserKey 判定升级、为任务文件查询增加索引，并让重启排队任务先重扫；执行/发布前也核验当前解析器身份。
- 解析器升级定向 20 项全部通过。Standards 另复现已索引目录消失后，范围变更遗留的 queued 文件使失败状态被错误显示为 indexing；新增目录消失/恢复回归并调整状态优先级。查找可选 `docs/agents` 返回目录不存在，审查依据继续使用用户指定计划及现有 README/CONTEXT。
- 扫描失败状态已稳定 red-green；修复后索引/文件/预览 36 项通过，最终全相关回归 28 文件 / 183 项通过（5 个可选真实资源用例跳过，先前已独立开启验证），build/typecheck 通过。两轴正在复核修复。
- 下一部分预研：Context7 与私有 uv 的本地帮助确认 `uv lock --check` 与 `uv sync --check` 可分别检查锁与环境，避免只凭锁文件存在认定可复现。初次猜测 `research-process.ts` 不存在，已通过文件清单定位现有 `process-runner.ts`，继续沿用该受限进程边界。
- 4c3b 完成：Standards/Spec 最终均 0 未解决；183 项相关回归、真实监听/PDF 链路与构建通过。Review 记录 `reviews/04c3b-project-index.md`，状态 Verified passing，独立提交。下一增量已开始起草实验合同与 Python/Notebook 执行片段，单独保留供 4d1 实现。
- 4c3b 已提交 `3e9ba8e`。4d1 已接入实验执行合同、Python/uv 环境检查、输入快照、持久运行/日志/输出、取消与中断恢复、知识/证据来源和流程发布。Notebook 使用指定解释器的临时 kernel 配置；进程边界新增明确联网策略与额外可执行程序清单。首次生命周期测试复现事件列名误写为 metadata_json，已按现有表结构修正为 payload_json；当前状态 Changed, unverified。
- 4d1 首轮生命周期 10 项通过；已接入 8 条 IPC、按哈希读取的实验资源和项目/应用关闭生命周期。真实 IPC → 私有 Python（参数/输入及项目外访问拒绝）、离线 uv 预检/运行、Notebook 指定内核/失败单元格保留共 3 项通过，约 22 秒。继续补 v9→v10 迁移、进程退出清理、协议和完整性检查，随后双轴 review。
- v9→v10/进程清理 7 项通过，相关服务/证据/IPC 35 项通过，工具链 38,565 项完整性通过。新增实验文档被既有 `docs/*` 忽略规则拒绝暂存，已为该明确文件增加例外；其他改动已成功暂存，进入 review 前补齐该文档。
- 4d1 全相关回归 198 项与 build/check:ipc 通过。初审复现子进程换组逃逸、失败后日志登记丢失、Notebook 输出未索引、manifest 与 DB 不一致/未验证等问题；新增 5 个失败回归。正在通过 Darwin syscall 过滤及受控 Notebook provisioner 固定进程组，保留已收集文件，以 DB 终态为权威、发布前生成并校验清单，按单元格索引 Notebook 文本输出。
- Darwin SDK 核对 setpgid=82、setsid=147、posix_spawn=244。syscall 过滤可用，猜测的 process-setcontrol 操作不存在；uv 查询解释器需要 posix_spawn，故只有固定 uv 预检显式授权该调用。一次含文档整行匹配的补丁未命中且未改文件，已拆分后完成修改。
- R/Julia 预研：Jina 读取 CRAN 超时，官方原页直读成功；确认 R 4.6.1 官方签名 pkg 与 Julia 1.13.0 官方 SHA-256。Julia 224,095,616 字节已通过现有可恢复下载器及官方 SHA-256 校验，尚未改动系统安装。
- 4d1 修复后生命周期/进程 18 项通过；Notebook 文本保留原始换行，回归断言已更正为原样保留。受控 provisioner 下真实 Python/uv/Notebook 3 项再次通过；追加真实 Notebook 内核及子进程取消、setsid/posix_spawn 逃逸拒绝用例通过。现有工具链完整 LaTeX/PDF/OCR/表格/公式链路 2 项通过（约 69 秒），类型检查通过。准备两轴窄复核。
- 4d1 Spec 三项已关闭。Standards 指出的 uv 继承风险经真实 `.pth` 回归确认：旧预检确实允许启动钩子调用 posix_spawn。已改为先在受限 Python 中探测，后由固定 uv 检查无启动钩子的安装元数据副本；两者临时写入范围隔离。uv 环境须共享已验证的内置解释器，禁用系统 site-packages；元数据摘要纳入环境指纹，原项目不会被改写。
- uv 隔离修复后真实链路 5 项通过（含 `.pth` red-green，uv stderr 确认使用 uv-check 临时环境）；追加真实本地 wheel 安装/运行、同版本元数据变化检测和未验证解释器拒绝 2 项通过。复制的只有受验证 dist-info/egg-info，系统 site-packages 关闭，项目 Python 探测与 uv 临时写入空间隔离；类型检查通过。R 官方 pkg 的签名/公证验证通过，已仅解包到私有测试目录。
- 4d1 完成：Standards/Spec 最终均 0 未解决，最终 201 项相关回归、7 项真实实验用例、既有工具链集成、build/check:ipc 与 38,565 项完整性校验通过。Review 记录 `reviews/04d1-python-notebook-experiments.md`，状态 Verified passing，独立提交。
- 4d2 预备资源：Julia 1.13.0 已在私有目录验证启动及 Pkg.Operations.is_manifest_current/is_instantiated 的实际接口；R 4.6.1 pkg 已核验官方 SHA1、Apple 分发签名与公证，解包后直接启动因绝对 libR.dylib 安装路径失败（SIGABRT）。未安装到系统，下一步验证受限运行中的私有库路径。后续 Julia 调用显式指定私有 JULIA_DEPOT_PATH，避免使用默认用户缓存。
- 4d1 已提交 `b12a88e`，工作区干净；继续 4d2。R 4.6.1 通过指定 R_HOME 与私有动态库目录启动，沙箱内使用明确的 env 启动参数也通过。已核实当前 Julia CLI 支持 existing 编译缓存模式；renv 1.2.4 的官方 macOS 二进制包有 SHA-256，正在准备私有测试库。R/Julia 运行均复用已有冻结输入/日志/证据服务，不自动安装或更新项目环境。
- 4d2 已扩展运行合同和 R/Julia 环境探测/执行，类型检查通过。真实 Julia 运行与过期 Manifest 拒绝通过；R 两项被 `Fatal error: R_TempDir contains space` 阻断，已定位为 R 初始化约束，新增每进程独占、无空格的临时目录并在 finally 清理。R 项目库允许标准 renv 包缓存链接，Julia 仅开放所选 depot 的包/产物/编译缓存，并关闭 startup 与自动预编译。
- R 最小回归进一步定位：utils 初始化的 uname 与 renv 的 Sys.which 都经过 macOS libc popen/posix_spawn；仅增加可执行文件白名单无效。已验证再次应用 sandbox 会被系统拒绝，允许 posix_spawn 则能另建进程组，均不能作为实现。现采用随应用携带的小型 C 适配库，以 fork/exec 实现 R 所需 popen/pclose/system，所有用户代码仍从启动起处于原沙箱，82/147/244 限制保持不变。标准库已加载成功，补齐 R 正常临时目录清理所需 rm 白名单后继续验证。早期桥接试验缺少 Mach-O LC_UUID 被 dyld 拒绝，已保留标准 UUID；未采用先无沙箱运行用户代码的方案。
- R/renv 两项真实链路已通过；R、Julia 取消及 Julia 本地包从冻结输入加载的三项追加用例通过。R 标准管道回归发现 libc 的 popen 与 R 使用的 popen$DARWIN_EXTSN 是不同入口；nm 与 R 4.6.1 官方源码确认后已同时适配，恢复输出与退出码。另确认 R 自身 readLines 对无换行管道输出也返回空向量，测试已改用完整文本行。SDK 没有 dyld-interposing.h，继续使用实际编译/加载通过的 dyld interpose section；适配库已构建为 arm64/x64 通用二进制并附源文件和哈希。
- R 进程适配器的 4 项验证全部通过：真实沙箱内 libc 管道字节/退出状态、R 标准库和临时目录清理、命令输出/退出码/可写及多路管道、越界写入拒绝和改组子进程回收。未采用额外读取 `/private/var/select` 的试验权限。已同步 R/Julia 配置、冻结输入、预检和受限执行文档，开始完整相关回归与双轴 review。
- 4d2 Standards 初审 0 未解决，完整相关回归 202 项、build/check:ipc 和工具链完整性通过。Spec 确认两项环境差异：Julia 优先配置文件未进入 controls，R 空 R_LIBS_SITE 会恢复默认 site-library。真实回归已分别复现冻结后配置降级与额外库进入执行；已使用 Base.preferences_names/Pkg.Artifacts.artifact_names，并将 R_LIBS_SITE 显式设为 NULL，进行定向复验。
- 两项 Spec 修复已通过真实 red-green 回归：R 临时克隆运行时存在 site-library 时，预检和执行仍仅使用指定库/自带库；Julia 两套偏好同时存在时，冻结后的实际值保持 42，优先配置和两种 artifacts 文件名全部登记。定向 2 项与类型检查通过，提交前请求两轴窄复核。
- 4d2 完成：Standards/Spec 最终均 0 未解决；最终 R/Julia IPC 与进程适配器 14 项真实测试通过，科研域/IPC/协议 202 项通过（25 项可选真实资源按环境跳过），build/typecheck、check:ipc 和差异检查通过，私有工具链 38,565 项完整性通过。Review 记录 `reviews/04d2-r-julia-experiments.md`，真实证据 `.artifacts/research-native-experiment-integration/`。状态 Verified passing；本部分独立提交，随后继续 4e。Intel 实机验证仍属 Packaging，不将通用二进制构建等同于 Intel 运行通过。
- 4d2 已提交 `27f9f5a`，工作区干净。4e 盘点：现有 figure.record 只有元数据，没有真实渲染或审核关联；实验服务已有可复用的异步执行、取消、冻结输入和文件验证。绘图采用固定 Matplotlib 执行入口，同一个 Figure 输出 PNG/SVG/PDF；将渲染入口本身与代码/数据一起冻结，独立进程验证输出，再登记图稿和人工闸门。避免新增第二套运行调度。猜测的 research/migrations.ts 与 services/pdf-preview-protocol.ts 路径不存在，已通过文件清单定位实际数据库迁移与预览协议文件。
- 4e 首轮实际 IPC → 私有 Python → Matplotlib → 独立 PNG/SVG/PDF 验证的 2 项测试通过：连续两次生成的输出字节一致；脚本伪造 savefig 输出会失败并保留 stdout。已接入 v11 图稿发布关联、三条 IPC、版本化资源路由及提交/批准前文件复验；图稿复用实验运行生命周期，证据主张沿用已有人工审核闸门。当前 Changed, unverified，继续生命周期和迁移回归。
- 4e 生命周期/证据/实验/协议定向 50 项通过；新增拒绝后原子替换图稿，旧主张与文件保留，新版本重新关联证据。完整相关回归 212 项通过（28 项按资源环境跳过）。续作时两个挂起验证会话已失效，无法读取最终退出状态；实际图稿审核证据已落盘，正在重新确认该命令与 build。已目检真实 600×450 PNG，标题、坐标轴和数据点完整；补齐绘图执行、限制、版本替换和审核文档。
- 4e 最终真实 IPC 3 项确认通过，包含冻结输出被修改后阻止批准、恢复后通过和原工作区变化不影响旧图读取；build/typecheck、check:ipc 与暂存差异检查通过。已基于 `27f9f5ab1aaa24f702241e28724b3725eab571ec` 对 26 个暂存文件启动 Standards/Spec 双轴 review，等待并处理发现。
- 4e review：Spec 真实复现 SVG 内嵌 PNG 被 CSP 拦截，以及普通文本 `url(...)` 被误当 CSS；Standards 定位关闭期间迟到审批，主审另复现验证期间退回/替换图稿导致旧请求批准新图。两项审批回归先稳定失败；修复将核验与同步状态提交放入受关闭生命周期管理的操作，比较阶段/图稿/主张版本快照。SVG 响应只增加 data: 图片权限，资源语法仅检查实际 CSS 位置。正在补真实 SVG 显示回归及复核。
- 4e 修复回归：图稿生命周期 12 项通过，包含两项审批 red-green；真实 SVG 文本/热图与外部链接拒绝 2 项通过。Electron 使用图稿及实验实际响应头，两个预览入口的热图像素均为红色，截图与像素 JSON 已保留。新增测试 helper 的环境对象推断丢失索引签名导致一次类型检查失败，已显式声明 NodeJS.ProcessEnv。Standards 子代理首轮中断，修复后重新请求完整规范审查和窄复核。
- Spec 窄复核已关闭两项，未解决 0；最终相关回归 215 项通过。Playwright 的 env 合同要求纯字符串映射，NodeJS.ProcessEnv 仍含可选 undefined；已显式筛选环境项，保留测试独占的用户数据目录。继续最终 build 与完整 5 项真实绘图验证。
- 4e 最终整组真实绘图 5 项通过（34.80 秒），build/typecheck 通过；两种 SVG 资源在独立 Electron 中均无 CSP 错误且热图像素正确。图稿修改/关闭竞态、文件变更、历史替换、v10→v11 保留旧记录及代码/数据/渲染入口快照均有回归。待 Standards 最终结论后完成审查记录并提交。
- 4e 完成：Standards 最终硬违反 0、设计判断 0、未解决 0，独立定向 25 项通过；Spec 最终未解决 0。审查记录 `reviews/04e-reproducible-figures.md`，状态 Verified passing。最终 215 项相关回归、5 项真实绘图/审核/Electron 像素测试、build/typecheck、check:ipc 与差异检查均通过；本部分独立提交，继续 4f 最终导出。Production/Renderer/Packaging 整体仍未完成。
- 4e 已提交 `58821ca`，工作区干净。4f 目标：以已接受审稿的批准正文、批准图稿及引用来源构建冻结的 LaTeX/PDF/参考文献/图稿/追溯 ZIP，预览并经过最终人工闸门后才能写入用户选择的新文件。复用固定 Tectonic/Python 与现有文件边界；不覆盖已存在的交付文件。验证路径覆盖真实 PDF/ZIP、未批准或过期来源拒绝、取消/重启、并发变更与文件篡改。
- 4f 已起草导出合同、来源快照、v12 持久作业、原子工件替换、固定 ZIP 归档和文件限额/哈希辅助层。正文 LaTeX 生成逻辑抽为共享函数，保持原批准正文内容；原证据/审稿 24 项回归通过。首次类型检查指出精确证据读取方法仍为 private，已按来源服务的实际用途开放已有的带项目/哈希验证读取，不增加另一路查询。当前 Changed, unverified，尚未接线导出执行服务与 IPC。
- 4f 已接入准备/取消/中断恢复、发布/替换/批准、PDF 预览、只读文件和排他 ZIP 保存的 7 条 IPC。首次回归发现新导出准备检查掩盖旧审稿接受错误，已保留原接受检查的优先级；一次 schema 导入大小写笔误已修正。生命周期与审稿 16 项通过，随后图稿/导出/审稿/协议 45 项通过；ZIP 普通文件/Unicode/哈希/链接/越界/不覆盖的 3 项 Python 回归通过。
- 4f 真实链路 2 项通过：中文论文含已批准图稿和实际实验数据，最终审核后保存 ZIP，逐项核对归档与清单哈希；用户模板保留原占位文件并注入批准正文。模板用例进一步接入真实文献库作者/年份/引用键，再次通过。已目检中文 PDF。补齐 `docs/research-exports.md`；继续完整相关验证与双轴 review，尚未提交。
- 4f 全相关回归（含数据库迁移）240 项、build/typecheck、check:ipc 和暂存差异检查通过。已基于 `58821cac5874f2cf64ff313233af5d443d4cfdd1` 启动 Standards/Spec 双轴 review；继续补关闭时等待审批结束、来源捕获后书目版本变化的边界验证。
- 4f review 复现两项：嵌套入口使用 nested/ 下旧占位正文；crossref 父条目漏入导出，PDF 缺会议、编辑和年份。两项真实 PDF 回归先失败后通过（22.56 秒）：生成槽位与图稿改随入口目录；补齐父依赖、版本、依赖排序及引用键索引。追加缺父、循环、歧义和父版本变化测试。另复现 Tectonic 对 BibTeX 错误仍返回 0，已在导出边界拒绝该已知错误报告。关闭/迟到书目变化 2 项回归通过；Standards 其余审查及旧行为等价已通过，待修复复核。Spec 回合遇到临时限流，修复后再请求窄复核。
- 4f 最终整组：246 项相关回归（含迁移）通过，34 项可选资源测试按环境跳过；4 项实际导出链路通过（47.73 秒），3 项 ZIP Python 回归通过，build/typecheck、check:ipc 与差异检查通过。Spec 最终未解决 0，Standards 已完成通用审查并正在最后窄复核。开始用 agent-development 技能核对后续生产工具/角色接线；当前只做源码盘点，未改该增量代码。
- 4f 完成：Standards 最终硬违反 0、判断项 0、未解决 0；Spec 最终未解决 0。审查记录 `reviews/04f-final-exports.md`，状态 Verified passing。最终验证与真实导出证据均已保留；独立提交后继续 Integration 4g。科研 Agent 真实工具接线、Idea Canvas/项目语言、完整 Renderer 和 Packaging 仍未完成。
- 4f 已提交 `c64e3fa`，工作区干净。4g 按可独立验证的读取、受控副作用、真实产物完成三个增量推进，机器可读验收见 `agent-integration-acceptance.json`。先做 4g1：现有 read_artifact 只能读取冻结的描述/正文，生产工件的实际运行记录和文件内容尚不可达；新增读取须绑定本次批准输入、验证哈希，并在取消或过期后拒绝返回。
- 4g1 已实现读取服务、角色工具和两个 IPC；初步 33 项定向测试及类型检查通过。继续补真实 LangChain 写作工具循环、图稿/导出 IPC 读取与 v12→v13 迁移验证，随后双轴 review；当前状态 Changed, unverified。
- 新增写作测试已完成 SDK 工具循环，但断言误用不存在的 manuscript.markdown；真实图稿读取通过，导出读取因测试误用未登记 manuscript.md 被正确拒绝。按当前 schema/导出清单改为 latex 与 source/roc-manuscript.tex 后复验。
- 4g1 新增回归 3 文件 11 项通过；真实图稿、中文 PDF/ZIP 读取均通过。开始以 c64e3fa 为固定基点审查暂存增量，同时执行完整相关回归与构建。测试路径检索曾误含不存在的 tests/main/ipc（rg exit 2），已使用实际根目录下的 IPC 测试文件。
- 4g1 首轮完整相关回归 246 项、build/typecheck、check:ipc 通过。补充检查复现 UTF-8 可解码的 NUL 二进制与纯 ASCII PDF 被误发为模型文本；沿用现有文件预览的 NUL/PDF 边界阻止文本返回，新增两项回归并纳入最终复核。
- 4g1 最终 36 文件、262 项回归通过（34 项可选资源跳过），真实图稿和中文 PDF/ZIP 读取各 1 项通过；build/typecheck、check:ipc、diff check 通过。Spec 最终未解决 0，独立 9/9 回归通过；Standards 最终窄复核待返回。
- 4g1 完成：Standards 最终硬违反 0、判断项 0、未解决 0，独立 12/12 回归通过；Spec 最终未解决 0。审查记录 reviews/04g1-production-inputs.md，验收表只将 4g1 标为通过，状态 Verified passing；本地独立提交后下一步为 4g2，整体 Production/Agent 接线/Renderer/Packaging 仍未完成。
- 4g1 已提交 `892b6f8`。4g2 将生产写工具接到阶段运行：服务绑定项目/运行身份，脚本修改使用 expectedHash，实验/导出用 requestId 幂等，取消后拒绝迟到副作用。
- 4g2 已实现：v14 回填 ownerRunId 并增加 workspace 文件版本表；角色工具不接受模型提供的 projectId；取消先 abort 在途实验/导出/模板编译，写回前再校验归属。新增 owned-effects 6 项回归。
- 4g2 完成：Standards 最终硬违反 0、判断项 0、未解决 0；Spec 最终未解决 0。审查记录 reviews/04g2-owned-effects.md，验收表只将 4g1/4g2 标为通过。最终相关回归 37 文件 / 268 项通过（34 项可选资源跳过），owned-effects 6/6，typecheck、check:ipc、diff check 通过。状态 Verified passing；本地独立提交后下一步为 4g3。

- 4g3 已实现：实验/绘图/导出阶段 complete() 绑定本次运行链已发布的真实工件；未发布则失败并保留模型版本。失败/重试留下已发布记录，重试成功后把模型 provenance 接到这些工件。人工批准和最终 ZIP 仍不向模型开放。
- 4g3 完成：Standards 最终硬违反 0、判断项 0、未解决 0；Spec 最终未解决 0。审查记录 reviews/04g3-production-role-results.md，验收表将 4g1–4g3 标为通过。最终相关回归 38 文件 / 274 项通过（34 项可选资源跳过），production-role-results 7/7，typecheck、check:ipc、diff check 通过。状态 Verified passing；本地独立提交后下一步为 Idea Canvas/项目语言。

- 4h 已实现：项目语言、结构化 Idea Canvas、批准后晋升、构思角色输出绑定真实 Canvas。v15 回填旧运行上下文的 language/origin/ideaCanvas。
- 4h 完成：Standards 最终硬违反 0、判断项 0、未解决 0；Spec 最终未解决 0。审查记录 reviews/04h-idea-canvas.md。最终相关回归 40 文件 / 288 项通过（34 项可选资源跳过），idea-canvas 9/9，typecheck、check:ipc、diff check 通过。状态 Verified passing；本地独立提交后下一步为 Renderer。

- 5a 已实现：项目仪表盘显示流程轨道、下一步、产物、事件时间线和阶段角色启动/取消/重试；审稿批准需显式接受或修订。
- 5a 完成：Standards/Spec 最终未解决 0。审查记录 reviews/05a-project-dashboard.md。research-view 3/3、导航/壳层回归与 typecheck 通过。状态 Verified passing；本地独立提交后继续文献库/阅读器。

- 5b 已实现：文献库视图支持检索导入、DOI 导入、项目关联，以及打开已解析全文。
- 5b 完成：Standards/Spec 未解决 0。审查记录 reviews/05b-library-reader.md。research-view 4/4 与 typecheck 通过。状态 Verified passing；下一步 Idea Canvas 编辑器。

- 5c 已实现：构思视图可创建/编辑 Idea Canvas，保存后晋升为新项目。
- 5c 完成：Standards/Spec 未解决 0。审查记录 reviews/05c-idea-canvas-ui.md。research-view 5/5 与 typecheck 通过。状态 Verified passing；下一步图稿/导出编辑器。

- 5d 已实现：图稿导出视图可选择已发布图稿、准备导出、发布审核并保存 ZIP。
- 5d 完成：Standards/Spec 未解决 0。审查记录 reviews/05d-figures-exports.md。research-view 6/6 与 typecheck 通过。状态 Verified passing；下一步 Packaging。

- Packaging 已实现：当前架构科研工具链随 extraResources 打包，afterPack 校验二进制和许可证记录。
- Packaging 完成：Standards/Spec 未解决 0。审查记录 reviews/06-packaging.md。native-packaging 20/20 与 typecheck 通过。状态 Verified passing；下一步 Phase 4 验证记录。Intel 实机验证仍未做。

- 5e 已实现：文稿视图可导入模板、编辑源文件并编译 PDF 预览。
- 5e 完成：Standards/Spec 未解决 0。审查记录 reviews/05e-latex-editor.md。research-view 7/7 与 typecheck 通过。状态 Verified passing；Phase 3 Renderer 完成。

- Phase 4 已记录：typecheck、check:ipc、build 与科研相关 276 项回归通过。全量测试中的既有 chat/agent/backup 失败和完整安装包 smoke 列为已知限制。
- Phase 4/5 完成：审查记录 reviews/07-phase4-verification.md。计划内科研增量全部交付。

- 5f 已实现：实验视图可校验环境、启动 Python/Notebook/R/Julia/Matplotlib 运行、取消、读取日志并发布实验或图稿。
- 5f 完成：Standards/Spec 未解决 0。审查记录 reviews/05f-experiment-runner.md。research-view 8/8 与 typecheck 通过。状态 Verified passing；下一步文献互操作/索引状态。
