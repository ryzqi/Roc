# 评测历史结果

本文保留 **2026-11-13—14 的结果摘要**。2026-11-14 已清理旧运行、比较、incident、experiment 及历史基线原始证据；原路径不能再用于 inspect、compare 或续跑，摘要也不能代替封存证据。当前用法见 [README](README.md)，协议见 [EXPERIMENTS](EXPERIMENTS.md)，清理范围见 [latest.json](local/cleanup/latest.json)。

本次文档同步未重跑模型评测、重新计分或升级历史质量资格。当前比较需要重新建立 matched 当前合同的基线与候选；Task Specs 保持 Draft / agent-reviewed。

## 2026-11-14：工程重构

当时记录：342 项评测器检查、35 项迁移消费者检查、七轮受控/离线 CLI 验收通过，统一四轨入口、生产 RAG 独立证据、预算/并发/安全恢复与预登记对照已接通。删除 34 个旧实现文件及空运行缓存。未新增真实模型质量对照、人工审核 holdout 或发布批准。详细验证记录已随清理删除，以上不能作为当前重验结果。

## 2026-11-13：Harness 与 QASPER

当时 harness fast 10/10、full 30/30，native 94/94；均为本地控制模型/确定性合同，无推理请求。5 项新增回归、64 项既有回归与 typecheck 通过。受控 QASPER fixture 5/5 scored，验证真实模型适配链、文件工具、checkpoint 与独立评分，分数只验证接线。

### v2 开发集对照

配置模型 group/deepseek，50 篇论文/50 题 × 3，两轮各 150/150 scored。候选调整回答格式、直接证据和按授权工具装配提示；数据、模型、限制、实际 schema、评分器与 v2 答案边界固定。

| 指标 | 基线 | 候选 | 差值 95% CI |
|---|---:|---:|---|
| answerF1 | 0.118390 | 0.190522 | [0.039217, 0.108233] |
| evidenceF1 | 0.277570 | 0.413308 | [0.077375, 0.197399] |
| citationValidity | 0.500000 | 0.820000 | [0.233333, 0.420000] |
| 严格 JSON 失败 | 75/150 | 27/150 | 描述性计数 |

论文簇配对 bootstrap 2000 次，比较为 non-inferior；预登记底线 answerF1 ≥ 0.20、evidenceF1 ≥ 0.45、citationValidity ≥ 0.99 均未通过，assess 为 **rejected / 3**。请求数 578 → 511，输入 tokens 3,596,246 → 3,161,026，中位单题耗时 8.999 s → 7.977 s。收益主要来自格式恢复，两轮均有效 JSON 的 62 个样本未同步改善证据选择；只覆盖所选开发集。

### v3 与更早答案边界

v3 live full 当时完成 150/150 scored，answerF1 ≈ 0.2532、evidenceF1 ≈ 0.5040、citationValidity=1；成本未计算。它不构成当前合同的 matched comparison，也不证明质量改善。

更早聚合文本边界的 full 为 answerF1=0.0397542761、evidenceF1=0.0957753358、citationValidity=0.1866666667，agent failure 122/150。最终 checkpoint 诊断发现 60 题被额外过程叙述误判格式，另 62 题的最终消息本身不满足严格 JSON。这是边界诊断，未重算原分数，也不能证明答案正确。另一次传输中断 attempted 86、scored 85、unattempted 64，仅作历史故障记录。

## 产物清理

| 日期 | 已记录删除范围 |
|---|---|
| 2026-11-13 | 251 个生成目录、31,676 个文件，约 2.67 GiB；当时保留的运行后来也在 11-14 清理 |
| 2026-11-14 | 21,108 个文件，约 3.21 GiB，含 25 轮封存运行原始证据及关联记录 |

代码、任务定义、数据集与配置示例保留；用户配置、凭据和生产数据库不在清理范围，evaluation 外的旧证据未纳入。测试现在拥有独立输出根，在失败时也回收临时 run/incident/experiment、Science 缓存和 venv；模型宿主确认退出后回收临时状态。

## 结论边界

以上是当时实现的工程/开发结果，不能证明当前模型、生产 UI、context compaction、子代理、跨会话记忆、外部 MCP、注入抵抗或官方 Science 环境通过。macOS 隔离依赖 sandbox-exec，系统库未完整镜像冻结，无总内存/磁盘硬配额；seal 是哈希清单。当前来源资格、独立证据、统计与资源 gate 以 README 和各 Task Spec 为准。
