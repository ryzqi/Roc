# 系统性综述

协议冻结 → 检索与原始语料 → 人工去重 → 双轮筛选 → 证据提取 → 质量评价 → 研究归组与报告。每步固定输入与版本回执；模型建议和人工决定独立保存。工程计数不证明科学质量、检索完整性或 meta-analysis 结论。

## 入口与共同合同

文献工具栏「综述核查」在唯一 AppShell 的项目检查器内打开，内容按需加载；协议、语料与阶段工件使用不同身份，不增加综述路由。界面复用[工件检查器](research-artifact-inspector.md)的抽屉、焦点和异步状态。

人工保存/冻结入口先校验严格 schema，再由主进程绑定真实 sender window、项目和具体能力。wire actor/reviewer、模型直调或跨范围上下文不能获得人工权限。用户填报的研究者 ID/姓名是出处声明，窗口身份是调用出处，二者都不认证独立领域审核。

所有修订追加不可变版本，要求当前父 ID/hash 与原因；相同项目/requestId/内容/调用者精确重放只读，漂移或旧父版本拒绝。独立收据与 head/freeze 标记同事务保存；已标记收据缺失、内容/hash或父链损坏显式失败，不退为草稿、空数据或旧版最新。归档和旧协议历史可读，新科学写入要求当前协议和来源。

只读 `referenceStatus` / `sourcesCurrent` 核对数据库引用，不表示重新读取磁盘；科学写入在 main-only `verifyCurrent` 核验真实原文件与准确解析/坐标工件，异步后和写后复查固定输入。重解析保留原决定/来源/收据，失效状态显式显示，不把旧判断挂到新原文。

## 公共 API

方法属于现有 research 插件和生成 preload；精确请求由 `src/shared/schemas/research-review*.ts` 定义。

| 步骤 | 主要方法 |
| --- | --- |
| 协议版本与冻结 | `saveReviewProtocol`、`freezeReviewProtocol`、`getReviewProtocol`、`getReviewProtocolHistory`、`listReviewProtocols` |
| 冻结查询 | `startReviewSearch`、`cancelReviewSearch`、`getReviewSearch`、`listReviewSearches`、`getReviewSearchPool` |
| 原始语料 | `createReviewCorpus`、`getReviewCorpus`、`listReviewCorpora`、`getReviewCorpusHit` |
| 人工去重 | `saveReviewDuplicateDecision`、`getReviewDuplicateDecisionHistory`、`getReviewDeduplication`、`freezeReviewDeduplication` |
| 审核人声明 | `createReviewScreeningPlan`、`getReviewScreeningPlan` |
| 标题摘要 | `saveReviewScreeningDecision`、`getReviewScreeningDecisionHistory`、`listReviewScreeningSuggestions`、`getReviewScreeningPhase`、`adjudicateReviewScreening`、`getReviewScreeningArbitrationHistory`、`freezeReviewScreeningPhase` |
| 全文来源 | `saveReviewFullTextBinding`、`getReviewFullTextBinding`、`listReviewFullTextBindings`、`getReviewFullTextBindingHistory` |
| 全文资格 | `saveReviewFullTextDecision`、`getReviewFullTextDecisionHistory`、`suggestReviewFullTextDecision`、`listReviewFullTextSuggestions`、`getReviewFullTextScreeningPhase`、`adjudicateReviewFullText`、`getReviewFullTextArbitrationHistory`、`freezeReviewFullTextScreening` |
| 提取 | `saveReviewExtraction`、`getReviewExtraction`、`listReviewExtractions`、`getReviewExtractionHistory` |
| 质量 | `createReviewQualityPlan`、`getReviewQualityPlan`、`listReviewQualityPlans`、`saveReviewQualityAssessment`、`getReviewQualityAssessment`、`getReviewQualityAssessmentHistory` |
| 研究归组与报告 | `saveReviewStudies`、`getReviewStudies`、`getReviewStudiesHistory`、`getReviewReport` |

## 协议、查询与原始语料

协议独立于普通 search_strategy，明确问题、nullable PICO、带 ID 的纳入/排除标准、年份、分库查询和页预算、两轮1或2名审核人、人工冲突解决、按设计声明的质量框架/版本与提取字段/单位。新表单方法为空，无默认标准、审核人或框架。保存仅创建版本；冻结另需准确 versionHash 和人工说明，原版本字节/hash不变。修改当前版本另存父关系/偏离原因，旧冻结不改写。

每次 `startReviewSearch` 执行一个冻结分库查询，只接收项目、准确协议版本/freezeHash、数据库/查询索引、requestId 与 nullable 重试父记录/hash；主进程派生 query/source/年份/pageSize/maxPages。复用[文献融合](research-literature-fusion.md)的 governor、缓存、请求账本和原始池。先保存不可变请求，再调度真实请求；人工开始/取消均绑定窗口权限。

