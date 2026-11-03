# 学术检索融合

检索保存候选快照。只有独立的收录操作才修改文献库；候选不代表已读论文、
已验证证据或完整学术覆盖。

## 冻结排序合同

当前快照版本为 13，排序方法为 RRF v1：

```text
score(paper) = sum(1 / (60 + source_rank(paper)))
```

所有选中来源的权重为 1。rank 是来源分页范围内原始的一基位置。同一来源出现同一
论文多次时，只用第一次的 rank 贡献一次分数，全部元数据记录仍然保留。来源请求
完成顺序与用户选择来源的顺序不改变排序；改变来源内部排名则会改变贡献。
同分按规范化文献 identity 的 UTF-16 码元顺序排序，不依赖操作系统 locale。

当前归并依据首先是规范化 DOI；没有 DOI 时采用规范化 arXiv、PMID 或来源与
外部 ID。标题相同或近似不构成归并依据。不同 DOI 不因同一个 arXiv/PMID 自动
合并；预印本与正式出版版之间的关系仍需实际来源证据。

同一声明的来源身份只有一个已观察 DOI 时，无 DOI 记录连接到该 DOI。多个
DOI 锚点仍保留独立候选，无 DOI 记录也单独保留；`identityConflicts` 显示共享
标识及竞争 DOI。`aliases` 保存该候选实际关联的规范身份。主展示记录保持
原 Provider 元数据，缺失 DOI 不用来拆分已确认同一标识的记录。

OpenAlex 的 `ids.doi` / `ids.pmid` 与 Semantic Scholar 的
`externalIds.DOI` / `externalIds.ArXiv` 参与强身份图。每条观察保存原始字段、
原始值与规范身份，完整标识字典也保留未知键。Semantic PubMed JSON 字段尚未
验证，因此只保留未知原始数据，不猜测身份边。已知标识格式错误在缓存前拒绝。
OpenAlex 主 DOI 与 ids.doi 冲突时保留竞争 DOI，该记录的附加 PMID 不连接其他
论文。无 DOI 的连通分量只有唯一 DOI 锚点时才附着；竞争锚点不能自动归并。

