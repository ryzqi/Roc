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
| research.zotero.probe | research.probeZotero | API/实例/schema 头及探测时间 |
| research.zotero.groups | research.getZoteroGroups | 当前用户的群组元数据页 |
| research.zotero.collections | research.getZoteroCollections | 指定库的集合、父集合及版本 |
| research.zotero.items | research.getZoteroItems | 指定库/集合的原始对象页，含标签和附件引用 |
| research.zotero.preview | research.previewZotero | 按可信会话/项目保存完整来源页并返回审查预览 |
| research.zotero.getPreview | research.getZoteroPreview | 按预览 ID 读取已冻结的来源对象 |

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

preview 使用 items 参数抓取一页，再完整保存；返回首 20 个对象。
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
这是后续用户选择与幂等导入的输入依据，尚未建立同步对象映射或收录检查点。

## 附件与取消

主进程附件路径方法读取 `items/<key>/file/view/url` 的纯文本 file URI，仅接受
本机 file URL，不跟随 `/file` 的 302。它只返回引用，不读取文件、不证明文件存在，
不授予 filesystem 权限，也不直接暴露成 renderer 的文件读取接口。后续导入必须
单独核对用户选择、真实路径、访问范围、文件存在性和链接附件状态。

请求超时 10 秒，响应字节上限 8 MiB。调用者取消及插件关闭中断读取，并等待
进行中的请求退出；已关闭适配器拒绝新请求，迟到响应不能成为有效页面。
HTTP/解析失败显式保留为失败，不回退为成功空页。

## 已验证与待完成

只读适配器、冻结预览、主进程能力和 IPC 已接入。测试使用合成数据与真实本机 HTTP
fixture 验证 GET/无 key、实例和库范围、原始 hash、集合/群组版本、分页完整性、
HTTP 重定向拒绝、附件引用、取消/关闭及响应上限。开发机标准路径
`/Applications/Zotero.app` 未发现安装；未读取真实 Zotero 数据库、用户文库或凭证。
预览回归还覆盖 25 条原始对象完整保存、分页/hash 重建、服务重启、会话/项目隔离、
末页损坏、有效期、数据库拒绝写入、迟到取消与 DB12→13 保留历史原文。
本地 fixture 不等于已安装 Zotero 的实际互操作验收。

设置区连接/安装检测、库/集合选择、预览后的持久化幂等导入、版本检查点、冲突
与删除状态、附件输入授权以及真实客户端验收仍待后续增量。V1 没有任何 Zotero
写请求，V3 写回继续另行授权。
