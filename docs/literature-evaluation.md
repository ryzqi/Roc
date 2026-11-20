# 文献检索与获取评测方法

本文维护可复用的捕获、标注与测量方法。产品行为分别见[检索融合](research-literature-fusion.md)和[自动入库](research-literature-acquisition.md)，通用环境与检查见[开发与检查](development.md)，统一评测框架见[评测指南](../evaluation/README.md)。工程 fixture、真实公网捕获和独立人工评价提供不同证据，不互相替代。

## 冻结范围与比较设计

仓库的[公开种子集](../evaluation/corpora/literature-acquisition-v1.json)包含七主题、每主题三个查询和共 13 篇 OA arXiv 论文：Multi-Agent Security、LLM Agent Memory、Agent Runtime Reliability、RAG / Agentic RAG、Deep Research、LLM Evaluation、Multimodal Agent。它声明 `unlabeled_seed_set`；这些数量描述输入设计，不是通过数或相关性结论。

捕获前固定语料、查询、来源及集合、时间范围、每页/总页预算、版本策略、代码与运行环境。保留原始池、请求/重试回执、失败和限流，不把网络重试排除在调用成本外。扩大到其他学科、受限全文、扫描件或更长时间范围时，需要另建明确的样本协议。

同一池可比较排序方法；路由、原生日期过滤、查询扩展或获取策略的变化必须重新捕获，并做同预算的配对比较。新策略独有且人工判为相关的规范论文数可作为 Unique Relevant Papers，须同时报告总调用数和共同分母。单次捕获、自动种子遗漏和结构检查不能证明召回率、下载率或科学质量提高。

## 显式公网捕获

以下命令从仓库根目录运行，会访问外部服务。`NEW_SEARCH_DIRECTORY` 和 `NEW_PDF_DIRECTORY` 是待创建的新目录，父目录须存在；已有目录/输出文件拒绝覆盖。

```sh
pnpm research:literature-capture --search \
  evaluation/corpora/literature-acquisition-v1.json \
  NEW_SEARCH_DIRECTORY
pnpm research:literature-capture --pdf \
  evaluation/corpora/literature-acquisition-v1.json \
  NEW_PDF_DIRECTORY
```

[capture-literature-public.mjs](../scripts/capture-literature-public.mjs)的两个模式有明确边界：

| 模式 | 请求与输出 | 测量边界 |
| --- | --- | --- |
| `--search` | 合并语料公共来源与主题来源，使用 `limits`、主题 `collections`、固定 `yearFrom:2020` 和语料 `asOf` 作为 `dateTo`；保存 `protocol.json`、逐查询完整池、`captures.json`、`annotation-packet.json`、`coverage.json` | 显式来源捕获不衡量自动路由或 deep 扩展；种子集不会随运行日期更新。覆盖报告保留逐来源状态与缺失种子线索，不生成相关性标签 |
| `--pdf` | 使用真实 resolver/downloader 与 PDF.js 首页检查；保存 `protocol.json`、逐论文候选/检查/收据、下载文件、`evidence.json`、`report.json` | 当前语料只提供 arXiv 身份；解析候选沿用默认 `balanced` 版本策略。它不启动应用完整解析、关键词/向量索引、Wiki 或故障恢复 |

PDF 捕获为每篇的来源解析与下载共享一个 90 秒中止信号，下载器每个候选另有 30 秒期限、25 MiB 上限；后续 PDF.js 检查未绑定该信号，因此 90 秒不是整篇捕获的硬性总期限。只有下载器校验通过、PDF.js 可读取、首页文字至少 200 字符且题名词覆盖率至少 0.6 时才写入成功收据。此启发式获取检查不等于应用完整解析后的身份/质量核验。失败样本保留在固定分母，不能为提高成功率删除大文件、无全文或受限项。

`--pdf` 的可选环境变量 `ROC_UNPAYWALL_EMAIL` 只有运行者主动配置时才启用 DOI 补充发现；解析器使用输入 DOI，或从 arXiv ID 派生 `10.48550/arxiv.<id>`，因此当前 arXiv 种子也能在下载失败后触发补充查询。捕获脚本不读取桌面应用的获取偏好。不要把邮箱写入语料、报告说明或命令日志。配置邮箱不表示已经执行查询，也不能把 Unpaywall 与 OpenAlex 视为独立 OA 覆盖投票。

