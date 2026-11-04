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


## 标题摘要决定与独立建议

`saveReviewScreeningDecision/getReviewScreeningDecisionHistory/getReviewScreeningPhase/listReviewScreeningSuggestions` 保存和读取逐项标题摘要审查。请求明确 phase、固定计划哈希、原始命中、声明审核人、纳入/排除/无法判断结果、理由及可空的已阅读建议引用。纳入必须指明协议内的纳入标准，排除必须指明一个协议内的主排除原因；未知标准、未声明审核人、已移除重复项、跨项目和来源漂移拒绝。每位审核人独立追加版本，修订带准确父 ID/哈希及原因，旧决定不覆盖。

DB32 将人工决定与 agent 建议存入不同表，phase 是固定记录和索引键。每条决定固定声明审核人和真实窗口调用者、原始 hit/record/query/pool/receipt 引用及摘要实际存在状态。null/空摘要记录为 missing，不补写摘要，也不自动产生结论。历史读取重新验证父链、原池、协议、审核人和所考虑的建议。

`research.reviewScreening.suggest` 是独立能力，主进程从实际 CapabilityOperationContext 派生 operation/tool-call/能力版本/首次尝试来源；wire 不接受 origin、modelId 或 runId。没有工具操作上下文就拒绝。重试可重放同一操作的首个固定建议，内容或能力版本漂移不能覆盖旧记录。这里记录的是实际工具建议出处，没有虚构已执行的模型请求或模型身份。建议不能调用人工决定入口，也不能增加已纳入/排除计数；人工即使引用某建议，仍明确填写自己的结果与理由。

逐项状态来自协议要求的人数及实际决定：pending、uncertain、conflict、included、excluded。双人结果不一致或虽都排除但主原因不同均为 conflict；无法判断单独可见，少一个审核人仍为 pending。计数满足 `recordsToScreen = pending + uncertain + conflict + included + excluded`。这些是当前逐项状态；仲裁、整轮冻结、全文决定和最终 PRISMA 尚在后续，不能把当前共识当成完整综述。声明身份与窗口身份仍不能证明独立领域审核。

专项13/13，和既有综述工作流合跑73/73；最终清理后的单元976/976、Harness94/94、原生13/13、启动12/12零 renderer 错误、生成 IPC/type/build/chunks通过。覆盖真实离线结果池、缺失/存在原始摘要、双人冲突/不同主原因、独立建议/人工改判、父/来源/阶段漂移、写后损坏/丢失回滚、DB31升级/磁盘重开以及窗口81与实际 main operation 接缝。没有外部模型消费或筛选 UI 端到端验收。旧 ZIP 计时测试边界修正单独提交 e2dbfb2，保持30ms关闭拒绝检查和原始错误断言。


## 绑定当前决定的人工仲裁

`adjudicateReviewScreening/getReviewScreeningArbitrationHistory` 记录声明仲裁人对完整冲突/无法判断集合的人工处理。请求带准确计划哈希、全部当前审核决定 ID/哈希、最终纳入或主原因排除、理由和实际主进程调用者。少审核人、已经一致、未知仲裁人/标准、旧决定或重复引用都拒绝。修订追加版本，必须带最新父仲裁 ID/哈希和修订原因。

DB33 的独立仲裁表保存两端审核来源、固定材料、身份和不可变历史。审核决定更新时旧仲裁 `currentDecisionSet:false`，仍可读取，但不能解除当前冲突。既有 `getReviewScreeningPhase` 返回带仲裁的解析状态，仅应用最新且匹配当前全部决定的仲裁；原始逐人决定、建议和理由不改写。不同主排除原因由用户明确选择；整轮冻结仍在下一部分。

事务写入后重新验证计划和完整审核集合。即使存储回调追加一条合法的审核新版本，保存也会拒绝并回滚仲裁与该变更，不能把过期仲裁返回为成功。原协议历史/归档可读，当前状态和科学适用范围分别显示；新判断拒绝。声明仲裁人身份仍是用户填报，权限由有效 main sender 绑定。

仲裁专项9/9，和既有综述工作流合跑82/82；单元985/985、Harness94/94、原生13/13、启动12/12零 renderer 错误、生成 IPC/type/build/chunks通过。覆盖真实审核决定、哈希漂移/过期/再仲裁、单人无法判断、不同排除原因、损坏父链、有效新审核版本和损坏来源的事务回滚、窗口91 main API、DB32升级/SQLite重开。未执行外部科学审查或 UI 端到端验收。


## 标题摘要整轮冻结

`freezeReviewScreeningPhase` 人工确认既有 `getReviewScreeningPhase` 展示的准确 `reviewHash`。审核集合包含固定计划/语料、原始有序命中、当前逐人决定哈希、实际应用的仲裁哈希、当前状态和主排除原因。模型建议数量与当前协议的展示标志不改变这个人工集合哈希；建议仍独立读取。全部记录必须纳入或排除，pending/uncertain/conflict 任一非零都会拒绝冻结。空结果也需明确人工操作，检索不完整信息仍保留在原语料。

