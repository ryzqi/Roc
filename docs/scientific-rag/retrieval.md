# 科研索引、检索与证据上下文

本专题说明从 Paper IR 到 Agent 可消费来源的当前合同。检索排名、上下文读取和科学支持判断是三个分别验证的步骤；质量资格见[评测](evaluation.md)。

## 分块、嵌入与发布

[scientific-chunks.ts](../../src/main/plugins/research/scientific-chunks.ts) 构建 paragraph、table、table row group、figure、equation、algorithm 和 caption 七类块。每块保存 source/parse、原对象、原文范围、章节、多角色、关系及确定性内容/输入 hash。通用 parent/child 索引仍供原有工具消费。

正文使用连续 UTF-16 原文区间，不拆代理对；表格行组保留表头和合并单元格的真实 anchor；公式和算法步骤保持完整。缺表格结构时可保留原 OCR 正文，不能虚构表头、单位或图像描述。[serializer](../../src/main/plugins/research/scientific-text-serializer.ts) 的版本、chunk policy 和实际输入共同参与向量身份。

正文、表格行组和算法的默认分块预算均为 450 tokens；`oversized` 标记序列化输入超过对应预算的块，不表示内容已被截断，也不保证 provider 能直接接受。

[embedding-batches.ts](../../src/main/plugins/research/embedding-batches.ts) 语义分片策略上限为每批 32 条、16384 tokens，单条及 provider context 各 8192 tokens；实际 HTTP 传输每次最多 4 条，避免冷批次越过网关时限。该传输分组不改变分片、加权合并或既有缓存身份。cl100k 是本地预算估计。超长输入在 provider 边界分成连续原文片段，按 token 加权合并归一化向量，存储对象与定位保持完整；该合并不保证与模型直接编码整对象语义等价。

每个原始输入的全部片段完成并归一化后，才保存可续跑缓存；后续批次失败不会丢失已完成输入。缓存写入前重新核对配置与来源，完整索引仍经原事务一次发布，不发布半份文档。HTTP 请求的 60 秒期限覆盖响应体读取，超时标为 `embedding_provider_timeout`，外部取消原样传播。超时不自动二分或无限重试。

只有明确的 `embedding_provider_input_limit` 才触发有界二分重试。数量、维度、有限值、非零向量及配置身份均需验证，全部片段成功后才能缓存。缓存同时绑定原输入 hash、serializer、模型配置修订、分片算法与预算。

项目 [index-service.ts](../../src/main/plugins/research/index-service.ts) 和文献库 [scientific-library-index.ts](../../src/main/plugins/research/scientific-library-index.ts) 准备科研及通用索引候选，再由事务复核来源、任务、IR 和配置并发布。失败候选不覆盖旧 active；来源漂移也不能因此让旧引用继续有效。无 embedding 时可以明确发布文本索引，不能伪造向量。

索引 building/active/retired 与抽取任务的 generation 分开。恢复、归档、移除来源及配置重建由各自所有者处理；历史工件和引用保留，详见[数据合同](02-data-contracts.md)。

## 查询计划与六通道

[scientific-query-planner.ts](../../src/main/plugins/research/scientific-query-planner.ts) 只接受调用方提供的授权目录。标题、ID、规范化 DOI 和显式 documentIds 约束范围；`all`、`selected`、`none` 有不同含义，未解析 DOI 的空范围不能变成全库。规则保留多个意图；可选有界模型补充只能选择已授权文档和查询中的真实条件跨度。

[scientific-retrieval-router.ts](../../src/main/plugins/research/scientific-retrieval-router.ts) 在同一授权快照下并行查询计划选中的通道，可选六类：

| 通道 | 来源 |
| --- | --- |
| Text | 科研 FTS5、sqlite-vec 与有界词法匹配 |
| Metadata | 当前 IR 中的论文身份和书目信息 |
| Table | 表号、caption、真实 cell、表头和条件文字 |
| Equation | 完整 LaTeX、编号、变量与原文引用 |
| Figure | 原图对象、caption、原文引用与已关联资产 |
| Citation | 已持久化的 Scholarly Relations 快照；检索本身不访问外网 |

共享文献库的 `projectId:null` 是存储范围，项目请求仍须检查成员关系。返回前重查原件大小/hash、IR、parse、active generation 与所有者，跨越异步调用的版本变化必须拒绝。

融合使用 [scientific-retrieval-fusion.ts](../../src/main/plugins/research/scientific-retrieval-fusion.ts) 的等权 RRF；同通道/方法的重复项不能重复加分，分数优先于角色偏好。精排见 [scientific-reranker.ts](../../src/main/plugins/research/scientific-reranker.ts)：provider 只能返回候选 index 的分数，不能改来源对象。预算最多 200 候选、单对象 4096 tokens、总计 64000 tokens；不截断公式或单元格以迁就预算。