检索池的 `sources[].requests` 保存逐次 HTTP 回执；PDF 捕获只保存候选、检查、成功收据和清理后的失败 provider/code，不输出逐请求重试或限流账本。因此 PDF 捕获产物不足以独立重算总调用成本。

修复后单独探测、官方页面本地回放和整批公网重跑分别保存；不能把探测结果替换到原捕获中。本地解析成功不证明公网可用，挑战页面、超时和 429 必须保留为失败或部分成功。

## 离线标注与排名评估

[retrieval-eval](../scripts/evaluate-literature-retrieval.mjs)仅读显式本地 JSON，不调用 Provider/模型或写文库。捕获集合同为 `schemaVersion:1`、`corpusId`、`minimumTopics` 和 `queries`（每条含 `queryId/topicId/pool`），见[共享 schema](../src/shared/schemas/literature-retrieval-evaluation.ts)。完整池须保留融合前全部已校验记录及回执，不能用前 N 个候选重建。

```sh
pnpm research:retrieval-eval --prepare \
  NEW_SEARCH_DIRECTORY/captures.json NEW_ANNOTATION_PACKET.json
pnpm research:retrieval-eval LABELED_CORPUS.json NEW_RETRIEVAL_REPORT.json
```

公网捕获已生成标注包，`--prepare` 可从原始池独立再生成。工具先校验池的 hash、来源、数量与原始排名，再输出 `unlabeled_packet`：按 `recordHash` 排列，保留问题、日期条件、元数据与已知标识，移除排名、分数、来源排序和候选分组。URL/标识仍可能透露来源，不能声称来源盲法。

人工为每个原始 `recordHash` 指定恰好一个 `paperId` 归属、0–3 级 `grade` 和 `evidenceRefs`；将判断与原始完整池组装为 `LABELED_CORPUS.json`，不是把标注包直接改名为输入。已知相关但未捕获论文可用空 `recordHashes`，进入 Recall 分母和理想排名。只有池内判断时必须按池内 Recall 解释。

| 模式 | 必须声明或满足的条件 | 报告资格 |
| --- | --- | --- |
| `engineering_fixture` | `annotation:null` | 始终 `engineering_only` |
| `human_reviewed` | `independent_human`、`blindToRanking:true`、至少两名不同且不属于 `producerIds` 的 reviewer、证据 reference/SHA-256；相关源码已提交且无相关工作区改动，捕获 `limit≥20` | `declared_independent_human`；工具不认证身份、独立性或科学代表性 |

[评估实现](../src/main/plugins/research/literature-retrieval-evaluation.ts)同时输出 `baseline`、`rrf`、`lexical`，使用同一当前身份归并和年份规则。baseline 是固定来源优先级/rank/identity 排序，并非优化前产品版本。前 20 位中重复 `paperId` 只首次计增益，错误跨论文归并计入 `falseMerges20`。

| 输出 | 计算与解释 |
| --- | --- |
| Recall@20 | 前 20 位相关论文数 / 全部已标注相关论文数；`grade > 0` 才算相关，每个查询须有相关分母 |
| nDCG@10 | gain=`2^grade-1`，discount=`log2(rank+1)`；理想排名包含已标注但未捕获论文 |
| 聚合 | Recall/nDCG 先平均同主题查询，再等权平均主题；重复率按全部前 20 槽位汇总，空排名为 null |
| `sourceGain` | 各来源捕获的相关论文数及仅该来源捕获的相关论文数；以完整池和人工判断计算 |
| `missingRelevantPaperIds` | 已标注相关、但本次所有来源均未捕获的论文；区别于未标注的 `missingSeedIds` |

报告保留失败/部分查询、样本资格以及 corpus/pool/源码/bundle 身份。达到 `minimumTopics` 不等于科学验收。hash、标签归属、来源或分母不完整会拒绝评估；输出原子发布到新文件，不覆盖已有结果。

## 获取指标与未测量项

以下命令离线重算，不联网；新的报告路径不能与捕获器已写出的 `report.json` 相同：

```sh
pnpm research:acquisition-eval \
  NEW_PDF_DIRECTORY/evidence.json NEW_ACQUISITION_REPORT.json
```

[获取评估器](../src/main/plugins/research/literature-acquisition-evaluation.ts)要求 `expectedPaperIds` 与样本逐项一致且无重复。输入明确 `environment` 为 `public_network`、`engineering_fixture` 或 `application_export`，报告分别给出全样本、声明为 OA 的子集及各主题指标。声明 OA 不是独立许可核验。

