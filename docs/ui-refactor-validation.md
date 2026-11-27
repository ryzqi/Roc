# 界面验证

界面行为见[科研工作台](research-workbench.md)和[组件设计契约](design-system.md)。以下检查在仓库根运行，环境和产物管理见[开发指南](development.md)。

| 范围 | 检查入口 |
| --- | --- |
| 交互、焦点与草稿 | `pnpm test:renderer`。按改动选择对应 Renderer 测试 |
| 工作台、助手、文献、设置与管理 | `pnpm verify:p3-workspace`、`pnpm verify:p4-assistant`、`pnpm verify:p5-literature`、`pnpm verify:p8-settings`、`pnpm verify:p9-management` |
| 样式、动效与可见性 | `pnpm audit:design`、`pnpm audit:motion`、`pnpm audit:layout` |
| 生产打包与启动 | `pnpm package:mac`。历史数据库另用隔离资料根验证 |

2026-11-24 的工程基线覆盖 783 个界面状态、2097 个控件及焦点检查，以及 125%、200%、400% 原生缩放。执行命令、已知限制和分阶段结果见[原始重构记录](https://github.com/ryzqi/Roc/blob/0ea0b6c730c0825ce1173325d946cd5457953131/docs/ui-refactor-validation.md)。之后的文献库回归见[文献库验证](ui-library-refinement-2026-11-27.md)，生产采样与实机验收范围见[动效验证](ux-motion/validation.md)。