来源依据为 2026-11-03 核对的
[OpenAlex work attributes](https://help.openalex.org/data/works/attributes/)
以及 Ai2 编写的
[Semantic externalIds.ArXiv consumer](https://github.com/allenai/genesys/blob/main/model_discovery/agents/search_utils.py)。
不使用 OpenAlex 各 location 的 DOI 推测版本相同，也不将 Semantic 声明的
arXiv vN 当作已从 arXiv 端点取得该版内容。修订关系继续仅来自直接观察的
arXiv 记录。

arXiv 规范化支持现代 ID、旧 archive/subject ID 和 `/abs/` URL。0704–1412 序号
为 4 位，1501 起为 5 位，版本必须为正整数。候选保留完整原始 ID 和记录；
同一 arXiv 的多次修订只贡献一次来源分数。`arxiv_later_version` 关系只连接实际
观察到的相邻版本及其元数据 hash；v1/v3 不推测 v2，无版本 ID 不推测具体最新版本。
格式依据 [arXiv identifier](https://info.arxiv.org/help/arxiv_identifier.html)。

PubMed 使用 `pmid:<id>`，Europe PMC 的 MED 来源映射到同一 PMID。其余 Europe
PMC 记录保留 `<namespace>:<id>`，PMC 与 MED 即使编号相同也不归并。PubMed
查询返回非 MED 来源会在缓存前失败。PMID 不经浮点转换，依据
[NLM PubMed help](https://pubmed.ncbi.nlm.nih.gov/help/) 的稳定唯一标识合同。

## 元数据与审查

主记录按 Crossref、OpenAlex、Semantic Scholar、PubMed、Europe PMC、arXiv 的
固定顺序选择，同一来源再按 rank 和元数据 hash 选择。此顺序决定展示及收录的
主记录，不代表可信度、研究质量或排序权重。收录同时准备所有不同来源观察，
全部成功后才在一个事务写入文库 `sources`，其中 `providerRecord` 保留规范化
之前的原始 Provider 记录；不会因候选快照过期丢失修订记录及其原始 hash。
任何来源准备失败或改变身份均取消该候选的全部写入。

每个候选保存 identity、稳定 candidateId、score、逐来源贡献、全部来源记录、
元数据 hash、来源 rank 和抓取时间。DOI、标题、作者、年份、引用量与访问 URL
不一致时保留冲突值和各自来源。DOI 的大小写/解析 URL 差异不作为冲突。
模型工具返回摘要与冲突预览，不复制全部 Provider 记录；原始元数据仍在受会话、
项目和有效期约束的搜索快照内。模型内容不能升级项目或工具权限。

查询、来源和年份筛选继续保存在请求快照中。年份筛选基于明确选择的主记录；
年份未知时排除并提示。部分来源失败保留状态、失败原因和 Retry-After。所有
来源首个页面全部失败仍是 failed；后页失败且已有候选时返回 partial，保留已验证
页面。不能把空结果解释为成功或穷尽检索。

旧版本搜索快照不转换、不补猜测字段。读取不符合当前合同的快照显式失败。
正式文献、证据和科研历史不随候选有效期删除。

科研数据库 8 对文库身份执行一次性迁移。保留条目 ID、书目、原始 `sources`、
归档状态和项目/附件引用，移除旧唯一身份约束，建立规范身份索引。不同历史条目
落到同一身份时全部保留，查询和收录显式拒绝自动整理，不静默合并。
旧 Europe PMC 的主记录命名空间仅从已保留的准确 article URL 重建，已有来源
metadata 和书目内容仍不改写。旧来源 `providerRecord:null`，不将可能已规范化的
历史数据冒充原始抓取；没有匹配 URL 时迁移失败且整体回滚，不推测 MED。
表替换在事务外临时关闭外键执行，提交前校验所有引用，结束后恢复原设置。
没有旧键回查路径。迁移失败的文库需要补齐真实来源记录后才能升级。

数据库 9 新增声明别名索引，不重写数据库 8 的文库条目。索引从当前主元数据和
真正保留的 `providerRecord` 建立，不推测旧未知来源。收录、候选匹配与文库
查询使用同一身份规则。只有一个匹配条目时，新的 DOI 可提升原无 DOI 条目的
规范身份，保留原条目 ID、引用键、主元数据优先级和来源；之后无 DOI 收录仍
保留已知 DOI。多个历史条目共享别名时显式拒绝自动整理，归档条目也保留身份。
已有不同 DOI 的条目不会因共享来源标识自动合并。
数据库表结构相同也不能补造数据迁移已经执行的账本；缺少对应迁移记录时
显式拒绝，保留原数据与迁移账本。

数据库 10 单独持久化 Provider 标识观察：文库条目、执行 ID、来源、原始 rank、
外部 ID、抓取时间、元数据 hash、原始字典与映射结果。旧数据不补造外部观察。
收录核对原始 Provider 记录及重新映射结果；同一执行/来源/rank 只有一个观察，
相同内容重复收录幂等，不同内容或不同条目冲突会回滚整个候选收录。
仅标识字段提供的 DOI 也同步到规范 metadata、书目 DOI、BibTeX 字段及已有 CSL；
原始来源记录和原始书目仍保留。

`research.library.getIdentifiers` / `research.getLibraryIdentifiers` 分页读取这些
观察，默认 20 条、最多 50 条。候选过期和文库归档不删除观察。普通文库列表
不附带完整原始字典，模型搜索/读回工具也省略字典；模型仍可核对已知映射值。

数据库 11 单独保存候选收录时的审查观察，含执行、来源、排名、原始记录 hash
与观察时间。`research.library.getReviews` / `research.getLibraryReviews` 按同样的
默认 20/最多 50 条分页读取，候选过期或文库归档后仍可读。旧文库不补造类型、
许可或撤稿结论。不同审查内容不能占据同一执行/来源/排名，冲突会回滚收录。

导入弹窗逐候选展示来源、类型、版本、许可、撤稿及更正/更新信息，原生 details
用键盘展开完整来源和字段/身份冲突。来源缺失的状态显示未知，不显示“正常”。
`is_retracted:false` 显示“来源未报告撤稿”，不代表独立核查或永久有效。收录仍
是独立按钮，撤稿信息供人核对，归档条目不能自动恢复。

OpenAlex 保存 type、primary_location 的 version/license/landing_page_url 以及
is_retracted。许可只用于所声明副本，不推广到其他版本，依据
[OpenAlex locations](https://help.openalex.org/data/locations/)。
Crossref 保存 type、license 的 URL/content-version 与 update-to 的目标信息，
依据 [Crossref Swagger](https://api.crossref.org/swagger-docs)。更新关系显示当前
记录更新哪个 DOI，不据此判定当前记录自身已撤稿。arXiv 版本来自实际 entry.id；
其他来源尚未验证的字段保持未知。所有已知字段在缓存前校验。

## 原始问题与确认检索计划

discovery 输出结构化 searchPlan。researchQuestion 必须逐字等于该阶段已保存的
instruction，这是原始研究指令快照，不冒充未经保留的原始聊天逐字记录。
refinedQuestion、keywords、synonyms、domain、excludedTerms 和查询式是模型建议。
queries 最多 3 组，固定 query、sources、limit、maxPages 和需要的年份范围；
总候选上限不能超过该任务的 60 条工具预算。排除项是纳入筛选标准；只有明确
写入具体查询式的条件才由来源执行，不声称 API 自动理解所有计划字段。

discovery 现在使用现有人工闸门。助手审批卡展示原始指令、建议问题、关键词/
同义词、领域、排除项以及每个查询的来源、时间范围、页数和数量。批准携带用户
看到的计划内容 hash；中断恢复重新读取后内容变化，或缺少原 hash，均拒绝批准。
直接 workflow approval 也必须提供对应 expectedSearchPlanHash。失败或无类型的
手工占位策略不能作为计划，旧自动批准状态不代表用户确认。

retrieval 启动前绑定唯一的已批准 search_strategy 工件及内容 hash。该阶段
search_literature 只接收零起始 queryIndex；主进程填写固定查询参数并再次核对，
模型不能改写来源、范围或分页数量。每次实际 HTTP 之前检查工件仍然有效；
计划 superseded 或内容变化后停止下一请求，保留原回执，不发布候选。

搜索快照及执行账本保存策略工件 ID、内容 hash、原始问题、查询编号和实际
批准时刻。普通会话或文献弹窗的直接查询保存 strategy:null，不假称已执行一个
经过用户确认的科研策略。已有正式文献与历史产物不迁移为虚构的新计划。

## Provider 响应合同

六个来源都校验结果容器、论文身份与题名。合法的空数组是空结果；缺失容器、
HTTP 200 错误对象、无身份记录或错误数据类型是来源失败，错误码为
`literature_provider_response_invalid`。不生成随机论文 ID、虚构题名或空成功。
来源可以增加元数据字段，已有必需字段不能消失后仍被接受。

每个来源保存实际 GET 尝试的 URL、分页位置、起止时间、HTTP 状态、Retry-After、
响应原始字节 SHA-256 和传输失败码。重试保留独立回执，等待退避不算作 HTTP
执行时间。HTTP 200 但内容无效时，HTTP 回执保留 200 与响应 hash，来源仍标记
数据失败。并发来源使用各自的请求上下文，不能互换回执。请求过滤条件继续
保存在搜索请求快照中；逐页保存位置、rankOffset、条数、覆盖范围与缓存观察。

OpenAlex 请求使用官方 `per_page` 参数。arXiv 先验证 XML 语法，再校验 Atom
结构；错误 entry 不能成为论文，公开 DOI 则保留到元数据中。Atom 的响应结构、
DOI 扩展与错误 entry 依据
[arXiv API manual](https://info.arxiv.org/help/api/user-manual.html)。
本地 fixture 验证正确、空、缺容器、缺身份、Atom 错误与未闭合 XML；没有把
fixture 覆盖等同于真实 Provider 可用性。

## 持久化执行与请求回执

科研数据库版本 7 新增检索执行与逐来源请求账本。可信入口在开始检索时保存
executionId、会话 owner、项目、执行 runId、冻结请求和 running 状态；发起 HTTP
之前保存 dispatched 回执，读取结束或本地终止后保存 received 回执。received
表示已记录本地结果，HTTP 状态仍可为 null，不表示远端成功。

快照显式关联 executionId。候选快照与执行终态在同一 SQLite 事务提交；
取消、关闭、数据库失败均不发布成功候选。所有并发来源退出并记录结果后才关闭
执行范围，导入服务关闭也等待这些搜索，不让迟到回执写入已关闭数据库。

请求审计写入失败必须抛错。发起前写入失败时不发 HTTP；完成记录失败时已保存
的请求保持 unknown，不能补造 HTTP 200、响应 hash 或完成时间。重启把 running
执行标记 interrupted，把未结束的请求标记 unknown，保留原始回执字节字段与
空结束时间，并拒绝迟到结果覆盖。执行终止时间是本地恢复时间，不是远端请求
实际结束时间。

候选 7 天有效期清理只删除预览。执行身份、原始请求和回执仍保留，不能因取消
或预览过期丢掉实际检索记录。迁移不推测旧快照对应的请求或执行，也不重写旧
候选。当前账本为主进程持久化基础；检查器展示与检索执行读取界面待后续接入。

## 验证与后续范围

当前来源 coverage 保存实际响应声明的 API 命中数、通过校验的页数、分页范围和
后续页标识。OpenAlex 使用 meta.count；Crossref 使用 total-results；Semantic
Scholar 使用 total/next；Europe PMC 使用 hitCount/nextCursorMark；arXiv 使用
Atom totalResults。统计缺失保留 null 与 unknown，并提示统计或终点未经报告；
不以返回条数补造 API 总命中数。

coverage 的 limited 表示当前候选尚未覆盖声明的 API 命中，truncated 同步标记
并提示后续分页。reported_end 仅表示抓取到该响应报告的 API 查询终点；complete
表示本次来源请求成功。学术 Recall、完整领域覆盖和穷尽结论需要独立标注与验证。
非法计数、与页面记录矛盾的计数或超出请求条数的页面是来源失败，HTTP 回执仍保留。
缓存命中保留原始统计、opaque cursor 与响应抓取身份。

`maxPages` 默认 1、最多 3，限制每来源抓取页数；`limit` 限制每页原始条数和
融合后最终候选数。OpenAlex 使用 page，Crossref/arXiv 使用 offset，Semantic
Scholar 使用响应声明的 offset，PubMed/Europe PMC 使用原始 opaque cursor。
查询和每页条数在分页中保持固定，cursor 作为参数编码，不改变主机或查询。
来源返回的 offset 跳跃保留实际排名；即使响应报告终点，收集条数与声明总数
不符时，聚合覆盖为 unknown。不能把缺失区间重新编号为连续排名。

stopReason 区分 reported_end、page_limit、provider_limit、
continuation_unavailable 和 failed。重复 cursor、倒退或重叠 offset 显式拒绝；
Semantic Scholar 下一页越过 1000 条范围时停止，保留未抓取位置。后页 HTTP
或数据失败保留之前的候选和回执。取消期间已有 HTTP 仍记录，候选不发布。
旧来源级 cache 字段已移除；每个页面独立记录 hit/miss，缓存命中不生成请求。
OpenAlex 当前基础 page/per_page 支持范围与 key 要求依据
[OpenAlex paging](https://help.openalex.org/api/paging/)；
Crossref 当前整数统计和 offset/rows 合同依据
[Crossref Swagger specification](https://api.crossref.org/swagger-docs)；
Semantic Scholar relevance search 的分页与范围依据
[Semantic Scholar Graph API](https://api.semanticscholar.org/api-docs/graph)。
Europe PMC 的后续 cursor 与终页省略规则依据
[Europe PMC API release announcement](https://groups.google.com/a/ebi.ac.uk/g/epmc-webservices/c/yG8kMl1R3cI)。

来源共用主机级准入，复用现有 FIFO 资源协调器。每个主机同时只有一个 HTTP
尝试，连接保持到结果校验完成；不同主机可以并行。PubMed 与 Europe PMC 使用
同一 EBI 主机，因此共享连接、配额和冷却。当前五个主机限定应用最多五个活跃
尝试，每次搜索继续分批调度最多三个来源。

应用策略为每主机固定一小时窗口最多 300 次尝试，最短间隔 1 秒，arXiv 为 3 秒。
这是本应用的进程内调用上限，不代表远端剩余额度；重启会重建窗口，其他程序和
机器的调用不在这个计数内。缓存命中和被拒绝的准入不占配额；重试分别占用。
配额耗尽显式报告 `literature_provider_quota_exhausted`，没有虚构 HTTP 回执。

Retry-After 在主机范围生效，包括其他项目的排队请求。Crossref 的响应 rate
limit/interval 只收紧应用间隔，不能扩大本地配额。连续三个 HTTP、传输、超时
或有效载荷失败开启 60 秒断路冷却；到期后允许受同一连接约束的恢复尝试。
只有新的完整校验成功才能恢复健康，旧缓存不能清除失败。用户取消及应用关闭
不计来源故障。排队与退避可取消，取消之后不继续调度该搜索。

快照保存主机、unknown/healthy/degraded/cooldown/quota_exhausted、连续失败数、
本地剩余次数/重置时间、实际最短间隔、冷却截止及最后成功/失败时间。它是该次
结果观察到的应用状态，不是后台轮询的实时服务状态或学术覆盖评分。

arXiv 的单连接和 3 秒要求依据
[arXiv API terms](https://info.arxiv.org/help/api/tou.html)。
Crossref 通用访问页仍有较旧的汇总限额，本实现采用 2026-07-21 发布的 public
list query 1 次/秒要求并观察响应头：
[Crossref query rate limits](https://community.crossref.org/t/refining-rest-api-limits-for-improved-stability-and-reliability/16137)。

应用共享进程内 LRU 响应缓存，最多 32 条、8 MiB UTF-8 响应文本，TTL 为 5 分钟。
缓存键包含可信项目、完整请求 URL（查询和分页参数）与响应格式。只有通过响应
及文献合同校验的结果才写入缓存，失败响应不缓存。导入入口从执行上下文确定
项目并保存请求，模型提供的项目字段不能改变缓存或快照范围。

每页明确记录 cache miss 或 hit。命中保留原始抓取时间及原始字节响应 hash，
该页 HTTP 回执为空，不把缓存读取伪装成新抓取。缓存不写磁盘，插件关闭时清空。
关闭先中断父阶段，再同时关闭检索、导入及原生服务，并汇总清理失败。检索关闭
中断进行中的请求、等待请求退出并拒绝后续读取；迟到角色输出不能发布工件。

确定性回归覆盖来源到达顺序、来源内重复、同分排序、DOI 等价写法、同标题不同
文献、冲突保存、快照读回、独立收录、模型预览、六来源分页、分页上限、
排名缺口、后页失败、逐页缓存/重试回执和分页取消。原生 P0 验证检索/人工收录到
解析、证据、实验、论文和导出的消费者链。

这批不提供学术 Recall@20/nDCG@10。独立标注集尚未建立。Provider 原始请求与
分页回执、有界缓存、进程内配额/健康度、持久化请求账本和确认检索计划已接入。
OpenAlex/Semantic 已验证外部标识归并及候选类型/版本/许可/撤稿/更正/冲突展示
已接入。其他来源未验证字段保持未知；独立检索标注与指标仍待后续增量。

官方合同核对日期：2026-11-03。OpenAlex 当前支持无 key 的基本查询；cursor
翻页需要 key，不能自动创建账号或读取凭证。参数和分页依据
[OpenAlex API](https://help.openalex.org/api/paging/)，认证依据
[OpenAlex Authentication](https://help.openalex.org/api/authentication/)。
Crossref 的缓存、rows/cursor 和退避建议见
[Crossref REST API tips](https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/)。
2026-11-03 另对 Europe PMC 官方示例公开标识发起一次匿名只读请求，确认 6.9
响应包含 hitCount=1、一个记录且终页省略 cursor。原始响应 hash 与脱敏合同记录
保存在 `.artifacts/research-optimization/pr04-coverage-live-contract.json`；随后离线
校验同一响应通过实际适配器。此探测只验证一个响应结构，其他来源仍由本地
fixture 验证；没有真实模型费用调用。