DB34 的独立冻结收据和计划 `title_freeze_hash` 同事务保存。冻结后拒绝新的审核决定、建议和仲裁；相同旧请求只读取原始记录。读取重新核对当前完整审核集合与冻结哈希；丢失已标记收据、内容损坏或任何合法的新审核版本漂移都不能退成未冻结或成功。写入期间即使追加一条完整有效的新审核版本，冻结和该变更也会一起回滚。

冻结保留每项主排除原因和实际审核/仲裁出处，满足 `recordsToScreen = included + excluded`。这些是标题摘要计数，重复移除和全文排除仍分开。历史协议/归档可读原收据；当前全文阶段必须使用准确、仍属当前协议的标题冻结哈希。它不是科学检索完整性或独立领域审查认证。

专项9/9，合跑91/91；单元994/994、Harness94/94、原生13/13、启动12/12零 renderer 错误、生成 IPC/type/build/chunks通过。覆盖完整/未完成集合、建议不进入人工哈希、冻结后零新写入、原请求重放、收据丢失、损坏与合法新版本的事务回滚、历史/归档、窗口101 main API、DB33存量快照升级/SQLite重开及失败零命中的不完整覆盖。迁移夹具明确种入规范化旧快照，新代码升级后核验全部原始字段；运行时没有旧数据库写入回退。全文绑定/筛选、提取/质量、检查器和最终计数报表继续实施。


## 全文取得与明确来源绑定

`saveReviewFullTextBinding/getReviewFullTextBinding/listReviewFullTextBindings/getReviewFullTextBindingHistory` 只处理标题摘要整轮已冻结的纳入记录。用户明确选择现有 managed document、原始 SHA 和可空的准确 parse ID/hash；不推断 DOI/标题匹配，不复制论文库。`not_retrieved` 保存人工未取得理由，独立于全文 eligibility 排除。取得状态修订追加版本，必须带最新父 ID/哈希与理由，原记录不变。

DB35 固定原始命中/检索来源、标题冻结哈希、文档/论文身份、原始字节 SHA、文件元数据、可选解析哈希/指纹/页数/坐标快照哈希、人工理由和 main 调用者。source-only 允许缺失或不可信解析，重解析不使固定原始字节绑定过期；明确选中的解析必须是已发布 `currentParseId`，不是运行中的 `activeParseId`。后来重解析使旧解析绑定显示 `superseded`，保留历史。

保存实际调用现有 source/preview 读取原始文件及选中坐标工件；异步读取后在事务内复核项目、冻结、父版本和完整来源快照。即使实际 preview 返回后坐标元数据被替换成合法新哈希，也拒绝保存未经核验的快照。写后来源漂移整事务回滚。后续科学写入使用 main-only `verifyCurrent` 再次实际核验字节和当前绑定，来源损坏不能授权新决定。

历史读取显示 `isLatest/currentProtocol/referenceStatus`，不重新抓取文件。`referenceStatus` 是保存来源与数据库引用的状态，不能证明当前磁盘文件已读取；物理文件损坏在实际 source/preview/verify 边界报错。工具直调、wire actor、跨项目和归档不能新写入，主进程在真实异步核验中保留窗口身份。

专项10/10，连同综述、坐标与批注合跑121/121；全量单元1004/1004、Harness94/94、原生科研13/13、启动12/12零 renderer 错误、生成 IPC/type/fresh build/chunks通过。实际 PDF→原生解析→现有文档发布→source/preview、异步漂移、历史修订/损坏/重解析、main窗口111和DB34升级/SQLite重开覆盖。坐标替换回归先复现失败后修正；无独立科学对应关系、全文资格决定或完整筛选 UI 验收声明。全文逐人决定/建议、仲裁/冻结、提取/质量、检查器及真实计数报表继续实施。


## 全文逐人资格决定与独立建议

`saveReviewFullTextDecision/getReviewFullTextDecisionHistory/suggestReviewFullTextDecision/listReviewFullTextSuggestions/getReviewFullTextScreeningPhase` 使用现有 phase-keyed 决定/建议表的 `full_text` 阶段。每项固定已冻结标题摘要纳入记录、计划/标题冻结哈希、准确全文来源绑定 ID/哈希、协议声明的全文审核人、标准、理由、父版本和调用者。人工 include/exclude/uncertain 与实际工具 operation/call/version 的建议分别保存；建议不计为人工决定，明确考虑建议也不要求同意。来源不能由 wire model/run/actor 字段伪造。

新人工决定和建议先调用实际 `verifyCurrent` 核验原文/坐标工件，异步后再在事务里核对准确绑定、协议、父版本和审核人；写后来源漂移、损坏或丢失新行一起回滚。未取得全文、已过期来源、另一项目、标题已排除记录、未声明审核人/标准或不完整修订均拒绝资格写入。source-only 原始字节仍可人工审查，不强制使用缺失或不可信解析。

整轮只包含标题摘要已冻结的纳入记录，分别展示 `retrieval_pending/not_retrieved/source_changed/pending/uncertain/conflict/included/excluded`，其和等于 `reportsToSeek`。未取得全文不是 eligibility 排除。双人决定与主排除原因都一致才形成结论；单人按固定协议人数执行。任何审核人仍引用旧绑定时，旧决定保留为 `sourceCurrent:false`，不能成为当前共识；用户必须明确修订每位审核人的决定到新来源。旧来源建议不能作为新来源的 consideredSuggestion。

