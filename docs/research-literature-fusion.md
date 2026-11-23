# 学术检索融合

检索保存候选快照；独立收录操作才修改文献库。候选不是已读论文、已验证证据或完整学术覆盖。当前合同由 [literature-import.ts](../src/shared/schemas/literature-import.ts)、[literature-fusion.ts](../src/main/plugins/research/literature-fusion.ts) 和 [literature-identity-graph.ts](../src/main/plugins/research/literature-identity-graph.ts) 定义；[系统性综述](research-systematic-review.md)复用请求账本和完整原始池，[Zotero](research-zotero.md)使用独立来源身份与预览。收录后的全文任务见[自动入库合同](research-literature-acquisition.md)，真实捕获与离线评价见[文献评测方法](literature-evaluation.md)。

## 排序与身份

当前搜索快照 schemaVersion 14，默认排序为 RRF v1：`score = sum(1 / (60 + source_rank))`。所有选中来源权重为 1，rank 是该来源分页范围的原始一基位置。同来源同论文只用首次 rank 贡献一次分数，全部原始观察仍保留。请求完成顺序和来源选择顺序不改变结果；同分按规范 identity 的 UTF-16 码元顺序排列。

显式 `rerank: "lexical"` 对融合、年份校验后的前 100 个候选执行确定性重排：题名/摘要词覆盖率权重为 0.7/0.3，相关性/原位置先验权重为 0.8/0.2，已选题名的最大 Jaccard 相似度乘以 0.15 作为多样性惩罚。每选出一篇只增量更新剩余候选的最大惩罚，题名对只比较一次；同分保持原位置顺序。保留原始 `score`、来源 rank、身份和观察；新增 `reranking` 回执单独记录重排分数。它是可选词法基线，未使用相关性模型；中文分词、语义近义词与科学质量判断不在其能力范围。监测重放使用相同规则核验候选。

## 查询规划、来源与日期

当前网络检索支持十来源：OpenAlex、Crossref、Semantic Scholar、arXiv、PubMed、Europe PMC、OpenReview、ACL Anthology、DBLP、CVF。Agent、批准计划、监控和系统性综述使用同一来源枚举；文献导入弹窗的检索页只列前六个通用来源。Unpaywall 是可选 PDF 补充发现服务，不计入这十个检索来源。

普通搜索省略 `sources` 时按查询关键词路由，并在 `planning` 回执中保存领域、选择方式及理由。显式来源及顺序保持不变；账本和原始池保存路由后的明确来源，读取历史请求时不重新推断。

| 查询领域 | 默认来源 |
| --- | --- |
| 通用 | OpenAlex、Semantic Scholar、arXiv |
| AI/CS | OpenAlex、Semantic Scholar、arXiv、OpenReview |
| 生物医学 | OpenAlex、PubMed、Europe PMC |
| 计算机与生物医学交叉 | OpenAlex、Semantic Scholar、arXiv、PubMed、Europe PMC、OpenReview |
| NLP / 计算机视觉 | 在 AI/CS 来源上按词表补充 ACL / CVF |

领域识别采用有限中英文关键词，不是分类模型；通用查询沿用 Roc 的计算机科研默认组合。Crossref、DBLP 可显式选择，路由本身不发起自动元数据补全请求。PubMed 和 Europe PMC 共用 EBI，不表示两个完全独立的语料库。

OpenReview 使用匿名 API2 公共论坛搜索，保留 Note 身份，复用公开字段权限校验，不把回复当论文。ACL 使用官方仓库的单集合 XML，CVF 使用官方会议集合页面，支持集合内词法排序及分页；两者不是跨年份的完整索引。普通请求缺少 `collections` 时由路由器依据 `yearTo`、`dateTo` 或上一 UTC 年推导，并在实际请求中冻结；ACL 默认 acl，CVF 默认 CVPR，已识别会议信息可改变集合。CVF 适配现代 2021 年起的目录结构。不存在的集合显式失败，不暗中改搜其他年份。

批准计划、监测和系统性综述必须明确 ACL/CVF 集合，审批、历史和重放保留同一范围，不能随当前日期漂移。DBLP 使用官方 JSON 出版物 API；挑战页面视为失败，不绕过验证或报告空成功。

