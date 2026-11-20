# UI 重构验证记录

## P0 工程基线（2026-11-20）

macOS 27.2.1 arm64，Electron 45，基线提交 `dd7511a`。隔离数据根启动当天既有 dist，窗口 1320×860，原生最小 1184×640。门户、默认写作、文献、发现（雷达）、知识（RAG）五面均成功加载，无 pageerror、无页面横向溢出，阴影审计均 `cut=0`。截图检查确认默认空写作页、重复文件列表，以及文献七标签带来的多层导航。

仓库根执行：

- `pnpm check:renderer-chunks`：通过，eager JS 481730 bytes / 10 files。
- `python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer`：239 文件通过。
- `pnpm typecheck`：通过。

导航诊断仅在当前窗口内存保留最近 500 个事件，记录页面类别和相对耗时，不含项目标识、查询、文件路径或凭据，不自动上传。任务事件继续使用实际运行事件；本地诊断不构成第二套任务状态。

用户访谈、T1–T3 真实外部服务任务、SUS 与灰度发布尚无证据；工程检查不能代替这些验收。临时截图和隔离运行数据在检查后清理，不进入版本库。
