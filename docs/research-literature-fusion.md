# 学术检索融合

检索保存候选快照；独立收录操作才修改文献库。候选不是已读论文、已验证证据或完整学术覆盖。当前合同由 `literature-import.ts`、`literature-fusion.ts` 和 `literature-identity-graph.ts` 定义；[系统性综述](research-systematic-review.md)复用请求账本和完整原始池，[Zotero](research-zotero.md)使用独立来源身份与预览。

## 排序与身份

当前搜索快照 schemaVersion 14，排序为 RRF v1：`score = sum(1 / (60 + source_rank))`。所有选中来源权重为 1，rank 是该来源分页范围的原始一基位置。同来源同论文只用首次 rank 贡献一次分数，全部原始观察仍保留。请求完成顺序和来源选择顺序不改变结果；同分按规范 identity 的 UTF-16 码元顺序排列。

身份首先使用规范 DOI；无 DOI 时使用规范 arXiv、PMID 或来源/外部 ID。标题相同或近似不建立归并边。强身份图保留实际声明的 aliases 和竞争 DOI：无 DOI 连通分量只有唯一 DOI 锚点才附着，竞争锚点保持独立并返回 identityConflicts，不自动合并不同 DOI。

| 来源标识 | 当前处理 |
| --- | --- |
| OpenAlex `ids.doi` / `ids.pmid` | 保存原始字典与映射；主 DOI 与 ids.doi 冲突时保留竞争 DOI，附加 PMID 不连接其他论文 |
| Semantic Scholar `externalIds.DOI` / `externalIds.ArXiv` | 参与强身份图；未经验证的 PubMed 等字段只保留原始值，不猜身份边 |
| arXiv | 支持现代/旧 ID 与 abs URL，版本为正整数；同一论文修订只贡献一次来源分数，仅连接实际观察版本，不补造缺失版本或内容 |
| PubMed / Europe PMC | MED 映射 `pmid:<id>`；其他 namespace 保持独立。PMC 与 MED 同号不归并，PMID 不经浮点转换 |

已知标识格式错误在缓存前失败。Provider 声明的 arXiv 版本不等于从 arXiv 实际取得该版内容，预印本与出版版关系仍需直接来源证据。

## 元数据、冲突与收录

主展示记录按 Crossref → OpenAlex → Semantic Scholar → PubMed → Europe PMC → arXiv，再按 rank/metadataHash 选择。该顺序只决定主元数据，不能解释为可信度、研究质量或排序权重。候选保存稳定 candidateId、identity、score、来源贡献、全部记录、rank/hash/抓取时间，以及字段与身份冲突；DOI 大小写/解析 URL 差异不算冲突。

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

Discovery 的结构化 searchPlan 保留阶段 instruction 原样作为 researchQuestion；它不是未经保存的聊天逐字记录。refinedQuestion、keywords、synonyms、domain、excludedTerms 和查询式是建议。每条 query 固定来源、年份、limit/maxPages；excludedTerms 只有写入具体查询式才由来源执行。

现有人工作业闸门显示完整计划并绑定 expectedSearchPlanHash。缺 hash、内容漂移、superseded、占位或无类型输出不能获批。Retrieval 绑定唯一已批准 search_strategy 工件与内容 hash；阶段工具只接收零起始 queryIndex，主进程派生参数并在实际请求前复核。相同项目下同一已批准工件/hash/queryId 不重复派发，账本返回 `research_search_query_already_dispatched`；每条查询仍使用已冻结页预算。

快照/账本保留策略 ID/hash、原始问题、查询编号和批准时刻。普通会话/文献弹窗直接查询为 strategy:null，不补造已确认科研计划。

## Provider、分页与覆盖

六来源均校验容器、题名、身份与已知字段。合法空数组是空结果；缺容器、HTTP200错误对象、类型错误或无身份记录为 `literature_provider_response_invalid`，不生成随机 ID、题名或空成功。arXiv 先校验 XML/Atom，错误 entry 拒绝；OpenAlex 使用 per_page。

limit 默认 10、最多 30，限制每页原始条数与最终候选数；maxPages 默认 1、最多 3。OpenAlex 用 page，Crossref/arXiv 用 offset，Semantic 用响应 offset，PubMed/Europe PMC 用 opaque cursor。查询/每页条数固定，cursor 不能改变主机；重复 cursor、倒退/重叠位置拒绝。排名缺口保留，不重新编号。Semantic 后页越过 1,000 条范围时停止。

coverage 保存实际 API 声明总量、校验页数、分页范围和后续位置。未知统计为 null/unknown，不以返回条数补造命中总数；reported_end 只表示响应报告的查询终点，limited/truncated 表示仍有限制。stopReason 区分 reported_end/page_limit/provider_limit/continuation_unavailable/failed。首轮全部来源失败为 failed，后页失败且已有结果为 partial；已校验页与错误保留。complete 表示本次请求成功，不能证明学术 Recall 或穷尽检索。

