# Renderer 状态清单与阶段任务

本清单对应 `Roc_UX_Motion_Phased_Plan_2026-11-24.md` 的 P0。源码基线为
`3eb8fd6ba1f6f5315ea7670f26c165994c2d34ef`。它区分源码事实、验收要求与运行证据：
**静态索引不是可见性测试，也不是性能成绩。** 未执行的运行路径均标为待验证。

## 索引范围与复现

`interaction-matrix.csv` 是正式状态索引，按 **35 个语义合同簇**记录 `UX-Sxx` ID。
完整 JSX 控件位置通过脚本 `--list` 按需查询，不保存庞大且重复的逐控件 CSV；
每个查询条目仍有可定位的 `UX-*` ID。问题表中的 `F01–F16` 为实施方案的风险 ID，
`F17` 为本阶段采样坐标校准发现，产品重叠尚未证实。一个列表模板可能在运行时生成多个按钮，共享控件内部与调用点也可能重复计数，
所以数量表示**源码模板数量**，不能称为已验收状态数或用户可见控件总数。

扫描 `src/renderer` 的全部 TS/TSX/JS/JSX 文件，以及 `src/shared/surfaces.ts`。
原生 `button/details/summary/dialog/select/input/textarea/a` 与
`ActionButton/ActionStatus/TransientStatus/PageListRow/TextField/NumberField/CheckboxField/SelectField/ModalShell/ConfirmDialog`
均纳入；`motion.*` 控件按其原生标签归类，Popover 属性、显式 `role="dialog"` 和
`onClick/onChange/onSubmit/onPointerDown` 事件节点单独记录。
路由索引同时读取 canonical `APP_VIEWS/AppSubview` 与已有 surface 分类表；
不把工件检查器或项目内工具新增为独立路由。
AST 解析失败直接报错，不跳过文件。

P0 扫描共 **402 个 Renderer 源文件 + 1 个注册表文件**，236 个文件包含索引条目，
共 **2126 个模板/路由条目**：2110 个 JSX/事件模板、4 个 canonical view、
2 个 canonical subview、10 个 surface 分类记录。原生模板包括 button 1060、
details 205、summary 205、select 134、input 168、textarea 83；其它为共享控件及事件入口。
所有模板均获得所属合同；S34 覆盖启动/项目失败入口与阅读、写作共用的选区命令。

P1 更新后仍为 402 个 Renderer 源文件、35 个合同，静态模板/路由为 2146 个；
新增量主要来自诊断披露、取消确认和项目搜索。当前源码摘要与定向证据保存在 CSV，
具体运行覆盖见阶段验证，不能将模板数量当作已通过用例数。

P2 增加共享受控反馈后为 403 个 Renderer 源文件、238 个含索引条目的文件，
共 2152 个模板/路由、35 个合同。新的状态入口纳入同一索引；CSS 与 Motion 映射、
AST 审查及实际画廊的定向证据见 P2 验证记录。

```sh
# 工作目录：仓库根目录
node scripts/ui-audit/index-interactions.mjs
node scripts/ui-audit/index-interactions.mjs --list --surface=S03
node scripts/ui-audit/index-interactions.mjs --write
node scripts/ui-audit/index-interactions.mjs --check
```

无参数只打印统计；`--write` 更新正式 CSV；`--check` 比较当前源码与快照。
合同 CSV 包含源码摘要、基线 commit、文件、状态要求、负责人和运行验收状态；
`--list` 补充各模板的准确行号、触发事件和可观察属性。实施后需要先审查变更，
再更新快照；不能用旧快照声称新版本已验证。
`--check` 只核对静态文件与模板摘要，不替人工运行结论背书。
`--write` 仅在所属合同源码摘要未改变时保留已填写的证据/运行状态及其基线 commit；
源码变化时恢复为待验证，避免将旧成绩带到新实现。

## 页面树与身份

