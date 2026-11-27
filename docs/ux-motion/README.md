# UX 与动效合同

动效生命周期和状态反馈见 [Motion Contract](motion-contract.md)。视觉决策见 [ADR 0023](../adr/0023-visual-and-motion-spec.md)，页面入口见[科研工作台](../research-workbench.md)。

| 文档 | 用途 |
| --- | --- |
| [界面清单](surface-inventory.md) | 状态编号与覆盖范围，供 AST 交互审计引用 |
| [交互矩阵](interaction-matrix.csv) | 静态控件索引及正常、失败、中断、焦点与减少动态效果覆盖 |
| [Motion Contract](motion-contract.md) | CSS、Motion 和原生交互的共同生命周期 |
| [采样协议](benchmark-protocol.md) | 生产构建动作采样、环境、固定报告和实机验收限制 |
| [阶段验证](validation.md) | 历史工程样本、复跑协议与实机验收边界 |
| [P0 基线](baseline-2026-11-24.json) | 当前源码起点的五轮生产动作报告 |
| [P3 对照](after-p3.json) | 同一硬件与夹具的壳体、拖拽和流式动作五轮报告 |
| [P4 长历史](after-p4-history-5000.json) | 5000 条历史与 500 流式增量的五轮生产动作报告 |
| [P6 动作对照](after-p6.json) | 最终构建的八类动作，各五轮；500 历史、500 流式增量 |
| [P6 长历史](after-p6-history-5000.json) | 最终构建的 5000 历史、500 流式增量，各五轮 |
| [P6 减少动态效果](reduced-motion.json) | reduce 下的同一动作协议，各五轮 |
| [P6 业务负载](after-p6-workloads.json) | 文献、画布切换、500/5000 历史与增量、启动，各五轮 |
| [起点业务负载对照](baseline-workloads-3eb8fd6.json) | P6 补测源码起点的同负载五轮报告，核查长流性能限制 |
| [P6 长 PDF](after-p6-pdf.json) | 每轮 400 页 PDF、200 次连续翻页与后台解析，共五轮 |