| 指标 | 当前计算 | 解读要求 |
| --- | --- | --- |
| PDF Discovery Rate | `discovered:true` / 全部冻结样本 | 仅表示发现候选，不等于取得文件 |
| Verified PDF Rate | 有非空下载收据 / 同一批全部样本 | 证据生成者须核验文件与身份；公网捕获器的核验仅到上述首页检查 |
| End-to-End Ready Rate | 有 `readyAt` / 同一批全部样本 | 完成须有收据且 `parsed/indexed/wiki` 全为 true；应用测量需核验完整解析、关键词/向量索引和对应 Wiki |
| P95 Completion Time | 有 `readyAt` 样本的耗时排序，第 `ceil(0.95 × n)` 项 | `population:completed_only`；另报 `censored`、截止时间和观察窗口，不把未完成项当作零耗时 |
| Recovery Success Rate | `recovered:true` / 全部有 recovery 事件的样本 | 输入保留 `interruption/rate_limit/restart` 类型；未知结果计入 `unknown`，不能当成功。报告不输出事件明细，故障类型分组需从原始 evidence 另行汇总 |

`--pdf` 将 `parsed/indexed/wiki/readyAt/recovery` 留为 null。报告中的 `endToEndReady.completeMeasurement`、`fullyObserved` 必须与比例一起读取；未观察不等于生产端到端失败率。`p95Ms:null` 表示没有完成时间测量；无 recovery 事件或无声明 OA 样本时，对应比例的分母为 0、rate 为 null。报告不输出 `startedAt/observedAt/readyAt`，截止时间和观察窗口需随原始 evidence 保留。评估器检查输入一致性并计算 `evidenceHash`，不会自行重新读取 PDF、运行解析器或核验任务数据库，也不检查 `recovered:true` 是否伴随 `readyAt`；恢复就绪须由证据生成者核验。

真实应用测量应从元数据提交开始计时，保存任务 generation、实际副本版本/许可证/hash、解析身份、索引 generation、Wiki 依据和各阶段回执。无全文、受限、损坏、扫描件与配置阻塞分别记录；项目和全局库的 Wiki 就绪依据按[自动入库合同](research-literature-acquisition.md)判定。索引、解析或 Wiki 的未知值不能补成 false/true。原始证据缺失时，汇总 JSON 或单独哈希无法支持独立复核。

## 受控工程检查

以下是可重复执行的入口，不表示已经针对当前代码运行通过。先完成构建，再启动依赖构建产物的应用或 renderer 检查；运行环境按[开发与检查](development.md)准备。

| 命令（仓库根目录） | 覆盖边界 |
| --- | --- |
| `pnpm test:literature-acquisition` | 查询规划、领域来源、融合、PDF 来源与任务、检索/获取评估器的聚焦回归 |
| `node --test tests/integration/literature-auto-ingestion.test.mjs` | 全文管线及缺少 Embedding 配置后的恢复 |
| `node scripts/verify-agent-literature-fulltext.mjs` | 隔离 Electron 窗口/测试 IPC 调用实际 Agent 工具、能力注册表、SQLite、下载器、Parser、IR、关键词/向量、Paper Card、Wiki 和重启复用 |
| `node scripts/verify-agent-literature-import.mjs` | 完整应用与受控 SSE 模型驱动的工具循环；显式 `metadata_only`、界面刷新及重复导入去重 |
| `node --test --test-concurrency=1 tests/renderer/literature-processing.test.mjs tests/renderer/research-monitors.test.mjs tests/renderer/research-search-plan.test.mjs` | 获取偏好、收据、监控/批准参数、键盘、主题及窗口布局 |

全文脚本使用合成原生文本 PDF、本地传输映射和受控 Embedding/Paper Card 输出；可核对正文检索、专题原始引用、不可获取项和重启无重复处理。它不覆盖完整 ResearchPlugin 装配、真实模型推理、生产 Parser Worker 启动器或阅读器 UI，也不证明公网 TLS、OCR 和科学综合质量。`--native` 仅运行更窄的 Node 边界，不能标成 Electron 验收。真实科学评价仍需独立标签、同预算配对运行，以及实际解析、索引、Wiki 和恢复观察。
