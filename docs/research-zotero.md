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

## 附件与取消

主进程附件路径方法读取 `items/<key>/file/view/url` 的纯文本 file URI，仅接受
本机 file URL，不跟随 `/file` 的 302。它只返回引用，不读取文件、不证明文件存在，
不授予 filesystem 权限，也不直接暴露成 renderer 的文件读取接口。后续导入必须
单独核对用户选择、真实路径、访问范围、文件存在性和链接附件状态。

请求超时 10 秒，响应字节上限 8 MiB。调用者取消及插件关闭中断读取，并等待
进行中的请求退出；已关闭适配器拒绝新请求，迟到响应不能成为有效页面。
HTTP/解析失败显式保留为失败，不回退为成功空页。

## 已验证与待完成

只读适配器、主进程能力和 IPC 是当前增量。测试使用合成数据与真实本机 HTTP
fixture 验证 GET/无 key、实例和库范围、原始 hash、集合/群组版本、分页完整性、
HTTP 重定向拒绝、附件引用、取消/关闭及响应上限。开发机标准路径
`/Applications/Zotero.app` 未发现安装；未读取真实 Zotero 数据库、用户文库或凭证。
本地 fixture 不等于已安装 Zotero 的实际互操作验收。

设置区连接/安装检测、库/集合选择、预览后的持久化幂等导入、版本检查点、冲突
与删除状态、附件输入授权以及真实客户端验收仍待后续增量。V1 没有任何 Zotero
写请求，V3 写回继续另行授权。
