# 科研性能测量

本页维护测量方法与解释范围。生产行为见各功能专题；检查选择见[开发指南](development.md)，科学质量评估见[评测指南](../evaluation/README.md)。

## 测量入口

在仓库根目录运行，显式指定新的报告路径。部分脚本会覆盖同名文件，不能复用已有基线的输出路径。报告保存协议、源码摘要、环境及样本；比较前须核对这些条件。

| 范围 | 命令 | 测量边界 |
| --- | --- | --- |
| SQLite FTS / 精确向量检索 | `pnpm research:retrieval-bench <新报告.json>` | 隔离合成 chunk 与向量的吞吐，包含项目过滤；不测 embedding 质量 |
| PDF 原生解析 / 页面代理复用 | `node scripts/benchmark-pdf-document-parser.mjs <新报告.json>` | 原生文本长文档、单页、取消与页面生命周期；缺模型路径不构成 OCR 吞吐测量 |
| 图谱邻域 | `pnpm research:graph-bench <新报告.json>` | 已记录关系与共享证据的邻域展开、分页；不测力导向布局 |
| 原生进程准入 | `pnpm research:admission-bench <新报告.json>` | macOS 原生探针的排队、容量、取消与清理；不测计算引擎吞吐 |
| 网络请求治理 | `pnpm research:network-bench <新报告.json>` | 注入响应下的缓存、退避、限流和取消；不访问真实服务 |
| 管理存储盘点 | `pnpm research:storage-bench <新报告.json>` | 隔离生成目录的扫描、计数及只读行为；不测真实用户库 |

各脚本内的协议定义规模、样本数、分位数算法和阈值。SQLite 新连接只重置连接缓存，不清除操作系统缓存；少量 nearest-rank 样本中的 P95 可能就是最大值。进程 RSS 可能包含导入、数据生成及前序样本，数据库文件大小不等于瞬时 WAL 或 APFS 独占占用。

PDF 原生提取事件、解析发布和 Electron 首次绘制是不同计时边界。解析版本以[运行时合同](../resources/research-runtime/README.md)为准。扫描件、混合 PDF、真实模型缓存与阅读器帧率需要各自的样本和运行。

`research.getStorageUsage({projectId})` 只盘点配置的受管目录。逻辑字节、按 inode 去重的分配块、索引 payload 与数据库分配各有含义；缺失目录和读取错误必须保留。盘点结果不授予删除权限，合同见[执行资源](research-execution-resources.md)。

## 冻结向量检索回归

```sh
pnpm evaluation:frozen-retrieval:check \
  --corpus tests/fixtures/local-retrieval-quality-context-role-v2.json \
  --output-root .artifacts/frozen-retrieval
```

`--corpus` 必填，`--output-root` 是新 run 目录的父目录，默认 `evaluation/runs/`。[适配器](../evaluation/adapters/frozen-retrieval/index.mjs)在隔离内存库中使用生产 schema、FTS、sqlite-vec 和 RRF，读取捕获的向量；统一 CLI 封存 manifest、journal、trial audit 和 summary。它不执行 ingestion、embedding 生成或建索引质量评估。

Contract 2 要求来源/chunk 与实际上下文 embedding 输入哈希、向量 provenance、producer/reviewer/split，以及每种策略全部范围内 chunk 的 0–3 相关性标签。输入漂移、无效身份或缺失标签在评分前失败；输入变化须另建版本化 fixture，真实模型向量需要重新嵌入。

仓库的 [context-role fixture](../tests/fixtures/local-retrieval-quality-context-role-v2.json) 使用合成向量，只验证工程排序。Recall@20、nDCG@10、证据链覆盖和无答案问题的非空检索分别报告；证据链覆盖不能证明推理正确，非空检索也不是回答拒答率。完整科学质量需要独立人工审查的数据和真实模型运行。

## 固定测量文件

以下 JSON 保留各自测量时的协议、来源与限制，不作为当前代码的通过声明。只有相关原始输入和产物齐备、合同兼容时才能重评分或比较。

| 类型 | 数据 |
| --- | --- |
| 检索 | [协议](research-performance-protocol.json)、[初始测量](research-retrieval-baseline.json)、[窄排序测量](research-retrieval-narrow.json) |
| PDF 与图谱 | PDF 原始报告 `docs/research-pdf-performance.json` 仅在本地留存；[图谱](research-graph-performance.json) |
| 资源治理 | [准入](research-admission-performance.json)、[网络](research-network-performance.json)、[存储](research-storage-performance.json) |
| 旧冻结 fixture | [输入](../tests/fixtures/local-retrieval-quality.json)、[结果](research-local-quality-fixture.json)，用于保留来源与输入漂移对照 |
