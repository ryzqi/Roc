# Roc Research Agent Harness 执行计划入口

日期：2026-11-06。计划版本：1。
核对基线：`eea2087b5d2d79df3b2fea7764ce48e4975fd764`。
来源：[`Roc_Research_Agent_Harness_Plan.md`](../Roc_Research_Agent_Harness_Plan.md)，已完整阅读。

本目录把来源方案转为可逐阶段执行、验收和删除旧实现的重构计划。
计划编制与 S00 已完成，状态为 `Verified passing（S00 文档与当前工程基线）`。
S01～S09 尚未启动；生产重构、迁移与科学验证尚未执行。

## 执行要求

- 允许跨 Runtime、Research、数据库、IPC、Skill 和 renderer 的大范围重构。
- 新合同一旦切换，同时修改生产调用方、持久化读写、测试和生成合同，删除被替代实现。
- 不保留向后兼容、旧接口别名、双写、旧状态机、旧 Skill 加载或生产运行回退。
- 内部依赖显式必填，合同错误直接暴露；不写默认成功、空结果、伪造回执或泛化重试。
- 项目身份、权限、审批、输入版本和预算仍在真实执行边界校验。
- 删除遗留代码不等于删除用户文件、历史证据或真实研究记录。
- 唯一研究助手、唯一 AppShell、任务仅管理抽屉、工作区文稿文件真身继续成立。

来源文档中的“可选 Manifest”“旧版本运行时解析”“保留旧运行路径”“回退旧静态 Skill”
由本目录的[切换合同](contracts.md)取代。算法 A/B 在隔离基线环境比较；
生产只运行已选合同。数据恢复采用停机和匹配版本备份，不依赖兼容层。

## 阅读顺序

1. [总计划与状态](task_plan.md)：阶段依赖、排程、执行次序和完成定义。
2. [架构与切换合同](contracts.md)：模块责任、状态、权限、迁移和代码删除规则。
3. [验收与来源追踪矩阵](acceptance.md)：WP/RH 对应、指标、检查命令与证据。
4. 对应阶段文件：进入阶段后按任务顺序实施。
5. [仓库核对](findings.md)、[进度记录](progress.md)：恢复上下文和登记实际检查结果。

## S00 交付入口

- [当前基线](baseline.json)：完整 SHA、运行环境、75 项依赖、schema 与六项检查日志 hash。
- [能力与四条消费者图](capability-inventory.md)：当前所有权、状态、调用方、测试及未测边界。
- [删除台账](deletion-ledger.md)、[迁移台账](migration-ledger.md)：后续完整切换与历史数据保护合同。
- [ADR 0028](../docs/adr/0028-execution-task-ownership.md)：共享执行协议与唯一任务事实。
- [ADR 0029](../docs/adr/0029-scientific-verification-boundaries.md)：科研建议与人工决定隔离。
- [ADR 0030](../docs/adr/0030-required-skill-contracts.md)：11 阶段强制 Manifest 与统一 context。

## 阶段文件

| 阶段 | 内容 | 进入条件 |
| --- | --- | --- |
| [S00 基线与重构合同](phase-00-baseline.md) | 能力清单、当前基线、所有权、迁移与删改边界 | 开始实施 |
| [S01 评测系统与独立数据](phase-01-evaluation.md) | 现有 runner 全量化、隐藏期望、标注、受控真实模型 adapter | S00 |
| [S02 执行事实与恢复](phase-02-runtime.md) | Task/Run/Stage、科研事件、effect、预算、回放和冷迁移 | S00 |
| [S03 Skill 与上下文](phase-03-skills-context.md) | 11 阶段必填 Manifest、权限交集、证据安全压缩 | S01 工程合同 + S02 |
| [S04 科研核验与审稿](phase-04-scientific-review.md) | 主张语义、反证、独立 Reviewer、修订与质量门 | S01 最小独立数据 + S02 + S03 |
| [S05 冻结检索与重排](phase-05-retrieval.md) | 多视角计划、审批版本、来源身份、证据重排 | S01 协议 + S02 + S03 |
| [S06 DAG 与有限并行](phase-06-task-dag.md) | 依赖节点、atomic claim、fencing、取消、Supervisor/Worker | S02 + S03 + S05 合同 |
| [S07 执行安全与桌面观察](phase-07-security-ui.md) | 真实攻击回归、任务抽屉、助手、工件检查器 | S02 + S04 + S05 + S06 后端 |
| [S08 导出与整体验收](phase-08-export-release.md) | 来源闭包、真实 ZIP、迁移演练、全链路、打包及发布材料 | S01～S07 相应验收 |
| [S09 条件扩展](phase-09-conditional.md) | 两分支实验树、必要时远程 Workspace RFC | S08 后独立立项 |

## 本轮交付与授权边界

本轮执行 S00，新增基线、能力清单、迁移/删除台账和 ADR，并运行指定六项离线检查。
smoke 使用临时数据与本地 loopback 模型 stub；未改业务代码、未安装依赖、
未调用付费模型或外部服务、未提交 Git、未发布。
后续本地重构按阶段实施；付费模型、外部数据传输、远端写入和正式发布需要覆盖具体目标的授权。
缺少这些条件时继续完成独立的本地工作，科学或外部验收记录为未完成。
