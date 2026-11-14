# 科研工件检查器

助手人工闸门的真实工件链接在唯一 AppShell 中按需打开抽屉，供读取保存内容、原文与生产文件，再返回助手作明确决定。没有独立阶段页或 renderer 直接批准入口。

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
