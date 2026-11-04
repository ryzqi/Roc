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


## 冻结协议检索

`startReviewSearch` 每次执行协议中一个明确的分库查询。请求指定项目、协议版本/冻结收据哈希、数据库/查询索引、请求 ID，以及可空的重试父记录/哈希；没有自定义 query、source、owner 或 actor。参数由主进程从固定协议派生，包括原始查询式、发表年份条件、页大小和最大页数。原生 main sender 绑定 start/cancel 的人工上下文；模型直调不能启动或取消。

每条查询先保存不可变请求快照再启动实际 `LiteratureImportService`，复用共享 Provider governor、缓存、请求账本和原始结果池。`getReviewSearch`、`listReviewSearches` 和 `getReviewSearchPool` 读取准确的执行/池哈希；后者按实际原始记录分页。原始池保留年份未知和范围外记录，不将经过年份过滤/候选上限的短预览视为完整语料。读取还核对池内原始请求收据与实际账本记录，不能用另一执行的数据替代。

状态来自真实执行：running/cancelling/complete/partial/failed/cancelled/interrupted。complete 只表示这一个已声明查询读到 API 报告的结果末尾；页预算耗尽、continuation 缺失或 coverage 未知均为 partial。它不证明数据库覆盖所有研究，也不证明科学检索质量。Provider 失败保留实际请求/响应摘要和失败结果，不算完整检索。

取消先在同一事务保存人工请求/哈希/身份和 cancelling 标记，再中止实际 Provider 请求；执行返回后写终态收据。删除已标记取消收据或终态收据会拒绝读取。记录保存失败显示状态丢失错误并记录主进程故障，不能用空数据或成功状态掩盖。

重试必须明确选择当前终态记录及其快照哈希，创建新请求；不覆盖旧结果、不扩展原协议页预算，不重放已完成覆盖的查询。候选预览过期后，已固定原始池仍可读。插件关闭先停止父任务与综述检索，再清理子服务；删除/归档项目先终止其查询。重启将当时运行/取消中的查询记为 interrupted，保留已完成池和已发请求账本，不自动重新请求或重做人工确认。

DB28 新增查询执行和取消收据表，不给已有协议补造搜索。`research-review-search.test.mjs` 使用实际 Provider 解析、governor、分页/缓存、导入服务账本、原始池、协议仓库、生成 main adapter 和 SQLite 磁盘重开；HTTP 响应是明确离线夹具，未调用外部数据库或付费语言模型。专项14/14，与协议存储/人工 API 合跑27/27；全量单元930/930、Harness94/94、原生科研流程13/13、启动12/12、构建/type/IPC/chunks通过。检索界面、去重/筛选/提取和正式 PRISMA 输出仍未交付。


## 固定原始语料

`createReviewCorpus/getReviewCorpus/listReviewCorpora/getReviewCorpusHit` 固定所有声明的分库查询结果。人工捕获必须明确选择每个查询的一条终态执行及其快照/收据哈希；遗漏、重复、运行中或协议漂移均拒绝。主进程绑定创建窗口身份，模型直调和 wire actor 不能创建。

DB29 的 `research_review_corpora` 只保存不可变来源引用与原始命中引用，不复制第二套论文库。来源带查询、执行、结果池、收据哈希、实际状态和覆盖情况；命中带原始池索引与记录哈希。重复返回、年份未知和范围外记录保留，尚无去重决定。partial/failed/cancelled/interrupted 可固定，但不能成为完整检索；失败零结果也保留实际来源。读取重新核对真实池、账本及来源收据。

新协议使旧语料 `currentProtocol:false`，固定内容仍可读；归档允许历史读取，拒绝新捕获。相同请求与调用者重放零写入，内容/调用者漂移拒绝；事务内写入后复核来源，失败整事务回滚。DB28 升级不补造语料或决定。

专项 `research-review-corpus.test.mjs` 10/10，和检索/协议/人工 API 合跑37/37；全量单元940/940、Harness94/94、原生科研流程13/13、启动12/12零 renderer 错误、生成 IPC/type/build/chunks通过。使用真实离线 Provider 服务、原始池和 SQLite 重开；窗口51是主进程适配器接缝，未声明外部科学检索或完整界面端到端验收。人工去重、两轮筛选、提取、质量评价和 PRISMA 输出继续实施。


