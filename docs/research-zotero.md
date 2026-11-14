# Zotero 本地只读接入

Roc 支持本地只读发现、冻结预览、逐页核对检查点、来源状态观察和单文件授权导入。自动化使用受控 HTTP fixture；真实 Zotero 客户端与原生选择框的互操作仍需独立验收，见[验证边界](verification.md)。

## 连接与范围

主进程适配器固定访问 `http://127.0.0.1:23119/api/`，只发 GET，不含 API key、不跟随重定向。返回的网页、附件或分页链接不能改变主机。初始化、恢复和读取本地回执不访问 Zotero；只有显式探测/来源读取发送请求。请求超时 10 秒、响应上限 8 MiB；取消和关闭会中止请求，迟到结果不能发布为成功。

API 版本固定为 3，必须返回真实 `Zotero-Server-ID`；缺实例标识的客户端不受支持，不生成替代身份。探测状态为 connected、disabled、unreachable、unsupported 或 invalid_response。高级设置需允许其他应用通信，未启用时为 403。不可达不能推出未安装；常用目录检测也不能证明系统安装状态。

个人库为 `users/0`，群组库为 `groups/<groupID>`。范围由 serverId、library `{kind,id}`、nullable collectionKey 及可信 owner/project 共同确定；对象身份另含 itemKey，DOI 不替代同步主键。IPC 明确传 projectId（文库范围为 null），owner/runId 来自真实执行上下文或窗口 sender，输入不能指定其他会话。

items/collections 请求携带 expectedLibraryVersion，首次可为 null；下一页沿用实际响应版本。items 的 nullable since 表示增量下限，offset 默认 0，limit 默认 20、最大 50。适配器显式发送分页参数，校验实例、版本、Total-Results、数量、唯一对象键及对象 key/version。缺失、版本回退、412 或实例变化均失败，不返回成功空页。群组元数据版本不能当作文库本地检查点，群组列表也不要求 Last-Modified-Version。