普通 Agent 会话可调用 `research_search_literature_plan`。`quick` 保留一条原查询；`deep` 保留原查询并用 LLM、RAG、NLP、RLHF、multi-agent 词表生成最多三条去重查询。未知术语不会凭空扩展。该工具不联网、不收录；Agent 需分别执行返回的查询，来源排名不会跨查询拼接。`maximumProviderPages` 为查询数 × 来源数 × `maxPages`，不包含重试；深度模式不隐式增加每页条数或页数。已绑定人工批准计划的阶段不提供此工具。

`dateFrom/dateTo` 是包含端点的 ISO 日期，与 `yearFrom/yearTo` 取交集，空交集拒绝。规划工具支持 `recentYears` 与 `asOf`（默认当前 UTC 日期），按滚动日历年解释，并将闰日夹到目标月末；不能同时传入相对和显式时间范围。例如 `recentYears:1, asOf:"2024-02-29"` 得到 `2023-02-28` 至 `2024-02-29`，解释规则随规划结果返回。

| 来源 | 每一页执行的原生日期条件 |
| --- | --- |
| OpenAlex | `from_publication_date` / `to_publication_date` |
| Crossref | `from-pub-date` / `until-pub-date` |
| Semantic Scholar | `publicationDateOrYear` |
| arXiv | `submittedDate`，按 GMT 分钟覆盖整个起止日 |
| PubMed / Europe PMC | `FIRST_PDATE`，首次电子或印刷出版日期 |
| OpenReview / ACL / DBLP / CVF | 无原生日期下推；只执行本地年份复核，ACL/CVF 另受固定集合约束 |

本地记录仍只有 `publishedYear`，因此本地兜底只能复核年份并排除未知年份，不能独立验证日级日期。arXiv 的提交日期与出版日期语义不同，日期搜索会显式提示此限制。未提供时间条件时保留原始 Provider 查询 URL。

身份首先使用规范 DOI；无 DOI 时使用规范 arXiv、PMID 或来源/外部 ID。标题相同或近似不建立归并边。强身份图保留实际声明的 aliases 和竞争 DOI：无 DOI 连通分量只有唯一 DOI 锚点才附着，竞争锚点保持独立并返回 identityConflicts，不自动合并不同 DOI。

| 来源标识 | 当前处理 |
| --- | --- |
| OpenAlex `ids.doi` / `ids.pmid` | 保存原始字典与映射；主 DOI 与 ids.doi 冲突时保留竞争 DOI，附加 PMID 不连接其他论文 |
| Semantic Scholar `externalIds.DOI` / `externalIds.ArXiv` | 参与强身份图；未经验证的 PubMed 等字段只保留原始值，不猜身份边 |
| arXiv | 支持现代/旧 ID 与 abs URL，版本为正整数；同一论文修订只贡献一次来源分数，仅连接实际观察版本，不补造缺失版本或内容 |
| PubMed / Europe PMC | MED 映射 `pmid:<id>`；其他 namespace 保持独立。PMC 与 MED 同号不归并，PMID 不经浮点转换 |

已知标识格式错误在缓存前失败。Provider 声明的 arXiv 版本不等于从 arXiv 实际取得该版内容，预印本与出版版关系仍需直接来源证据。

## 元数据、冲突与收录

主展示记录按 Crossref → OpenAlex → Semantic Scholar → PubMed → Europe PMC → arXiv → OpenReview → ACL → DBLP → CVF，再按 rank/metadataHash 选择。该顺序只决定主元数据，不能解释为可信度、研究质量或排序权重。候选保存稳定 candidateId、identity、score、来源贡献、全部记录、rank/hash/抓取时间，以及字段与身份冲突；DOI 大小写/解析 URL 差异不算冲突。

年份筛选按主记录执行，未知年份排除并提示。模型工具只返回摘要和冲突预览；完整原始记录受可信 owner/project 和快照有效期约束，模型字段不能扩大权限。当前合同不兼容的旧快照显式失败，预览 7 天过期不删除正式文献、证据、执行账本或原始池。

独立收录先准备所有来源观察，全部成功且身份一致后才事务写入文库。`sources.providerRecord` 保留规范化前的原始记录。候选准备或来源/身份冲突导致该候选整体失败；多候选作业可部分成功。归档条目不自动恢复。