状态为 running/cancelling/complete/partial/failed/cancelled/interrupted。complete 要求本查询达到 API 报告终点；页预算耗尽、continuation 缺失或覆盖未知为 partial。缓存命中保留原抓取时间，不能宣称重新联网。取消先保存意图/身份/hash，再中止请求，真实退出后保存终态。重试必须引用最新终态记录/hash，不扩大预算、不覆盖历史或重试已完整覆盖查询。关闭/项目删除或归档先停请求；重启保留 interrupted 与已发账本，不自动重跑。

固定语料需人工为每个声明查询选择一条准确终态执行及快照/收据hash。漏项、重复、运行中或协议漂移拒绝；partial/failed/cancelled/interrupted 可如实固定，保留覆盖缺口和失败零结果。语料只保存不可变来源/原始命中引用，不复制第二套论文库；重复返回、未知年份和范围外记录保留。读取重新校验真实池/账本/收据，新协议使旧语料 currentProtocol:false。

## 人工去重与审核人声明

去重决定固定A/B两端命中与原始来源/hash、规则名称/版本、理由、调用者和父版本。duplicate 明确移除左项/保留右项，distinct 明确保留不同记录；系统不从 DOI/题名自动作出决定，不删除原返回。相同无向对反转方向仍属同一版本链。

去重冻结提交全部当前决定ID/hash（含distinct），解析重复链到最终保留项。环、多个移除目标、distinct与链矛盾、漏项/旧版本均阻止冻结。未声明重复的命中保留。收据固定准确集合并满足 `identifiedRecords = removedDuplicates + recordsToScreen`；重复移除不是全文排除。冻结后需新语料才能调整决定，空/无重复集合也需人工冻结。

随后固定两轮审核人和仲裁人。人数严格匹配协议1或2，同轮ID唯一、同ID姓名一致，跨轮允许相同人；不补造第三人。一个语料仅一个声明，需要新安排则新建语料。研究者声明与实际main actor分开保存。

## 双轮筛选与人工冻结

| 阶段 | 固定材料 | 状态与冻结条件 |
| --- | --- | --- |
| 标题摘要 | 去重集合、计划hash、原始命中/记录/摘要存在状态、声明审核人、标准、理由 | pending/uncertain/conflict/included/excluded；全部included或excluded才可冻结 |
| 全文 | 标题冻结纳入集合、计划/标题冻结hash、准确全文binding ID/hash、声明审核人和标准 | retrieval_pending/not_retrieved/source_changed/pending/uncertain/conflict/included/excluded；全部明确not_retrieved或来源有效的included/excluded才可冻结 |

纳入需协议内纳入标准，排除需一个主排除原因，无法判断独立保存；少审核人为pending，双人结果或主排除原因不同为conflict。每位审核人独立修订，旧判断不覆盖。缺摘要保持missing，不自动生成摘要或结论。

建议存入独立表，出处来自实际CapabilityOperationContext的operation/tool-call/能力版本/尝试，不接受wire origin/modelId/runId。建议不增加人工计数；consideredSuggestion只记录准确已读引用，不替代人的结果。全文新决定/建议须实际verifyCurrent；旧绑定建议不能成为新来源的已考虑建议，用户须明确修订每位审核人的决定。

仲裁由已声明仲裁人针对完整当前conflict/uncertain集合，引用全部当前决定ID/hash、最终标准/理由及准确来源。缺审核、已一致、旧集合或失效来源拒绝。只有最新且currentDecisionSet:true的仲裁解除冲突；新审核/来源使旧仲裁失效，历史保留。仲裁不改写逐人决定。

整轮冻结绑定准确reviewHash、当前逐人决定、有效仲裁、来源与主排除原因，保存独立收据/标记。标题满足 `recordsToScreen = included + excluded`；全文满足 `reportsToSeek = not_retrieved + included + excluded`。空集合也需人工冻结；未取得全文独立于资格排除。冻结后禁止本轮新增决定、建议、仲裁（全文另禁新binding）。后来重解析保留冻结计数/hash，同时显示来源失效，不能授权新科学写入。

## 全文取得与原文提取

全文binding只针对标题冻结纳入命中，由人明确选择已有managed document、原始SHA和nullable准确parse ID/hash，或记录not_retrieved理由。系统不猜DOI/题名对应关系。source-only允许没有可信解析；若选解析，须已发布currentParseId，不是activeParseId。绑定固定原字节、解析/坐标身份和人工说明，保存时真实核验，历史读取只报告引用状态。

提取只针对全文冻结纳入报告，复用已有Evidence和原文，不复制数据源。每个字段保存number/text/missing/unjudgeable，缺失/无法判断有理由；required必须明确填写，optional未填仍未提取。数值须有限且单位与协议准确一致，空值不能成为零。研究设计保存原文支持的text或missing/unjudgeable，不自动套质量量表。

提取固定准确全文冻结/binding/协议、字段定义/单位、Evidence+locator digest及解析/坐标版本、审核人/actor与父版本。source-only binding仍以原字节为权威，提取另固定实际Evidence解析。重解析使旧提取superseded，须显式选新Evidence并修订，不能把旧值换绑新原文。

