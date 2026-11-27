# 文献自动入库合同

文献检索只保存候选和检索回执。明确导入时，元数据登记后即可返回；全文处理由主进程接手。`fulltext_auto` 表示自动获取可用全文，`metadata_only` 表示只登记元数据。无可用 PDF 时，已登记的文献仍可引用和管理。

| 阶段 | 就绪依据 |
| --- | --- |
| 元数据 | 已提交的文献条目和项目关联；关键词状态仅指标题、作者、摘要等字段 |
| PDF | 已校验的文件哈希和下载或复用收据；项目导入还需完成 `papers/` 发布 |
| 解析 | 文档为 `ready`，具有当前解析版本，正文通过质量和身份核验 |
| 全文索引 | 当前解析的索引 generation 已发布；关键词与向量分别核验 |
| 论文 Wiki | 当前解析对应的 Paper Card 与 Wiki 来源页已有可读版本 |
| 专题 Wiki | 以当前可用论文为依据发布专题版本，写明覆盖数量和证据出处，保留人工章节 |

只有 PDF、解析、全文关键词和向量索引、项目论文 Wiki 均就绪，才报告项目文献完整处理完成。专题 Wiki 另报覆盖范围。全局库没有项目 Wiki，之后关联到项目时可复用内部 PDF。

## Wiki 发布边界

来源页就绪必须同时满足当前解析的六维 Paper Card、已编译来源页、原始引用与依赖版本核验。仅创建页面不算就绪。全局库以已核验的 Paper Card 为对应发布物，不创建虚构的项目 Wiki。

每个导入操作在目标项目中对应一个稳定专题页，使用持久化批次成员确定候选，以最初请求篇数作为覆盖分母。来源页晚到会补入同一个专题；部分覆盖可以阅读，页面仍明确显示未覆盖数量。首层专题采用研究问题、贡献、方法、实验条件、结果与局限六维的原文并列对照，引用原始块并保留条件；没有依据的分类、跨论文优劣、共识和研究空白均不自动断言。这是带来源的整理草稿，科学综合质量仍需单独评估。

后台重编译保留人工及助手章节和历史版本；人工覆盖覆盖范围章节时阻塞自动完成。重解析、切换 Embedding 配置或来源页失效会重新核验已完成任务。Wiki 失败仅重试 Wiki 阶段，复用已经核验的 PDF、解析和索引。

## 持久化与故障边界

元数据导入以 `requestId` 幂等。采用 `fulltext_auto` 时，每条成功登记的文献在同一事务中加入目标范围（项目或全局库）和文献身份对应的后台任务。同一文献可被多个批次引用。项目、来源和路径均由主进程验证；Agent 不提供任意下载地址或写入目录。结束 Agent 对话不取消已提交的任务。

任务分别保存阶段 `resolve/download/import/parse/index/wiki` 与状态 `queued/running/ready/blocked/failed/unavailable/cancelled`，连同 `generation`、尝试次数、`nextRetryAt`、文档、来源候选和下载收据持久化。启动把中断的 `running` 任务重新排队；已经排队等待退避的任务保留重试时间。显式重试仅接受 `failed/blocked/unavailable/cancelled`，要求当前 generation 并生成新版本；旧任务不能覆盖新状态。此合同由 [literature-acquisition.ts](../src/shared/schemas/literature-acquisition.ts)、[repository](../src/main/plugins/research/literature-acquisition-repository.ts) 和 [service](../src/main/plugins/research/literature-acquisition-service.ts) 定义。

| 情况 | 可见状态与恢复行为 |
| --- | --- |
| 没有开放全文或来源拒绝访问 | 保留元数据，显示原因，允许手动附加 PDF 或重试 |
| 网络暂时失败、限流、应用关闭 | 临时网络失败保存阶段和重试时间，达到尝试上限后转为 failed；启动恢复中断任务，限流尊重 `Retry-After` |
| 现有 PDF 有效、任务中断 | 通过哈希及文档身份复用；没有收据的临时文件可以重新获取 |
| PDF 损坏、为空或身份明显不符 | 不发布为可检索正文，保留错误原因 |
| Parser 或 Embedding 配置缺失 | 阻塞对应阶段；保留已提交的 PDF 和解析产物 |
| 向量或 Wiki 生成失败 | 状态显示失败；重试时从缺失阶段继续 |
| 重解析、配置变化或旧任务迟到 | 用解析版本、索引 generation 和任务 generation 校验发布；保留历史证据 |
| 用户取消 | 不再推进未提交阶段，已完成的阶段继续可用 |
| 工作区文件被更改或文件名冲突 | 保留用户文件，以内部不可变副本和内容哈希复核证据 |

