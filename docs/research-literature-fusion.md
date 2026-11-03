# 学术检索融合

检索保存候选快照。只有独立的收录操作才修改文献库；候选不代表已读论文、
已验证证据或完整学术覆盖。

## 冻结排序合同

当前快照版本为 3，排序方法为 RRF v1：

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

## 验证与后续范围

确定性回归覆盖来源到达顺序、来源内重复、同分排序、DOI 等价写法、同标题不同
文献、冲突保存、快照读回、独立收录和模型预览。原生 P0 验证检索/人工收录到
解析、证据、实验、论文和导出的消费者链。

这批不提供学术 Recall@20/nDCG@10。独立标注集尚未建立。Provider 原始请求与
首页回执已保留。后续分页、缓存/配额/健康度、取消时的独立持久化请求账本、
完整文献类型/版本/许可/撤稿展示仍待后续增量。

官方合同核对日期：2026-11-03。OpenAlex 当前支持无 key 的基本查询；cursor
翻页需要 key，不能自动创建账号或读取凭证。参数和分页依据
[OpenAlex API](https://help.openalex.org/api/paging/)，认证依据
[OpenAlex Authentication](https://help.openalex.org/api/authentication/)。
Crossref 的缓存、rows/cursor 和退避建议见
[Crossref REST API tips](https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/)。
本批仅核对文档并使用本地响应 fixture，没有发起真实检索或费用调用。