同步读取把当前已核验标题快照传给同批来源/历史行，仍逐行检查源、哈希和父链；异步和写后重新取得状态，不设持久缓存。历史协议/归档可读固定决定与建议，新写入拒绝。当前决定还未包含人工仲裁或全文整轮冻结。

专项12/12，综述/来源/坐标/批注合跑133/133；全量单元1016/1016、Harness94/94、原生13/13、启动12/12零 renderer 错误、生成 IPC/type/fresh build/chunks通过。覆盖真实 PDF/source/preview、双人/单人、来源重解析及全审核人重新审核、实际文件损坏/异步漂移/事务回滚、历史/归档、main窗口121及真实工具 operation 来源、DB35存量保持/SQLite重开。未声明独立科学审查或全文 UI E2E 完成；仲裁/冻结、提取/质量、检查器和真实计数报表继续实施。


## 全文人工仲裁

`adjudicateReviewFullText/getReviewFullTextArbitrationHistory` 在现有 `full_text` 仲裁版本表固定全部当前审核 ID/哈希、准确来源绑定、协议/标题冻结/计划哈希、声明仲裁人、最终标准/理由与 main 调用者。仲裁必须针对完整且来源有效的 conflict/uncertain 集合；单人无法判断也可明确仲裁。已一致、缺审核、未取得、过期来源或过期/重复/缺失审核引用均不能仲裁。

新仲裁实际核验原始/坐标字节，异步后重新读取完整当前集合，在事务内核对最新父仲裁与所有来源/审核引用。插入后追加一条完全合法的新审核版本，也会使仲裁失败并回滚仲裁及该修订；损坏/丢行/来源漂移同样明确失败。人工决定和来源绑定不被仲裁改写。

`getReviewFullTextScreeningPhase` 现在返回 resolved view，只有最新且 `currentDecisionSet:true` 的仲裁解除冲突。审核修订或来源变化使旧仲裁明确过期，保留原文、原标准、理由和版本；新仲裁带准确最新父 ID/哈希。历史协议/归档可读，禁止新写入。重开 SQLite 不重新检索、导入或补造审核。

专项10/10，综述/全文/坐标/批注合跑143/143；全量单元1026/1026、Harness94/94、原生13/13、启动12/12零 renderer 错误、生成 IPC/type/fresh build/chunks通过。覆盖逐人修订/过期仲裁/历史父链、完整/一致/单人/来源缺失、真实文件损坏、事务内追加合法审核版本及来源漂移回滚、损坏原文、历史/归档、main窗口131、真实 SQLite 重开。全文整轮冻结、提取/质量、检查器及真实计数报表继续实施。


## 全文整轮冻结与来源历史

`freezeReviewFullTextScreening` 固定显示的准确 reviewHash、当前绑定/逐人决定/有效仲裁 ID/哈希、主排除原因和人工计数。所有标题摘要纳入记录必须明确 not_retrieved 或来源有效的 included/excluded；未处理取得状态、来源过期、未完成审核、无法判断或冲突阻止冻结。每个取得来源先实际核验原始/坐标字节，异步后事务内重新核对全集合。有效新审核版本、来源变动或协议变化发生在写入期间，也使收据/标记和事务内变动一起回滚。

DB36 独立 `full_freeze_hash` 与现有 `full_text` 冻结收据同行提交。缺少/损坏标记或收据不能退成未冻结。新绑定、人工决定、模型建议和仲裁写入全部拒绝，原请求精确重放保持只读。建议数量和 currentProtocol 不成为冻结人工权威。

计数守恒 `reportsToSeek = not_retrieved + included + excluded`；not_retrieved 只表示未取得，不是全文资格排除，标题摘要排除和重复移除仍分开。冻结保留人工作出的准确来源版本结论。后来原文重解析时，原冻结收据/人工计数/哈希不变，live phase 显示 source_changed、旧仲裁失效与 `sourcesCurrent:false`，后续科学写入不得使用过期来源。

`sourcesCurrent` 检查当前数据库来源引用，不表示只读调用重新读过磁盘字节；科学操作仍在实际 `verifyCurrent` 边界核验文件。历史协议/归档保持收据可读，不能新写入。数据库升级保存每个原字段/原行，新标记为空，不补造终局审核或取得记录。

专项10/10，全部综述/全文/坐标/批注合跑153/153；单元1036/1036、Harness94/94、原生13/13、启动12/12零 renderer 错误、生成 IPC/type/fresh build/chunks通过。实际字节、独立来源修订、合法新审核版本与来源漂移事务回滚、缺少/规范化篡改收据、冻结后全部写入拒绝、原请求重放、重解析后固定历史/活跃过期状态、main窗口141、DB35明确旧快照升级、真实SQLite重开和失败零命中覆盖。旧DB34测试改为核对全部原列并另断言新标记为空；无运行时旧schema回退。提取/质量、检查器及真实计数报表继续实施。
