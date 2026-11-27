# Findings & Decisions

## Requirements
- 三阶段：零重排、8 原则减负、动效与压测；每阶段独立可验收并 Git 提交。
- Renderer 单壳，项目文献列表属于 canvas，不创建新 route 或第二套前端。
- 圆角 6/8/12/16，正文 13px，chrome 12px，语义色和类别图标维持项目口径。
- Drawer/Popover 必须脱离列表流；输入和 Agent 状态必须保留真实权限、焦点与 IME 契约。

## Research Findings
- 起始分支 main，只有用户提供的未跟踪界面优化.md；无已有代码修改。
- 已有 React 19.3.1、Electron 45.3.4、TypeScript 7.0.2、motion 14.14.0、react-virtuoso 4.18.23。
- 已有 useLiteratureStore、LibraryVirtualizedRows、LiteratureProcessingPanel 与 durable acquisition retry/cancel。
- useLiteratureStore 已有搜索防抖、跨项目请求守卫与 archiveItem；需要确认恢复合同后实现撤销。
- shell 断点与库 Inspector 断点分别负责不同区域；不能为文献库调整破坏全局 shell。
- LibraryList 当前两行工具条，筛选/全选在文档流内插入，行高由两行题名、换行元数据与选中状态决定。
- LibraryVirtualizedRows 已懒加载且保留 wheel/thumb 与键盘接管，默认预估 88px；改为固定 64px 不能丢失已有导航守卫。
- LiteratureHubView 默认阅读页 + 240px 可收起列表；需在同一 retained host 内增加列表/Inspector 浏览模式，外部阅读深链仍打开全文。
- 当前没有共享 Floating UI Popover；新增定位原语仅负责浮层/焦点，不引入第二套视觉组件库。
- UI 验收已有真实 Electron fixture；build 后运行，禁止 build 与读取 dist CSS 的 fixture 同时执行。
- 匹配到 React UI/UX 指引：浮层焦点返回、泛型接口、列表稳定 ID；采用符合本任务的焦点与稳定 key 项。
- @floating-ui/react 固定版本 0.27.20 已写入依赖与 lockfile；共享 AnchoredPopover 由浮层任务核验焦点与坐标菜单。
- 已把列表行锁定为 64px，复选框轨道常驻，悬停动作绝对定位，归档筛选脱离文档流；这些改动尚未通过修改后运行验证。
- baseline 文献列表 11/11 检查通过，200 篇仅挂载 13 行；证据位于 /tmp/roc-ui-baseline。
- PDF 默认 startParse 已覆盖全文解析与索引；不能把 ok:true 或静态定时进度当作就绪状态。
- 全库 archive 影响所有项目并退休科学来源；项目移除使用 linkItem(false)，Undo 使用 linkItem(true)。
- 文献宿主采用单击 Inspector / 明确阅读按钮或双击全文；阅读深链保留原入口，列表保持挂载。

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 列表以现有 Virtuoso 固定行高重构 | 避免引入重复依赖和丢失现有键盘导航/分页能力 |
| 每阶段保留运行截图与布局测量 | 样式静态审计不能证明 CLS、滚动与焦点稳定 |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| CodeGraph index v1.6.0，engine v1.6.4 | 关系可能缺失；以实际文件/调用路径验证，不主动重建 |
| 查询含不存在 components/ui 目录和 research-literature.md | 改用实际 shell/shared/literature 目录和 docs 索引 |

## Resources
- 界面优化.md
- AGENTS.md，docs/adr/0022-single-frontend-after-cutover.md，docs/adr/0023-visual-and-motion-spec.md
- .agents/skills/b-end-design-system/SKILL.md
- .agents/skills/desktop-agent-ui/SKILL.md
