# Scientific RAG 文档索引

本目录描述当前源码中的科研 PDF、检索、知识抽取与 Wiki 合同，以及取得科学质量结论所需的输入和验证。能力已接入生产不代表完整科学验收通过；运行结果必须依据当次冻结输入、真实调用与独立参考判断。

| 文档 | 用途 |
| --- | --- |
| [当前实现与验收边界](00-current-state.md) | 生产能力、权威版本与尚需取得的科学质量证据 |
| [架构与职责](01-architecture.md) | 来源、IR、索引、检索、抽取和 Wiki 的所有者及发布边界 |
| [数据合同](02-data-contracts.md) | 权威 schema、定位、代次、失效范围与历史保护 |
| [PDF 解析与 Paper IR](parsing.md) | Native/OCR 融合、阅读顺序、结构对象、可选补充及工件生命周期 |
| [索引、检索与证据上下文](retrieval.md) | 分块、嵌入预算、原子发布、六通道、精排、引用验证及可选视觉 |
| [科研知识抽取与 Wiki](extraction.md) | 完整输入、Entity/Fact/Relation、条件来源权限、provider 工具 schema 与知识依赖 |
| [科学评测资格与运行前提](evaluation.md) | corpus 配额、独立参考、六层评分、Baseline/A–I 配对及可用脚本限制 |

产品使用合同见[科研 RAG 与持久 Wiki](../research-rag-wiki.md)，界面位置见[科研工作台](../research-workbench.md)，数据库升级见[数据库存储](../database-storage.md)。

开发检查入口为[开发指南](../development.md)。评测 CLI、隔离与封存见[评测指南](../../evaluation/README.md)，通用的[实验比较与采用](../../evaluation/README.md#实验比较与采用)和[验证方法](../../evaluation/README.md#验证方法)由该指南统一维护。
