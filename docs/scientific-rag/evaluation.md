# 科学评测资格与运行前提

科学验收需要独立参考、冻结输入、真实运行和可重建的评分。源码存在、工程测试通过、公开组件可运行或来源字符串一致，都不能单独建立完整科研质量结论。通用 CLI、隔离、预算、封存和安全续跑见[评测指南](../../evaluation/README.md)，[实验比较与采用](../../evaluation/README.md#实验比较与采用)及[验证方法](../../evaluation/README.md#验证方法)由该指南统一维护；开发检查见[开发指南](../development.md)。

## 三种证据范围

| 范围 | 可支持的结论 | 需要另外准备 |
| --- | --- | --- |
| 工程 fixture / 离线回放 | schema、来源拒绝、预算、取消、恢复、发布原子性、引用保留等受控行为 | 真实模型、独立语义参考、真实项目与资源测量 |
| 公开组件评测 | 明确来源、版本、cohort 和标签范围内的 Parser/检索/Wiki 等组件观察 | 完整 PDF 定位、缺失类别、全文 Entity/Fact 库存及最终答案判断 |
| 完整科学质量评测 | 符合任务资格的质量、拒答和受控配对收益 | 完整来源与审核、所有选定 case 的真实执行、独立评分及预先确定的验收阈值 |

公开人审标签保留其上游 provenance。Agent review 必须标明身份，不能写成人审；机械文本匹配、图像对应候选和字符完全相同不能自动提升为人工认可的语义支持或精确 glyph 定位。

## 完整 corpus 资格

权威输入为 [corpus](../../evaluation/corpora/scientific-rag/README.md)，校验实现在 [scientific-rag-corpus.mjs](../../evaluation/lib/scientific-rag-corpus.mjs)。

| 论文类别 | 最少唯一来源数 |
| --- | --- |
| two-column | 10 |
| single-column、formula-heavy、table-heavy、figure-heavy、scanned、mixed-language、long-appendix | 每类 5 |

| Query 类别 | 最少题数 |
| --- | --- |
| paper-qa | 50 |
| method-equation、table-results | 每类 40 |
| cross-paper | 30 |
| figure、unanswerable | 每类 20 |

资格要求至少 45 篇唯一 sourceHash 的原始 PDF、200 题及对应完整结构标注。PDF 必须可读、hash 一致并有来源和使用许可；标注覆盖实际页面，包含原文、阅读顺序、对象及原始定位。基于捕获 parse 的标注要绑定 parse identity；直接基于 PDF 的 `parseRef` 可为 null。

人审记录需至少两名不同于 producer 的独立 reviewer，内容摘要与当前标注一致；判定不一致时需独立仲裁。无答案题须有审核后的理由；gold 不得从待测 extractor 或候选答案补全。完整配额、审核与证据要求未满足时，不取得 qualified baseline。

仓库根的只读资格检查：

```sh
pnpm evaluation:scientific-rag:check
pnpm evaluation:scientific-rag:check --corpus /absolute/path/to/manifest.json
```

exit 0 表示输入合格，exit 2 表示缺失或无效；该命令不调用模型，也不生成质量成绩。是否满足资格以当前提供的 manifest 检查为准，不能用旧运行记录推断当前配置或用户数据库。

## 任务与评分

| 层 | Task Spec | 需独立取得的参考与指标 |
| --- | --- | --- |
| Parser | [scientific-parser](../../evaluation/tasks/scientific-parser/Task.md) | 全文转录、region 类别/bbox 与阅读顺序；CER/WER、Layout F1、Reading Order |
| IR / Objects | [scientific-objects](../../evaluation/tasks/scientific-objects/Task.md) | 完整对象与精确 locator、表格网格/合并、LaTeX；对象召回、Cell Exact Match、TEDS、规范化公式匹配 |
| Retrieval / Context | [scientific-retrieval](../../evaluation/tasks/scientific-retrieval/Task.md) | 完整分级相关证据、保存排名与实际读取；Recall@5/10/20、MRR@10、nDCG@10、Span Recall、Locator Accuracy |
| Extraction | [scientific-fact-extraction](../../evaluation/tasks/scientific-fact-extraction/Task.md) | 全文实体与原子 Fact、全部适用条件及支持区域；Entity F1、Fact F1、Evidence Coverage |
| Wiki | [scientific-wiki](../../evaluation/tasks/scientific-wiki/Task.md) | 独立事实集合、实际综合正文、原文引用与依赖变化；Fact Coverage、Citation Validity、Stale Propagation |
| E2E | [scientific-e2e](../../evaluation/tasks/scientific-e2e/Task.md) | 真实 Agent 最终答案、全部主张、实际工具读取、无答案参考；Correctness、Faithfulness、Evidence Recall、Correct Refusal |

Task Spec 描述验收合同；是否有可运行 suite 以 [registry](../../evaluation/lib/registry.json) 为准。完整 scientific-* 任务不能仅因规格存在而当作已注册、已执行或已通过。

排名命中与实际 context 读取分别计分；完整证据跨度按唯一来源区间求并，重复命中不重复得分。未定位证据保持缺失原因，无答案题不混入正例 Recall 分母。表格树、距离、公式 normalization 与匹配规则需固定版本；来源绑定、投影或部分字符串重叠不能替代完整证据。

Fact 参考包含类型、subject、predicate、object/value、单位、dataset/version、split、metric、baseline、预算和其他适用条件。缺失标注是 unknown，显式 inapplicable 不是通配符。Entity 与 Fact 使用独立的一对一匹配，重复预测不能重复计 TP；单篇或定性完整子集只能报告该范围，不能外推全文 Fact F1 或数值覆盖。

失败作业与未发布结果保留在适用分母；有 gold 而无预测时 recall 为零，不能把中间候选当成已发布知识。结构失败与语义误报分开记录。没有 gold 的类别为 NA，缺少独立判定的科学指标为 null 并说明原因。

答案需同时判断参考要求覆盖和模型额外主张。精确引文不证明全答案 entailment；局部要求满足不能抵消额外错误。无答案标签一致性、明确拒答、来源语义不可回答性分别报告；未决保留，不能根据待测答案改写冻结标签。Token overlap 仅可作为标明范围的辅助指标。

## Baseline / A–I 配对条件

执行前锁定同一 PDF、问题、参考、代码、Parser/IR/索引、模型配置、权限、预算、超时、重复次数及评分规则。每个实验只改变声明变量，保留全部选定样本、错误和取消；不得从不同 cohort 或不同历史运行相减得到收益。

| 组 | 允许变化 | 资格与必要观察 |
| --- | --- | --- |
| Baseline | 冻结基线实现 | 与候选组同条件的实际运行；通用文本路径不自动等于完整改造前系统 |
| A | Parser 融合 | 同源 PDF 与独立全文解析 gold；不能以保存 IR 回放冒充重跑 OCR |
| B | Paper IR | 固定 Parser 输出与对象参考，区分结构传递和识别收益 |
| C | 结构分块 | 固定来源和预算；若同时改 token budget，单列该实验 |
| D | 多类型检索 | 固定 Parser/IR/Chunk/embedding，分类型比较实际排名 |
| E | Reranker | 可用真实配置、相同候选集、冻结输入、实际 transport/排序及失败记录 |
| F | Context Assembly | 固定排名、上下文预算与回答模型，记录实际读取和遗漏 |
| G | Fact Retrieval | 完整真实抽取、active publication、独立完整实体/事实参考及检索观测 |
| H | Wiki Integration | 实际综合正文、当前 revision、Fact/原始证据依赖及独立支持判断 |
| I | Complete | E/G/H 等前提齐备，同条件整链路、最终答案/拒答评分及真实项目验收 |

E/G/H/I 的正式质量结论仍需上述测量与独立参考。若没有实际 reranker 调用、只有空知识/未发布候选、只有 Wiki 页面外壳，或缺最终答案判断，则相应范围保持未验收。不能将词法降级、工程配对或一次超时解释为相应质量实验完成，也不能据此推断当前用户环境缺配置。

真实项目启用须分别记录隔离项目、已授权实际项目、多论文项目和扩大范围，核对原 PDF、旧 Evidence 和不可变 Wiki revisions，并演练失败、回退及兼容代次切换。工程示例项目不代替真实项目验收。

## 可用入口与输入限制

| 入口 | 使用前提与边界 |
| --- | --- |
| [score-scientific-pdf.mjs](../../scripts/score-scientific-pdf.mjs) | 必须提供 `--run`、`--source-root`、`--output`；gold 模式可传 `--manifest`，`--observe` 与 manifest 互斥。observe 保留未知质量，不建立完整 baseline。 |
| [benchmark-scientific-public-pdf.mjs](../../scripts/benchmark-scientific-public-pdf.mjs)、[verify-scientific-public-pdf.mjs](../../scripts/verify-scientific-public-pdf.mjs) | 准备真实原 PDF、对应模型/配置和新的输出；独立回读范围限于实际输入与已实现指标。 |
| [scientific-query-binding.mjs](../../evaluation/lib/scientific-query-binding.mjs)、[scientific-evidence-resolution.mjs](../../evaluation/lib/scientific-evidence-resolution.mjs)、[scientific-evidence-scoring.mjs](../../evaluation/lib/scientific-evidence-scoring.mjs) | 显式绑定问题与请求；按 source/parse/版本解析精确块和完整证据范围。解析失败不提升为有效对应。 |
| [run-scientific-agent-pilot.mjs](../../scripts/run-scientific-agent-pilot.mjs) | 需真实 provider、授权项目/工具、完整输入和预算。诊断成功不自动取得最终答案验收资格。 |

绑定已丢失历史快照或不存在 Git 基线的专项脚本已移除，包括旧 Parser/IR 回放、typed retrieval/context 对照、GROBID 阶段对照及桌面演练准备。新实验须重新冻结输入与基线，不能据保存摘要恢复原运行。

其他 `benchmark/verify/check-scientific-*` 脚本也应先阅读参数及输入。源码入口存在不保证运行数据、模型或原始请求仍可取得。任何重放都须具备被消费的原字节、摘要、失败记录和完整依赖；仅有汇总 JSON 或旧 hash 不足以独立重评分。

## 性能、成本与复验

性能报告区分解析、索引、检索、上下文、模型 transport、桌面渲染与完整 ingestion。固定设备、并发、缓存模式和输入，保留 P50/P95、RSS、实际样本及失败；fixture 向量能测吞吐，不能测语义 Recall。连接冷启动不能写成 OS cache 清空。

持续解析资源入口为 [benchmark-scientific-sustained.mjs](../../scripts/benchmark-scientific-sustained.mjs)，结果用[独立 verifier](../../scripts/verify-scientific-resources.py) 的 `--sustained` 模式核验；检索预算见[性能协议](../research-performance-protocol.json)。先确认实际输入、模型与测量范围，不能把旧测量当当前设备承诺。

费用需要真实 provider usage 与可信计价，未知值为 null。重复运行固定输入与评分版本，确定性输出应一致；延迟/RSS 使用实际样本，不要求逐位相等。质量、各类别不劣、错误来源上限及资源阈值须在比较前确定；未测项目保持未验收。
