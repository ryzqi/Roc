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
- 文献元数据列表已有 250ms 防抖；真实全文入口 RagStudio 仍手动提交检索，需要补齐实时搜索并保护旧请求身份。
- 阶段三沿用现有共享 motion.ts；根 MotionConfig 的 reducedMotion 尚未保证所有 scale/位移和 CSS 披露归零，需要一条全局适配链。
- 原生导入 details 的 block-size 过渡让快速 Space→Tab 被 focus trap 回送关闭按钮；唯一变量取消该局部过渡的真实窗口 probe 通过。表单披露只需原生开启，活动流披露将在阶段三统一检查。
- 阶段三将保持浮层定位元素不参与动画，仅动其内容；选择滑块、图标反馈、批量/撤销和可视行补位复用共享事件预设。拖拽轨道不插值，快速原生滚动暂停行级表现。
- Floating UI 关闭时保留 x/y，但复位 isPositioned；退出 DOM 的可见性必须按同一次挂载的定位历史保留，初次未定位仍隐藏。Inspector 的边界渐隐、遮罩与内容应同步折返，关闭时立即 inert。
- 性能验收区分 RAF 调度间隔、输入到第二次 RAF 和实际渲染帧；不能将前两者作为物理 60/120fps 或每帧 8/16ms 的证明。阶段三补充实际 trace / paint 证据并如实报告环境限制。
- 全文容错只做读时文本投影，注册到每个 Main/worker 连接；原有 FTS/字面候选优先，容错填充剩余候选。查询队列最多一个运行和一个最新待运行请求，清空/IME/离开/项目切换立即使旧回执失效；问 AI 使用本次显式请求的当前回执。
- 缓存按内容键存储 2048 条、保守字符串预算 8MiB；短 ASCII 不缓存，32768 字滑动窗口避免大文本投影爆量。1200 条文献 warm page+count 约 9ms；生产只读 worker 与 Main 的 10000+ chunk 搜索保持一致且原始行/回执字节未改变。
- Undo 按钮禁用 / 消失会让原生焦点回落 body；恢复成员关系的 RPC 返回早于列表刷新完成。焦点恢复必须等待成功恢复的行实际挂载，并用作用域、查询及用户焦点所有权守卫，不能仅同步调用 focus 或改变选中文献。
- Durable 导入 ledger 会直接返回相同 requestId 的旧收据；成功 DOI / 候选导入后的再次加入必须开启新意图，未知失败重试仍复用原意图。后台刷新保留 ready 行时应单独呈现 error，不靠 loading/error 状态卸载列表。

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 列表以现有 Virtuoso 固定行高重构 | 避免引入重复依赖和丢失现有键盘导航/分页能力 |
| 每阶段保留运行截图与布局测量 | 样式静态审计不能证明 CLS、滚动与焦点稳定 |
| 项目移除使用解除关联与六秒撤销 | 保留全局文献、科学来源和其他项目关系，不将全库归档包装成局部删除 |
| PDF 自动补全为请求级模式，显式手工模式优先 | 不改变持久化 schema/receipt，保留既有导入调用与用户手工覆盖 |
| 已加载状态筛选与全库后台搜索分开说明范围 | 批量状态只覆盖已加载的页，不能使后续页搜索匹配不可达 |
| 就绪要求当前解析和实际语义索引均通过校验 | 解析回执不能证明索引就绪；不通过计时器制造完成状态 |

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

- 240px 导航栏原 132px 行尾动作会覆盖标题中心；440px 以下缩为阅读 / 更多 68px，菜单及快捷键保留复制 / 问 AI。真实 hover 命中、窄栏 Tab 和明暗裁切全部通过。
- 第三阶段计数不能只依赖 generic span aria-label；可访问树使用独立 sr-only 完整数值，视觉数字整体 aria-hidden。Inspector 的方向必须由当前可见排序决定，不能按原始 items 顺序推断。
- 最终 4x CPU trace raw CLS=0、挂载 17/1000 行，但 RAF P95 32.5ms、最长 task 36.838ms；严格帧预算未达。LayerTree 不发 layerPainted 时，空事件不等于零重绘；采用 Paint / invalidation 节点追踪和实际 Paint Flashing 截图，明确不据此宣称完整 raster damage 或物理 FPS 通过。