合同依据为 2026-11-03/04 核对的 [Local API](https://www.zotero.org/support/dev/web_api/v3/local_api)、[分页规范](https://www.zotero.org/support/dev/web_api/v3/basics)及[固定官方源码](https://github.com/zotero/zotero/blob/1ca9d58c9aa9aeca1032d3966f3765d4d40ab7b2/chrome/content/zotero/xpcom/server/server_localAPI.js)。这是来源核对记录，不是本轮在线互操作结果。

## 能力入口

以下为 preload 方法；完整 schema/能力声明见 `src/shared/schemas/research-zotero*.ts` 和 `src/shared/surfaces.ts`。

| 分组 | 方法 |
| --- | --- |
| 连接与分页发现 | `getZoteroStatus`、`probeZotero`、`getZoteroGroups`、`getZoteroCollections`、`getZoteroItems` |
| 冻结预览与只读差异 | `previewZotero`、`getZoteroPreview`、`reviewZotero` |
| 题录收录与原始来源 | `addLiterature`（kind:zotero）、`getZoteroSources` |
| 逐页核对会话 | `startZoteroSync`、`readZoteroSync`、`findZoteroSync`、`readZoteroSyncPage`、`captureZoteroSyncPage`、`acknowledgeZoteroSync`、`controlZoteroSync` |
| 来源状态 | `observeZoteroSource`、`readZoteroSourceState` |
| 子项与附件检查 | `getZoteroChildren`、`inspectZoteroAttachment`、`readZoteroAttachment` |
| 单文件授权 | `grantZoteroAttachment`、`readZoteroAttachmentGrant` |
| 附件导入 | `importZoteroAttachment`、`readZoteroAttachmentImport`、`cancelZoteroAttachmentImport` |

## 冻结预览

`previewZotero` 使用 `include=data,csljson` 抓取并保存完整一页，保留请求、实例/库/版本、原始已知与未知字段、响应字节 SHA-256 和 fetchedAt。它只创建审查快照，不收录、读取附件、解析或索引。

当前预览合同 schemaVersion 2、`projection:data,csljson`，审查有效期 7 天。contentHash 覆盖完整来源页、请求、预览身份与有效期。读回先验证整页再截取展示范围；旧合同、损坏、过期或其他会话/项目显式失败，不补造 CSL。有效期不删除正式文献和收录历史。

初次返回最多 20 个对象；`getZoteroPreview` 默认 20、最多 30，只读快照。`capturedTotal` / `nextPreviewOffset` 表示保存页内分页，`sourcePage.total` / `sourcePage.nextOffset` 表示 Zotero 来源总量与下一页。保存一页不等于已抓取整库。

## 对象收录、引用键与原始版本

`addLiterature` 的 Zotero 输入为 previewId/itemKey，单次最多 30 论文。作业创建前固定本范围的完整原始对象、版本、题录与 CSL；笔记、附件、批注不能作为论文。缺题名/CSL、格式或题名/DOI冲突显式失败。完整 CSL 交给原生书目 worker；未知字段保持未知，不生成题名、作者或年份。通用归并合同见[文献融合](research-literature-fusion.md)。

对象映射使用 serverId、library kind/id、itemKey。不同对象即使 DOI 相同也保留独立映射和回执，可指向同一规范文献。同一版本内容变化、对象版本回退或已绑定对象改变文献身份均拒绝。原始版本保存完整 data/CSL；每次新请求另存 operationId、所见文库版本、previewId、抓取/收录时间。相同 requestId 重放原结果；新请求复用已保存对象版本与书目，不重复 worker/来源、不修改本地注释、标签或引用键。归档文献返回 skipped_archived。

引用键映射由 `zotero-citation-key.ts` 和共享 schema 定义：

- 显式来源候选为 native `data.citationKey`、CSL `citation-key`、Extra 的 `Citation Key:`；CSL id 和 Zotero itemKey 是对象身份。
- 有既有本地键时保留；新文献可采用一致、有效且不冲突的来源键。
- 无有效唯一来源或发生碰撞时生成本地键，记录 `invalid_source_key`、`source_disagreement`、`key_collision`、`local_key_retained` 等真实问题。预览中尚未生成的 localKey 为 null，收录回执记录实际映射。

文献、对象映射、原始版本、收录回执和逐项作业结果同事务提交。失败回滚该对象，不留下成功结果；多对象作业可部分失败。取消停止余下对象，已提交条目保留。`getZoteroSources` 默认 20、最多 50 条，校验完整原始对象及 hash；归档或预览过期不使正式回执失效。

`reviewZotero` 对当前 previewId 和 1–30 个唯一 itemKey 比较冻结来源、规范文库现值与本范围已收录原始版本；只读、不联网、不运行 worker。它区分新对象、未变化、新版本、回退、同版本冲突和身份改变，按双方实际值显示字段差异。核对不构成持久批准或覆盖授权；收录仍重新检查身份/版本并按保留已有值、补齐缺值策略执行。

## 可恢复的逐页核对检查点

同步会话范围是可信 owner/project/实例/库/集合。`startZoteroSync` 显式选择 full、incremental 或 rebaseline，页大小 1–50；同范围只允许一个进行中或暂停会话。incremental 从上次完整核对版本取 since；full 保留旧版本下限；rebaseline 明确按当前来源建立检查点，完成后可建立较低版本，已有对象回退/冲突约束仍生效。

`captureZoteroSyncPage` 使用 syncId/expectedRevision 捕获当前位置一页，冻结预览与会话更新同事务。首个响应固定目标版本/总量；后续必须一致、不能跨页重复。待核对页不隐式覆盖，replacePreviewId 明确重读并使旧选择失效。过期页不能确认，可显式重读同位置。

`acknowledgeZoteroSync` 要求当前页每个对象都有真实收录回执或明确跳过理由。50 对象页可拆成多个 30 论文作业；失败/未完成不能当已收录。页决定、已见对象与位置一起提交，只有末页确认推进完整 since 检查点。确认失败不撤销已提交题录，但检查点和页回执回滚。**完成表示捕获范围已逐项核对，不表示全部收录或完整检索覆盖。**

pause/resume/abandon 要求当前修订；暂停/放弃中止实际读取并保留历史。实例变化、版本回退、页间版本/总量变化或重复对象进入 reset_required；断连不推进。find/read/readPage 只读已有状态，重启不自动联网或收录。增量缺席不能证明永久删除或集合移除；单对象状态另行显式观察。

UI 在同一导入页恢复当前范围会话，明确提供读取、暂停、继续、结束、刷新、重读过期页及 rebaseline。确认前必须加载整页并逐项收录/跳过；只显示前 20/30 个对象不能确认 50 对象页。确认不自动读取下一页。

## 来源状态观察

`observeZoteroSource` 先校验本范围真实原始收录 operationId、实例/库/itemKey 与 hash，再显式 GET 当前对象并保存不可变观察。对象响应的 Last-Modified-Version 不推进文库检查点。present/trashed 来自真实记录；404 通过 API/schema/实例头校验后才记 not_found，仍不能证明永久删除。

集合成员区分 listed/not_listed/unknown/not_requested；子对象缺集合列表、回收站和未找到状态保持 unknown。版本区分 missing/regressed/unchanged/newer/version_conflict，同版本比较请求到的 data 结构。观察保留原始收录版本、当前原文、响应/hash及检查时间，不修改规范题录、证据、映射或附件。失败保留最后有效观察；`readZoteroSourceState` 只读本地记录。

## 附件：发现 → 检查 → 授权 → 导入

四步独立执行，均依赖本范围真实父对象收录回执；读回校验范围、hash和上下游链接。

| 步骤 | 实际行为与边界 |
| --- | --- |
| 发现当前子项 | `getZoteroChildren` 显式分页读取父对象 children，校验 parentItem/实例/版本；保留笔记与附件真实类型，不写数据库或读取文件 |
| 检查附件引用 | 核对当前附件类型、parentItem/linkMode；imported_file/imported_url/linked_file 才读取本地 file URI。只做路径/访问/文件身份检查，不读内容或授权；网址、嵌入图片、回收站、缺失、拒绝访问、符号链接/非文件、格式/大小问题分别报告 |
| 单文件输入授权 | ready 检查记录经再次身份核验后，在真实发送窗口打开原生单文件选择框。用户必须选中同一真实文件；输入仅 projectId/inspectionId/requestId，不能提供任意路径。取消无授权回执；授权为 `read_one_file`，仍不读字节或建文档 |
| 授权导入 | projectId/grantId/requestId 和 library_only/current_project 目标。无 Zotero HTTP、解析或自动索引；renderer不能提供 sourcePath/字节。只读打开时使用 O_NOFOLLOW，核对 fd 身份、大小、读取前后身份和实际字节，再传给现有文档服务 |

文档、内容 SHA-256、附件检查/授权/父来源和导入回执同事务提交；失败清理本次临时副本并保留授权。相同请求重放已提交结果，不重读外部文件；新请求相同文献/内容复用文档并追加来源回执。requestId 不能换绑授权或目标，归档文献不能新增附件。取消发真实信号，最终回执才能确定结果；已导入不等于已解析。

## 界面与恢复边界

设置弹窗「文献与解析」中的检测按钮独立呈现常用目录安装检测与 API 状态；打开设置不自动探测或修改 Zotero。文献画布现有「导入」弹窗提供 Zotero 页签，用户显式连接、选库/集合、预览、核对、选择和收录。来源总量与保存页分页分开；原始字段、引用键问题和失败原因可展开查看。

来源详情只读已有观察，点击才检查当前来源或读取子项；附件操作依次展示真实状态、单文件授权与导入目标。进行中作业在关闭详情/弹窗或切换页签时继续，同一画布重开可查看结果；项目/来源范围变更后拒绝旧响应。原始回执和同步检查点可跨应用重启读取，但 UI 选择与附件操作链不承诺跨重启自动恢复。没有后台抓取、Zotero 写回或自动解析/索引。