## PDF 来源、退避与版本发布

解析器仅接受身份匹配的 Provider 明确声明的 PDF 字段，包括无 `.pdf` 后缀的下载端点。OpenAlex 使用 `best_oa_location` 及明确 `is_oa:true` 的 primary/其他 locations；兼容 best OA 记录缺少 `is_oa`，明确 false 则拒绝。Semantic Scholar 使用 `openAccessPdf`，Europe PMC 要求 `documentStyle:pdf`；落地页不会因为路径像 PDF 就成为候选。

候选仍要求 HTTPS、无凭据/片段、公开主机与标准端口。下载时继续逐跳核验 DNS/公网地址、固定连接地址、限制大小、流式校验 PDF 头尾；下载成功后仍需既有解析质量和论文身份校验。

解析器依赖可配置 `versionPreference`：`balanced` 保留发现顺序（含 arXiv 优先），`preprint` 优先预印本，`published` 优先出版版、其次接受稿。未知版本不推断为最新版；明确指定的 arXiv 修订不会改成未锁定 URL。排序回调可返回理由与发现位置，实际取得版本、许可证、来源和内容哈希仍写入原有收据。“文献处理 → 获取偏好”可保存跨项目的版本偏好，下次来源解析生效；已保存候选不会随设置变化自动重排，也不按解析质量学习排序。设置经严格 IPC 写入主进程配置，不使用 renderer localStorage，界面入口为 [AcquisitionPreferences.tsx](../src/renderer/literature/AcquisitionPreferences.tsx)。

领域来源支持公开 OpenReview Note 的 PDF 字段，以及合法 ACL/CVF 文献标识对应的官方 PDF 地址。OpenReview 复用公开读权限校验，不获取私有投稿或评审。领域标识来自已保存的 Provider 观察，不接收 Agent 指定的任意下载 URL。

获取偏好保存在主进程配置键 `literature.acquisition`，严格 schema 默认 `versionPreference:"balanced"`、`unpaywallEmail:null`；读写能力分别为 `research.library.acquisitionSettings` 和 `research.library.saveAcquisitionSettings`。这是桌面应用配置；独立公网捕获脚本另读 `ROC_UNPAYWALL_EMAIL`，不继承这里的邮箱或版本偏好。

可选 Unpaywall 仅使用 DOI 查询，在常规来源没有候选或下载失败后补充发现。解析器优先使用输入 DOI，缺少 DOI 但有 arXiv ID 时派生 `10.48550/arxiv.<id>`。用户在“获取偏好”填写联系邮箱才启用，界面明确说明会向 Unpaywall 发送 DOI 与邮箱，清空即可停用。下载失败后的补充查询成功时，`source_json.doiFallbackComplete` 随任务保存（即使未发现新候选），避免重启后无限重复；临时失败和远端等待时间进入既有重试调度。本地文件发布冲突不会触发额外 DOI 查询。邮箱不进入下载收据或原始错误消息；此设置不是新的主检索来源，也不视为独立于 OpenAlex 的 OA 覆盖证明。

下载失败携带经过清理的 provider、category 和 `retryAfterMs`，不向上层传递原始传输消息或带凭据 URL。多个候选失败时，可重试失败不会被后来的 404 或受限副本遮蔽；`429`/`5xx` 的秒数或 HTTP 日期型 `Retry-After` 最多接受 24 小时。持久任务使用指数退避加抖动与远端等待时间的较大值；来源发现失败的等待信息同样传递。重启保留等待退避任务的 `nextRetryAt`。

