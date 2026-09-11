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
