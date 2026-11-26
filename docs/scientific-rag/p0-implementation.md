# 知识库优化 P0：工程基线与来源合同

本阶段实现《知识库优化.md》的 RAG-01/RAG-02 工程基础。基线代码为
`3b8acb7feb9b745b437bdb365699264aed7e4756`，包含方案分析基准之后的内存修复。
本阶段不改变数据库 schema、正式 Evidence/Claim 审核、Wiki 修订或人工内容。

## 交付范围

- 复用现有 corpus checker，增加 v2 源码/依赖/配置冻结、实验条件和细分拒答原因。
  历史 v1 输入继续按原合同评分，不自动升级资格。
- 分开报告解析、检索、抽取、Wiki、写作的缺失输入、执行状态和质量状态。
  条件不可比的原文证据独立保存，不进入正例 Recall 分母。
- 新增共享 `ScientificSourceRef`，复用 Paper IR identity、index generation 和
  `ResearchSourceLocator`。检索与科研抽取可投影为同一原始对象引用，现有来源验证路径已接入。
  绑定历史工件不等于通过当前项目权限、当前 PDF 字节或科学审核。
- 提供单篇原生 PDF 解析基线入口，冻结原 PDF、源码、配置和输出摘要；失败保留无评分收据，
  清理临时 bundle 和不完整解析产物。

## 真实素材核查

本地 SciEGQA 缓存的 80 篇 PDF 已逐一核对 hash；1,623 道上游人工题、1,823 张图像、
2,497 个区域通过已有导出器的重建验证。其许可未明确，且未完成本地独立全文审核，
不能提升为本项目正式科学 gold。

M3SciQA 本地导出含 452 题，许可为 CC-BY-4.0，标签 hash 与 manifest 一致。
当前 Python 缺少 `pyarrow`，未完成从原始 Parquet 的复导出验证。
这些结果证明本机存在真实素材；提交的正式自采 corpus 仍为空，二者不可混淆。

单篇 SciEGQA 原论文 `2311.07631` 经当前生产解析器处理，得到 28 页、1,131 个文本块，
无 OCR/Embedding/Reranker/LLM 调用。计时与完整输入摘要见
[机器报告](p0-native-baseline.json)。这是原生文本解析观察，不是识别精度、检索召回或科研质量成绩。

从仓库根复跑，最后一个参数必须是不存在的新目录：

```sh
node scripts/benchmark-scientific-native-baseline.mjs \
  evaluation/local/corpora/sciegqa-bench-v1/pdfs/cs/2311.07631.pdf \
  2551035de153b3de967b7f2372802af4548408ee73dd2aa2910c43987c3b091f \
  .artifacts/p0-native-baseline-new
```

该入口仅消费仓库内显式指定的 PDF，校验前后 source hash，拒绝覆盖已有输出。
不下载资料、不读取用户数据库、不自动获取模型。

## 验证与证据保留

工程检查的准确命令、版本、结果和日志摘要记录于
[工程基线报告](p0-engineering-baseline.json)。所有候选命令从仓库根目录执行。
基线使用上述 commit 的独立工作树；初次 pnpm 执行触发依赖重连接，受污染结果作废。
修复依赖后用 package scripts 的直接命令重跑同一套来源/评测回归，再检查候选代码。
工程回归不能代替科学质量验收。

专项来源/解析回归 67 项、评测合同回归 60 项通过；初始提交的对应回归为 56 项和 55 项。
`pnpm typecheck`、`pnpm check:skills`、`pnpm check:ipc`、`pnpm build` 通过。
完整 `pnpm test:unit` 首次执行受 Electron 二进制缺失影响，受影响的四个文件在恢复锁定版本后
复跑 35 项全部通过；不能将首次完整运行改写成全绿。
`pnpm test:renderer` 全量 1,054 项通过。
`pnpm evaluation:check` 恢复后为 726 通过、2 失败、41 跳过。

以下三个失败均在初始提交的独立工作树中复现，未由本次 P0 引入，仍需后续处理：

- `tests/unit/research-ovis-structural-replay.test.mjs:39`：后续有效页实际仍为 failed。
- `evaluation/tests/capability-mcp-runtime.test.mjs:148`：`capability_mcp_artifact_read_contract_invalid`。
- `evaluation/tests/experiment.test.mjs:260`：预期的 `record_changed` 未抛出。

保留 `.artifacts/p0-engineering-checks/` 和 `.artifacts/p0-native-baseline-v2/`
作为可核对的本地基线证据；不提交原 PDF 或生成页面。临时工作树、测试夹具、bundle
和已被可复跑入口替代的首次试运行目录在交付前清理。已有素材、模型和用户源文档保留。

## 尚未验收

用户确认暂时没有独立人工审核语料，本次完成工程基线，正式质量验收保持缺口：

- 授权清晰且完整登记的 PDF、结构标注、题目、两名独立审核者及必要仲裁。
- 抽取 Entity/Fact 全量参考、Wiki 增量场景、写作 Claim/正文修订参考。
- 冻结的真实模型配置、实际运行与独立语义评分，及 Apple Silicon 资源测量。
- 旧 SciEGQA PDF benchmark/verifier 的 `compact`/`complete` 约定不一致，当前未使用该链路。

`pnpm evaluation:scientific-rag:check` 应返回 exit 2，所有科学质量指标仍为 null。
P0 交付时 P1–P5 尚未实施；后续阶段的工程交付与当前验收边界见[专题索引](README.md)。
