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
生产类型视图、阅读恢复与人工闸门版本绑定见下文。

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
关联任务动作复用管理抽屉。批准仍在助手人工闸门；检查器通过下述整阶段重读流程返回核对版本。

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
显示需要重读的错误；检索计划错误但真实版本仍有效时可以退回。检查器提供显式
整阶段刷新和回到原助手确认；不暴露 renderer 直接批准能力。

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

新入口返回明确的 validation/permission/conflict/not_found/degraded 错误，未知失败继续传播。

## 按需生产类型视图

检查器通过显式“查看生产文件”加载生产视图，再按实际来源加载实验、图稿或
导出模块。实验显示真实运行标识、环境、退出码、时间、输入hash和参数；图稿
显示实际发布/运行标识、源文件、物理/像素尺寸、种子及发布/渲染hash；导出显示
保存的正文、来源、工具链、交付包hash及题录/图稿/审稿报告数量。nullable来源值
明确显示未记录，不编造执行环境或已完成状态。

输入、输出、日志和交付文件按区域选择；文件按钮明确触发带工件版本与文件hash
的只读IPC。文本由React转义，PNG/JPEG/WebP展示已验证base64内容。版本或选定
文件改变立即清除旧内容，迟到响应不进入新范围。核对/读取错误保持失败状态并
提供显式重试。超过4MiB的文件禁用读取；ZIP只显示校验metadata；PDF入口明确
未接入。证据与主张的原文定位走[PDF 阅读导航](research-pdf-navigation.md)，与此生产文件预览入口不同。

## 关闭后的阅读恢复

唯一AppShell持有当前窗口的reading-location Map。按实际project/artifact定位，值
只保存当前工件SHA、正文滚动、生产文本滚动、native details展开、焦点key与
生产区域/选定文件metadata。关闭、返回助手或打开关联任务前捕获。不开localStorage，
不缓存原文bytes、审核上下文或人工决定；重启窗口不恢复这份临时阅读状态。

重开必须先通过真实工件检查，只有返回的SHA与保存版本一致才恢复。生产文件
再次经过实际inspect/read合同，不把保存位置当读取授权。新版本丢弃旧展开和
文件选择；关闭在新版本核对中也不能把旧文件metadata保存到新版。DOM/layout
观察器随真实异步模块和文件挂载恢复阅读位置，用户的pointer/key/wheel立即停止
恢复，迟到内容不能抢回手动位置。Escape继续由共享overlay恢复原助手入口焦点。

检查器的 evidence 包含 required nullable sourceLocator，保存真实
managed document/parse/block/source/parse hash 与原页/区域，并参与工件 SHA。
没有托管文档关联保持 null；历史来源定位保持不可替换快照。读取不读磁盘字节，
原文导航复用托管文档的 PDF 预览；详见[证据来源与关系审核](research-evidence-relations.md)与[PDF 阅读导航](research-pdf-navigation.md)。
