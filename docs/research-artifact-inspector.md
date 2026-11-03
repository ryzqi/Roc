# 科研工件检查器

## 只读快照合同

`research.artifacts.inspect` / `research.inspectArtifact` 输入只有显式 `projectId`、
`artifactId` 和 nullable `expectedVersion`。工件 ID 必须真实属于所传项目；不接受
任意文件路径、工件标题替代 ID 或旧时间戳版本。主进程在一致的数据库读取事务中
返回实际工件、项目/阶段状态、保存的角色输出、来源运行、任务标识、主张和工件内
原始来源记录。初次读取指定 `expectedVersion:null`。

`version` 是按严格合同序列化这些保存内容后计算的 SHA-256，读取时间不参与。
题名、正文、主张版本、证据定位失效、来源记录或阶段状态变化都会改变快照版本；
同一时间戳内修改也能识别。预期版本不同返回 `status:stale` 及实际新快照，不伪装为
旧版本成功。该版本针对数据库保存的快照，不声称校验任意外部文件的当前字节。

未保存角色输出时 `content:null`；来源运行不存在时 `origin:null`。没有真实任务标识
时没有返回任务操作；有实际来源任务时返回 `return_to_task`。当前待审核阶段的
工件另可返回 `review_gate`，它仅表示允许读取审核上下文，不授予批准权。原始审核状态和主张状态按保存值返回，不把历史关联升级成新
语义审核，也不把有证据 ID 当成科学支持的证明。

来源记录按工件和项目直接查询，稳定排序；不混入其他工件的来源。主张引用的证据
通过独立只读 `inspectEvidence` 返回原始片段、定位、hash 和实际失效时间。
`referenceStatus:recorded` 仅表示没有保存的失效标记，不表示重新验证原文件或科学
语义；`superseded` 保留原始片段并明确旧定位失效。严格发布消费者的 `getEvidence`
仍拒绝失效证据。缺失、跨项目或原文 hash 损坏分别失败，没有空成功快照。

检查器不读取 `artifact.path`，不请求网络、不运行模型/worker、不写数据库。
结构化实验、图稿和导出文件继续由既有 `inspectProductionInput` /
`readProductionInputFile` 边界校验和读取。助手入口、叠加面板与焦点恢复见下文；
生产类型视图和阅读定位保持仍属后续增量；人工闸门版本绑定见下文。

## 本增量验证

unit813/813、相关25/25、最终bridge/refusal4/4、Harness94/94、fresh build/typecheck、
native13/13、现有来源/候选renderer23/23、最终启动12/12、IPC/chunks1131153bytes6files
和diff通过。最终4项包括项目缺失的准确not_found分类。之前native13/unit813仍覆盖
数据读取与严格证据消费者；最终错误分类修正不改变保存内容或发布行为。
日志`.artifacts/research-optimization/xui-inspector-*.log`保留；原生工作流每个真实
完成工件的只读快照位于`p0-production/<taskId>/artifact-inspections.json`，校验实际
来源任务/内容运行对应且读取前后数据库total_changes不变。没有真实模型质量、
真实外部客户端或新检查器UI验收的完成声明。

## 助手工件入口与只读叠加面板

人工闸门工具从当前阶段实际工件 ID 的快照生成 `artifactLinks`；每条链接包含真实
项目/工件/预期内容版本及显示元数据。title-only payload 与对应旧展示辅助函数已移除。
链接缺失、重复或非法时明确提示且不能批准，不按题名猜测 ID。发现阶段的原检索计划
显示及 hash 核对继续存在，未被工件链接取代。

必需的打开回调经过 AssistantPanel/Transcript/MessageRow 到 AppShell，纳入 memo 比较。
同壳按需加载 ArtifactInspector，以现有 ModalShell 全高抽屉呈现；没有新常驻导航、
阶段页或第二壳。项目切换立即过滤旧选择并清空。保存的角色 Markdown 另行按需加载，
展示真实主张状态、原始片段、定位失效及原始快照；未保存正文明确为空。

