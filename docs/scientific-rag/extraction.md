# 科研知识抽取与 Wiki

生产抽取从不可变 Paper IR 提出 Entity、Fact、Relation，经原文与来源校验后以独立 generation 发布。`source_validated` 只表示工程来源校验成立，所有生成知识仍为 `scientificApproval: unreviewed`。科学质量资格见[评测](evaluation.md)，完整字段见[数据合同](02-data-contracts.md)。

## 任务与发布

[scientific-extraction-service.ts](../../src/main/plugins/research/scientific-extraction-service.ts) 是顺序后台所有者，负责排队、来源订阅、模型配置检查、恢复、重试、取消和读取授权。[repository](../../src/main/plugins/research/scientific-extraction-repository.ts) 分别记录任务状态与 active/retired 发布状态：

- 输入身份包含来源/parse/IR、抽取器、prompt、模型修订和显式 alias 字典。单独更新 embedding/index generation 不触发同输入的重复抽取。
- 相同输入的成功、失败、取消任务默认去重；重试通过显式操作生成新代次。启动恢复未完成任务并保留 attempts。
- 每次模型调用前后检查来源与配置，发布事务再次验证项目归属、原始候选、实体引用、alias 目标和当前输入。完整结果成功后才替换 active；失败、取消及过期输出不能部分发布。
- 历史读取仍重新授权项目成员关系；来源或配置不再匹配时返回 stale 等实际状态，历史对象可读不等于当前有效。
- 关闭等待后台调用及模型构造结束。AbortSignal 约束调用和晚返回，但协作取消不等于能硬性抢占不响应的 provider。

能力 `scientificRead`、`extractionEnqueue`、`extractionJobs`、`extractionRetry`、`extractionCancel` 均在 `research.knowledge` 下，参数由[共享 schema](../../src/shared/schemas/research-scientific-extraction.ts)和[生产注册](../../src/main/plugins/research/research-plugin-knowledge.ts)定义。凭据、endpoint、原始私有错误和模型 options 不作为 renderer 可读配置快照；安全身份与 revision digest 用于失效判断。

## 三阶段与完整输入

[scientific-extraction-pipeline.ts](../../src/main/plugins/research/scientific-extraction-pipeline.ts) 先完成全部 Entity 批次，再处理 Fact，最后处理 Relation。Paper 元数据由程序确定；模型只提出局部 ID，主机生成可追溯的跨批次身份。

[scientific-extraction-batches.ts](../../src/main/plugins/research/scientific-extraction-batches.ts) 让结构对象与关联上下文独立成批，完整表格保留所有行列、cell、合并跨度、表头、caption 与脚注；公式保留完整 LaTeX。正文只按连续 UTF-16 原文范围划分，不拆代理对。完整对象、完整序列化输入、批次数和调用预算分别校验；不能截断对象后宣称完整抽取。

[scientific-extraction-model.ts](../../src/main/plugins/research/scientific-extraction-model.ts) 从实际模型 context/output 计算可用输入，输入上限 64000、批次上限 8000，创建模型时请求输出上限 6000。每次预检包括 messages、实际工具 schema、名称与 framing 预留；超预算明确失败。

结构化输出包含原响应元数据。`finish_reason=length` 或 `stop_reason=max_tokens` 导致 `research_scientific_extraction_output_budget_exceeded`；无效输出导致 `research_scientific_extraction_output_invalid`。外形合法的部分响应不能作为完整结果发布。未返回 response 的超时不能推断 finish reason、模型候选或科学正确性。

## 选择来源与实体

[scientific-extraction-input.ts](../../src/main/plugins/research/scientific-extraction-input.ts) 为本批次提供原文、对象、cell 和 token 句柄，解码后恢复原始 proposal，再执行原业务 schema 和来源验证。选择域缩小模型可输出的值，不能替代主机校验。

[scientific-entity-extractor.ts](../../src/main/plugins/research/scientific-entity-extractor.ts) 支持 Paper、Method、Model、Dataset、Metric、Experiment、Baseline、Equation、Figure、Table、Algorithm：

- Equation/Figure/Table/Algorithm 选择本批次真实 objectId，原编号、完整公式和来源由主机重建。
- 其他名称与 aliases 选择证据中的连续 token 范围，保留原印刷文本、大小写、标点和空白。
- 同名或相似不能自动跨来源合并。只有显式 alias 字典及目标项目、类型、名称、发布状态一致时才允许对齐；冲突保持可见。