文库与候选匹配使用同一身份规则。只有唯一匹配时，新 DOI 可提升原无 DOI 条目的规范身份，保留条目 ID、引用键、主元数据优先级和来源；后续无 DOI 收录不丢失已知 DOI。多个历史条目共享别名或已有不同 DOI 时拒绝自动整理。

| 正式观察 | 读取入口 | 保留内容 |
| --- | --- | --- |
| Provider 标识 | `research.getLibraryIdentifiers` / `research.library.getIdentifiers` | 执行/来源/rank、外部 ID、原始字典、规范映射和 metadataHash |
| 类型/版本/许可/撤稿/更正 | `research.getLibraryReviews` / `research.library.getReviews` | 原始记录 hash、观察时间与来源声明 |

两者默认 20、最多 50 条；候选过期或文库归档后仍可读。同执行/来源/rank 的内容冲突回滚候选收录，不补造历史观察。标识中的 DOI 同步到规范 metadata、书目/BibTeX/已有 CSL，原记录与原书目保留。

导入弹窗可展开原始观察和冲突，未知状态保持未知。OpenAlex 的许可只适用于声明副本，`is_retracted:false` 表示来源未报告撤稿；Crossref update-to 表示当前记录更新目标 DOI，不判定当前记录自身已撤稿。其他未经验证字段不生成结论。

## 人工确认检索计划

Discovery 的结构化 searchPlan 保留阶段 instruction 原样作为 researchQuestion；它不是未经保存的聊天逐字记录。refinedQuestion、keywords、synonyms、domain、excludedTerms 和查询式是建议。每条 query 固定来源、年份、日期、重排选项和 limit/maxPages；excludedTerms 只有写入具体查询式才由来源执行。

现有人工作业闸门显示完整计划（含日期、年份交集与排序方式）并绑定 expectedSearchPlanHash。缺 hash、内容漂移、superseded、占位或无类型输出不能获批。Retrieval 绑定唯一已批准 search_strategy 工件与内容 hash；阶段工具只接收 queryId，主进程派生参数并在实际请求前复核。相同项目下同一已批准工件/hash/queryId 不重复派发，账本返回 `research_search_query_already_dispatched`；每条查询仍使用已冻结页预算。

监控的冻结参数、编辑器与版本历史见[文献持续监控](research-monitors.md)。

快照/账本保留策略 ID/hash、原始问题、查询编号和批准时刻。普通会话/文献弹窗直接查询为 strategy:null，不补造已确认科研计划。

## Provider、分页与覆盖

十来源均校验容器、题名、身份与已知字段。合法空数组是空结果；缺容器、HTTP200错误对象、类型错误或无身份记录为 `literature_provider_response_invalid`，不生成随机 ID、题名或空成功。arXiv 先校验 XML/Atom，错误 entry 拒绝；OpenAlex 使用 per_page。四个领域来源的结果明确提示上述日级筛选和覆盖边界。

limit 默认 10、最多 30，限制每页原始条数与最终候选数；maxPages 默认 1、最多 3。OpenAlex 用 page，Crossref/arXiv 用 offset，Semantic 用响应 offset，PubMed/Europe PMC 用 opaque cursor。查询/每页条数固定，cursor 不能改变主机；重复 cursor、倒退/重叠位置拒绝。排名缺口保留，不重新编号。Semantic 后页越过 1,000 条范围时停止。

发现页的 IPC 输入可显式传 `pageSize`（1–30），保存本次已请求页面的全部融合候选，最多为 `limit × maxPages × 去重来源数`（上限 900），首响应只返回一页。`total` 是保存候选数，`nextOffset` 用于 `readLiteratureSearch({searchId, offset, limit, projectId})` 读取同一快照，后续页不会重新请求 Provider。未传 `pageSize` 的普通调用仍只保留最终 `limit` 个候选；Agent 工具不接受这两个 UI 字段。分页不改变可信 owner/project、7 天期限、排序或批量导入最多 30 条的边界，也不把快照总量冒充来源全部命中。

发现页先订阅 `research.onLiteratureSearchProgress`，再携带本次唯一 `requestId` 发起搜索，并在结束时取消订阅。每个来源真实完成时发送 `requestId/projectId/completedSources/totalSources/source/records`；`source` 保留成功、空结果、部分、超时或错误，`records` 最多 30 条来源观察，仅可作为只读预览，没有 `searchId/candidateId`，最终响应返回正式候选后才可选择导入。主进程作用域将事件直接路由至发起请求的可信 sender，不广播给其他窗口；`requestId` 只做关联，不授予访问权限。来源事件按实际完成顺序发送，最终融合仍按确定性的来源/排名规则。完成来源计数不表示本地融合和快照发布已经完成。

