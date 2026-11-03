# Zotero 本地只读接入

主进程 `zotero-adapter.ts` 固定访问 `http://127.0.0.1:23119/api/`，只发 GET。
请求不含 API key，不访问 Connector，不触发授权、修改设置或写回 Zotero。
重定向不跟随；返回的网页、附件或分页链接不能改变请求主机。初始化不会读取
Zotero 文库；只有调用探测/读取能力才发本地请求。

## 当前合同与支持范围

2026-11-03 读取的官方
[Local API](https://www.zotero.org/support/dev/web_api/v3/local_api)
更新于 2026-07-29。Zotero 高级设置中需允许其他应用通信，未启用返回 403。
API 版本固定为 3；Zotero 10+ 的 Zotero-Server-ID 标识数据库实例，本地对象
version 与云端或其他实例无关。缺少实例标识的旧客户端不支持，不生成替代身份。
探测输出 connected、disabled、unreachable、unsupported 或 invalid_response；
unreachable 只表示本地请求未完成，不能单凭它推断未安装。

个人库固定 `users/0`；群组库为 `groups/<groupID>`。同步范围使用实例 ID 与
`{kind,id}`，后续对象映射还必须含 itemKey，DOI 不替代同步主键。
群组 metadata version 属于云同步版本，不能作为该群组文库的本地检查点。
群组列表不要求 Last-Modified-Version；集合和文献页要求它并核对预期版本。
实例变更或版本变更拒绝整页，不能沿用旧检查点或缓存成功结果。

来源结构与响应头核对到 Zotero 主仓库固定 commit
[1ca9d58c9aa9aeca1032d3966f3765d4d40ab7b2](https://github.com/zotero/zotero/blob/1ca9d58c9aa9aeca1032d3966f3765d4d40ab7b2/chrome/content/zotero/xpcom/server/server_localAPI.js)。
旧文档中的 xpcom/localAPI 路径已移动，当前代码位于 xpcom/server。

## 分页读取

主进程能力及对应 preload：

| 能力 | preload 方法 | 内容 |
| --- | --- | --- |
| research.zotero.status | research.getZoteroStatus | 常用应用目录检测与独立 API 连接状态 |
| research.zotero.probe | research.probeZotero | API/实例/schema 头及探测时间 |
| research.zotero.groups | research.getZoteroGroups | 当前用户的群组元数据页 |
| research.zotero.collections | research.getZoteroCollections | 指定库的集合、父集合及版本 |
| research.zotero.items | research.getZoteroItems | 指定库/集合的原始对象页，含标签和附件引用 |
| research.zotero.preview | research.previewZotero | 按可信会话/项目保存完整来源页并返回审查预览 |
| research.zotero.getPreview | research.getZoteroPreview | 按预览 ID 读取已冻结的来源对象 |
| research.zotero.sources | research.getZoteroSources | 指定文献在当前会话/项目中的 Zotero 收录回执及原始对象 |
| research.zotero.review | research.reviewZotero | 冻结来源与当前文库字段、对象版本及范围内原始来源的只读核对 |
| research.zotero.sourceObserve | research.observeZoteroSource | 校验本范围原始收录回执后，显式读取当前对象并保存来源状态观察 |
| research.zotero.sourceState | research.readZoteroSourceState | 只读同原始收录回执与集合范围的最后有效观察 |
| research.zotero.attachmentInspect | research.inspectZoteroAttachment | 验证原收录回执与当前子附件关系，保存路径/访问/文件身份检查 |
| research.zotero.attachmentRead | research.readZoteroAttachment | 只读当前会话/项目的附件检查记录 |

读取参数显式携带 serverId、library、expectedLibraryVersion；首次读取可指定
expectedLibraryVersion:null。items 还需要 collectionKey/since，null 分别表示
整个库/不限制修改版本。offset 默认 0，limit 默认 20、最大 50。下一页使用真实
返回的 libraryVersion 作为 expectedLibraryVersion。所有请求回传 Server-ID，
同时检查响应头，412 和响应实例不符都拒绝。

本地 API 默认无分页上限，因此适配器每次明确发送 start/limit。页数、总量与
返回条数必须一致，缺失 Total-Results、重复对象键、错配 key/version、对象版本
大于 libraryVersion 均失败。页面保留原始已知/未知字段，附响应原始字节 SHA-256、
fetchedAt、total 和 nextOffset；不截断后伪装成有效页面。
分页/版本依据
[官方 Basics](https://www.zotero.org/support/dev/web_api/v3/basics)。

## 冻结预览

数据库 13 保存预览原始完整来源页、查询参数、实例、库、版本、响应 hash 与抓取
时间。主进程从可信执行上下文填写 owner、projectId、runId；输入不能指定其他
会话或项目。预览不收录文献，不启动附件读取、解析、索引或书目 worker。

preview 使用 items 参数，以 `include=data,csljson` 抓取一页，再完整保存；返回首 20 个对象。
getPreview 只读本地快照，不重新请求 Zotero，默认 20、最多 30 个对象。
`capturedTotal` / `nextPreviewOffset` 是保存页内的分页；
`sourcePage.total` / `sourcePage.nextOffset` 是 Zotero 查询的总量及下一次来源读取位置。
两个范围保持独立，不能把保存的一页当作已抓取整库。

contentHash 覆盖固定版本、预览 ID、完整来源页、原始请求和审查有效期。每次读回
先校验全部内容，再截取当前显示页；被省略的末页记录损坏也会拒绝。未找到、
其他会话/项目、7 天有效期结束或内容损坏均显式失败。预览有效期不删除正式文库
或已有科研历史。旧数据库升级不补造 Zotero 来源、预览或导入映射。

请求失败、保存失败、调用者取消或应用关闭不返回成功预览。导入服务跟踪预览
请求，关闭时中断并等待其退出；忽略取消的迟到响应仍被发布前检查拒绝。
应用重启后的有效快照可在同一会话/项目继续审查；原始响应与冻结内容 hash 保留。
当前预览合同为版本 2，显式声明 `projection:data,csljson`。旧的版本 1 不补造 CSL、
不转换；数据库升级仍保留原始旧预览行，读取不符合当前合同的数据显式失败。

## 对象收录与原始版本

现有 `research.addLiterature` 接受 `kind:zotero`、previewId、itemKey。用户选择的
每个对象在创建作业前按会话/项目读回完整预览，固定原始对象、版本、题录投影和
导出的 CSL。附加 source 类型为 Zotero；附件、笔记、批注不能作为论文收录。
缺题名、格式错误、缺 CSL 或 CSL 的题名/DOI 与原记录不一致均显式失败。

CSL 走现有原生书目 worker，不使用只含题名/作者的临时书目代替完整导出。期刊、
卷期、页码、完整作者角色和日期保留在书目/原始 CSL 中；DOI 规范化后比较。
缺字段继续保持未知，不生成虚构题名、年份或作者。

数据库 14 的同步主键为 serverId、library kind/id、itemKey；导入作业键也由该
对象身份产生。不同对象即使 DOI 相同，也独立保留映射、原始版本与收录回执，
可以共同指向同一个规范文献。同一来源版本出现不同内容、对象版本回退或已绑定
对象要改到其他文献时拒绝，不按 DOI 重写同步主键。

原始对象版本只保存一次，含全部题录、标签、集合、未知字段与 CSL。每次新的
收录请求另存 operationId、所见文库版本、previewId、抓取与收录时间的回执。
相同 requestId 的重放读回原结果；新 requestId 收录同一版本时复用已保存文献
和书目，不重复 worker、不追加重复文献来源、不改引用键或本地注释/标签。
需要关联新项目时只建立项目关联，在事务提交后发布作业事件。

新来源版本保留旧、新两侧原始数据；不覆盖 Roc 用户已有书目 note/keywords。
已归档文献保持归档，返回 skipped_archived，不自动恢复。元数据归并仍使用现有
强身份规则；题名相似不建立新归并边。归并歧义、来源/CSL 冲突和不可重试的冻结
输入错误保留明确原因。多对象作业可部分失败；取消停止剩余对象并拒绝迟到 worker。

文献、对象映射、原始版本、当前收录回执与作业结果在同一 SQLite 事务提交。
写入失败回滚该对象的全部变更，不留下“已收录”的结果。getZoteroSources 默认
20、最多 50 条；按可信会话/项目分页回执，每条带完整原始对象及 hash，读取校验
对象 key/version/hash。文献归档和预览审查有效期结束后，已收录回执仍可读。
多个新请求使用相同对象版本，会有独立回执；这不表示文献或原始版本重复。

对象版本记录用于下文的显式逐页增量核对与来源状态观察。
实例变化及版本回退仍需人工核对，不能凭失败结果伪造同步完成。

## 附件与取消

主进程附件路径方法读取 `items/<key>/file/view/url` 的纯文本 file URI，仅接受
本机 file URL，不跟随 `/file` 的 302。它只返回引用，不读取文件、不证明文件存在，
不授予 filesystem 权限，也不直接暴露成 renderer 的文件读取接口。后续导入必须
单独核对用户选择、真实路径、访问范围、文件存在性和链接附件状态。

请求超时 10 秒，响应字节上限 8 MiB。调用者取消及插件关闭中断读取，并等待
进行中的请求退出；已关闭适配器拒绝新请求，迟到响应不能成为有效页面。
HTTP/解析失败显式保留为失败，不回退为成功空页。

## 已验证与待完成

只读适配器、冻结预览、对象收录/来源回执、主进程能力和 IPC 已接入。测试使用合成数据与真实本机 HTTP
fixture 验证 GET/无 key、实例和库范围、原始 hash、集合/群组版本、分页完整性、
HTTP 重定向拒绝、附件引用、取消/关闭及响应上限。开发机标准路径
`/Applications/Zotero.app` 未发现安装；未读取真实 Zotero 数据库、用户文库或凭证。
预览回归还覆盖 25 条原始对象完整保存、分页/hash 重建、服务重启、会话/项目隔离、
末页损坏、有效期、数据库拒绝写入、迟到取消与 DB12→13 保留历史原文。
本地 fixture 不等于已安装 Zotero 的实际互操作验收。

逐页检查点、冲突审查 UI 与来源状态后端已实现，详见下文。
来源状态 UI 已接入原始来源详情；附件输入授权及真实客户端验收仍待后续增量。V1 没有任何 Zotero
写请求，V3 写回继续另行授权。

对象收录增量最终验证：单测 761/761、对象相关 26/26、Harness 94/94、原生 P0
13/13（含真实 CSL bibliography worker）、应用启动 smoke 12/12，typecheck/build、
IPC 和 renderer chunks 均通过。来源回执、DB13→14 原文及 ledger 保留、重复请求、
同版本新请求复用、取消和事务回滚均有实际数据库回归。日志见
`.artifacts/research-optimization/pr05-object-*.log`；原生 worker 的数据库与回执保留于
`pr05-object-native-csl/`。真实 Zotero 客户端验收仍未运行。

## 设置状态

现有设置弹窗的「文献与解析」区提供 Zotero「检测连接」。打开设置不自动读取
Zotero；用户点击才检查 /Applications/Zotero.app 和 ~/Applications/Zotero.app 的
Contents/MacOS/zotero 文件，同时探测固定 loopback API。只检测应用执行文件是否
存在，不启动它，不扫描或读取 Zotero 文库。其他路径的安装不在检测范围内；
未发现常用目录安装不能推出系统中未安装，API 不可达也不能推出未安装。目录
读取异常是明确的失败，不伪装成未发现。

UI 独立显示应用目录与 API：已连接、未启用通信、不可达、版本不支持、响应无效。
已连接时列出真实 API3 和题录预览能力；未启用提示高级设置操作，Roc 不代为修改。
每次检测使用新资源键，立即移除旧状态；关闭后的迟到结果不能出现在再次打开
的区块。新 UI 使用 12/13px tokens、0.5px 分隔线、键盘焦点和状态文字。

最终单测762/762，实际 Electron 设置组件3/3，原设置 Radix 层级1/1，Harness94/94，
生产 build/typecheck、IPC/chunks 通过。应用启动 smoke12/12 在最后一处纯边框修改
前通过；最终新组件再次运行3/3并更新光暗1100/1099/800截图与阴影审计，全部
cut0/hidden0。证据 `pr05-settings-*.log`、`zotero-settings-ui/`。真实 Zotero 客户端
互操作仍未运行。

## Renderer 预览边界

previewZotero、getZoteroPreview、getZoteroSources 的 IPC 请求显式要求
projectId（库范围用 null）。主进程 bridge 使用真实 sender ID 构造 window owner
和项目上下文，输入不能提供 owner/runId。能力入口剥离 IPC 项目字段后，核心服务
仍验证 scope-neutral 请求；原始快照请求与内容 hash 格式保持不变。检索池
getLiteraturePool 同样通过文献上下文读取。

实际 bridge 回归曾复现这些能力缺少上下文导致内部错误；结构映射检查未覆盖
这条执行路径。修复后验证真实 sender/project 预览保存与隔离、原生 CSL codec
收录/来源回执、请求重放和检索池上下文。765/765 单测、30/30 相关回归、
Harness94/94、生产 build/typecheck、原生 P0 13/13、启动 smoke12/12 与 IPC/chunks
通过。UI 草稿单独验证，不包含在此边界修复的完成状态中。

## 选择与收录 UI

文献画布现有「导入」弹窗新增 Zotero 页签；方向键、Home/End 切换导入方式。
点击「连接 Zotero」后读取分页群组与所选文库的集合。用户选个人/群组库、集合
和每次20/30/50对象的读取范围，再点击「读取并预览」。集合翻页沿用已见本地
文库版本，版本变更阻止后续预览；重新连接显式重建选择。

来源总量/下一页与已保存预览内分页分别展示。预览只显示原始对象，用户逐项
勾选，单次最多30论文；笔记、批注、附件和缺题录/CSL对象不能当论文收录。
原生details可用键盘展开原始题录、标签、集合、附件引用和未知字段。读取失败
显示原始失败信息；来源翻页先清空旧预览，不把旧内容显示成新页成功。

收录走既有作业与请求ID。传输失败重试保持相同ID，已明确部分失败可只重试
标记可重试的条目。结果逐项显示收录/关联/已存在/归档跳过/失败/取消及原因。
取消通过requestId查到真实operationId再发停止请求；「已请求取消」与最终
取消回执分开，已提交条目不回滚。取消请求未结束时不开始新收录。

导入作业与回执状态由现有弹窗组件持有，关闭或切换页签不取消作业；同一画布
重新打开Zotero可看进行中/最终结果。项目切换重建弹窗，旧项目迟到结果不能
进入新项目。这里不承诺跨应用重启恢复UI选择；整库检查点/恢复仍属后续增量。

最终生产build/typecheck、实际Electron新UI5/5及原候选审查3/3、文献动作hook1/1、
应用启动smoke12/12、IPC/chunks通过。光暗1100/1099/800、默认/hover/展开/长字段
和reduced-motion截图审计全部cut0/hidden0，字体至少12px。日志
`pr05-ui-*.log`，截图/审计`zotero-import-ui/`。共享后端的765单测和原生13场景
在前一IPC边界修复中通过；最后修改仅涉及renderer。真实Zotero客户端未运行。

## 来源与本地差异核对

`reviewZotero` 要求明确 projectId、当前范围的 previewId 和1–30个不重复 itemKey。
仅读取已有冻结预览、文库与映射，不请求 Zotero、不运行书目 worker、不写数据库。
返回冻结原始来源、规范文库现值/书目字段/归档状态、已记录对象版本和当前文库修订。
对象状态区分新对象、未变化、新版本、版本回退、同版本内容冲突与文献身份改变。
原始旧来源仅返回同 owner/project 的最新收录回执；其他范围可见规范文库元数据，
不能读取这里的原始来源历史。损坏来源和歧义文献身份明确失败。

界面按当前预览与选择核对，迟到结果不能替代新选择。核对完成后才能收录；
版本回退、同版本冲突、身份改变、归档或读取失败阻止收录。题名、作者、DOI、
摘要和 URL 仅在双方都有值时展示精确差异；没有语义书目等价判断。
键盘 details 展示两侧值、本地注释/标签和本范围原始旧来源。核对是当前只读
视图，不是持久化批准；收录仍在主进程按原有版本/身份合同检查并保留已有字段、
补齐缺值、另存原始来源。没有字段覆盖接口或 Zotero 写回。

展开长详情曾使 `overflow-hidden` 的弹窗外层被焦点滚动144px，标题移出可见区。
共用 ModalShell 的模态外层改为 `overflow-clip`，正文仍滚动；实际键盘展开与
滚轮回归确认外层 scrollTop0、标题位置不变、正文可滚动。截图
`zotero-import-ui/source-local-differences.png` 与 scroll/audit JSON 保留。

单测769/769、Harness94/94、实际原生P0 13/13、最终 build/typecheck、
新界面6/6及原候选3/3、启动12/12、IPC/chunks通过。日志 `pr05-review-*.log`。
实际 Zotero 客户端与附件授权仍待后续验收；逐页检查点见下文。

## 可恢复的逐页核对检查点

Research DB15 新增同步会话、逐页决定、已见对象和完成批次检查点。旧迁移保持不变；
DB14升级保留原预览、文库、原始来源和迁移回执，不补造历史检查点。
`startZoteroSync` 明确实例/库/集合、full、incremental或显式rebaseline及1–50页大小；incremental
仅从同 owner/project/实例/库/集合的上次完整核对版本读取 since。full重新读取
全范围，保留旧完整版本下限；rebaseline按当前来源完整核对，末页确认后可建立
较低的新检查点。旧对象导入版本约束仍执行。每个范围只能有一个进行中
或暂停会话；创建和读取会话不发送 HTTP、不收录题录。

`captureZoteroSyncPage` 使用真实会话ID和expectedRevision，只捕获当前位置的一页；
冻结预览与会话更新同一事务。首个响应固定目标文库版本与总量，后续页面要求一致，
跨页重复对象不能推进。待核对页不能隐式覆盖；replacePreviewId明确指定被替换页，
重读会生成新预览并使旧选择失效。过期预览不能确认，但可以显式重读同位置。

`acknowledgeZoteroSync` 要求当前预览、所有对象的真实收录回执或逐项明确跳过理由。
50对象页可以拆为多个既有30论文收录作业；未完成/失败的收录不能伪装为已收录。
确认页的决定、已见对象和下页位置同事务；只有最后一页完成才推进 since检查点。
已成功收录的题录不因确认事务失败而消失；检查点与页回执会一起回滚。
“检查点完成”表示本次捕获范围全部核对，不表示全部对象已收录或检索覆盖完整。

`controlZoteroSync` 显式pause/resume/abandon，要求当前修订；暂停/放弃中止实际HTTP，
保留已确认页、待核对预览与旧完整版本。同一同步不能重复并发读取。断连不推进；
实例变更、版本回退、页间版本/总量变化或重复对象进入reset_required，保留旧历史。
重启只读已有状态，不自动HTTP或收录。通过保存的syncId恢复同可信owner/project；
UI按当前范围查找并恢复，见下一节。

官方固定源码再次核对于2026-11-04：since按本地clientVersion筛选，
format=versions返回对象本地版本；includeTrashed=1和items/trash可报告软删除，
源码没有/deleted接口。增量结果中缺席不能证明永久删除或集合移除；本阶段不标记
这种推测，也不删除本地题录、证据或附件。单对象状态观察见下文，附件授权仍待实现。
依据仍为本文固定官方源码，新增读件hash保存在`pr05-zotero-primary-contract.json`。

最终unit780/780、相关37/37、Harness94/94、生产build/typecheck、
实际native13/13、现有UI6/6、启动12/12、IPC/chunks通过。新增回归覆盖实际数据库
文件重开、取消/迟到拒绝、页事务回滚、真实sender桥接收录回执与隔离、版本回退、
跨页重复/总量变化、空页和损坏状态。原生CSL作业完成后实际确认检查点版本9；
保留`pr05-sync-native-csl/`数据库与回执，日志`pr05-sync-*.log`。

## 检查点发现与恢复 UI

`findZoteroSync` 只读当前可信owner/project/实例/库/集合的最新会话；
时间戳相同也按实际插入顺序定位。没有记录返回null，不创建或启动同步。
`readZoteroSyncPage` 返回当前待核对预览及实际同预览的已收录对象键；
读取不改变版本、请求 Zotero或运行worker。其他owner/project不能读取，
旧集合的迟到lookup不能替代当前选择。原始来源仍按现有预览范围和hash验证。

现有Zotero导入页显示「增量逐页核对」「完整重新核对」及真实检查点状态。
用户显式读取、暂停、继续、结束本次或打开待核对页。关闭后重连同一范围，
从数据库恢复暂停状态、当前位置和已收录回执；没有自动继续来源读取或收录。
版本/状态错误后刷新真实后端状态，另有只读「刷新核对状态」动作。
过期页读取失败保留检查点，显式重新读取本页生成新预览。

已收录对象不能重复勾选。本次预览必须全部加载显示，再逐项收录或填入未收录
对象的共同跳过理由；主进程仍逐键检查回执。仅显示前20/30对象不能确认50对象页。
确认只推进核对位置，下一页来源仍由用户点击读取；部分失败和确认事务失败保留
当前位置/预览。暂停后继续才能确认本页。原有单页手动导入保持其独立作用。

reset_required状态提供「按当前来源重新建立检查点」，明确按新来源建立版本并
保留旧历史/本地资料。该动作选择rebaseline，不自动发生；完成页后可建立较低的
同实例检查点。既有题录/对象的版本回退和内容冲突继续拒绝，不能借此降级或覆盖。

最终相关39/39、unit782/782、Harness94/94、生产build/typecheck、native13/13、
实际UI12/12（Zotero9、原候选3）、最终键盘/暗色1099恢复1/1、启动12/12、
IPC/chunks通过。截图`sync-paused`、`sync-paused-dark-1099`、`sync-complete`
和光暗1100/1099/800长内容审计保留，cut0/hidden0。日志`pr05-sync-ui-*.log`。
实际Zotero客户端及附件路径/访问授权仍待后续实现与验收。

## 原始收录回执对应的来源状态

Research DB16 追加不可变的 `research_zotero_source_states`，保留 DB15 数据与已应用
迁移 SQL/name/checksum。输入显式携带 projectId、实例/库、真实收录 operationId、
itemKey 与 nullable collectionKey。主进程先验证原始回执归属及 hash，再请求 Zotero；
其他会话/项目/作业不能触发来源读取。复合外键指向实际对象收录观察。

单对象 GET 固定读取 `items/<key>?format=json&include=data`，仅使用原回执的实例/库。
该响应的 Last-Modified-Version 是对象版本，绝不推进文库检查点。present/trashed 来自
实际对象及 deleted 布尔值；404 必须先通过 API/schema/实例头验证，才记为 not_found。
not_found 表示本次来源未找到，不能证明永久删除。网络、解析、写入失败保留为失败，
不会替代最后有效观察。初始化、恢复、只读观察均不自动发 HTTP。

顶层对象的 collections 明确证明 listed/not_listed；子对象省略集合列表时为 unknown。
顶层缺失或非法集合数据显式失败。未请求集合为 not_requested，回收站/未找到的集合
成员状态为 unknown。版本状态为 missing/regressed/unchanged/newer/version_conflict；
同版本仅比较 data 的结构内容，键顺序及未请求的 CSL 导出不造成冲突。

每条观察保留原始收录对象版本、规范文献 ID、当前原文、响应 hash、检查/记录时间及
内容 SHA-256。读回验证来源/ID/hash 与原回执链接；过期预览不使正式收录回执失效。
关闭服务中止实际 HTTP，等待退出并拒绝迟到观察写入。本能力不修改规范题录、
对象映射、证据或附件。来源详情 UI 见下文。

最终相关46/46、unit789/789、Harness94/94、fresh build/typecheck/native13/13、
现有UI12/12、启动12/12、IPC/chunks及diff通过。日志
`.artifacts/research-optimization/pr05-source-state-*-complete.log`；真实 native CSL
收录后保存/只读重放来源观察且题录修订不变，数据库/回执保留于
`pr05-source-state-native-csl/`。固定官方源码的本地 API、Item、DataObject 合同与
hash 保留于 `pr05-zotero-primary-contract.json`。未运行真实 Zotero 客户端互操作。

## 原始来源详情中的状态 UI

沿用导入弹窗的「已收录的原始来源」详情。只有当前范围存在原始收录回执且用户展开
详情时，才读取本地保存的观察；不开启后台 Zotero 检查。显式「检查当前来源」使用
该回执的 operationId/实例/库/itemKey 和当前项目/集合，保存返回的真实状态。

界面展示存在/回收站/未找到、当前集合成员状态、对象版本变化、原收录/当前版本及
真实检查时间。not_found 明确说明不能确认永久删除；来源缺失、回收站或集合移除时
显示 Roc 题录、证据与附件保留。原始观察 JSON 可展开，未保存和读取损坏分别呈现。
检查失败保留最后有效观察及错误；不会变成来源缺失、完成收录或检查点成功。

关闭/重开详情只读保存状态。项目/集合/实例/库/对象/原始 operationId/版本变化时
重建状态组件，旧读取或检查响应不能替代新范围。缺少原回执时没有当前来源检查动作。
新界面复用现有原生 details、ModalShell、token、焦点和滚动布局。

最终 `node --test --test-concurrency=1 tests/renderer/` 69/69、
键盘/光暗1100/1099/800布局复核2/2、production build/typecheck、
启动12/12、IPC/chunks通过。后端未改，上一增量unit789/native13/Harness94仍适用。
日志 `pr05-source-state-ui-*.log`；`zotero-import-ui/source-state-*.png` 与
audit保留。暗色1099截图已检查，状态/版本/时间和保留文案可见，cut0/hidden0。
首轮新增3项因父详情未可见时聚焦子标题而失败；等待真实可见后保持原键盘断言通过。
实际 Zotero 客户端互操作与附件授权仍待验收。

## 附件引用检查后端

Research DB17 追加不可变附件检查，与真实父对象收录回执建立复合外键。
输入携带 projectId、实例/库、父对象 operationId/itemKey 与 attachmentKey。
先校验当前会话/项目的实际原始回执，再 GET 当前附件；type、parentItem 与 linkMode
必须真实对应该父对象。关系或模式错误不读取路径，其他会话/项目的回执不触发 HTTP。

固定官方源码 `attachments.js` 的 linkModeToName 核对于2026-11-04，明确支持
imported_file、imported_url、linked_file、linked_url、embedded_image。仅前3种读取
file/view/url 本地引用；链接网址、嵌入图片、回收站及未找到来源分别记录原因，
不请求文件路径、不下载网址。链接文件单独保留其类型，不伪装成 Zotero 管理文件。

本地引用只做 lstat/realpath/access 检查，记录引用路径、真实路径、设备/inode、
大小与修改/变更时间；不打开内容、不创建文档、不授予文件权限。缺失、无权读取、
符号链接/非文件与不支持文档格式/大小分别报告。路径或文件身份在检查过程中变化
显式失败。记录保留当前原始附件、来源 hash、原收录对象版本与实际检查时间。
只读回放检查 hash、父对象/回执链接与当前会话/项目；预览过期不抹除已收录历史。
传输/写入失败不替代原记录。服务关闭中止 HTTP 并拒绝迟到检查写入。

本增量是后端/API 检查，原生选择文件授权、附件内容导入与界面仍待下一步。
最终unit794/794、相关51/51、Harness94/94、fresh build/typecheck/native13/13、
现有来源/候选UI15/15、启动12/12、IPC/chunks及diff通过；
原生CSL收录后检查真实linked_file并只读回放，规范题录修订不变且文档数为0。
日志 `pr05-attachment-*.log`；数据库与回执保留于`pr05-attachment-native-csl/`。
官方附件源码读件及hash保留于`pr05-attachment-source-read.txt`和
`pr05-zotero-primary-contract.json`。实际 Zotero 客户端互操作未运行。