Relation 限于 `PROPOSES`、`USES`、`EVALUATES_WITH`、`CONTAINS`，检查端点类型及本批次实际提供的 Entity/Fact。原对象 ID 与 Entity ID 属于不同身份空间。

## Fact 的行、数值与条件权限

[scientific-fact-wire.ts](../../src/main/plugins/research/scientific-fact-wire.ts) 根据当前批次和已提供实体构造模型选择域；[scientific-fact-validator.ts](../../src/main/plugins/research/scientific-fact-validator.ts) 独立重建真实来源和实验结果范围。论文中看得见某个词，不代表该词可作为任意结果的条件。

| 字段 | 当前约束 |
| --- | --- |
| 非数值 Fact | 证据必须在当前批次；subject/object 只可引用已提供 Entity 或 null，不能用 Table 等 objectId 代替。 |
| 数值位置与 raw | 必须选择真实 table/零起始 row/数值 cell，raw 保持该 cell 完整原值；表头、主体标签和相邻行不能替代。复合数值整体保留，不因可选就推断 normalized 已知。 |
| 数值主体 | 只能选当前结果行许可的 Method/Model/Baseline/Experiment，并有同行或跨行合并 anchor 的原名称证据；没有适格主体时为 null。 |
| Dataset / Baseline 条件 | canonicalName 必须出现在结果行 condition cells 或完整落入 linkedTextRanges 的原文。整体对象、metadata、未关联正文及其他行不授权该条件。 |
| Metric 条件 | 除同行/关联原文外，只可额外使用对应结果列的显式 header cells。视觉上的首行文字不自动成为表头。 |
| 字符串与 other 条件 | 从该行允许来源中选择连续原 token 范围；列头不能借 other 键绕过 metric 权限。没有支持的 other 键应省略。 |
| 已知与未知 | 每个已知条件必须有同 field/key 的唯一证据项，并支持实际选值。null、固定字符串 `unknown` 不带条件证据；不允许孤立、重复或无关证据。 |

[scientific-fact-condition-tokens.ts](../../src/main/plugins/research/scientific-fact-condition-tokens.ts) 使用 `{sourceId, firstToken, lastToken}`，token 下标从 0 开始，lastToken 包含在内。主机保留精确 UTF-16 原文、标点、空白和断词连字符；范围选择后仍核对相同来源和字段支持。`other.__proto__` 等无法原样表示的键拒绝，不能静默丢失条件。

数值保存 raw、normalized、rawUnit、unit 和 unitEvidence；只有支持的数值表达与真实单位来源才规范化。未知保持 null/unknown。原值、身份和条件验证都不能证明结论真实或跨论文可比。

## Provider 工具 schema 边界

Fact 预算预检与实际 adapter 共用 `scientificExtractionToolSchema`，以 `reused: 'ref'` 生成 JSON Schema，保留共享引用与嵌套约束。返回值仍经 Zod、codec、proposal 和原文校验。

[provider-tool-json-schema.ts](../../src/main/services/provider-tool-json-schema.ts) 在递归 sanitizer 后要求根 `type === 'object'`。不支持的纯引用/引用组合根、标量及可空根在 dispatch 前抛出 `provider_tool_schema_root_unsupported`；从 properties 推导的对象根可用，嵌套引用和可空字段继续保留。这不是任意 JSON Schema 的通用认证器。

[OpenAI-compatible wrapper](../../src/main/services/langchain-openai-compatible-models.ts) 先转换 structured tools，再检查对象根；流式路径在检查后注册取消监听，并在 finally 清理。[模型工厂](../../src/main/services/langchain-model-factory.ts) 的 Anthropic 路径检查转换前后工具数量及输出 schema，防止工具被静默过滤。

本地传输回归入口为 `node --test tests/unit/provider-tool-json-schema.test.mjs`（仓库根）。它使用本地 HTTP fixture，不构成真实模型质量评测；工程检查选择见[开发指南](../development.md)。

## Paper Card、Wiki 与比较

[paper-card-service.ts](../../src/main/plugins/research/paper-card-service.ts) 保留六节阅读卡片；[Paper Card Knowledge](../../src/shared/schemas/research-paper-card-knowledge.ts) 独立提供完整科研知识和原对象。卡片版本包含来源、parse/IR/chunk 和生成配置，不能用卡片摘要代替完整 Fact 库存。