```text
AppShell（唯一窗口壳）
├── 项目门户 / 新建与编辑项目
└── 当前项目
    ├── WindowChrome / ActivityRail / ContextDrawer
    │   └── 文件 / 文献 / 会话
    ├── Canvas（view-registry 懒加载）
    │   ├── 总览 / 发现
    │   ├── 文献库 / 知识库
    │   │   ├── 搜索、导入、处理、阅读 / PDF、笔记、译文
    │   │   └── RAG、Wiki、图谱、来源、监控与资源
    │   ├── 写作 / LaTeX / 文件预览 / 终端
    │   └── 运行 / 任务中心
    ├── 助手（会话、转录、Composer、工具、审批、任务状态）
    ├── 检视 / 工件 / 审阅 / 发布（项目内 inspector）
    └── OverlayHost
        ├── 设置 / 命令搜索
        ├── Git / 管理（记忆、技能、MCP、任务、Python 环境）
        └── 导入、确认与编辑浮层
```

项目身份来自 `projectId`；会话、文献、工件、任务及回执分别使用各自真实 ID。
当前 canonical 画布 view 为 `overview/library/writing/runs`，
`discover/knowledge` 为 subview；`terminal/files` 归写作工具，`tool=tasks` 规范化为
`view=runs`。旧 surface 表中的分类不能据此新增或恢复旧独立画布。
`ViewContent` 保留旧视图直到新模块 ready；隐藏资源依靠 `ViewActivity` 停止工作，
草稿守卫继续有效。媒体断点改变浮层几何，不改变业务对象。权限与副作用来自主进程；
本清单中的“建议”只指派生或只读信息，不授权目录写入、外部提交或付费调用。

## 全部合同的共同验收要求

下表是对源码状态簇的语义审查与后续验收要求，CSV 的状态列引用对应合同。
已经存在的反馈、守卫、虚拟化或焦点逻辑应复用；缺少运行证据的能力不标为通过。

- **before / trigger**：显示当前对象与可执行动作；输入由当前项目、当前选中对象、
  用户草稿或后端状态提供。派生值可建议，用户可改写。
- **pending / success**：触发立即反馈；服务动作防重复提交；完成由真实响应或事件决定。
  文献入库、解析、知识索引与发布是不同阶段，不合并为假成功。
- **failure / retry**：错误常驻可读，说明失败对象及可执行下一步；重试保留原有
  `requestId/runId/receipt/expectedRevision` 语义，不用前端动画伪造终态。
- **cancel / undo**：暂停、拒绝尚未提交的授权、取消后台请求、归档与永久删除分别说明。
  有恢复能力才提供恢复；已发生的磁盘或外部副作用不能宣称已撤销。
- **repeat / identity**：第二次开关改变当前目标，不排队等待动画；对象切换与卸载清理
  过期动画/异步引用；已退出视觉树立即 inert，不再占焦点或触发旧回调。
- **reduced motion / focus**：沿用根 `MotionConfig reducedMotion="user"` 与 CSS 抑制，
  位移/缩放落最终态；保留同等文字、图标、键盘与焦点信息。
  浮层开关沿用 `useOverlayBehavior`，失败、后台完成与动画不抢正在编辑的焦点。
- **long content**：用户滚动、编辑选区、阅读定位优先；不对整个 PDF、终端、图谱或
  虚拟列表做 FLIP，不让离屏状态驱动持续可见动画。

## 按 surface 的状态审查

所有合同负责人为 `renderer`；涉及恢复、权限和回执的事实需由对应主进程合同确认。
“运行：待验证”同时适用于正常、失败/取消和中途第二次操作三个路径。

