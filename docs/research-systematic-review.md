# 系统性综述协议

## 固定协议与人工确认

`ResearchRepository.systematicReviews` 保存独立于普通搜索策略的综述协议。协议明确研究问题、可空的 PICO、带 ID 的纳入/排除标准、发表年份范围、分库查询式和页预算、两轮审核人数、人工冲突解决、按研究设计声明的质量评价框架版本，以及提取字段/单位。没有默认纳入标准、默认审核人或默认评价框架。规范不验证用户声明方法的科学适用性；冻结前仍需要人工审查。

`save` 创建新协议或追加新版本。修改必须指明当前父版本 ID/哈希并填写偏离原因；不会改写父版本或旧冻结。版本快照保存项目、请求/请求哈希、父关系、完整内容、可信调用者和时间。新协议 version1，后续版本严格递增。

`freeze` 接受所显示版本的准确哈希和人工审核说明。独立冻结收据与版本的 freeze_hash 标记在同一数据库事务保存；原始版本 JSON 和版本哈希不变。缺少已标记收据、内容损坏或身份不一致时读取失败，不能退成草稿。新检索调用 `requireFrozen` 必须使用当前版本及准确的冻结收据哈希；历史版本保留可读。

相同项目/请求 ID/内容/调用者重放零写入；漂移、并发旧版本、跨项目、已归档写入和重复冻结均明确失败。归档协议历史可以读取。没有生成 Evidence、主张、科学审核或 PRISMA 计数。

## 数据与验证

DB27 新增 `research_review_protocol_versions` 与 `research_review_protocol_freezes`；不会给已有普通搜索/文献补造综述协议或人工决定。原库数据、旧迁移时间及来源快照保留。

`tests/unit/research-systematic-review.test.mjs` 覆盖严格契约、固定版本/收据、并发/哈希/请求冲突、历史重放、归档/跨项目、损坏/收据缺失、事务回滚、真实 SQLite 磁盘备份重开和 DB26 升级。当前专项9/9、全量单元912/912、Harness94/94、原生科研流程13/13、实际启动12/12、构建/type/IPC/chunks通过。身份为明确的测试用户；实际分库检索、筛选/提取及检查器交互是后续部分，不能把存储验证称为完整综述验收。


## 公共 API 的人工边界

生成 preload API 为 `saveReviewProtocol`、`freezeReviewProtocol`、`getReviewProtocol`、`getReviewProtocolHistory`、`listReviewProtocols`，对应 `research.reviewProtocol.save/freeze/get/history/list`。声明和实际注册均在现有 research 插件内，renderer 没有 Node/数据库访问入口。

保存与冻结扩展既有 `research-human-context`：主进程先验证严格请求，再将有效 sender window 与项目、具体能力绑定。模型直调、无窗口、跨能力/项目上下文和 wire actor/reviewer 都不能得到人工权限。用户窗口是应用调用身份，不等于独立领域审查者认证。读取准确版本和历史不会更新决定。

`research-systematic-review-ipc.test.mjs` 实际使用注册器、生成请求契约和主进程适配器，覆盖窗口17/23保存/冻结、幂等重放、无权限零写入、并发旧版本拒绝，以及跨项目/归档/损坏的明确错误类别。与已有关系/来源迁移人工路径合跑33/33通过。该证据仍是主进程测试接缝，不声明完整 production kernel/preload 的界面端到端验收。