[wiki-scientific-synthesis.ts](../../src/main/plugins/research/wiki-scientific-synthesis.ts) 消费 current、published、active 的知识及对象，知识条目须为 `source_validated`。模型只选择本次提供的 Fact/Entity/Relation/Object 引用或 unknown，精确返回请求的章节 ID；主机依据原记录确定性构造正文。Fact 的依赖闭包保留相关实体、条件与单位证据及原表，Relation 还带关联 Fact；闭包整体纳入或省略，不缩短对象与条件以适应预算。

一次综合最多 3 节，每个目标最多考察 80 个候选，输入最多纳入 120 个闭包条目。[wiki-synthesis.ts](../../src/main/plugins/research/wiki-synthesis.ts) 将输入预算设为 `min(12000, contextWindowTokens - maxOutputTokens - 512)`，预检包含 messages、工具 schema 和 framing；创建模型时请求输出上限 4000。生成正文每节超过 6000 个 UTF-16 code units 时返回 `wiki_scientific_section_budget`。来源不足保留 unknown；[topic/比较模板](../../src/main/plugins/research/wiki-scientific-pages.ts) 分别创建 9/3 个 assistant stale 章节，创建页面本身不代表综合已完成。

[wiki-repository.ts](../../src/main/plugins/research/wiki-repository.ts) 按来源 document 记录 `paper_knowledge` 依赖，使用[知识摘要](../../src/main/plugins/research/wiki-paper-knowledge.ts)绑定 IR、抽取代次、alias 及 input/result hash。它传播失效并保留不可变 revision、human 正文和 CAS/Basis Digest。重新综合只允许 stale assistant 章节，合并请求取消、服务关闭和 60 秒超时信号；模型返回后重读 PDF/IR、复核来源与修订/依据，再事务发布。公共保存入口重新构造并校验科研正文，assistant 不能移除已有 `scientificStatements` 来绕过校验。

[wiki-scientific-comparison.ts](../../src/main/plugins/research/wiki-scientific-comparison.ts) 核对论文覆盖、显式 Dataset/Metric/Baseline 身份、版本、split、metric 定义、单位、预算、其他条件和已记录数值。未知或不同返回 `not_directly_comparable`；同名不等于同实体，即使 `conditions_match` 也不等于科学批准或模型优越性。

科研 topic、比较、知识搜索和阅读界面复用唯一项目壳及原文定位。Wiki 导航命中只能引导读取来源，不能充当事实证据；批准和导出仍遵守[Evidence/Claim 关系](../research-evidence-relations.md)。

## 类型化知识搜索与分页

`research.wiki.knowledge.search`（preload：`research.searchWikiKnowledge`）读取已发布科研对象。[共享 schema](../../src/shared/schemas/research-scientific-knowledge-search.ts) 定义三种 strict 请求：

| kind | 筛选与返回 |
| --- | --- |
| entity | entityTypes、原始/解析后名称及显式 aliases；返回完整 Entity，保留 candidate 身份。 |
| fact | factTypes、methodId（Method/Model 主体或客体）、datasetId、metricId、baselineId、datasetVersion、split；返回完整 Fact 及相关 Entity。 |
| relation | relationTypes、任一端 entityId 或有方向的 fromEntityId/toEntityId；返回完整 Relation 与端点 Entity。 |

[查询实现](../../src/main/plugins/research/scientific-knowledge-search-query.ts) 对名称做 NFKC、小写及 trim，完整名称匹配优先于子串匹配；所有用户值以参数绑定。分页默认 limit 10、上限 20，使用 offset/nextOffset。后续页应携带上一页 `basisDigest`；[抽取服务](../../src/main/plugins/research/scientific-extraction-service.ts) 将选择条件、当前索引/抽取发布、aliases 和模型 stamp 纳入摘要，依据变化时拒绝并返回 `research_scientific_search_basis_changed`。

显式 documentIds 即使尚未入索引也先核验项目授权；空列表按当前索引目录选择。返回前重新读取原始来源字节，并执行最终文件、成员关系、发布和配置检查。缺少抽取或来源/配置过期通过 `unavailable` 返回 documentId、missing/stale 及 configurationError；它覆盖本页读取目标及显式指定文档，不是全项目状态清单。命中保留完整值、单位、条件与证据，`scientificApproval` 始终为 unreviewed。

[Agent Wiki 工具](../../src/main/plugins/agent/wiki-tools.ts) 以 `research_wiki_search_entities`、`research_wiki_search_facts`、`research_wiki_search_relations` 暴露相同合同；后续回答仍需读取原文并经过科研上下文和证据验证。
