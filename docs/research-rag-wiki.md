# 科研 RAG 与持久 Wiki

## 原始检索与科研结构

原始解析 Block 保持原有 ID、正文和定位。论文语义结构另存 paper/parse/source
身份、多级章节路径、方法/实验/结果/讨论等角色，以及父块和前后块关系；原生
PDF 跨页继承当前章节。检索和嵌入消费结构信息，不改写原文 Evidence。

原始检索使用 BM25、向量与 RRF；科研问题规则路由可以限定单篇论文或增加
跨论文候选多样性。候选池与最终输出数量独立；可选精排使用 Cohere Rerank 协议，
密钥仅进入 main secrets。
配置缺失、超时或服务失败保留 RRF 并记录真实降级；取消不能包装成成功。
模型收到精简命中，完整排序审计保留在工具 artifact。

`research_read_knowledge_context` 绑定当前项目、准确 chunk 与 indexedVersion；
父块和相邻原文共用最多 8000 字符预算。来源或解析变化拒绝旧上下文读取。

向量索引任务持久记录 queued/running/ready/blocked/failed、generation 与重试次数。
重启恢复中断任务；新来源或配置修订替换 generation，旧任务不能覆盖新状态。
没有可用配置显示 blocked，失败可显式重试。缓存按实际输入和配置版本复用，
不恢复失效的证据身份或科学审核。

## 论文卡片与修订

解析成功后通过持久 outbox 自动生成六节 Paper Card：问题、贡献、方法、实验设置、
结果与消融及局限。输入最多 10000 tokens，引用保存准确原始 chunk、
解析及来源版本。模型失败有可见状态和显式重试；已解析论文后续关联项目也
会创建来源页。卡片只存于 Wiki 派生层，不进入原始知识索引或 Evidence。

Wiki 章节 owner 为 system/assistant/human，status 为 current/stale。来源重编译
替换系统章节，保留助手和人工正文及其旧依赖；依据变化使对应章节 stale。
Revision 不可变，保存继续检查 revision CAS、Basis Digest、项目和有效来源；
助手不能覆盖人工章节。回滚新增修订，保留旧依据与 stale 状态。

`research_wiki_read_section` 绑定页面修订，按 offset 分段读取最多 6000 字符；
一次重新综合最多 3 节 stale 助手章节，只使用当前原文，落库再次检查依据。
人工章节和科学审核不能由重新综合改写。

## 章节导航

`research.searchWiki` 返回 pages、命中章节 ID/标题/短摘录、nextOffset 和检索回执。
空查询分页列举；非空查询使用章节 FTS5 BM25 与语义检索，以 RRF 融合并按页去重。
中文采用现有汉字位置 token，保留短语顺序。

向量在事务外后台每批 16 节生成，复用现有 embedding 服务及缓存；缓存由
模型配置 ID/revision、`wiki-section-v1` 和输入 SHA 约束。修订发布事务同步替换
章节与 FTS；异步检索后再次剔除旧修订。Wiki 向量不进入原始 knowledge embeddings。
查询向量使用独立 `wiki-query-v1` 缓存。

回执 mode 为 list/bm25/hybrid；degradation 明确区分 config_missing、
index_pending、embedding_failed。界面和 Agent 都显示实际降级，服务失败
不会冒充语义检索成功。导航结果保持未审核；事实必须通过原始 Evidence 核查。

## 主张阅读投影

主张及其证据另提供概念阅读投影，分别显示主张声明、当前人工关系审核和来源有效性。
关联论文优先使用后端来源快照；时间线表示引用文献的最早发表年份。
共享证据只表示关联，不自动代表科学支持。

投影保存 evidence→claims 邻接索引，仅对选中主张展开邻居，每页最多 50 条；
命令面板只生成摘要，不物化所有主张对。相关历史测量见
[2026-11-08 分析摘要](research-knowledge-wiki-analysis.md)。

## 版本与验证范围

数据库和阶段输出必须满足当前合同；不自动迁移或删除旧用户数据。版本拒绝策略见
[数据库存储](database-storage.md)，启动验收使用隔离的新数据根。

离线检查验证检索流程、引用、版本隔离、取消、降级和事务边界；Electron 检查
验证启动、真实 IPC 及界面行为。真实科研质量、模型延迟和成本需另用匹配运行测量，
不能由结构检查推导；当前入口见 [评测流程](../evaluation/README.md)。
