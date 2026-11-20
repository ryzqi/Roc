# 文献持续监控

监控属于现有科研项目。它读取 Provider 元数据并保存检查回执，不调用模型、不导入论文、不修改 Evidence、工作流或科学审批。提醒的「已读」仅记录人工阅读。

## 查询、调度与权限

- 搜索查询固定十来源枚举中的显式来源、关键词、每页及最终结果上限、页数、可选年份/日级日期和重排方式；选择 ACL/CVF 必须给出集合。每个来源通过既有受治理的 LiteratureImportService 执行，范围和日期语义见[检索融合](research-literature-fusion.md#查询规划来源与日期)。
- DOI 更新查询固定项目文献条目、revision 和规范化 DOI。项目归档或目标归属、版本、DOI 改变后，新读取会被阻止。
- 查询版本不可变；控制 revision 独立递增。新查询建立新 baseline，保留旧查询、检查和提醒。
- 每日或每周检查复用主进程 BackgroundDeadlines；创建或恢复后一个周期开始首次检查。唤醒只重挂已存 deadline，运行中的检查不会重复启动。
- 创建、修改、暂停、恢复、手动检查、取消和已读要求主进程绑定的人工窗口上下文。IPC 请求不接受 actor。读取历史支持只读项目。

## 官方 Provider 合同

OpenAlex 使用 DOI singleton 的 `id,doi,is_retracted,title` 字段。`is_retracted` 是来源观察，不构成科学审核结论。

Crossref 使用 `GET /works?filter=updates:DOI&rows=100&offset=N&sort=indexed&order=asc`，读取指向目标 DOI 的 incoming update notices。返回 notice 的 `update-to` 必须包含目标 DOI。原论文 singleton 的 outgoing `update-to` 不能用于推断它收到的勘误。

过滤语义参考 [Crossref REST API filters](https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-filters/)；OpenAlex singleton 的字段语义见[学术关系](research-scholarly-relations.md)。固定 Provider fixtures 不证明实时 API 可用性或科学结论。

Crossref 每次最多 100 条：满页下一检查 offset 加 100；短页重置为 0，下个周期从头扫描。此为有限覆盖的周期扫描，不保证完整增量 feed。分页期间 Provider 数据可能变化。共享限流、缓存、超时、429、失败健康度和响应大小限制沿用[文献检索传输层](research-literature-fusion.md#准入缓存与关闭)。

## 回执与去重

监控、查询版本、mutation 请求、检查、检查点、seen 和 alerts 保存在当前科研库。transport 前持久化 running check；每个监控最多一个 running check。终态包括 complete、partial、failed、cancelled、interrupted。重启将未结束检查置为 interrupted；相同 request key 返回旧回执，不自动重读。

成功来源的检查点、普通论文 seen、提醒和终态检查在同一事务提交，并在事务前后校验控制与查询版本。首次成功搜索建立普通论文 baseline；首次发现撤稿或勘误即提示。seen 按查询版本、来源、论文身份保存；提醒按 monitor、身份、类型跨来源去重。unknown、未报告或后来消失不会删除旧提醒。

检查保留查询版本、逐来源治理状态、请求回执、搜索快照或解析后的 DOI records/events/coverage。搜索回执绑定 durable execution 的 project、monitor owner、精确查询与 durable pool；重新融合候选验证结果，不依赖会过期的候选搜索表。检查整体 JSON 上限 4 MiB；本地列表和历史每页上限 20。

搜索整体 `fetchedAt` 为 null；真实 fetch 和 cache 时间来自逐页搜索回执，不能把聚合时间当 Provider fetch 时间。DOI 查询保留其 transport fetch/cache/hash。

## 现有文献画布界面

文献画布的「监控」子视图首次访问才懒加载。监控按项目隔离；查询版本和控制 revision 切换会重建编辑器。草稿、进行中命令和结果不确定时锁定监控选择及 tab 离开；项目变为只读后保留草稿、禁写并允许放弃。

宽画布使用监控列表与详情两栏，分别滚动；窄画布一次展示列表或详情，提供「返回监控列表」并恢复焦点。详情表单限制行宽，窄区域改为单列。返回与选择监控遵循同一草稿及写入锁。

编辑器可选择十个来源、ACL/CVF 集合、年份、显式日期及排序；保存时保留未设置与显式关闭重排的区别，修改名称或频率不丢失原查询参数。日级日期与年份无交集或缺少必需集合时拒绝保存；查询版本历史展示冻结参数，执行时不随当前日期重新路由。

保存、暂停/恢复、检查和已读保留精确失败请求；重试不生成新的 requestId。取消针对主进程返回的真实 running check ID，并分别显示取消信号与终态。当前检查每秒刷新权威回执，最多 120 次，隐藏、读取错误或终态停止；手动刷新可恢复。列表、查询版本、检查和提醒分别分页，每页 20 条。

DOI 目标按真实条目 ID 读取，不从当前过滤列表推断目标缺失。读取未完成或失败时禁止保存/立即检查，显示原始失败和重试；版本变化要求显式重新选择。查询保留已绑定选项，避免过滤列表清空合法绑定。检查详情展开后才渲染大型来源内容，原始 JSON 第二层展开后才序列化。

合同与实现入口为 [research-monitors.ts](../src/shared/schemas/research-monitors.ts)、[monitor-service.ts](../src/main/plugins/research/monitor-service.ts) 和 [MonitorEditor.tsx](../src/renderer/literature/MonitorEditor.tsx)。界面检查可在仓库根目录执行 `node --test tests/renderer/research-monitors.test.mjs`；跨模块检查按[开发与检查](development.md)选择。