## 人工去重与固定筛选集合

`saveReviewDuplicateDecision/getReviewDuplicateDecisionHistory/getReviewDeduplication/freezeReviewDeduplication` 记录人工两端比较并冻结语料的待筛选集合。每个决定固定两端命中、来源查询/执行/池/收据/记录哈希、规则名称/版本、理由、请求与调用者。duplicate 明确移除左项、保留右项；distinct 明确保留不同记录。系统不从 DOI 或标题自动产生决定，不复制或删除原始返回。

同一无向记录对的修订追加版本，必须带最新父决定 ID/哈希和修订原因；反转保留方向仍属于同一对。旧版本和原语料字节保留。冻结必须提交所有当前决定的准确 ID/哈希，包括 distinct；缺项、旧版本、重复或漂移拒绝。人工重复链解析为最终保留项，循环、同一项多个移除目标及 distinct 与重复链矛盾均阻止冻结，未解决的决定仍可读取和修订。

DB30 增加不可变决定版本与独立冻结收据，语料的收据哈希标记在同一事务保存。缺少已标记收据、来源或父版本损坏、冻结内容与当前固定决定不一致均报错，不能重置成未审查。冻结保存原始命中数、重复移除数、待筛选数和准确集合，满足 `identifiedRecords = removedDuplicates + recordsToScreen`；重复移除不是全文排除。无重复或失败零命中的语料也需明确人工冻结，原检索不完整标记不变。

冻结后的决定不再修改；需要改动时显式捕获新的语料并重新记录/冻结，已有审查不被覆盖。历史协议/归档仍可读取固定决定，禁止新写入；当前筛选前要求准确且仍属当前协议的冻结哈希。主进程绑定 save/freeze 窗口身份，工具直调、wire actor、跨项目/能力上下文无法写入。窗口身份是调用出处，不能证明独立领域审核人身份。

`research-review-deduplication.test.mjs` 14/14，和原始语料/检索/协议/人工 API 合跑51/51；全量单元954/954、Harness94/94、原生流程13/13、启动12/12零 renderer 错误、生成 IPC/type/build/chunks通过。实际离线 Provider、完整结果池、事务注入故障、SQLite重开/DB29升级、窗口61 main adapter均覆盖。无新增界面或外部科学检索验收；两轮筛选/模型建议分离/双人冲突、提取、质量评价、检查器和 PRISMA 继续实施。


## 固定筛选审核人声明

`createReviewScreeningPlan/getReviewScreeningPlan` 在人工去重冻结后保存两轮审核人和仲裁人的明确声明。声明固定语料/去重冻结/协议版本哈希、两轮审核人 ID/姓名、仲裁人、说明、实际调用者及请求哈希。标题摘要和全文的人数分别严格匹配协议的1或2；同轮不可重复 ID，同一 ID 在两轮/仲裁声明中必须使用一致姓名。跨轮允许同一审核人；仲裁人按用户声明记录，不补造第三人或身份认证。

声明中的研究者身份是用户填报的审查出处，保存权限仍来自 main sender。二者独立保存；研究者姓名/ID不能给工具人工权限，也不能证明独立领域审核已经发生。此部分尚未保存筛选决定。

DB31 的 `research_review_screening_plans` 与语料收据标记同事务写入。一个语料仅有一个固定声明，不提供默认名单或原地替换；需要新安排时创建新语料，保留已有审查。相同请求/调用者重放零写入，来源/身份漂移明确失败。已标记声明丢失、字节损坏或上游固定去重改变时报错；历史协议/归档可读，禁止新声明。DB30升级保持原始语料/去重内容，不给已有记录生成审核人。

专项9/9，和综述协议/检索/语料/去重合跑60/60；全量单元963/963、Harness94/94、原生13/13、启动12/12零 renderer 错误、生成 IPC/type/build/chunks通过。真实离线服务/池、事务故障、SQLite升级/重开和窗口71 main adapter覆盖；无筛选 UI 或独立人工科学审查验收。分阶段决定、建议与人工结果分离、冲突处理继续实施。
