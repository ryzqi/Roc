# 科研工作流实施验收

验收日期：2026-11-23。对应[2026-11-21 调研](https://github.com/ryzqi/Roc/blob/0ea0b6c730c0825ce1173325d946cd5457953131/docs/research-workflow-gap-analysis-2026-11-21.md)的八项优化。最终顺序原生回归通过。功能合同见下表。

## 实施范围

| 项目 | 提交 | 当前合同 |
| --- | --- | --- |
| P0-1 科研提案与下一步查询 | `18b6e79` | [工件检查器与提案](research-artifact-inspector.md) |
| P0-2 工作稿与受控正文同步 | `d35612d` | [稿件同步](research-manuscript-sync.md) |
| P0-3 真实结果进入图稿、正文和 Methods | `c82e10c` | [实验结果](research-experiment-results.md) |
| P0-4 技能参考依赖闭包与运行准备检查 | `c802a38` | [内置技能](builtin-skills.md)、[阶段技能](research-skills.md) |
| P1-1 已记录关系的影响与定向修复 | `8ba7a63` | [变更影响](research-impact.md) |
| P1-2 证据矩阵、大纲与提取试查 | `24ce68b` | [论证大纲](research-argument-outline.md)、[系统综述](research-systematic-review.md) |
| P1-3 投稿配置、署名与匿名包 | `4d4a459` | [投稿](research-submissions.md) |
| P1-4 外部意见与实验报告回流 | `e57d188` | [协作](research-collaboration.md) |

这些功能复用现有工件、证据、执行图、人工审核和导出服务。影响查询覆盖已记录关系；提取试查覆盖选定的一至五篇全文；外部实验报告保留“未经独立核验”的身份。它们不构成任意学科的自主科研保证。

## 验证范围

`node scripts/run-research-p0.mjs` 在固定 macOS arm64 环境顺序运行通过 19 项，覆盖真实 SQLite、PDF 解析、实验执行、图稿、LaTeX/Typst 编译及投稿包。与 Electron smoke 并行的较早一次运行遇到进程监管失败，根因未定位。

模型输出和部分外部响应来自受控夹具，适用范围为工程回归。完整命令、历史失败和环境信息见[原始验收记录](https://github.com/ryzqi/Roc/blob/0ea0b6c730c0825ce1173325d946cd5457953131/docs/research-workflow-validation-2026-11-23.md)。
