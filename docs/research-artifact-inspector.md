# 科研工件检查器

助手人工闸门的真实工件链接在唯一 AppShell 中按需打开抽屉，供读取保存内容、原文与生产文件，再返回助手作明确决定。没有独立阶段页或 renderer 直接批准入口。

检查器使用 920px 的自适应抽屉，窄窗口受现有 ModalShell 可用宽度约束。正文、编辑表单与来源元数据共用阅读布局；窄窗口将双列信息排成单列。综述协议列表独立滚动，为当前协议内容保留空间；关闭、焦点恢复、草稿与进行中操作仍由原边界管理。

## 保存快照

`research.artifacts.inspect` / `research.inspectArtifact` 输入显式 projectId、artifactId、nullable expectedVersion；初读为 null。ID 必须属于项目，不接受标题、任意路径或旧时间戳代替。

一致读取返回工件、项目/阶段状态、保存角色输出、真实来源运行/任务、主张、原始来源及 nullable production。未保存输出为 content:null，未记录运行为 origin:null；只有真实任务返回 return_to_task，当前闸门可返回 review_gate。

version 是严格序列化保存内容的 SHA-256，不含读取时间。正文、主张、定位失效、来源、生产元数据、审核头或阶段状态变化都能改变版本，同时间戳修改也可识别。预期不符返回 stale 与实际新快照；元数据 hash 不证明当前磁盘字节有效。

检查不读 artifact.path、不联网、不运行模型/worker、不写库。原始状态照实返回；`inspectEvidence` 的 recorded 仅表示未保存失效标记，superseded 保留原片段，严格消费者 `getEvidence` 仍拒绝失效证据。缺失、跨项目和原文 hash 损坏明确失败。固定 sourceLocator 参与工件 hash；原文阅读见[证据关系](research-evidence-relations.md)与 [PDF 导航](research-pdf-navigation.md)。

## 整阶段版本与人工决定

`getGateReviewContext` / capability `research.workflow.gateReview` 输入 projectId、expectedStage、nullable artifactId，要求项目未归档且当前阶段 waiting_approval。一次一致读取返回全阶段工件链接、发现检索计划/hash与读取时间，不写库或执行生产验证。

approve/reject 和审稿接受/修订/退回须携带非空、唯一、完整的 expectedArtifactVersions。集合与每个 SHA-256必须匹配当前阶段；人工批准在异步生产验证前及事务写入前各验一次，期间来源失效也不能批准。科研 HITL 严格解码人返回的 reviewedArtifactVersions，不采用重放读取的新版本代替人核对值。

缺失/过期决定明确拒绝，进入新的 review 节点调用及 interrupt，要求重新阅读、明确决定；领域发布及未知错误继续传播，不自动重放旧批准。

助手卡片和检查器均提供显式全阶段重读。读取中/失败禁用决定；成功只替换展示上下文。检查器须先让所选工件显示版本匹配全阶段版本，才能“返回助手重新确认”；局部刷新不替换整阶段核对值。返回绑定原 interrupt/project/stage，聚焦原卡片重读按钮，由原 resumeApproval 提交决定。项目/选择变化隔离迟到响应。

真实链接缺失、重复、非法时显示错误并禁用决定，不按题名猜 ID。检索计划异常但工件版本有效仍可退回。Escape/关闭恢复实际入口焦点，关联任务复用管理抽屉。

## 人工编辑与异步状态

方法计划、结果评估、引用与数值审核、回复矩阵、期刊检查和公开导出共用
[`ArtifactEditorBoundary`](../src/renderer/artifacts/artifact-editor-guard.tsx)。各模块按需加载，只有明确打开后才读取对应报告或历史。

- 未保存草稿阻止刷新来源、交叉编辑及阶段决定；关闭、切换工件或离开项目时须明确放弃修改。保存期间禁止关闭、切换和重复提交；关闭窗口也受未保存状态保护。
- 请求失败保留草稿和错误；需要精确重试的写入保留原 requestId 与完整请求。内容变更必须形成新请求，不能将失败显示为空成功。
- 当前报告必须匹配展示的工件版本；读取中、失败或来源改变时不沿用旧成功报告。项目、工件或所选来源变化后，迟到响应不能填入新范围。
- 人工审核保存后刷新工件，重新核对受影响的阶段版本。局部保存不代替整阶段重读，也不提交助手批准。