coverage 保存实际 API 声明总量、校验页数、分页范围和后续位置。未知统计为 null/unknown，不以返回条数补造命中总数；reported_end 只表示响应报告的查询终点，limited/truncated 表示仍有限制。stopReason 区分 reported_end/page_limit/provider_limit/continuation_unavailable/failed。首轮全部来源失败为 failed，后页失败且已有结果为 partial；已校验页与错误保留。complete 表示本次请求成功，不能证明学术 Recall 或穷尽检索。

每次实际 GET 保存 URL、位置、起止时间、HTTP状态、Retry-After、响应原始字节 SHA-256及传输错误。重试独立记账，退避不算 HTTP执行时间；200无效载荷保留200/hash但标为数据失败。缓存页保留原始抓取时间/hash、独立 hit/miss；命中不生成新 HTTP回执。

## 账本与完整原始池

检索开始保存 executionId、可信 owner/project/runId、冻结请求和 running；HTTP前保存 dispatched，读取/本地终止后保存 received。received 不等于远端成功，HTTP状态可为 null。候选、完整原始池和执行终态同事务发布；取消、关闭或写入失败不发布成功候选。

审计失败抛错：派发前写失败就不发 HTTP，完成记录失败保留 unknown，不补造状态/hash/结束时间。重启将 running 标记 interrupted、未完成请求标记 unknown，保留字节回执；本地恢复时间不能当远端结束时间。

完整池保留融合前所有已校验来源记录、原始排名/标识/审查、请求、确认策略与回执，年份/候选上限不截断它。`getLiteraturePool` / `research.literature.getPool` 按 executionId 分页（默认20、最多30），每次先校验完整 contentHash，再返回 total/nextOffset。缺旧池显式失败，不能从RRF前N候选反推。完整池是标注输入准备，不等于独立相关性标签或完整论文全集。

## 准入、缓存与关闭

来源共用主机级 FIFO 准入，每主机同时一个 HTTP尝试直到响应校验结束；十检索来源使用九主机，PubMed/Europe PMC共享EBI。DataCite、Hugging Face 和 Unpaywall 的独立主机也复用 governor。每次普通搜索分批最多三个来源，不同主机可并行。

应用策略为每主机每小时最多300次、最短1秒（arXiv 3秒）；重试计数，缓存/拒绝准入不计数。配额是进程内上限，非远端剩余额度，重启重建窗口。Retry-After影响同主机其他项目；处于冷却的请求立即拒绝准入，保留等待时间，不占用工作线程睡眠。失败后自适应间隔翻倍至30秒（远端已声明的更长间隔仍保留），有失败的主机只分配一个探测页；成功后逐步缩短间隔，始终不低于策略/远端下限。连续三次HTTP/传输/超时/载荷失败开启60秒冷却，新校验成功才恢复健康，旧缓存不清故障。取消/关闭不计来源故障，排队和退避可取消。

共享进程内LRU最多32条/32MiB响应文本、TTL5分钟，键包含可信项目、完整URL/分页和格式。仅校验成功结果缓存，不写磁盘。单次响应上限通常4MiB，ACL/CVF集合为16MiB；集合来源45秒、包含集合的搜索60秒截止，其他来源15秒、搜索30秒。403/404/410 失败另有最多128条、60秒负缓存，命中保留失败而不伪造新 HTTP 回执。治理状态是该次结果的应用观察，不是实时远端健康或学术覆盖评分。关闭中止并等待所有请求/导入，清空缓存，拒绝迟到结果和工件。

## 评测与检查

公网捕获、人工标注、RRF/词法重排对比和获取指标统一见[文献评测方法](literature-evaluation.md)。原始池和种子遗漏只提供评测材料，不构成相关性标签；当前排序保持等权 RRF 与可选词法重排。来源路由或查询扩展的效果需要同预算配对捕获，不能从固定池的重排分数推导。

工程检查按[开发与检查](development.md)选择；本地 SQLite/向量检索的性能方法见[性能测量](research-performance.md)。
