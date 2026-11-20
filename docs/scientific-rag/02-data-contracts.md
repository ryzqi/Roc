# Scientific RAG 当前数据合同

下表描述已接入生产的合同；字段、上限与 strict 校验以链接源码为准。版本表见[当前实现](00-current-state.md)，当前 Research schema 为 74，v71/v72/v73 的独立离线升级见[数据库存储](../database-storage.md)。完整人工 gold 与公开组件资格见[评测](evaluation.md)。

## 来源与科研对象

| 合同 | 权威源码 | 保证 |
| --- | --- | --- |
| Parsed Document | [research-production.ts](../../src/shared/schemas/research-production.ts) | Parse Contract 4；sourceHash/parserFingerprint、原始 blocks、locations、assets、工件及结构派生信息。 |
| Coordinate Snapshot | [research-document-coordinates.ts](../../src/shared/schemas/research-document-coordinates.ts) | source/parse 与工件绑定；PDF CropBox/rotation/viewport 到 TOPLEFT raster 的投影依据。 |
| Source Locator | [research-source-locator.ts](../../src/shared/schemas/research-source-locator.ts) | 固定 document/parse/knowledgeDocument/block 与来源 hash，原始 locator、UTF-16 span、page/bbox/origin；没有几何时不能从字符串猜坐标。 |
| Paper IR v2 / Artifact | [research-paper-ir-v2.ts](../../src/shared/schemas/research-paper-ir-v2.ts) | schema 2、`roc-paper-ir/2.1`；完整 source identity、metadata、章节/块、table/cell、figure、equation、algorithm、citation/reference、结构关系与质量。工件另外固定路径/hash/size/indexedBlocksHash。 |
| 原 parent/child 标注 | [research-paper-ir.ts](../../src/shared/schemas/research-paper-ir.ts) | 保留旧知识工具所消费的章节角色及邻块关系，与独立 IR v2 工件并存。 |

对象 ID 对 parseId/originalId 分量编码，避免分隔符歧义；cell 和算法 step 仍绑定原对象与同一 parse。表格几何可为 unknown，结构关系可为 candidate；这些状态不能提升成精确原文支持。

## 索引、上下文与知识

| 合同 | 权威源码 | 保证 |
| --- | --- | --- |
| 科研索引代次 | [research-scientific-generations.ts](../../src/shared/schemas/research-scientific-generations.ts)、[scientific-index-repository.ts](../../src/main/plugins/research/scientific-index-repository.ts) | source/parse/IR/chunk/policy 与 embedding 配置身份绑定；building/active/retired/failed/cancelled；候选与当前 active 分开。 |
| 查询计划 / Search | [research-scientific-query-plan.ts](../../src/shared/schemas/research-scientific-query-plan.ts)、[research-scientific-search.ts](../../src/shared/schemas/research-scientific-search.ts) | 项目/论文范围、意图、条件、六通道、候选来源与 ranking snapshot；异步后重新核对实际来源。 |
| Scientific Context | [research-scientific-context.ts](../../src/shared/schemas/research-scientific-context.ts) | snapshotId、候选、所选对象范围/原文/图片身份、budget、实际 usage 与 omissions。默认 12 对象、24 段落、8000 tokens、2 图片、每篇 4 条证据；表格行/cell 与算法步骤按命中合并，超预算不能静默截断选中值、公式或步骤。 |
| 句子证据验证 | [research-scientific-evidence.ts](../../src/shared/schemas/research-scientific-evidence.ts) | 同预算重建上下文并核对身份；quote 精确原文、table_value 原 cell、equation 完整 LaTeX 为窄验证。自由 claim/比较不能自动获得科学支持，inference 保留标记。 |
| Entity / Fact / Relation | [entities](../../src/shared/schemas/research-scientific-entities.ts)、[facts](../../src/shared/schemas/research-scientific-facts.ts)、[relations](../../src/shared/schemas/research-scientific-relations.ts) | 独立类型、原值/normalized/unit、数据集/metric/baseline/split/budget 条件及原始证据；保守身份对齐，不自动合并未知实体。 |
| 抽取任务 / 读取 | [research-scientific-extraction.ts](../../src/shared/schemas/research-scientific-extraction.ts) | 独立 generation 与固定来源/模型 stamp；完整结果事务发布，失败隔离；项目授权读取，来源或配置漂移显示实际状态。 |
| 科研知识搜索 | [research-scientific-knowledge-search.ts](../../src/shared/schemas/research-scientific-knowledge-search.ts) | entity/fact/relation 三种 strict 请求；默认每页 10、最多 20 条完整记录，offset/nextOffset 与 basisDigest 固定分页依据；missing/stale 返回 unavailable，知识保持 unreviewed。 |
| Paper Card Knowledge | [research-paper-card-knowledge.ts](../../src/shared/schemas/research-paper-card-knowledge.ts)、[research-paper-card.ts](../../src/shared/schemas/research-paper-card.ts) | 六节阅读文字与完整科研对象分开；来源/IR/chunk/生成配置指纹约束卡片，已发布抽取 job 绑定对应历史 IR 与 method components。 |
| Wiki Section / Revision | [research-wiki-pages.ts](../../src/shared/schemas/research-wiki-pages.ts) | owner/status、引用、paper knowledge 依赖摘要、不可变 revision、CAS/Basis Digest；human 内容和旧依赖不得覆盖。 |