每次实际 GET 保存 URL、位置、起止时间、HTTP状态、Retry-After、响应原始字节 SHA-256及传输错误。重试独立记账，退避不算 HTTP执行时间；200无效载荷保留200/hash但标为数据失败。缓存页保留原始抓取时间/hash、独立 hit/miss；命中不生成新 HTTP回执。

## 账本与完整原始池

检索开始保存 executionId、可信 owner/project/runId、冻结请求和 running；HTTP前保存 dispatched，读取/本地终止后保存 received。received 不等于远端成功，HTTP状态可为 null。候选、完整原始池和执行终态同事务发布；取消、关闭或写入失败不发布成功候选。

审计失败抛错：派发前写失败就不发 HTTP，完成记录失败保留 unknown，不补造状态/hash/结束时间。重启将 running 标记 interrupted、未完成请求标记 unknown，保留字节回执；本地恢复时间不能当远端结束时间。

完整池保留融合前所有已校验来源记录、原始排名/标识/审查、请求、确认策略与回执，年份/候选上限不截断它。`getLiteraturePool` / `research.literature.getPool` 按 executionId 分页（默认20、最多30），每次先校验完整 contentHash，再返回 total/nextOffset。缺旧池显式失败，不能从RRF前N候选反推。完整池是标注输入准备，不等于独立相关性标签或完整论文全集。

## 准入、缓存与关闭

来源共用主机级 FIFO 准入，每主机同时一个 HTTP尝试直到响应校验结束；六检索来源使用五主机，PubMed/Europe PMC共享EBI。DataCite、Hugging Face、OpenReview的独立主机也复用 governor。每次普通搜索分批最多三个来源，不同主机可并行。

应用策略为每主机每小时最多300次、最短1秒（arXiv 3秒）；重试计数，缓存/拒绝准入不计数。配额是进程内上限，非远端剩余额度，重启重建窗口。Retry-After影响同主机其他项目；响应限额只收紧间隔。连续三次HTTP/传输/超时/载荷失败开启60秒冷却，新校验成功才恢复健康，旧缓存不清故障。取消/关闭不计来源故障，排队和退避可取消。

共享进程内LRU最多32条/8MiB响应文本、TTL5分钟，键包含可信项目、完整URL/分页和格式。仅校验成功结果缓存，不写磁盘。治理状态是该次结果的应用观察，不是实时远端健康或学术覆盖评分。关闭中止并等待所有请求/导入，清空缓存，拒绝迟到结果和工件。

## 离线标注与排名评估

评估仅读明确本地JSON，不调用Provider/模型或写文库；输入为 `src/shared/schemas/literature-retrieval-evaluation.ts`。先重建每个完整池并校验数量/hash，准备 schemaVersion1、corpusId、minimumTopics 和 queries（queryId/topicId/pool）：

```sh
pnpm research:retrieval-eval --prepare captures.json new-annotation-packet.json
pnpm research:retrieval-eval labeled-corpus.json new-report.json
```

准备输出 unlabeled_packet，按metadataHash排序，保留问题/元数据/已知标识，移除排名、分数、来源排序与候选分组。URL/标识仍可能透露来源，不能声称来源盲法。人工给每个原始recordHash恰好一个paperId归属、0–3级grade和evidenceRefs；已知相关但未捕获论文可用空recordHashes，进入Recall分母/理想排名。仅池内判断须按池内Recall解释。

engineering_fixture 要求 annotation:null，始终 engineering_only；human_reviewed 声明 independent_human、blindToRanking、至少两名不同且不属于producerIds的reviewer及证据reference/SHA-256。人工模式要求相关源码已提交且无相关工作区改动、捕获limit≥20。工具仅记录 declared_independent_human，不认证身份、独立性或科学代表性。

基线按固定来源优先级/rank/identity排列，与RRF使用同一当前身份和年份规则。前20截断后重复paperId只首次计增益，跨多个paperId的归并计falseMerges20。Recall@20分母为全部已标注相关论文；nDCG@10使用gain=`2^grade-1`、discount=`log2(rank+1)`。同主题查询先平均，再等权平均主题；重复率按全部前20槽位汇总，空排名为null。报告保留失败/部分查询、数量条件、corpus/pool/源码/bundle身份；达到minimumTopics不等于科学验收。

输出原子发布新文件，已有路径EEXIST不覆盖；不完整池、hash/标签/身份错误和缺相关分母均失败。现有示例为合成工程fixture；独立人工查询集与真实Recall/nDCG验收尚未建立，见[验证边界](verification.md)。本地SQLite/向量检索另见[性能与冻结检索](research-performance.md)。