显式刷新沿用上次核对版本。来源变化显示实际新内容和待核对状态，另有显式按当前
版本重读动作；不自动把旧版本视为有效。Escape/关闭恢复实际打开链接的焦点；真实
关联任务动作复用管理抽屉。此增量没有新批准/编辑操作；原批准仍在助手人工闸门。
把当前工件版本绑定到批准/退回，以及刷新后更新整个闸门上下文，是下一增量，
不能把本次只读闭环当成已完成这些写入约束。

最终unit813/813、相关gate/inspector11/11、Harness94/94、fresh build/typecheck/native13/13、
完整串行renderer82/82、启动12/12、IPC/chunks1132666bytes6files与diff通过。
日志`xui-overlay-*.log`及`artifact-inspector-ui/`截图/审计保留。新5项Electron测试
用真实仓库/已注册能力/生成桥接读取真实保存的工件、任务与证据ID；通过Playwright
暴露调用跨到Node测试进程，不宣称这是生产preload传输。已有native13验证实际运行时
持久化，最终生产启动验证壳装配。新UI没有数据库写入、自动批准或模型调用。

明暗1100/1099/800、长原文、reduced-motion、键盘和迟到选择均通过。审计cut0；共享
全高抽屉贴物理上/右/下边，只有这3边阴影完全隐藏且gap0，左侧阴影可见。测试逐项
限定这3处，拒绝其他裁切或隐藏。首轮源码summary被文本选择器与关闭JSON同时匹配，
修正为真实summary；随后去除不符合全高抽屉物理结构的hidden0预期，保留cut0硬门禁
并增加精确边/面板/gap断言，最终全套通过。暗色1099截图已检查，标题/关闭固定、
正文/主张/来源可读且无水平溢出。整体检查器与执行计划仍未完成。


## 整阶段人工核对与版本绑定

`research.workflow.gateReview` / `research.getGateReviewContext` 只读输入为显式
`projectId`、`expectedStage` 和 nullable `artifactId`。项目必须未归档且当前阶段等待
审核；选择的工件必须属于该项目和当前工件集合。一次一致读取返回全部工件链接、
发现阶段检索计划及其 hash、读取时间。读取不写库、不执行生产验证或工作任务。

`approve`、`reject` 必须提供非空、唯一、完整的 `expectedArtifactVersions`。每个
`artifactId` 与 SHA-256 必须匹配当前整个阶段，缺失、重复、集合变化和内容/来源
变化均拒绝。人工批准在异步生产验证前校验一次，事务写入前再次校验；审核期间
来源失效也不能批准。批准/退回事件保留人实际返回的核对值，不自动采用重放读取
的新版本。审稿的接受/要求修订/退回同样绑定全部版本。其他通用 HITL 工具不被
强制携带科研版本，但科研闸门从人返回的 `reviewedArtifactVersions` 严格解码。

