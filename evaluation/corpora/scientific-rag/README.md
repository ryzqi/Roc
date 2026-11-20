# Scientific RAG Phase 0 corpus

本目录维护自采 gold 的 schema、来源锁和配额合同；生产能力与公开组件轨道见[Scientific RAG 索引](../../../docs/scientific-rag/README.md)及[当前状态](../../../docs/scientific-rag/00-current-state.md)。公开组件只在其原始标注和观测范围内解释，不改变这里的人工 gold 门槛。

[manifest.json](manifest.json) 声明原始 PDF、独立结构标注和问题文件。资格以实际输入的 checker 输出为准；Schema/Task Specs 的 agent review 不构成人工 Ground Truth，下载缓存是否存在也不代表质量通过。

公开来源使用各自内容锁：[QASPER/结构页面](public-sources.lock.json)、[SciEGQA](sciegqa-sources.lock.json)与[选样集合](sciegqa-cohort.lock.json)、[SciDQA](scidqa-sources.lock.json)、[M3SciQA PDF](m3sciqa-pdf-sources.lock.json)、[专家来源](expert-sources.lock.json)。保留锁内 revision、原始 URL/hash、许可、上游人工或辅助标注的真实来源；不编造本地 reviewer。公开问答、文本段落或页面子集不替代完整类别/结构 gold，自采 checker 不授予它们额外资格。

仓库根目录执行：

```sh
pnpm evaluation:scientific-rag:check
pnpm evaluation:scientific-rag:check --corpus /absolute/corpus/manifest.json --output /absolute/new-readiness.json
```

输出是确定性 readiness 报告。exit 0 只说明输入资格检查通过；exit 2 说明缺资料、配额、人审记录或来源不一致。输出文件必须不存在；检查不覆盖旧报告、不下载论文、不调用模型、不读写生产数据库、不产生质量分数。checker 的 `scientificBaselineReady` 始终 false；完整科学基线须另行真实测量与验收。

[论文](papers/README.md)、[结构标注](annotations/README.md)、[问题](queries/README.md) 分别保存原始数据、独立 gold 和证据题。私有语料置于 evaluation/local 或仓库外；从其他目录传入 manifest 时，全部文件必须位于其目录内。manifest 不能引用外部路径或借助软链接越过根目录。

资格检查验证真实可读 PDF/hash、全部页、结构/object 引用、人审内容 digest、证据精确 span、唯一来源与类别配额。合同要求至少 45 个独立 PDF 和 200 题，具体类别见子目录说明与 [schema](../../lib/scientific-rag-corpus.mjs)。它无法凭审核者姓名证明人类身份，也不能自动判断论文真实性、许可、科学答案正确性或标注完整性；这些由真实人工记录和独立核验承担。synthetic、pending、engineering_fixture 不能以其来源声明通过真实语料门槛。

## 独立观测与评分入口

以下是独立脚本，不是 `pnpm evaluate run --suite scientific-*`。完整输入、精确参数以链接源码为准；仅在准备好可读取的原始 PDF、保存运行和新输出路径后执行。

| 入口 | 输入与边界 |
|---|---|
| [score-scientific-pdf.mjs](../../../scripts/score-scientific-pdf.mjs) | `--run`、`--source-root`、`--output`；gold 模式用 `--manifest`，先检查完整语料；`--observe` 与 manifest 互斥，只导出已核验预测，质量为 null |
| [resolve-scientific-evidence.mjs](../../../scripts/resolve-scientific-evidence.mjs) | `--run`、`--output`，可选 `--manifest` 或 `--observe`；重建原 PDF/SQLite 来源，仅唯一精确块对应可绑定 gold |
| [capture-scientific-context-reads.mjs](../../../scripts/capture-scientific-context-reads.mjs) | `--run`、`--output`；对兼容只读库进行新的生产 context 读取，不冒充历史 Agent context |
| [score-scientific-retrieval.mjs](../../../scripts/score-scientific-retrieval.mjs) | `--run`、`--bindings`、`--output`，可选 `--manifest`、`--context`；显式绑定 gold query 与保存请求，先检查完整语料，缺请求或不兼容范围保持 NA |

这些入口不创建人工 gold，也不自动授予完整 scientific baseline；`scientificBaselineReady` 保持 false。精确评分与原始证据合同见 [parser](../../tasks/scientific-parser/Task.md)、[objects](../../tasks/scientific-objects/Task.md)及 [retrieval](../../tasks/scientific-retrieval/Task.md)。公共组件优化和执行授权的范围定位见[专题索引](../../../docs/scientific-rag/README.md)。
