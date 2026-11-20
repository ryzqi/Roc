# Scientific RAG 当前实现与验收边界

以下依据当前仓库源码与生产注册，描述实现能力和验收条件。具体运行是否具有可用模型、完整输入及科学质量资格，须在目标环境中验证；文档中的能力声明不替代运行结果。专题导航见[目录](README.md)。

## 当前生产能力

| 能力 | 当前实现与边界 | 主要源码（相对仓库根） |
| --- | --- | --- |
| PDF Native / OCR / Mixed | 保存原生文字项、布局区域、融合来源与替代结果；派生阅读顺序、跨页关联、章节树、多角色和页级质量报告。OCR 仍需要完整模型；可选语义分类与 GROBID 补充有独立配置和失败边界。 | `src/main/plugins/research/document-parser.ts`、`src/shared/schemas/research-production.ts` |
| Paper IR v2 | 发布 parse/source 绑定的不可变 IR 工件，含章节、原始块、表格及 cell、图、公式、算法、引用和结构关系；保留原文定位，缺失几何或关系只能明确为 unknown/candidate。 | `src/main/plugins/research/paper-ir-builder.ts`、`src/main/plugins/research/paper-ir-repository.ts` |
| 科研分块与嵌入 | 科研对象分块和确定性 serializer；实际输入、token 预算、配置修订约束缓存与批处理。原 parent/child 知识索引继续供原有工具使用。 | `src/main/plugins/research/scientific-chunks.ts`、`src/main/plugins/research/scientific-text-serializer.ts`、`src/main/plugins/research/embedding-service.ts` |
| 索引代次 | 文献库与项目索引先准备科研及通用索引向量，再核验来源并事务发布；失败候选不覆盖旧 active。保留代次可显式切换，但必须兼容当前来源与配置，不能借此恢复过时 Evidence。 | `src/main/plugins/research/scientific-index-builder.ts`、`src/main/plugins/research/scientific-index-repository.ts`、`src/main/plugins/research/scientific-generation-service.ts` |
| 查询与检索 | 规则多意图计划、精确 DOI/title/ID 选择与固定项目范围；可选有界模型补充。text、metadata、table、equation、figure、citation 六通道在来源快照下检索、融合与可选精排；降级可见，取消传播。 | `src/main/plugins/research/scientific-query-planner.ts`、`src/main/plugins/research/scientific-retrieval-router.ts` |
| 对象上下文与句子验证 | 重建来源快照，按对象、段落、token、图片和每篇预算装配所选命中及完整扩展段落；保留命中行/cell/算法步骤范围，不截断选中值或公式。再次读取及校验来源；精确 quote、原 cell 值、完整 LaTeX 的窄范围验证已接入 Agent，自由主张和比较仍不能自动证明。 | `src/main/plugins/research/scientific-context-assembler.ts`、`src/main/plugins/research/research-scientific-evidence.ts`、`src/main/plugins/agent/scientific-tools.ts` |
| Entity / Fact / Relation | 三阶段结构化抽取、原始对象/单元格/条件证据验证；持久后台任务、独立抽取代次、来源与模型配置复核、原子发布、恢复、显式重试/取消、项目授权读取。输出是未审核科研知识，不能替代人工科学决定。 | `src/main/plugins/research/scientific-extraction-service.ts`、`src/main/plugins/research/scientific-extraction-pipeline.ts`、`src/main/plugins/research/scientific-fact-wire.ts` |
| Paper Card / Wiki | 六节阅读卡片与独立完整科研知识对象；卡片指纹包括来源/parse/IR/chunk 与生成配置。Wiki 依赖抽取代次摘要，保留不可变 revision、人类正文、CAS 与 stale 传播；支持科研 topic、比较与知识搜索。 | `src/main/plugins/research/paper-card-service.ts`、`src/main/plugins/research/wiki-repository.ts`、`src/main/plugins/research/wiki-scientific-synthesis.ts` |
| 可选视觉能力 | 显式配置的本地视觉索引、多向量检索及来源绑定的图像解释；独立模型、环境、资产和代次校验。图像解释保持未审核，原 PDF/图仍是核查依据。 | `src/main/plugins/research/visual-index-service.ts`、`src/main/plugins/research/figure-understanding-service.ts` |
| 运行与资源 | 生产注册连接上述服务；处理 trace、持久任务、计算准入、取消、资源观测与关闭释放已有实现。日志中的观测与缺失值不能转换成科学正确性或完整成本证明。 | `src/main/plugins/research/research-plugin-production.ts`、`src/main/plugins/research/research-plugin-knowledge.ts` |

科研能力继续位于唯一项目壳、助手及文献画布；没有新增独立阶段页面。界面与路由见[科研工作台](../research-workbench.md)，使用合同见[RAG 与 Wiki](../research-rag-wiki.md)。

## 当前版本

| 项目 | 值 | 权威源码 |
| --- | --- | --- |
| Research DB schema | 74 | `src/main/infrastructure/database-schemas.ts` |
| Parse Contract | 4 | `src/shared/schemas/research-production.ts` |
| Derivation Generation / Parser | 10 / `roc-research-parser/10` | `src/shared/schemas/research-production.ts` |
| Paper IR | schema 2 / `roc-paper-ir/2.1` | `src/shared/schemas/research-paper-ir-v2.ts` |
| Scientific chunks | `roc-scientific-chunks/1` | `src/main/plugins/research/scientific-chunks.ts` |
| Scientific context | `roc-scientific-context/1` | `src/shared/schemas/research-scientific-context.ts` |
| 抽取 Prompt | `roc-scientific-extraction-prompts/25` | `src/main/plugins/research/scientific-extraction-model.ts` |

IR、chunk、索引、抽取、卡片与 Wiki 的代次有各自身份，不能用一个 parser 版本替代全部失效判断。数据库启动拒绝不兼容旧库；v71/v72/v73→74 使用独立离线迁移，详见[数据库存储](../database-storage.md)。

Provider 工具在递归 sanitizer 后要求 `type: 'object'` 根；未支持的纯引用/组合根、标量和可空根在 dispatch 前返回 `provider_tool_schema_root_unsupported`。从 properties 推导的对象根仍支持，嵌套引用与可空字段保留。源码与工程回归入口见[抽取模型的工具边界](extraction.md#provider-工具-schema-边界)。

## 科学验收条件

完整质量结论须满足[科学评测资格](evaluation.md)：原始 PDF 与完整标注、独立审核、冻结任务和真实运行缺一不可。公开组件标签、工程 fixture 与完整科研质量评测各有范围，不能相互替代。

下列范围必须取得对应证据后才可声明验收完成：

- **E / Reranker**：使用可用真实配置，在相同候选集上取得配对 transport、排序、预算及失败测量。词法降级不能证明 reranker 收益。
- **G / Fact**：完成真实抽取和 active publication，并取得独立完整 Entity/Fact 参考。有限定性参考只能支持其标注范围，不能生成全文 Fact F1。
- **H / Wiki**：取得实际综合正文、当前修订及 Fact/原始证据依赖，独立检查事实覆盖与支持。页面外壳不能替代正文验收。
- **I / Complete**：先满足所依赖组件的前提，再取得同条件整链路、最终答案、额外主张、拒答及真实项目的完整评分。

任一前提未满足时，相应范围保持未验收；不能从一次失败推断当前环境缺配置，也不能从一次成功推断完整质量达标。新的验证先核对[脚本与输入限制](evaluation.md#可用入口与输入限制)，准备被脚本实际消费的完整来源和新输出。性能、provider 延迟及费用需要各自的真实测量。
