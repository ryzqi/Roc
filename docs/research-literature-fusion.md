# 学术检索融合

检索保存候选快照。只有独立的收录操作才修改文献库；候选不代表已读论文、
已验证证据或完整学术覆盖。

## 冻结排序合同

当前快照版本为 7，排序方法为 RRF v1：

```text
score(paper) = sum(1 / (60 + source_rank(paper)))
```

所有选中来源的权重为 1。rank 是来源响应内原始的一基位置。同一来源出现同一
论文多次时，只用第一次的 rank 贡献一次分数，全部元数据记录仍然保留。来源请求
完成顺序与用户选择来源的顺序不改变排序；改变来源内部排名则会改变贡献。
同分按规范化文献 identity 的 UTF-16 码元顺序排序，不依赖操作系统 locale。

当前归并依据是规范化 DOI；没有 DOI 时采用来源与外部 ID。标题相同或近似不
构成归并依据。arXiv/PMID 跨来源别名与预印本/正式版关系属于后续身份工作，
当前不能声称已经解决。

## 元数据与审查

主记录按 Crossref、OpenAlex、Semantic Scholar、PubMed、Europe PMC、arXiv 的
固定顺序选择，同一来源再按 rank 和元数据 hash 选择。此顺序只决定展示和收录的
元数据，不代表可信度、研究质量或排序权重。

每个候选保存 identity、稳定 candidateId、score、逐来源贡献、全部来源记录、
元数据 hash、来源 rank 和抓取时间。DOI、标题、作者、年份、引用量与访问 URL
不一致时保留冲突值和各自来源。DOI 的大小写/解析 URL 差异不作为冲突。
模型工具返回摘要与冲突预览，不复制全部 Provider 记录；原始元数据仍在受会话、
项目和有效期约束的搜索快照内。模型内容不能升级项目或工具权限。

查询、来源和年份筛选继续保存在请求快照中。年份筛选基于明确选择的主记录；
年份未知时排除并提示。部分来源失败保留状态、失败原因和 Retry-After。所有
来源失败仍是 failed，不能把空结果解释为成功或穷尽检索。

旧版本搜索快照不转换、不补猜测字段。读取不符合当前合同的快照显式失败。
正式文献、证据和科研历史没有被删除或重写。

## Provider 响应合同

六个来源都校验结果容器、论文身份与题名。合法的空数组是空结果；缺失容器、
HTTP 200 错误对象、无身份记录或错误数据类型是来源失败，错误码为
`literature_provider_response_invalid`。不生成随机论文 ID、虚构题名或空成功。
来源可以增加元数据字段，已有必需字段不能消失后仍被接受。

每个来源保存实际 GET 尝试的 URL、首页位置、起止时间、HTTP 状态、Retry-After、
响应原始字节 SHA-256 和传输失败码。重试保留独立回执，等待退避不算作 HTTP
执行时间。HTTP 200 但内容无效时，HTTP 回执保留 200 与响应 hash，来源仍标记
数据失败。并发来源使用各自的请求上下文，不能互换回执。请求过滤条件继续
保存在搜索请求快照中；本版记录首页请求，不声明抓取了后续页面。

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

快照版本 6 显式关联 executionId。候选快照与执行终态在同一 SQLite 事务提交；
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
非法计数、与首页记录矛盾的计数或超出请求条数的页面是来源失败，HTTP 回执仍保留。
缓存命中保留原始统计、opaque cursor 与响应抓取身份。

这批只记录首页与后续标识；实际抓取后续页待下一增量。OpenAlex 当前基础
page/per_page 支持范围与 key 要求依据
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

来源明确记录 cache miss 或 hit。命中保留原始抓取时间及原始字节响应 hash，
本次 HTTP 回执为空，不把缓存读取伪装成新抓取。缓存不写磁盘，插件关闭时清空。
关闭先中断父阶段，再同时关闭检索、导入及原生服务，并汇总清理失败。检索关闭
中断进行中的请求、等待请求退出并拒绝后续读取；迟到角色输出不能发布工件。

确定性回归覆盖来源到达顺序、来源内重复、同分排序、DOI 等价写法、同标题不同
文献、冲突保存、快照读回、独立收录和模型预览。原生 P0 验证检索/人工收录到
解析、证据、实验、论文和导出的消费者链。

这批不提供学术 Recall@20/nDCG@10。独立标注集尚未建立。Provider 原始请求与
首页回执、有界缓存、进程内配额/健康度与持久化请求账本已保留。后续分页、
完整文献类型/版本/许可/撤稿展示仍待后续增量。

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