模型通过已有 source/object/cell/条件句柄选择来源证据；解码后仍执行原业务 schema 和来源验证。Fact 的数值主体、原值及条件均受当前结果行的来源权限约束，详见[Fact 行与条件权限](extraction.md#fact-的行数值与条件权限)。

Fact 预算与 adapter 共用 [scientificExtractionToolSchema](../../src/main/plugins/research/scientific-extraction-model.ts)，以 Zod `reused: 'ref'` 转换并递归保留引用约束。provider wrapper 在 sanitizer 后要求对象根；不支持的根以 `provider_tool_schema_root_unsupported` 拒绝，properties 推导的对象根仍可用，详见[Provider 工具边界](extraction.md#provider-工具-schema-边界)。共享引用不替代业务校验。工具名称与参数见 [scientific-tools.ts](../../src/main/plugins/agent/scientific-tools.ts)。

## 失效与历史保护

| 变化 | 重新执行范围 | 保留 |
| --- | --- | --- |
| PDF source / parser 文字或定位语义 | 新 Parse 及其下游派生链 | 旧原件、parse、Evidence 与 Wiki revisions；旧引用可能 superseded |
| Artifact-only contract | 按实际工件兼容性校验/重建 | 不能仅凭合同数字决定全部重解析 |
| IR 内容 / 来源身份 | 新科研索引、抽取输入及受影响的卡片/Wiki 依据 | 原始 Parse 与历史工件；旧发布知识不自动成为 current |
| 科研 chunk / serializer / policy | 受影响索引及向量候选；IR 与抽取配置不变时不据此重复抽取 | 兼容的原始 Parse、IR 与抽取结果 |
| Embedding revision | 新向量候选与缓存身份 | 兼容来源的旧 active，直到新候选完成 |
| Extractor / Prompt / Model | 新抽取代次、受影响卡片与 Wiki 依据 | 原 Evidence、已发布历史知识与人工内容 |
| Wiki 综合配置或依赖 | 新修订，受影响 assistant 内容 stale/重新综合 | human 正文与旧 revisions |

这些边界由各自输入身份决定：[抽取 input hash](../../src/main/plugins/research/scientific-extraction-repository.ts) 包含 Paper IR receipt、配置和 aliasesHash，不含 index generation；[卡片 fingerprint](../../src/main/plugins/research/paper-card-service.ts) 包含 active IR hash 与通用 `knowledgeChunkVersion`，不能将其与科研 chunk 版本混用；[Wiki 知识摘要](../../src/main/plugins/research/wiki-paper-knowledge.ts) 绑定 IR、抽取代次、alias 及 input/result hash。

失败候选不能覆写 active，但来源变化仍要求消费者拒绝旧上下文。历史知识或 stored receipt 可读不代表当前有效，更不恢复人工审核；批准与导出边界见[证据关系](../research-evidence-relations.md)。