## 质量框架与逐域评价

质量plan绑定准确人工提取版本，研究设计必须为已保存text并匹配协议 `{studyDesign, framework, version}`。missing/unjudgeable设计不能猜替代框架。用户明确输入domains/问题/各域与总体允许类别、文档依据、审核人和理由，来源为user_declared；这不是完整官方量表实现或统一数值评分。同提取不原地换框架，新提取需新plan。

评价逐个覆盖每个冻结domain恰好一次，judged类别来自该域选项，overall由人单独选择；unjudgeable保留理由。判断引用该提取已有Evidence/digest，不从域判断计算总体分数。保存不可变评价父链与head标记；失效提取/来源不能新写入。旧框架/评价保留currentExtraction:false或superseded。

## 报告、研究归组与计数

[PRISMA 2020词汇表](https://journals.plos.org/plosmedicine/article?id=10.1371/journal.pmed.1003583)区分record、report和study；一研究可有多报告，报告数不能充作研究数。[正式流程图](https://www.prisma-statement.org/prisma-2020-flow-diagram)的新/更新及来源范围需人工确认，当前只展示有依据的计数，不自动选择完整模板。

研究归组由人覆盖全部全文冻结纳入报告，明确studyId/名称/身份理由和每份准确hit/binding及原文说明；允许多报告一研究，也允许明确说明同报告涉及多研究。系统不按标题/DOI/作者推断身份。未归组为null，只有零纳入报告可显式保存空归组获得审核后的零研究数。includedReports与人工studyId数独立。

`getReviewReport` 在一个SQLite只读事务内读取协议、语料、各冻结权威、归组及最新提取/质量收据。格式 `roc.review-report.v1`，正文bodyHash与当前协议/来源状态分开；新提取/评价/归组改变正文，重解析/协议变更只改变引用状态。四条等式为：

- identifiedRecords = removedDuplicates + recordsScreened
- recordsScreened = recordsExcluded + reportsSought
- reportsSought = reportsNotRetrieved + reportsAssessed
- reportsAssessed = reportsExcluded + includedReports

查询附录保留实际参数/日期、原池/账本/来源错误和覆盖缺口；原始记录、排除清单引用准确记录与人工决定。证据表按报告保存最新提取、单位/Evidence/原文定位、对应质量框架/评价；未提取/未评价为null，missing/unjudgeable保持类型。不自动分配研究级效应量或计算meta-analysis；损坏来源/标记收据拒绝整个报告。

## 助手读取、建议与拥有查询

`research_review_read` 读取准确协议/查询/池、语料/命中、筛选/冻结、全文绑定、提取/质量/归组/报告。分页返回真实总数/范围/下一页，列表达上限标记capped；snapshotHash/reviewHash/bodyHash对应完整记录，不把展示页当完整快照。fulltext_content由准确binding派生文档/原始hash/parse身份，真实校验原文/坐标后读固定块；未取得或无绑定解析失败，不触发解析或换到最新版本。

`research_review_suggest_title/fulltext` 只保存建议，项目由运行装配绑定、requestId为可信工具idempotencyKey；精确重放返回原建议，载荷漂移拒绝。模型不能人工仲裁或冻结。工具回执链接绑定准确版本/语料/正文hash，通过 `ToolMessage.artifact.roc_review_receipt_links` 保留最多三条受schema校验的链接，在唯一AppShell打开readonly检查器。只读入口直接按ID/hash读取，不用近期列表猜身份，不提供人工提交控件；正文改变使旧链接失败。

助手执行冻结查询使用ExecutionGrantBroker独立调度凭证，绑定父Run/线程/项目、冻结Manifest、查询请求/hash和工具域。Manifest须允许 `research_review_execute_query` 在main执行；阶段/查询凭证不互换，复制、过期、撤销、重启或父终结拒绝。内部 `research.reviewSearch.startOwned/getOwned/cancelOwned` 保存实际owner回执，读取/取消分别要求main工具权限，没有新增renderer IPC或从actor文本猜拥有者。

先保存查询/owner，再关联Agent数据库 `review_search` 执行与真实聊天根任务，成功后才发Provider请求；关联失败保留失败记录，不自动补挂或重跑。每个请求前核对owner、父Manifest/线程/项目、任务状态和取消信号。父取消、任务暂停/取消清理本任务查询，其他任务独立；状态通知驱动现有任务界面，查询阶段字段为空。任务记录与诊断见[任务可观测性](research-task-observability.md)。

## 界面与验证边界

各步在同一检查器按需打开原始材料、人工表单和完整历史；列表/原文分明确分页，错误不变成空表单。待写回执保留输入/requestId并禁用冲突操作/切换/关闭，精确重试不新增权威记录。范围切换隔离旧响应，只读/历史/归档保留保存值与live失效状态。

本地确定性测试核验版本、权限、来源和计数合同；真实模型筛选质量、独立领域评价准确性和正式PRISMA模板适用性仍需独立验收，见[验证边界](verification.md)。