| 合同 / surface | before → trigger → pending → success | failure / cancel / undo | repeat / identity / focus / long content；源码依据 |
| --- | --- | --- | --- |
| <a id="s01"></a>**S01 壳体左右栏与检视区** | 关闭/内联/浮动 → 顶栏开关或快捷键 → 视觉进出 → 目标栏可用。源码使用 `hidden` 和条件遮罩；P3 补 present/interactive。 | Escape/遮罩走原关闭入口；工件脏状态仍由离开守卫决定。 | 快速反向、跨断点、左栏与右栏切换不产生双焦点区；关闭立即 inert，保留 mounted 重资源。`app/WorkspaceLayout.tsx`；F01。运行：待验证。 |
| <a id="s02"></a>**S02 分栏拖拽** | 当前宽度 → 指针/方向键/重置 → RAF 跟手 → 最终宽度持久化。源码每次 resize 同步写偏好。 | Escape 恢复拖动起点；pointercancel/lost capture 清理。P3 确保中间值未落盘。 | 指针反向不 tween；对象切换/卸载安全收尾；键盘可达，有真实范围值；长内容帧采样待验证。`shell/ResizableDivider.tsx`、`app/useLayoutPersistence.ts`；F02/F14。 |
| <a id="s03"></a>**S03 顶栏菜单/项目切换** | 当前项目/布局 → 原生 Popover → 选项可读 → 选择项目或布局。超过 12 项提供本地题名搜索和清空。 | Escape/点击外部关闭，项目切换走草稿守卫，加载失败仍有回退。 | 打开搜索聚焦，关闭重置查询；当前项目不重复导航；原生搜索先清空、再 Escape 关闭。`shell/WindowChrome.tsx`、`shell/chrome.css`；F05/F17。P1 的 100 项选择/空态/焦点回归见阶段验证；P0 输入比例成绩仅对应原基线，物理鼠标仍待验证。 |
| <a id="s04"></a>**S04 画布/侧栏导航** | 当前 view/subview → 导航/快捷键 → 新模块加载，旧页保留 → ready 后交接。 | 模块失败显示错误与重试，旧内容可读。 | 保留项目身份、草稿与滚动；轻量选中标记可过渡，正文不弹跳。`canvas/WorkspaceCanvas.tsx`、`shell/AppNavigation.tsx`、`app/ViewContent.tsx`；F03/F04。运行：待验证。 |
| <a id="s05"></a>**S05 命令搜索** | 当前项目/选中对象 → 搜索快捷键 → 分组检索 → 键盘选择目标。 | 无结果给可理解空态；关闭不改变现有对象。 | CJK IME、方向键/Enter/Escape、跨对象结果隔离；长列表有界。`shell/SearchPaletteModal.tsx`、`shell/use-search-groups.ts`。运行：待验证。 |
| <a id="s06"></a>**S06 通用浮层/确认/空态/错误** | 触发点 → Modal/Confirm → pending 禁止重复确认 → 服务完成后关闭并还焦点。 | 错误 `role=alert` 常驻；危险确认默认聚焦取消；遮罩不确认。 | 再开不被旧退出回调关闭；关后不可点击；深浅/窄高/减少动态效果等效。`shell/ModalShell.tsx`、`ConfirmDialog.tsx`、`ErrorBar.tsx`。运行：待验证。 |
| <a id="s07"></a>**S07 新建/编辑项目** | 初始字段/已有项目 → 编辑并明确选目录 → 原生目录选择/提交 pending → 打开真实项目。新建空标题建议已选目录名，研究目标仍必填。 | 字段错误与目录选择失败单独展示；脏草稿关闭先确认；不默许目录写入。 | 手改标题和已有项目标题不覆盖；目录 picker generation 隔离旧响应；首焦点标题，语言编辑限制保持。`project/ProjectFormDialog.tsx`、`use-projects.ts`；F06。P1 定向路径见阶段验证。 |
| <a id="s08"></a>**S08 项目门户/排序/归档/删除** | 搜索/筛选/最近/置顶 → 打开或操作项目 → action pending → 列表按真实结果刷新。当前 40 条增量可见。 | 删除已有确认；归档/恢复与删除后果不同；失败留原对象和错误。 | 筛选收缩钳制键盘索引；小列表位置反馈不影响大列表滚动；焦点不能落已删行。`project/ProjectPortalView.tsx`、`ProjectRow.tsx`；F12。运行：待验证。 |
| <a id="s09"></a>**S09 总览与首次任务** | 当前项目及可用资源 → 主要行动/FirstSteps → 对应任务或视图 pending → 到目标对象。 | 项目缺失/只读/加载失败说明下一步。 | 同一入口重复触发不增加步骤；项目切换不保留错项目提示；窄窗行动可达。`project/OverviewView.tsx`、`FirstSteps.tsx`。运行：待验证。 |
| <a id="s10"></a>**S10 文献导入** | 文件/DOI/检索/手工字段 → 自动建议与可改引用键 → 明确导入 pending → 入库回执。 | 重复候选明确选择；错误常驻；取消 file picker 不授权读取；脏草稿有守卫。 | P1 引用键首次人工改写后保留，包括空值；“恢复自动生成”重新使用题名派生。旧 operation/session 不覆盖新对象；入库不宣称索引完成。`literature/ImportDialog.tsx`、`format.ts`；F07。P1 定向路径见阶段验证。 |
| <a id="s11"></a>**S11 Zotero 导入/附件/同步** | 连接/来源/预览 → 选择条目、文件授权、同步计划 → import/check pending → receipt 与 source state。 | 文件缺失/拒绝/断链明确；取消授权区别于取消后台 import；真实重试/ack。 | 保留 previewId/syncId/revision；过期响应不覆盖新页；原始对象移入详情仍可读。`literature/Zotero*Panel.tsx`、`use-zotero-*.ts`；F09。运行：待验证。 |
| <a id="s12"></a>**S12 发现/雷达/资源/外部来源** | 查询与筛选 → 搜索/候选预览/下载 → 获取 pending → 显示真实候选或资源状态。 | 离线/降级/低置信度与失败明确；不能自动授权外部提交或费用。 | 新查询覆盖旧展示目标；选择与滚轮优先；分页/大结果不整列动画。`literature/DiscoverySearch.tsx`、`RadarBrowser.tsx`、`OpenReview*`、`HuggingFace*`、`Resource*`。运行：待验证。 |
| <a id="s13"></a>**S13 文献库** | 当前列表/选中论文 → 筛选/分页/选择/入库 → 局部 pending → 真实列表/阅读对象。 | 空态、分页失败与重复项区分；重试不清空可读列表。 | `LibraryVirtualizedRows` 保持窗口化；键盘与手动滚动优先；项目/论文 identity 明确。`literature/LibraryList.tsx`、`LibraryVirtualizedRows.tsx`、`LiteratureHubView.tsx`。运行：待验证。 |
| <a id="s14"></a>**S14 文献解析/后台知识任务** | imported/parsing/ready/failed 等真实状态 → 查看/重试/取消 → 可确定进度优先 → 当前阶段完成。 | 错误持久，取消信号等待终态，不宣称所有阶段完成。 | 高频进度数字使用等宽，不逐点滚动；离屏停止可见循环；回执与索引身份分开。`LiteratureProcessingPanel.tsx`、`PipelineProgress.tsx`、`KnowledgeJobs.tsx`；F13。运行：待验证。 |
| <a id="s15"></a>**S15 阅读/PDF/笔记/译文/批注** | 当前论文、页/选择/笔记 → 翻页/定位/编辑/翻译 → 局部 loading/save → 返回准确阅读位置。 | PDF/来源失败可重试；笔记脏状态守卫；异步错误不清空可读内容。 | 阅读边界恢复时不跑展开 transition；文本选择、定位、200 页 PDF 和长公式不做整页动画。`PaperReader.tsx`、`PaperPdfView.tsx`、`ReadingViewBoundary.tsx`、`Reading*Panel.tsx`。运行：待验证。 |
| <a id="s16"></a>**S16 RAG/Wiki** | 当前知识索引/页/证据 → 查询/编译/历史 → search/control pending → 真实结果及任务状态。 | 查询降级/编译失败保留错误；按真实 revision 重试；暂停不同于取消。 | `expectedRevision` 保持；来源/历史可达；主视图原始版本编号待分层；不对知识正文/全图动画。`RagStudio.tsx`、`WikiPages.tsx`、`WikiWorkspace.tsx`；F09。运行：待验证。 |
| <a id="s17"></a>**S17 图谱/科学知识/证据关系** | 当前对象/关系/邻域 → 选择/展开/来源检视 → evidence loading → 真实关系及证据。 | 缺少证据、降级与失败说明；不补造结论。 | 图谱只强调当前关系；长图谱不全图 spring；对象版本/来源不能错误共享 identity。`KnowledgeGraphView.tsx`、`GraphNeighborhood.tsx`、`Scientific*`、`Scholarly*`。运行：待验证。 |
| <a id="s18"></a>**S18 监控** | monitor draft/当前检查 → 保存/检查/暂停/取消 → 锁定 pending → 真实检查结果。 | 取消只表示信号已接收并等待终态；错误/目标变更可见；草稿离开守卫。 | queryVersion/revision 保留诊断可查；旧检查不能覆盖新 monitor；离屏轮询遵循 activity。`MonitorEditor.tsx`、`MonitorsPanel.tsx`、`MonitorHistory.tsx`；F09。运行：待验证。 |
| <a id="s19"></a>**S19 写作/LaTeX/编译/同步** | 当前文件/选区/脏草稿 → 编辑/保存/编译/同步 → action pending → 真正保存/编译产物。 | 编译错误与保存失败持久；换项目/文件走草稿守卫；撤销只对应可撤销编辑。 | CJK IME、光标和选区保持；字符流不动效；大文件与分栏不新增全树测量。`latex/SourceEditor.tsx`、`WorkspaceCompilePanel.tsx`、`ManuscriptSyncPanel.tsx`。运行：待验证。 |
| <a id="s20"></a>**S20 文件树/预览/Notebook** | 已绑定工作区与当前文件 → 展开/搜索/选择 → file read pending → 正确预览。 | 文件不可读/超限/来源变化可解释并重试；PDF 使用 preview protocol。 | 大树窗口化、选中可达；禁止 renderer Node；对象切换过期响应隔离，阅读位置按身份恢复。`canvas/files/FileTreeView.tsx`、`FilePreview.tsx`、`NotebookPreview.tsx`。运行：待验证。 |
| <a id="s21"></a>**S21 Git** | branch/工作树/commit draft → diff/stage/discard/commit/切分支 → pending → 真正 Git 状态。 | discard 已有确认；失败保留草稿与 diff；远程写入沿用权限。 | 重复 action 去重；分支/项目切换守卫；大 diff 无字形动效，键盘焦点归属稳定。`canvas/git/GitPanel.tsx`、`GitBranchSwitcher.tsx`、`GitFileDiff.tsx`。运行：待验证。 |
| <a id="s22"></a>**S22 终端** | 当前 PTY/session/workspace → 开启/输入/终止 → 原生字符反馈 → 后端状态同步。 | 启动失败与退出代码可读；结束进程不能宣称撤销已发生磁盘操作。 | 字符流、选区、IME 不加动画；隐藏/恢复尺寸可靠；旧终端不跨项目绑定。`canvas/terminal/TerminalView.tsx`。运行：待验证。 |
| <a id="s23"></a>**S23 审批/HITL/问题卡** | 等待审批/问题与明确影响范围 → 批准/拒绝/回答 → submission pending → 真实授权结果/续跑。 | 拒绝未提交授权；授权失败可重试；不把已执行操作称为可撤回。 | runId/toolCallId/receipt 是唯一身份；重复审批防重；出现不强制滚动、不抢输入焦点。`assistant/HitlApprovalDock.tsx`、`blocks/approval-cards.tsx`、`question-card.tsx`。运行：待验证。 |
| <a id="s24"></a>**S24 Composer/附件/模型选择** | 当前草稿/附件/模型 → 发送或移除附件 → 即时 pending → 当前消息进入真实运行。 | 发送失败保留可重试草稿；停止任务不同于撤销外部副作用。 | 已有 element-scoped View Transition 保持；中断/unsupported/rejection 清理；CJK IME、输入焦点与选区稳定。`assistant/composer.tsx`、`composer-draft.ts`、`model-picker.tsx`。运行：待验证。 |
| <a id="s25"></a>**S25 助手转录/历史** | 当前会话/用户阅读位置 → prepend/tail/new message/定位 → history loading → 可读历史/当前消息状态。 | 历史失败保留现有转录；定位可取消。 | `react-virtuoso` 与用户滚动接管保持；500/5000/10k 有界 DOM；离屏消息不动效；跨会话恢复不整列 FLIP。`assistant/transcript-panel.tsx`、`blocks/message-row.tsx`。运行：待验证。 |
| <a id="s26"></a>**S26 助手科研任务进度** | 后端 task status → 进度/详情/控制 → 真实 action pending → 终态留在原位置。 | needs_input/failed/interrupted/cleanup_failed 区分；有能力才继续/恢复。 | 与任务中心状态文案一致；低频数字等宽，流式变化不逐点动画；不抢读者焦点。`ResearchTaskProgress.tsx`、`StatusPillHeader.tsx`；F13。运行：待验证。 |
| <a id="s27"></a>**S27 工具/活动/会话/诊断** | 当前活动或 session → 披露/复制/切换/重试 → 局部 pending → 真实工具/会话状态。 | tool/hook/guardrail 失败可读；诊断保留证据与复制。 | 原生 details 双向展开复用；退出不可操作；工具 identity 不共享到别的执行；无 token 逐字动效。`assistant/blocks/*`、`SessionListView.tsx`、`RunDiagnostics.tsx`。运行：待验证。 |
| <a id="s28"></a>**S28 科研任务控制与诊断** | active/waiting_approval/paused 等 → 暂停/取消/继续/恢复审批 → 等待清理/恢复 → 真正 task status。 | 取消需确认当前任务，说明不撤销已完成操作；暂停一键。cancelled 有 continuationRunId 时可能可继续，不能一律写“不可恢复”。 | running ref 防重复；身份或状态变化清除旧确认；cleanup_pending/failed 持久阻止恢复，重挂载不伪称清理完成。`research/tasks/TaskControls.tsx`、`TaskFactsPanel.tsx`；F10。P1 定向路径见阶段验证。 |
| <a id="s29"></a>**S29 管理/任务中心** | 当前管理领域/作用域 → 记忆/技能/MCP/任务/环境行动 → 共享 store pending → 真实结果与状态。 | 删除/配置改动按真实后果确认；busy/dirty 离开守卫；失败保留草稿。 | scope identity 隔离项目/全局；与助手任务状态一致；原始诊断可展开；长列表和后台任务不抢焦点。`management/ManagementPanel.tsx`、`TaskCenterOverview.tsx`、`sections/*`。运行：待验证。 |
| <a id="s30"></a>**S30 RAG 设置** | 当前配置/知识索引 → 编辑/探测/保存 → 保存与读取 pending → 真配置及收录状态。 | 原始 error 保留；探测/保存失败不丢字段；秘密不持久化到 renderer。 | P1 默认显示阶段、收录/剩余计数；phase/revision/generation 保留在诊断。expectedRevision 使用 settings.revision；IME/焦点/草稿保持。`settings/sections/RagSection.tsx`；F08。设置定向路径见阶段验证。 |
| <a id="s31"></a>**S31 设置全部领域** | 当前 13 分区、搜索、脏状态 → 导航/编辑/保存 → save pending → 真正配置完成。 | 重大影响确认、脏草稿关闭/重置确认与失败持久；可重试，不削弱守卫。 | P1 记最近合法分区，未通过草稿守卫的切换不写偏好；只保存导航 ID。P3 弱交接保持焦点；密集表单可滚动，缩放不裁切。`SettingsModal.tsx`、`settingsRegistry.ts`、`sections/*`；F11。P1 的 29 项设置回归见阶段验证。 |
| <a id="s32"></a>**S32 工件/审阅/出版/生产** | 当前 artifact/version/source/proposal → 检视/编辑/审阅/发布 → command pending → 真回执/产物。 | expectedRevision 失败不伪成功；删除/发布/外部协作权限保持；脏编辑离开守卫。 | 版本/证据 identity 分开；正常/失败/换对象三个用例按业务区执行；长表/代码无全容器动画。`artifacts/ArtifactInspector.tsx`、`ReviewInspector.tsx`、`*Editor.tsx`、`*Receipt.tsx`。运行：待验证。 |
| <a id="s33"></a>**S33 共享表单/页面反馈** | idle/可编辑字段 → trigger → loading/disabled/aria-busy → success 内容投影。 | Field/FormNote/ErrorBar 保留可见标签、原始失败与重试；不自造业务完成态。 | ActionButton 仅展示 loading，调用者防重；ActionStatus 统一可访问反馈，TransientStatus 只收起真实完成提示。减少动态效果保留文字与图标；长字段不裁切。`shared/form-ui.tsx`、`action-status.tsx`、`page-ui.tsx`、`shell/DelayedFallback.tsx`；F13/F14。P2 画廊与设置回归通过，完整合同其余路径待验证。 |
| <a id="s34"></a>**S34 启动/项目失败入口与选区命令** | 启动/项目读取失败 → 重试或返回门户；阅读/写作选区 → 选区命令/替换预览 → pending → 真实提案或应用到草稿。 | 项目失败仍有返回入口；拒绝提案不更改原文；选区变化时丢弃过期预览。 | Skip-to-canvas 保留；选区命令不拥有路由/Agent 状态；⌘K、IME、焦点与原选区归属保持。`app/AppShellContent.tsx`、`canvas/InlineCommandBar.tsx`。运行：待验证。 |
| <a id="s35"></a>**S35 surface 注册/路由** | surface id/current project → query/menu intent → lazy view 或 drawer loading → 在注册位置显示。 | unknown/parked 能力不转为新 page；加载错误可重试，旧视图可读。 | 仅一个 AppShell；项目切换走守卫；tab/subview/drawer 语义一致；历史/焦点恢复待验证。`src/shared/surfaces.ts`、`app/routes.ts`、`view-registry.ts`。 |

