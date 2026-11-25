# Renderer 状态清单与阶段任务

本清单记录 [UX 与动效合同](README.md#阶段交付)的 P0 起点及 P1–P6 交付。源码起点为
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

P5 业务调用点迁移后为 405 个 Renderer 源文件、238 个含索引条目的文件、
2258 个模板/路由、35 个合同。模板数增加主要来自共享状态入口；虚拟行、PDF、
图谱和编辑正文保留原行为，不能把这些模板数称为已覆盖状态数。

P6 产品源码保持 P5 最终构建，索引仍为 **405 源文件 / 238 含控件文件 /
2258 模板与路由 / 35 合同**。35 个合同的 evidence/runtime_acceptance 逐项映射到
当前回归、五轮报告或仍待验证的路径，源码身份为 `5bbe60d735179e69fe340fee29b65cbacd233dc1`。
全量回归和定向修正的已验证并集、布局、长流限制及原生包结果见
[P6 验证](validation.md#p6)。静态条目不转换为运行通过状态。

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
P1–P5 证据保留其阶段范围；当前 P6 运行证据以 CSV 的指定测试/场景为准。
未列的正常、失败/取消、中途第二次操作及其全组合继续待验证。

| 合同 / surface | before → trigger → pending → success | failure / cancel / undo | repeat / identity / focus / long content；源码依据 |
| --- | --- | --- | --- |
| <a id="s01"></a>**S01 壳体左右栏与检视区** | 关闭/内联/浮动 → 顶栏开关或快捷键 → CSS 边缘进出 → 目标栏可用。DOM/资源保活，遮罩同步过渡。 | Escape/遮罩走原关闭入口；工件脏状态仍由离开守卫决定。 | 关闭立即 inert/aria-hidden，退出中重开保留节点与草稿；断点先切几何。`app/WorkspaceLayout.tsx`；F01。P3 真窗反向、宽窄/深浅裁切、检视守卫范围见阶段验证；物理输入另验。 |
| <a id="s02"></a>**S02 分栏拖拽** | 当前宽度 → 指针/方向键/重置 → RAF 视觉跟手 → 释放写一次最终宽度。 | Escape/pointercancel/分隔条卸载恢复起点，拖动中没有偏好写入；收起动作单独保存。 | 指针反向不 tween；旧作用域回调不写新项目；键盘可达且一次写入。`shell/ResizableDivider.tsx`、`app/useLayoutPersistence.ts`；F02/F14。P3 存储与取消回归、生产帧对照见阶段验证。 |
| <a id="s03"></a>**S03 顶栏菜单/项目切换** | 当前项目/布局 → 原生 Popover → 选项可读 → 选择项目或布局。超过 12 项提供本地题名搜索和清空。 | Escape/点击外部关闭，项目切换走草稿守卫，加载失败仍有回退。 | 打开搜索聚焦，关闭重置查询；当前项目不重复导航；原生搜索先清空、再 Escape 关闭。`shell/WindowChrome.tsx`、`shell/chrome.css`；F05/F17。P1 的 100 项选择/空态/焦点回归见阶段验证；P0 输入比例成绩仅对应原基线，物理鼠标仍待验证。 |
| <a id="s04"></a>**S04 画布/侧栏导航** | 当前 view/subview → 导航/快捷键 → 新模块加载，旧页保留并提示目标 → ready 后轻量遮层交接。 | 模块失败显示错误与重试，旧内容可读。 | 草稿宿主与滚动保持；共用实例隔离的 SelectionIndicator，正文不动画。`canvas/WorkspaceCanvas.tsx`、`shell/AppNavigation.tsx`、`app/ViewContent.tsx`；F03/F04。P3 冷热切换、失败重试及宿主身份回归见阶段验证。 |
| <a id="s05"></a>**S05 命令搜索** | 当前项目/选中对象 → 搜索快捷键 → 分组检索 → 键盘选择目标。 | 无结果给可理解空态；关闭不改变现有对象。 | CJK IME、方向键/Enter/Escape、跨对象结果隔离；长列表有界。`shell/SearchPaletteModal.tsx`、`shell/use-search-groups.ts`。P6 原生清空/Enter、空查询、键盘滚动/焦点及合成 CJK 确认回归通过；物理 IME 另验。 |
| <a id="s06"></a>**S06 通用浮层/确认/空态/错误** | 触发点 → Modal/Confirm → pending 禁止重复确认 → 服务完成后逻辑关闭并还焦点。 | 错误 `role=alert` 常驻；危险确认默认聚焦取消；遮罩不确认。 | 保留退出树实时读取 presence，关闭立即不可交互；恢复尝试结束后视觉卸载不再抢焦点。`shell/ModalShell.tsx`、`ConfirmDialog.tsx`、`ErrorBar.tsx`。P3 模态反向及管理双层退出回归见阶段验证；Radix 例外见 Motion Contract。 |
| <a id="s07"></a>**S07 新建/编辑项目** | 初始字段/已有项目 → 编辑并明确选目录 → 原生目录选择/提交 pending → 打开真实项目。新建空标题建议已选目录名，研究目标仍必填。 | 字段错误与目录选择失败单独展示；脏草稿关闭先确认；不默许目录写入。 | 手改标题和已有项目标题不覆盖；目录 picker generation 隔离旧响应；首焦点标题，语言编辑限制保持。`project/ProjectFormDialog.tsx`、`use-projects.ts`；F06。P1 定向路径见阶段验证。 |
| <a id="s08"></a>**S08 项目门户/排序/归档/删除** | 搜索/筛选/最近/置顶 → 打开或操作项目 → action pending → 列表按真实结果刷新。当前 40 条增量可见。 | 删除已有确认；归档/恢复与删除后果不同；失败留原对象和错误。 | 完整集合 ≤20、同显示 ID 且行可见时局部位置过渡；大集合即使筛少也直接更新。搜索/滚动/窗口/减少动态效果取消过渡，焦点按 ID 保留。`ProjectPortalView.tsx`、`ProjectRow.tsx`；F12。P3 重排反向及大集合即时更新回归见阶段验证。 |
| <a id="s09"></a>**S09 总览与首次任务** | 当前项目及可用资源 → 主要行动/FirstSteps → 对应任务或视图 pending → 到目标对象。清理待确认的已取消任务仍列为当前任务。 | 项目缺失/只读/加载失败说明下一步；清理未确认不提供继续研究。 | 同一入口重复触发不增加步骤；项目切换不保留错项目提示；窄窗行动可达。`project/OverviewView.tsx`、`FirstSteps.tsx`。P4 总览定向回归通过，完整合同其余路径待验证。 |
| <a id="s10"></a>**S10 文献导入** | 文件/DOI/检索/手工字段 → 自动建议与可改引用键 → 共享导入 pending → 入库回执。 | 重复候选明确选择；错误常驻；取消 file picker 不授权读取；脏草稿有守卫。 | P1 人工引用键及空值保持；P5 按真实 operation 反馈，旧 session 不覆盖新对象，入库不宣称索引完成。`literature/ImportDialog.tsx`、`format.ts`；F07。P1/P5 定向路径见阶段验证。 |
| <a id="s11"></a>**S11 Zotero 导入/附件/同步** | 连接/来源/预览 → 选择与授权 → 共享读取/核对/收录 pending → 真实 receipt 与 source state。 | 文件缺失/拒绝/断链明确；取消请求等待最终回执；已请求取消不是完成。 | previewId/syncId/revision 和独立暂停/取消锁保持；来源读取只在主预览入口反馈；回执及逐项结果持久。`literature/Zotero*Panel.tsx`、`use-zotero-*.ts`；F09。P5 定向与宽窄/深浅通过；真实客户端另验。 |
| <a id="s12"></a>**S12 发现/雷达/资源/外部来源** | 查询与筛选 → 搜索/候选预览/下载 → 共享搜索及候选 pending → 真实候选或资源状态。 | 来源部分失败与截断保留；入库回执不表示全文就绪；外部提交/费用不自动授权。 | 新查询覆盖旧目标；选择、滚轮和返回焦点保持；分页/大结果不整列动画。P5 只迁移发现及候选反馈，其它已有反馈保留。`literature/DiscoverySearch.tsx`、`LiteratureCandidateReview.tsx`、`RadarBrowser.tsx`、资源面板。P5 定向通过；P6 既有来源测试通过，真实来源另验。 |
| <a id="s13"></a>**S13 文献库** | 当前列表/选中论文 → 筛选/分页/选择 → 批量引用复制 pending → 真实复制结果。 | 空态、分页失败与重复项区分；复制错误持久，重试不清空列表。 | P5 只改 `BulkCitationActions`；`LibraryVirtualizedRows` 的变高测量、键盘/滚轮接管与 item identity 保持。`literature/LibraryList.tsx`、`LibraryVirtualizedRows.tsx`。P5 列表/复制定向通过，P6 列表回归与 10k 文献五轮通过，物理滚轮另验。 |
| <a id="s14"></a>**S14 文献解析/后台知识任务** | 真实处理阶段 → 查看/重试/取消 → 当前 job ID 一处提交反馈 → 返回实际阶段。 | 错误持久；取消竞争以服务返回的 ready/cancelled 等事实为准；回执不宣称索引完成。 | 高频进度用等宽数字；不逐点动画；旧项目与 picker generation 保持隔离。`LiteratureProcessingPanel.tsx`、`PipelineProgress.tsx`、`KnowledgeJobs.tsx`；F13。P5 正常/失败/取消/第二次操作与布局定向通过。 |
| <a id="s15"></a>**S15 阅读/PDF/笔记/译文/批注** | 当前论文/选区 → 查找/高亮/翻译准备 → 共享局部 pending → 实际保存或逐段译文。 | 设置失败保留草稿；停止翻译等待当前段返回，保留实际已译段；准备原文不等于完成翻译。 | PDF 翻页、批注坐标、选区及阅读恢复不增加动效；原 busyRef 与来源/hash/revision 保持。`PdfReadingTools.tsx`、`ReadingTranslationPanel.tsx`、`PaperPdfView.tsx`、`ReadingViewBoundary.tsx`。P5 高亮和翻译守卫通过；长 PDF 与实机输入见 P6 范围。 |
| <a id="s16"></a>**S16 RAG/Wiki** | 当前索引/页/证据 → 查询/编译/历史 → 共享检索/移交/控制 pending → 真实结果或 job 状态。 | 检索失败保留旧证据与原查询；Wiki 写入失败保留草稿；提交不表示答案/编译已完成。 | expectedRevision、BasisDigest、generation 和来源身份保持；诊断分层已完成；正文/整图不动画。`RagStudio.tsx`、`WikiPages.tsx`、`WikiWorkspace.tsx`；F09。P5 查询、Wiki 写入/历史/换项目与宽窄深浅定向通过。 |
| <a id="s17"></a>**S17 图谱/科学知识/证据关系** | 当前对象/关系/邻域 → 选择/展开/来源检视 → evidence loading → 真实关系及证据。 | 缺少证据、降级与失败说明；不补造结论。 | 图谱只强调当前关系；长图谱不全图 spring；对象版本/来源不能错误共享 identity。`KnowledgeGraphView.tsx`、`GraphNeighborhood.tsx`、`Scientific*`、`Scholarly*`。P6 图谱既有分页/选中/键盘/50k 有界列表和宽窄深浅回归通过；专业关系全组合与真实来源另验。 |
| <a id="s18"></a>**S18 监控** | monitor draft/当前检查 → 保存/检查/暂停/取消 → 锁定 pending → 真实检查结果。 | 取消只表示信号已接收并等待终态；错误/目标变更可见；草稿离开守卫。 | queryVersion/revision 保留诊断可查；旧检查不能覆盖新 monitor；离屏轮询遵循 activity。`MonitorEditor.tsx`、`MonitorsPanel.tsx`、`MonitorHistory.tsx`；F09。P6 既有真实 SQLite 元数据/版本、提交冻结、独立取消/重试去重、草稿/旧响应和诊断布局回归通过；真实来源另验。 |
| <a id="s19"></a>**S19 写作/LaTeX/编译/同步** | 当前文件/草稿 → 保存后编译 → 共享 pending → 实际编译及哈希核验产物。 | 编译错误持久；取消等待真实终态；另存框返回 null 不提示导出成功。 | 草稿、光标、选区与保存前置保持；字符/编辑正文无新增动画。`WorkspaceCompilePanel.tsx`、`SourceEditor.tsx`、`ManuscriptSyncPanel.tsx`。P5 保存/成功/失败/取消与深浅宽窄定向通过；物理 IME 另验。 |
| <a id="s20"></a>**S20 文件树/预览/Notebook** | 当前文件 → 读取/保存 → 共享 pending → 正确预览及实际恢复点回执。 | 不可读/超限/失败保持解释与重试；脏草稿和保存锁保留；片段不可覆盖完整文件。 | 大树与预览身份保持；PDF 仍用 preview protocol；文本/Markdown 草稿与关闭焦点保持。`canvas/files/FileTreeView.tsx`、`FilePreview.tsx`、`NotebookPreview.tsx`。P5 文件保存/失败/关闭/阴影定向通过；P6 大树/Notebook/预览既有回归与原生 preview 通过。 |
| <a id="s21"></a>**S21 Git** | 工作树/commit draft → 刷新/提交/推送 → 共享 pending → 真正 Git 回执。 | discard 确认、失败草稿与 diff 保持；取消推送保持原生可聚焦按钮和 aria-disabled 守卫。 | 大 diff 不动画；分支/项目守卫保持；成功信息来自真实 commit/push。`canvas/git/GitPanel.tsx`、`GitBranchSwitcher.tsx`、`GitFileDiff.tsx`。P5 草稿与宽窄深浅定向通过，P6 既有请求/草稿/隐藏状态回归通过，真实远端另验。 |
| <a id="s22"></a>**S22 终端** | 当前 PTY/session → 开启 → 共享启动反馈与原生字符流 → 后端连接状态。 | 启动失败与退出码可读；结束进程不表示撤销磁盘操作。 | 顶部唯一播报，overlay announce=false；xterm/PTY、隐藏恢复、选区及 IME 接线保持。`canvas/terminal/TerminalView.tsx`。P5 清屏/隐藏恢复/截断/布局定向通过；实机输入另验。 |
| <a id="s23"></a>**S23 审批/HITL/问题卡** | 等待审批/问题与明确影响范围 → 批准/拒绝/回答 → 共享 submission pending → 真实授权结果/续跑。 | 拒绝未提交授权；授权失败可重试；历史审批说明不作为 live status；不把已执行操作称为可撤回。 | runId/toolCallId/receipt 是唯一身份；重复审批防重；出现不强制滚动、不抢输入焦点。`assistant/HitlApprovalDock.tsx`、`blocks/approval-cards.tsx`、`question-card.tsx`。P4 三类真实助手审批与焦点回归通过；P6 深度助手 64/64 覆盖审批/提问/取消与强制恢复。 |
| <a id="s24"></a>**S24 Composer/附件/模型选择** | 当前草稿/附件/模型 → 发送或移除附件 → 即时 pending，保持本次发送/回复/纠正/追加意图 → 当前消息进入真实运行。 | 发送失败保留可重试草稿；停止等待真实确认，不宣称撤销外部副作用。 | 已有 element-scoped View Transition 保持；scope、附件读取、重复提交和模式切换隔离；CJK IME、输入焦点与选区稳定。`assistant/composer.tsx`、`composer-draft.ts`、`model-picker.tsx`。P4 Composer 12 项及真实助手守卫回归通过；物理 IME 待验证。 |
| <a id="s25"></a>**S25 助手转录/历史** | 当前会话/用户阅读位置 → prepend/tail/new message/定位 → history loading → 可读历史/当前消息状态。 | 历史失败保留现有转录；定位可取消。 | `react-virtuoso` 与用户滚动接管保持；当前消息状态才驱动工具 busy；历史无 busy/live；跨会话恢复不整列 FLIP。`assistant/transcript-panel.tsx`、`blocks/message-row.tsx`。P4 用户上滚/换会话与 5000 历史五轮通过；P6 10k 启动挂载 13 行，5000 增量 P95 25.2ms 目标未达；实机阅读另验。 |
| <a id="s26"></a>**S26 助手科研任务进度** | 后端 task status 与清理原因 → 进度/详情/控制 → 真实 action pending → 终态留在原位置。 | 清理等待显示“正在取消”，清理失败显示“资源清理未确认”；有能力且清理确认后才继续/恢复。 | 与任务中心共用纯展示投影，底层 data-status 保留；低频数字等宽，流式变化不逐点动画；不抢读者焦点。`ResearchTaskProgress.tsx`、`task-presentation.ts`；F13。P4 任务状态/清理/重挂载回归通过，完整范围见阶段验证。 |
| <a id="s27"></a>**S27 工具/活动/会话/诊断** | 当前活动或 session → 披露/复制/切换/重试 → 当前消息且本身/祖先活动时局部 busy → 真实工具/会话状态。 | tool/hook/guardrail 失败可读；诊断保留证据与复制。 | 原生 details 双向展开复用；完成及历史停止 busy/live；工具 identity 不跨执行；无 token 逐字动效。`assistant/blocks/*`、`SessionListView.tsx`、`RunDiagnostics.tsx`。P4 活动 7 项含 reduced motion 通过；P6 深度助手和既有会话/诊断回归通过，全组合另验。 |
| <a id="s28"></a>**S28 科研任务控制与诊断** | active/waiting_approval/paused 等 → 暂停/取消/继续/恢复审批 → 等待清理/恢复 → 真正 task status。跨表面共用清理状态文案。 | 取消需确认当前任务，说明不撤销已完成操作；暂停一键。cancelled 有 continuationRunId 时可能可继续，不能一律写“不可恢复”。 | running ref 防重复；身份或状态变化清除旧确认；cleanup_pending/failed 持久阻止恢复，重挂载不伪称清理完成。`research/tasks/TaskControls.tsx`、`TaskFactsPanel.tsx`、`task-presentation.ts`；F10。P1/P4 定向路径见阶段验证。 |
| <a id="s29"></a>**S29 管理/任务中心** | 当前管理领域/作用域 → 记忆/技能/MCP/任务/环境行动 → 共享 store pending → 真实结果与状态。刷新反馈与既有任务内容并存；技能读取、启停、导入、内置检查和安装按实际请求反馈。 | 删除/配置改动按真实后果确认；busy/dirty 离开守卫；失败保留草稿。清理等待归当前、未确认归失败，已确认取消才归历史。 | scope identity 隔离项目/全局；与助手任务状态一致；内置安装只在当前 source ID 旋转；原始诊断可展开，长列表和后台任务不抢焦点。`management/ManagementPanel.tsx`、`TaskCenterOverview.tsx`、`sections/*`。P4 任务中心/清理分组/刷新/换项目及 P5 技能导入、安装重试、深浅宽窄定向通过；P6 既有管理回归通过，真实 MCP/环境与全组合另验。 |
| <a id="s30"></a>**S30 RAG 设置** | 当前配置/知识索引 → 编辑/探测/保存 → 保存与读取 pending → 真配置及收录状态。 | 原始 error 保留；探测/保存失败不丢字段；秘密不持久化到 renderer。 | P1 默认显示阶段、收录/剩余计数；phase/revision/generation 保留在诊断。expectedRevision 使用 settings.revision；IME/焦点/草稿保持。`settings/sections/RagSection.tsx`；F08。设置定向路径见阶段验证。 |
| <a id="s31"></a>**S31 设置全部领域** | 当前 13 分区、搜索、脏状态 → 导航/编辑/保存 → save pending → 真正配置完成。 | 重大影响确认、脏草稿关闭/重置确认与失败持久；可重试，不削弱守卫。 | P1 记最近合法分区，未通过草稿守卫的切换不写偏好；只保存导航 ID。P3 弱交接保持焦点；密集表单可滚动，缩放不裁切。`SettingsModal.tsx`、`settingsRegistry.ts`、`sections/*`；F11。P1 的 29 项设置回归见阶段验证。 |
| <a id="s32"></a>**S32 工件/审阅/出版/生产** | 当前 artifact/version/source → 核对公开清单 → 共享核对/生成请求 pending → 真预览及后台作业回执。 | sourceHash/expectedRevision、许可及 requestId 保持；失败不清草稿；请求接受不表示 ZIP 交付完成。 | P5 只迁移发布清单编辑器；其它编辑/回执保留原合同，无全容器动画。`artifacts/StageArtifactInspector.tsx`、`ExportPublicationEditor.tsx`、`ReviewInspector.tsx`。P5 导出正常/失败/取消/换对象与键盘布局通过；P6 既有工件/出版回归通过，真实外部服务另验。 |
| <a id="s33"></a>**S33 共享表单/页面反馈** | idle/可编辑字段 → trigger → loading/disabled/aria-busy → 真 success 内容投影。 | 原始失败和重试保留；不持有服务/权限/草稿，不自造完成。 | P5 unstyled 保留调用者几何/焦点；ActionStatus 单一 live region，TransientStatus 只收起真实完成。原复制计时器复用，错误/回执不新增到期。`shared/form-ui.tsx`、`action-status.tsx`、`page-ui.tsx`；F13/F14。P2 画廊及 P5 业务接线通过，P6 现有调用点全量回归与 405 源文件 AST 审查通过，实机读屏另验。 |
| <a id="s34"></a>**S34 启动/项目失败入口与选区命令** | 启动/项目读取失败 → 重试或返回门户；阅读/写作选区 → 选区命令/替换预览 → pending → 真实提案或应用到草稿。 | 项目失败仍有返回入口；拒绝提案不更改原文；选区变化时丢弃过期预览。 | Skip-to-canvas 保留；选区命令不拥有路由/Agent 状态；⌘K、IME、焦点与原选区归属保持。`app/AppShellContent.tsx`、`canvas/InlineCommandBar.tsx`。P6 核心/原生 smoke 的正常启动、资源和 preview，以及鼠标选择/原生复制/代码空白与草稿保持回归通过；默认资料根 Finder、失败入口实机及完整命令合同另验。 |
| <a id="s35"></a>**S35 surface 注册/路由** | surface id/current project → query/menu intent → lazy view 或 drawer loading → 在注册位置显示。 | unknown/parked 能力不转为新 page；加载错误可重试，旧视图可读。 | 仅一个 AppShell；项目切换走守卫；tab/subview/drawer 语义一致。`src/shared/surfaces.ts`、`app/routes.ts`、`view-registry.ts`。P6 规范路由/surface、草稿守卫和懒加载既有回归及 AST 快照通过；未列焦点/历史全组合另验。 |

## 风险与提交阶段

优先级顺序为数据丢失/越权、任务阻断、交互误解、频繁操作、装饰优化。
下表保留 P0 源码起点的风险与实施安排；当前交付和运行证据见上述合同及阶段验证。
“源码确认”只描述该起点事实，用户影响的实机结论需另有证据。

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

P0 当次证据为源码定位、AST 模板索引、快照一致性检查与 F17 的输入坐标校准复现。
`tests/renderer` 已有针对壳、导入、任务、审批、草稿、阅读、Git、管理和工件的真实
Renderer 回归，可按改动选最小集合；本 P0 不重复运行全套业务测试。

需要运行证据才可勾选的项目：八条用户旅程正常/失败/中断、宽窄与深浅、减少动态效果、
动作帧采样、500/5000/10k 长历史、长 PDF/大代码、中文 IME、VoiceOver、物理触控板、
60Hz/120Hz 可用硬件与低功耗。录屏、原始 trace 和构建目录为采样临时物；
最终只保留可复现协议、正式统计报告与必要失败说明。未完成项目不能用旧版记录替代。

P6 现有测试的已验证并集为单元 2781 通过、1 原有跳过，Renderer 1036/1036；
布局 783 状态 / 2097 控件与焦点检查 cut=0，核心 smoke 23/23、深度助手 64/64、
隔离原生包 smoke 通过。全量命令的初次失败和定向补跑分别保留，准确范围见
[阶段验证](validation.md#p6)。CSV 映射 35 个合同的指定路径，未把完整合同全组合
或物理输入统一勾选。

最终三份动作报告各八场景 × 五轮，无长任务、RAF >50ms 或缺失反馈；拖动内 0 写、
释放 1 写、Escape 0 写。长历史/增量、10k 文献、10k 启动与长 PDF 的正式报告
分别保留；5000 增量 P95 25.2ms（起点 25.1ms），继续记录 20ms 目标未达。
20 次画布切换为 10.4→16.5ms，代价单列。S30 独立 RAG 后端计数/诊断仍待验证。
物理 IME/触控板/VoiceOver、实际显示帧、低功耗、第二台 Mac、真人八旅程、真实服务、
默认资料根 Finder 与长期资源继续保留实机缺口。临时产物核验后清理，正式 JSON 保留。