下载器在进程内按实际主机（含重定向目标）共享冷却时间，排队论文直接返回延期信息，不占用任务长时间睡眠。主机冷却表本身不跨进程持久化；重启后新任务仍可能首次访问该主机。该边界与已有 Provider governor 分开，不能解释为远端全局限额或跨设备协调。

下载与手动补充统一使用不可覆盖的发布规则：默认路径已存在且内容一致时复用；内容不同时发布为 `papers/年份/论文名--文献ID哈希前12位--内容哈希前16位.pdf`。带哈希路径冲突仍拒绝。历史文件及收据保留，任务收据指向本次实际副本；界面没有独立的版本关系浏览器。

## 本地文件导入

- **单文件**：新建文献默认使用 `metadataMode:"automatic"`，从 PDF 元数据和首页的明确 DOI 或 arXiv 标签识别身份，尝试精确补全。缺少可信标识时保留本地材料。手动模式使用 `provided`，保留人工题名与引用键。附加到已有文献时沿用该文献身份。
- **多文件**：在「添加文献」选择 2～500 份文档，批次登记后即可关闭窗口。请等各原件显示已保存后再移动或删除。重新打开导入面板可查看本作用域的批次和逐文件状态，并重试失败项。
- **批次执行**：主进程在 SQLite 保存清单、逐文件状态与收据。同一 `requestId` 仅可重用同一输入。接收和登记各至多一份并行，解析最多两份且仍受计算资源准入限制。启动时重新排队未完成的接收、登记和解析；已复制的文件用哈希复核后重用。重复文件和失败独立记账，失败重试从已提交的阶段继续。文件未完成接收且原件不可读时，该文件会报告失败。
- **完成范围**：「已解析」表示批次解析完成。索引和 Wiki 使用各自的后台流程及就绪收据。

批次合同见 [IPC schema](../src/shared/schemas/research-document-import-batch.ts)、[主进程实现](../src/main/plugins/research/document-import-batches.ts)及[恢复测试](../tests/unit/research-document-import-batch.test.mjs)。

## 查看处理和恢复

文献库的「文献处理」和阅读器的「处理阶段」分别展示论文信息、PDF、解析、索引、知识页。重试、取消和手动补充 PDF 均通过相应任务入口。补充 PDF 先登记本地文档，再用同一文献、同一项目下的 `documentId` 和当前任务版本重试。界面显示实际来源、版本、许可、错误与下次重试时间；列表汇总只统计当前页。文献列表、键盘操作与 Inspector 见[工作台](research-workbench.md#文献库)。

`research_add_literature` 默认使用 `fulltext_auto`。返回的 `status`、`counts` 与 `metadataImported` 描述元数据导入，`processingQueued` 是提交时的排队数。Agent 可查询和控制由当前项目上下文绑定的任务：

| 工具 | 参数或效果 |
| --- | --- |
| `research_get_literature_processing` | 按批次或文献分页查询，将返回的 `acquisitionBatchId` 作为 `operationId` |
| `research_retry_literature_processing` | 提交当前 `jobId` 与 `generation` |
| `research_cancel_literature_processing` | 取消后续处理，保留已提交的元数据与工件 |

## 项目移除与永久删除

「项目移除」只解除当前项目关联，支持六秒内撤销。「永久删除文献」需要明确确认，移除文献及其跨项目关联。主进程先事务提交删除和清理清单，再停止关联后台工作并清理受管 PDF、解析产物及索引。共享内容或已被用户修改的工作区副本会保留。未完成的文件清理以「重试清理」继续，后台也会检查持久化的待清理回执。详见[删除服务](../src/main/plugins/research/library-deletion-service.ts)和[删除回归](../tests/unit/literature-deletion.test.mjs)。

## 检查与测量

获取、恢复和 Wiki 就绪是不同的测量阶段。可复用的受控检查、公网捕获、固定分母指标及科学测量边界集中在[文献评测方法](literature-evaluation.md)；通用构建和运行环境见[开发与检查](development.md)。单次工程通过或 PDF 下载成功不能替代真实全文解析、索引、Wiki 与科学综合质量的测量。