## 风险与提交阶段

优先级顺序为数据丢失/越权、任务阻断、交互误解、频繁操作、装饰优化。
“源码确认”只描述实现事实，不表示用户影响已在实机复现。

| ID | 源码确认 / 待验证事实 | 点击前系统已知信息 | 阶段交付与最小回归 |
| --- | --- | --- | --- |
| F01 | 浮动栏 `hidden` 与遮罩瞬切；实际感知待验证。 | open、side、floating、当前对象。 | P3 presence/inert/反向退出；窄窗开关、Escape 重开、断点切换。 |
| F02 | resize 逐次同步写 workspace layout；掉帧待测。 | 起点宽度、当前指针、范围、项目/布局键。 | P3 只在操作结束落盘；spy 次数、Escape 恢复、指针反向。 |
| F03 | ready 后直接换可见内容；旧页保留正确。 | target、resolved、loadError。 | P3 明确加载目标与弱交接；冷加载失败/重试、阅读/草稿保留。 |
| F04 | 指示器预设存在但导航未使用。 | current view/subview/tab。 | P3 低成本选中反馈；键盘导航与减少动态效果。 |
| F05 | 原生 Popover 无共享生命周期；项目全部列出。 | 当前项目、可用项目、最近项目。 | P1 搜索；P3 受控过渡；Escape、焦点、快速二次点击。 |
| F06 | 名称、目标、目录必填；明确目录选择必须保持。 | 当前已授权工作区/可读目录名/项目字段。 | P1 可编辑建议；目录取消不产生授权，手改内容保持。 |
| F07 | 标题会重算覆盖手改 document key。 | 文件名/题名/用户是否改键。 | P1 auto/manual；手改后标题变化、恢复自动、切对象隔离。 |
| F08 | 设置头部显示 raw phase/revision/ready。 | 索引 counts/真实阶段/settings revision。 | P1 正常状态可读、诊断保留；错误与保存冲突仍可达。 |
| F09 | Wiki/Monitor/Zotero 等主内容有版本/原始对象。 | 任务阶段、来源、可执行下一步。 | P1/P5 分层披露；原值可读可复制，不能删证据链。 |
| F10 | 取消任务直接执行；恢复能力依状态/continuation/cleanup。 | task ID/status/continuationRunId/canRestoreApproval。 | P1 正确后果确认；暂停一键、重复取消防重、换 task 不误取消。 |
| F11 | 设置 key 内容替换；已有搜索/领域/守卫。 | 相关分区、脏状态、来源入口。 | P1 最近相关入口；P3 短交接；导航不丢草稿或焦点。 |
| F12 | 项目筛选/置顶/归档即时重排。 | 可见数量、排序、焦点索引。 | P3 小列表连续反馈；大列表直接更新，删除保留确认。 |
| F13 | 同类 pending/成功/失败展示零件分散。 | 真实 action/task 状态、错误、回执。 | P2 合同与共享反馈，P4/P5 调用点迁移；正常/失败/二次操作。 |
| F14 | CSS/JS 时长分别维护，divider 有 transition-all。 | 语义事件和既有 token。 | P2 映射/AST 规则；P3 缩小 transition 属性；无新动画依赖。 |
| F15 | 历史功能/布局成绩不能证明本次帧性能。 | commit、锁文件、构建、宿主、场景数据。 | P0/P6 普通生产构建与 ≥5 轮动作采样；RAF/GPU/显示帧分开。 |
| F16 | 现有设计审查为正则规则，无转场/中断 AST 闸门。 | JSX/事件/共享原语/例外路径。 | P0 AST 模板索引；P2/P6 加有限有意义规则与代表场景。 |
| F17 | **采样校准，产品重叠未证实**：普通生产 dist，native 1440×900、zoom=2 → CSS 720×450。助手按钮中心 x=694 的 DOM 命中正确。助手开关改变 URL 后，`getZoomFactor()` 可返回 1，而 CSS 与可信输入仍保持两倍缩放；按该 getter 发输入会落到 x=347 的搜索区。原生 Electron `sendInputEvent` 改用原生内容区宽/CSS 视口宽，菜单、左栏、助手各连续十次开关均正确，可信事件落点与目标一致；结束后可恢复 1440×900 CSS 视口。初次 locator 的搜索拦截不能据此认定布局重叠。 | CSS 边界、原生内容区、reported zoom、实际输入比例、可信事件目标。 | P0 采样逐次先做 CSS hit-test，再通过 Electron 原生输入发送可信指针事件，不使用 force。F17 不作为 P1 必修产品 Bug；F05 的项目搜索/菜单合同独立实施。五轮基线已完成，无鼠标场景阻断；不能据此宣称物理鼠标或全状态通过。 |

## 验收证据与缺口

本文件的实际证据为源码定位、AST 模板索引、快照一致性检查与 F17 的输入坐标校准复现。
`tests/renderer` 已有针对壳、导入、任务、审批、草稿、阅读、Git、管理和工件的真实
Renderer 回归，可按改动选最小集合；本 P0 不重复运行全套业务测试。

需要运行证据才可勾选的项目：八条用户旅程正常/失败/中断、宽窄与深浅、减少动态效果、
动作帧采样、500/5000/10k 长历史、长 PDF/大代码、中文 IME、VoiceOver、物理触控板、
60Hz/120Hz 可用硬件与低功耗。录屏、原始 trace 和构建目录为采样临时物；
最终只保留可复现协议、正式统计报告与必要失败说明。未完成项目不能用旧版记录替代。