闸门内部使用子图：每次 review 节点调用只有一个 interrupt。旧决定的缺失/过期
版本产生明确拒绝信息，并通过条件边进入新的节点调用和新的 interrupt ID；用户
需要核对新上下文、再次明确决定。不会重放已失败的旧 resume 来自动批准。
未知错误和领域发布失败仍向上传递。此模式遵循当前
[LangGraph 官方中断文档](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
的一次中断及条件边验证流程；没有节点内多次 interrupt 的 while 循环。

助手卡片批准、退回、修订都发送其展示的全部版本。无效真实链接禁用全部决定，
显示需要重读的错误；检索计划错误但真实版本仍有效时可以退回。检查器的显式
整阶段刷新和回到原助手确认由下一 UI 增量完成；不暴露 renderer 直接批准能力。

A3A 验证：unit819、最终gate6、Harness94、fresh build/type/native13、完整串行
renderer83、启动12、IPC/chunks1132666bytes6files和diff通过。日志`xui-gate-*.log`；
原生来源重解析故障保留真实来源身份、禁止批准和严格证据getter拒绝记录。


## 检查器返回原助手审核

检查器在当前待审核工件提供显式“读取本阶段全部审核工件”。只有用户点击时才
读取整个阶段上下文；展示全部工件题名/版本与真实读取时间。用户再点“返回助手
重新确认”才把完整上下文交回原卡片。读取/返回均不批准、不启动任务、不写库；
当前工件的局部刷新或版本 recapture 不会自动替换整个闸门的核对值。

回调经唯一壳/助手/虚拟化消息行传递，类型引用不加载检查器模块。原卡片将重读
上下文绑定 interrupt/project/stage，显示新链接和完整检索计划，要求再作明确决定。
返回后聚焦原卡片的重读按钮且避免主动滚动。Escape 仍恢复实际打开工件的链接。
决定继续走原 `resumeApproval`，没有 renderer 直接批准 capability。

卡片也能显式重读整个阶段，用于核对期间变化或无效链接的恢复。项目/阶段标识
必须真实、明确，缺失时禁用重读并提示重新请求闸门；不按题名/旧字段猜测 ID。
读取中或读取失败禁用全部决定；失败不把旧快照继续当作当前成功。重读成功替换
全部版本和发现阶段 plan/hash，但不会自动提交。选择/项目/interrupt 改变时，旧
响应与旧核对状态不能进入新范围。

整阶段重读后，检查器的返回按钮还要求所选工件的显示快照匹配该审核版本。
若正文仍旧，明确提示并禁用返回；用户必须显式刷新工件、看到新正文后再返回。
工件刷新保留已经捕获的整阶段上下文，不隐式重读或批准。

A3B 最终 fresh build/type、相关Electron13、完整串行renderer87、启动12、
IPC/chunks1132803bytes6files和diff通过。A3A unit819/Harness94/native13后端证据
沿用；本增量未改后端。日志`xui-review-ui-*.log`，最终完整上下文和返回卡片截图
保留；选择工件的审核hash、显示hash与最新正文已人工检查一致。

生产文件读取前置修复：图稿文件按真实 figure-run ID 交给图稿服务，实验/导出分别
交给自己的读取器。旧图稿路由到实验仓库导致真实PNG失败，已由native红/绿回归
覆盖。最终unit819/Harness94/fresh build/type/native13/startup12/IPC/chunks通过；
每类真实已批准文件均校验bytes/SHA/size且DB无写入，未批准角色读取继续拒绝。


## 生产来源版本与人工只读文件检查

工件快照增加 nullable `production`，保存真实实验执行、图稿发布/验证/执行或导出
执行及文件 metadata。生产工件必须有对应真实发布记录；不存在时明确失败。
这些保存值参加工件 SHA，同时间戳修改来源参数或文件校验值也会改变版本。
元数据检查仍不读取文件；保存的文件 hash 不等于已经验证当前磁盘字节。

`research.artifacts.inspectProductionReview` / `research.inspectProductionReview` 输入显式
project/artifact/非空 expectedVersion，校验版本后核对实际生产文件。只读文件入口
`research.artifacts.readProductionReviewFile` / `research.readProductionReviewFile` 还要求
area、manifest 内相对 path 和 expectedFileHash。保存的发布源决定实际读取器和根，
renderer 不能指定任意路径。读前和异步读后分别验证工件版本；返回 bytes/文件
SHA/size 必须匹配捕获值和当前 metadata。单文件预览上限 4 MiB。

未批准工件只有在当前实际等待人工闸门时可供人工核对；已批准工件可读取。
归档、被替代、范围错误、阶段不可核对或旧版本均拒绝。角色工具原有生产入口
仍要求已批准工件，新人工入口未加入角色 capability allowlist。检查不会批准、
运行模型、启动生产 worker 或写数据库。实验核对直接验证保存 manifest；缺失时
失败，不重建。snapshot 写入器仍只属于实际发布流程。

新入口返回明确 validation/permission/conflict/not_found/degraded 错误，未知失败
继续传播。最终unit824/Harness94/finalreview5/fresh build/type/native13/renderer87、
最终相关UI13/startup12/IPC/chunks通过。日志`xui-production-review-*.log`；原生
`production-review-previews.json` 保留真实未批准三类生产文件的 bytes/SHA/size 和
无 DB 写入证据。只有 task-created 临时 manifest 被删除/按原字节恢复以验证
缺失拒绝；冻结科研 fixtures 没有改动。生产类型 UI 与阅读位置仍待下一增量。
