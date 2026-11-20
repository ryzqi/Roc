# UI 重构验证记录

## P0 工程基线（2026-11-20）

macOS 27.2.1 arm64，Electron 45，基线提交 `dd7511a`。隔离数据根启动当天既有 dist，窗口 1320×860，原生最小 1184×640。门户、默认写作、文献、发现（雷达）、知识（RAG）五面均成功加载，无 pageerror、无页面横向溢出，阴影审计均 `cut=0`。截图检查确认默认空写作页、重复文件列表，以及文献七标签带来的多层导航。

仓库根执行：

- `pnpm check:renderer-chunks`：通过，eager JS 481730 bytes / 10 files。
- `python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer`：239 文件通过。
- `pnpm typecheck`：通过。

导航诊断仅在当前窗口内存保留最近 500 个事件，记录页面类别和相对耗时，不含项目标识、查询、文件路径或凭据，不自动上传。任务事件继续使用实际运行事件；本地诊断不构成第二套任务状态。

用户访谈、T1–T3 真实外部服务任务、SUS 与灰度发布尚无证据；工程检查不能代替这些验收。临时截图和隔离运行数据在检查后清理，不进入版本库。

## P2 壳体与系统

五目的地、工作台、集中旧深链迁移、写作内终端、共享文献宿主与 1200px 抽屉阈值已接入。仓库根 `pnpm build`、`pnpm check:renderer-chunks`、设计规则审计通过；eager JS 482999 bytes / 10 files。

`node --test tests/unit/renderer-routes.test.mjs tests/unit/surfaces.test.mjs`：29/29，通过 1920 路由组合。`node --test --test-concurrency=1 tests/renderer/canvas-view-loading.test.mjs tests/renderer/literature-workspace-layout.test.mjs`：10/10，覆盖共享宿主与草稿保留。

隔离 Electron 实窗完成默认工作台、冷入口导入、五目的地、终端、管理深链、1280px 列布局及 1184px 抽屉检查；浅/深主题无 pageerror、无横溢出，`clip.cut=0`。

## P3 文献与发现

发现页默认搜索，来源部分失败保留结果，批量收录展示后端原始分项回执。导入四入口、六能力；阅读器与后台处理展示五阶段，解析不推断索引，缺记录明确待核验。列表增加当前结果排序与批量引用导出。

仓库根 `pnpm typecheck`、设计规则审计通过。`node --test tests/unit/literature-pipeline-state.test.mjs` 5/5；发现 Electron 回归 1/1；导入状态与编辑保护 12/12；阅读与后台处理 20 项均通过（修正旧文案断言后单独复跑失败项）；文献列表与复制动作测试通过。外部搜索和下载未以 fixture 冒充验收。
