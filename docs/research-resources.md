# 科研资源与 DataCite 元数据观察

现有科研插件提供 ResearchResource 元数据观察。数据集和软件 DOI 保存为独立资源，使用已有检索传输、主机治理和缓存；不会导入论文、下载内容或改变科研审批。支持论文及实验的人工版本关联，阅读器提供查询、历史和关联面板。

## 官方合同

官方资料核对日期：2026-11-06，不是政策生效日期。

- [DataCite Public API](https://support.datacite.org/docs/api) 和 [GET DOI](https://support.datacite.org/reference/get_dois-id)：使用 JSON API v2 的 `/dois/{doi}`，仅读取公开 findable 记录。404 表示本次公开元数据不可用，不认定 DOI 在全球不存在。没有使用废弃 v1 API。
- [DataCite Metadata Schema 4.7 version](https://datacite-metadata-schema.readthedocs.io/en/4.7/properties/version/)：保存 Provider 报告的原始版本，不推断最新版本。`reportedSchemaVersion` 保留返回值；通用 kernel-4 URI 不被解释为具体 4.7 注册版本。
- [Rights](https://datacite-metadata-schema.readthedocs.io/en/4.7/properties/rights/)：保存 rights、rightsUri、rightsIdentifier、rightsIdentifierScheme、schemeUri 和 lang。许可元数据不是内容下载或再分发授权。
- [RelatedIdentifier](https://datacite-metadata-schema.readthedocs.io/en/4.7/properties/relatedidentifier/)：保留资源 A → B 的原始标识类型、relationType、resourceTypeGeneral、relationTypeInformation 和元数据 scheme 字段。4.7 的额外关系说明为自由文本，不转换成已验证科研结论。
- [限流](https://support.datacite.org/docs/rate-limit)：官方匿名配额为每 IP 每 5 分钟 500 次。产品沿用较保守的每主机 1 请求/秒、300 请求/小时，不配置虚构邮箱或凭据。

外部响应选择已声明字段，核对 data.type、data.id、attributes.doi、findable 状态和 Dataset/Software 类型；JournalArticle 等其他资源类型拒绝。缺省 version、rights 和 relatedIdentifiers 保存为 null；已报告的空集合保存为 []，两者不混用。

## 不可变观察与读取

每次捕获显式提供 projectId、requestId 和 DOI。DOI 使用现有规范化函数，项目须存在且未归档。保存请求、查询时间、端点、元数据、获取时间、原始响应哈希、实际 GET 回执、缓存命中和治理观察。失败保存为 error 观察，metadata 为 null；取消和关闭不保存迟到结果。

相同项目和 requestId 精确重放已保存观察；进行中的相同请求共享作业，修改 DOI 拒绝复用标识。新查询使用新 requestId。归档后仍可读取旧观察，但不能捕获新观察。

当前结构保存 `research_resource_observations` 和项目/DOI 索引，不推断既有文献或实验的资源关系。规范化 JSON 的 SHA-256 绑定物理行 id、项目、requestId、DOI、端点及主机；读取重新校验完整记录。

四个生成式 IPC 方法为 `captureResource`、`cancelResourceCapture`、`getResourceHistory` 和 `getResource`。捕获只返回摘要，历史每页最多 50 条，关系每页最多 100 条。标题最多 32 个、许可最多 64 个、关系最多 10000 个；超限失败，不截断成成功。

DataCite 属于元数据 Provider，不进入论文搜索 source 枚举。传输、缓存、取消和关闭复用
`LiteratureSearchService.readProviderJson`；共同网络边界见[学术关系](research-scholarly-relations.md#网络与读取边界)。

## 显式关联

关联是追加保存的 `user_declared_context` 人工相关性声明。请求绑定成功观察的 resourceId/contentHash，以及主进程提供的目标身份。它不证明下载了哪些字节、实际使用了哪个数据集，也不改变审批。

论文绑定真实项目 membership、未归档状态、revision、DOI（允许显式 null）及 `{id,revision,metadata,bibliography}` 的哈希。实验只接受当前项目已完成的托管 execution，绑定 inputHash、environment.hash 与完整 schema-parsed execution 哈希；必须具有环境、输入哈希、结束时间、零退出码且无 error。手工登记或未完成实验不能作为目标。

目标分页接口返回主进程计算的身份，每页最多 50 条。人工明确保存 rationale；IPC 不接受 actor 或 approved，身份由实际窗口绑定。事务内在插入前后校验项目、资源及目标版本，漂移回滚。相同 projectId/requestId 精确重放，不同内容拒绝。

历史/read 返回 `{association,currentState}`，状态为 current、target_changed 或 target_unavailable。论文取消项目关联/归档或托管执行不再存在时标明 unavailable；版本变化标明 changed。保存的记录保持原始目标版本、标题、资源哈希、人工身份、时间和关联哈希。资源或账本损坏明确失败，不能转成 unavailable。归档项目允许旧关联读取及精确重放，不能新增。

实验完成后迟到的 finish 不覆盖终态；publish 添加 artifactId 后完整执行哈希会变化，旧关联显示 target_changed，需要用户明确关联新版本。实验 get 还验证物理行的项目、runId、requestId 和 status 与快照一致。

生成式 IPC 方法：`associateResource`、`getResourceAssociation`、`getResourceAssociationHistory`、`getResourceTargets`。

## 阅读器资源面板

阅读器的“科研资源”按需加载项目面板，与学术关系共用最高 55% 的滚动区域。人工填写 DOI 后查询，
可真实取消；观察历史每页 20 条、原始关系每页 50 条。许可六字段、报告版本、缺省/空集合、
失败及 GET/缓存/哈希回执分别显示，关系保持来源方向。

关联从真实论文/托管实验目标选择并填写依据。未保存、保存中和未确认回执锁定切换与关闭；
精确重试保持 DOI/requestId 或完整关联请求，重新读取须明确放弃旧草稿。只读项目可查历史和放弃草稿，
不能发起写入。迟到回执按项目/论文/资源隔离；历史展示人工身份及版本 current/changed/unavailable。

## OSF Projects 政策决定

历史政策核查日期：2026-11-06；决定不立项 Projects 写入同步。

| 日期 | 官方变化 | Roc 的实施含义 |
| --- | --- | --- |
| 2026-08-11 | COS 公告及支持文档发布 | 此为公告日期，不是 API 写入停用日期 |
| 2026-11-16 | 停止创建 Projects、components 和直接从 Project 创建注册 | 不建立依赖这些目的地的同步流程 |
| 2027-02-19 | Projects 转为只读，Project 写入/更新流程退役 | 不建立新的 Project 文件上传或持续写同步 |

既有公开 Projects 的读取、URL 和 DOI 保持可用；独立 OSF Registries 与 Preprints 工作流继续。公开 Projects 的可访问性不能推导为 Projects 写入服务继续；也不能将独立注册服务等同于从 Projects 创建注册。

来源于 2026-11-06 读取：[OSF Projects API Impact](https://help.osf.io/article/744-osf-projects-api-impact)（页面标注 2026-08-11 更新）及 [COS OSF Changes](https://www.cos.io/osf-changes)。API Impact 页关于个别剩余管理操作存在例外，不能从「只读」推导所有 HTTP 方法一律停用；本决定仅涉及新建、上传和持续写同步。

当前没有 OSF Projects 写入连接器；公开内容只读导入和独立预注册需另行评估。
[Zenodo 审核式发布](research-zenodo.md)使用独立合同。