人工写入的身份由主进程根据有效 IPC sender 绑定到精确项目和能力，wire 参数不能提供 actor 或自行授予批准权。该边界见
[`research-human-context.ts`](../src/main/services/research-human-context.ts)。可写阶段、已批准工件例外、父版本、来源重验及归档后的重放规则由各模块决定，不能从“历史可读”推断“可以新增或重放写入”。

`stored_receipt` 历史只核验保存内容、哈希与版本链，不证明当前来源有效。当前核验另走各模块的来源检查。
特殊合同见[方法与评估](research-ideas.md)、[实验指标](research-experiment-results.md)、[写作检查](research-writing-checks.md)、[图稿](research-figures.md)、[回复矩阵](research-response-matrix.md)、[期刊检查](research-journal-compliance.md)和[导出](research-exports.md)。

## Agent 提案与下一步

`research_inspect_workflow` 读取真实阶段状态、工件版本和各领域检查报告，返回问题、涉及对象、建议行动和需人工处理的事项。期刊候选规则可预检，人工判断留待审核。历史页和实时检查分别标明验证范围。

当前项目的主助手可通过 `research_propose_change` 保存方法计划、引用直接性、正文或图稿数值映射、回复矩阵、期刊规则和实验结果审核提案。宿主从有效的工具执行记录取得运行、会话和能力清单，记录目标版本、相关工件版本和材料依据。`research_read_proposals` 可读取提案状态和版本变化原因。

在对应工件表单中读取提案，核对依据后可填入当前草稿或填写理由拒绝。填入前重验提案和来源，保存通过原人工接口校验。后续版本变化会使旧提案过期，历史和拒绝记录仍可阅读。

## 生产文件核对

`inspectProductionReview` 要求 projectId、artifactId、非空 expectedVersion，再核对实际生产文件；`readProductionReviewFile` 另要求 area、manifest 相对 path 与 expectedFileHash。保存发布源决定读取器和根目录，renderer不能选择任意路径。读前及异步读后均校验工件版本，bytes/hash/size须匹配捕获值和当前 metadata。

未批准工件仅在实际待审核闸门供人工核对，批准工件可读；归档、替代、错范围、非可审核阶段或旧版本拒绝。角色生产读取仍要求批准，人工作用域不扩展角色 allowlist。实验 manifest 缺失直接失败，不通过检查重建发布记录。

按“查看生产文件”加载实验、图稿或导出视图：

| 类型 | 核对内容 |
| --- | --- |
| 实验 | 真实执行、环境、参数、输入 hash、退出码和时间 |
| 图稿 | 发布/运行、源文件、物理/像素尺寸、种子、发布/渲染 hash |
| 导出 | 保存正文、来源、工具链、ZIP hash及书目/图稿/审稿报告 |

输入/输出/日志/交付按区选择。文本转义展示，PNG/JPEG/WebP读取已验证内容；4 MiB以上禁用预览，ZIP仅显示校验元数据，生产列表 PDF 预览尚未接入。Evidence/Claim的独立原文 PDF 阅读仍可用。

版本或文件改变立即清除旧内容；核对/读取失败保留错误并提供显式重试，不伪造未记录环境或成功状态。公开导出、实验及图稿的领域合同分别见[导出](research-exports.md)、[实验](research-experiments.md)、[图稿](research-figures.md)。

## 窗口内阅读恢复

AppShell按实际 project/artifact 在内存 Map保存工件 SHA、正文/生产文本滚动、details展开、焦点及区域/文件元数据。关闭、返回助手、打开任务前捕获；不持久化原文 bytes、审核上下文或决定，重启窗口不恢复。

重开先检查真实工件，SHA相同才恢复；生产文件重新经过 inspect/read，位置不授予读取权限。新版本丢弃旧展开与文件选择，异步内容挂载后恢复位置，用户 pointer/key/wheel立即停止恢复，迟到内容不能抢回手动位置。