精排超时设置为 100–120000 毫秒，新配置默认 30000 毫秒；已有配置保持原值，需按真实候选池延迟明确调整。短查询样例可用不证明完整池能在同一期限完成。

缺配置、服务失败或预算不足时保留实际 RRF/词法结果与降级原因；取消、来源或配置竞态继续拒绝。精排输入的 dataset/metric 仍取原文中出现的查询条件，methods 为空；已有 typed extraction 不等于该精排输入已消费抽取知识。

## 上下文与句子验证

[scientific-context-assembler.ts](../../src/main/plugins/research/scientific-context-assembler.ts) 从真实 IR/chunks 重建候选来源投影；`candidateIds` 为空时选择已保存的 `search.hits`，按 generation/object 合并命中。所选范围由 [scientific-search-candidate.ts](../../src/main/plugins/research/scientific-search-candidate.ts) 决定：表格合并命中行、表头及原始 cell anchors，保留 caption/脚注；算法合并所选步骤；正文保留命中原文区间。上下文不保证含整张原表、整个算法或全文；抽取的完整表格输入另见[抽取批次](extraction.md#三阶段与完整输入)。

默认预算见[context schema](../../src/shared/schemas/research-scientific-context.ts)：12 对象、24 段落、8000 tokens、2 图片、图片单边 2048、每篇 4 条证据。先整体纳入合并后的命中及对象表示，再按预算加入完整 parent、同章节相邻段落、标题、实验设置或公式说明；不截断选中 cell 值、公式或算法步骤。未纳入的对象或扩展项通过 `omissions` 说明。Token 计量覆盖整个 `evidence` 数组的 JSON（含来源字段），不含返回 envelope；段落计数包括正文/算法命中单元及获准的扩展段落。

当前 assembler 只为 Figure 证据加载图片。图片需重新验证真实资产、PNG、尺寸、字节和来源；项目图片的读取观察 hash 不能写成发布时 hash。Metadata/Citation 命中不直接充当 PDF 正文证据。跨论文请求的 dataset/metric 也不证明实验条件一致。

[research-scientific-evidence.ts](../../src/main/plugins/research/research-scientific-evidence.ts) 重建同预算上下文并复核所有来源。句子支持范围为：

- `quote`：精确 UTF-16 原文或由主机解析的原文句柄。
- `table_value`：同一对象中指定 cell 的完整原值。
- `equation`：指定对象的完整原始 LaTeX。
- `claim` 与 `comparison`：不能由当前窄范围验证自动获得科学支持。
- `inference`：保留推断标记。

只有非空句子列表全部满足窄范围支持时才允许 `canAnswerAsFacts`。来源有效不等于全答案正确或科学批准。[Agent 工具](../../src/main/plugins/agent/scientific-tools.ts) 保存本次运行的 search/context receipts，让模型选择句柄；项目身份与工具权限由运行固定。

## 可选视觉与维护

[visual-index-service.ts](../../src/main/plugins/research/visual-index-service.ts) 默认关闭。启用需自动准备 Python 环境、检查本地模型身份、保存配置并重建所选 Figure/Table PNG。当前 [Python adapter](../../src/main/plugins/research/visual-python-adapter.ts) 要求 Sentence Transformers 6.0.1、原生 ColPali/ColQwen2、安全本地权重和匹配的环境快照；使用 CPU、禁用网络/GPU，并限制进程资源。普通文本请求不启动视觉模型。

视觉排名保留多向量 MaxSim 与原始 PDF 定位；独立代次、模型/图片 hash 和来源检查约束每次读取。缺包、缺图、输入变化及预算超限按实际错误返回。图像相似度不能替代原 cell/text 的精确数值证据。

[figure-understanding-service.ts](../../src/main/plugins/research/figure-understanding-service.ts) 显式读取一个已授权 Figure，要求模型支持图片及结构化输出。结果为派生、未审核解释，须回到原图核查；不创建人工批准的 Evidence 或 Fact。取消、来源变化和模型变化拒绝晚返回。

[scientific-shadow-retrieval.ts](../../src/main/plugins/research/scientific-shadow-retrieval.ts) 通过主进程 `research.shadowRetrieval` 配置对明确项目启用；默认关闭，原检索完成后才调度，无等待队列。日志中的候选交集不是 Recall，无独立相关性标签时 recall 为 null；影子查询仍可能调用已配置模型。

[scientific-generation-service.ts](../../src/main/plugins/research/scientific-generation-service.ts) 提供显式维护切换：请求需有项目、document、storage scope、目标 generation 和 expectedActiveId。只能激活与当前来源、parse、IR 和 embedding 配置兼容的已发布保留代次；CAS 与事务检查防止并发错配。它不重解析、不恢复人工审核，也不属于 Agent 检索工具。
