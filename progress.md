# Progress Log

## Session: 2026-11-27

### Current Status
- **Phase:** 2 - Automatic Workflow & Reduced Controls
- **Scope:** 三阶段界面优化，每阶段本地 Git 提交
- **Started:** 2026-11-27

### Actions Taken
- 读取需求、项目规则、B 端/桌面 Skill、TypeScript、React 与 UI/UX 验证指导。
- 轻量 memory 查询无命中，后续以当前仓库为准。
- 初始化根目录文件计划；检查起始 Git 状态。
- CodeGraph 查询文献 store、处理面板、虚拟列表及受影响调用关系。
- 校验文件计划格式通过；按任务分离只读管线调查、真实窗口基线与 Floating UI 原语实现。
- 明确阶段一保留 wheel/thumb/键盘接管与跨项目请求守卫，外部阅读深链保持完整阅读模式。
- 恢复依赖和当前 diff；新浮层、固定网格 / 64px 行高 / gutter / 绝对定位行尾动作已在工作区，尚未执行修改后的 build 与测试。
- 确认按阶段显式暂存；用户提供的界面优化.md 保持未跟踪。
- 文献宿主加入列表浏览 / 全文阅读模式；详情与后台处理进入 340px 独立 Inspector，窄画布通过 Portal 覆盖。
- 修正 Inspector 使用不存在的 document.relativePath；托管 PDF 使用文献 / parse 身份打开既有 Reader 预览。
- 浮层层级区分 modal 语义与键盘所有权，非模态 Inspector 保留列表焦点和行间切换。
- 首轮运行发现浮层快速重开定位失效、窄窗 Inspector 初挂载未读到父级 ref，以及处理详情插入造成 Inspector 内 CLS；分别修定位重算、提交后测量、固定详情槽位。
- 更新旧列表测试的全选入口和归档状态断言以匹配 Portal 披露；原滚动、查询和跨项目保留断言继续执行。

### Test Results
修改前基线：`ROC_WORKSPACE_CAPTURE=/tmp/roc-ui-baseline node --test --test-concurrency=1 tests/renderer/literature-list-layout.test.mjs`，11/11 通过；200 篇 / 13 DOM 行。后续验证必须重新构建。

| Test | Expected | Actual | Status |
|------|----------|--------|--------|

### Errors
| Error | Resolution |
|-------|------------|
| 初次计划 patch 使用错误标题 | 改为匹配 progress.md 的三级标题 |
| 恢复时猜测不存在的 CSS / 测试名 | 使用真实目录与精确选择器定位 |
| 规划 patch 表头不匹配 | 重新以已读取的段落为锚点应用 |

### Floating surface verification
- 新增 AnchoredPopover：固定定位、Portal、flip/shift/size、关闭立即 inert、焦点等待定位完成后移交。
- overlay-stack 区分键盘所有权与 modal；useOverlayBehavior 增加独立 modal 标记，Radix 保留 modal:true，Esc 增加 composition 守卫。
- `node --test tests/unit/renderer-overlay-stack.test.mjs`：7/7 通过；新增测试先复现非模态背景误判，再验证修复。
- `node --test --test-concurrency=1 tests/renderer/anchored-popover.test.mjs`：11/11 通过；16 组明暗 / 700px 与 380px / 四角菜单阴影均 cut=0、hidden=0。
- 该轮 `pnpm typecheck` 仅发现并已通知 parent 修正 LibraryInspector.tsx 的两处 relativePath 字段；浮层、栈与 hook 无类型错误。继续检查既有 Radix 键盘兼容与截图，不触发全仓构建。
| Inspector typecheck 报 ResearchDocument 无 relativePath | 使用现有 openLiterature 阅读请求与 parseId，不构造工作区路径 |

### Phase 1 final verification
- 工作目录均为 `/Users/Apple_501/Desktop/Roc/Roc`。`pnpm build` 已通过（包含 typecheck 与 renderer chunk gate）；`pnpm audit:design`、`pnpm audit:motion`、`git diff --check` 通过。
- 受影响 renderer 回归首轮 63/64 通过。唯一失败是复制拒绝提示挡住重试按钮；已将提示移至动作区左侧并取消提示的指针事件，正在重新构建并执行真实点击回归。
- `node --test tests/unit/renderer-overlay-stack.test.mjs`：7/7；`node --test --test-concurrency=1 tests/renderer/anchored-popover.test.mjs`：12/12；Radix 设置浮层相关回归 4/4。
- `ROC_LITERATURE_CAPTURE=/tmp/roc-ui-zero-reflow-20261127 node --test --test-concurrency=1 tests/renderer/literature-zero-reflow.test.mjs`：7/7，无页面错误。默认、悬停、展开、最终状态的 clip-audit 全部 `cut=0`。
- 1000 篇文献仅挂载 15 行。4x CPU、连续选择 20 篇，原始 layout-shift 总和为 0；RAF 间隔 p95 10.1ms，输入至第 2 个 RAF p95 25.4ms，最长 task 17.244ms。RAF 测量不等于物理帧率，不能宣称严格 120fps 或所有任务低于 16ms。
- 最新 trace：`/tmp/roc-ui-zero-reflow-20261127/zero-reflow-4x-1795753742947.trace.json`；明暗与窄窗截图保存在同目录。
- 最终 `pnpm build > /tmp/roc-ui-phase1-final-build.log 2>&1` 通过；`node --test --test-concurrency=1 --test-name-pattern='library citation copy' tests/renderer/literature-action-guards.test.mjs` 已通过真实失败后重试。提示保持可访问且不遮挡复制动作。
- 阶段一已独立提交：`05cf648 refactor(literature): stabilize library layout and add Inspector`。

### Phase 2 implementation in progress
- 自动 PDF 元数据链与原生拖放桥正在落地。仅请求新增 automatic/provided 模式，不改变持久化数据库或回执格式；手工标题与 CiteKey 保留原值。
- Store 默认导入后启动现有解析 / 索引管线，采用文档 / 项目身份与 in-flight promise 防重复；失败或取消回执不报就绪。
- 同范围后台刷新保留当前行与已加载页数；项目 / 查询改变仍隔离旧内容。接下来验证滚动、焦点与分页并发。
- 共享 StatusBadge、PaperMetaCard 与 ContextMenu 已实现，继续接入列表 / Inspector；批量操作与六秒撤销使用项目解除关联，保护其他项目的文献。
- 原生 PDF bridge 真实 Electron 回归 3/3 通过；其余阶段二运行测试等待源码集成与统一构建。
- 阶段二列表已接入单行 48px 工具条、后台搜索、明确标注的已加载状态筛选、memo 行组件与逐行回执订阅。排序、刷新、多选收拢至顶层筛选浮层；批量栏和六秒 Undo 绝对定位，不改变列表轨道。
- 单行快捷操作统一为阅读、复制引用键、问 AI、更多菜单；项目移除调用 `linkItem(false)`，撤销调用 `linkItem(true)`。成功移除与切换搜索后清除旧勾选，保留 Reader 的草稿离开守卫。
- PDF 文件选择与原生拖放均使用请求级 automatic 模式；手工披露使用 provided 模式。自动识别明确 DOI / arXiv 首部标签与元数据，不将文件名或参考文献当作标识证据。arXiv 注册 DOI 仅作为精确 CSL 查询键，离线不生成虚假 DOI。
- 工作目录 `/Users/Apple_501/Desktop/Roc/Roc`；`node --test --test-concurrency=1 tests/unit/research-document-auto-import.test.mjs tests/unit/research-document-status.test.mjs tests/unit/literature-document-pipeline.test.mjs tests/unit/research-scientific-library-publication.test.mjs tests/unit/research-grobid-publication.test.mjs tests/unit/literature-import.test.mjs tests/unit/zotero-import.test.mjs`：168/168 通过，38.58 秒。
- `pnpm typecheck && pnpm check:ipc` 通过。批量状态核验存储身份、当前解析与数据库索引，1000 条实际导入文档回归验证 SQL 批量上界；不逐行重读源 PDF，Reader / retrieval 保留现有源字节校验。
- `pnpm build > /tmp/roc-ui-phase2-build.log 2>&1` 已通过，包含 renderer chunk gate；`pnpm audit:design && pnpm audit:motion && git diff --check` 已通过（design 289 文件，motion 418 文件）。
- 菜单首轮真实 Electron 3/5 通过，发现显式文献菜单名称被 Floating UI 生成的标签覆盖、Shift+Tab 回到触发按钮后菜单未收起；记录后等待本轮导入回归结束再修复和统一构建。深浅色与 8 个窄窗角落的裁切均为 `cut=0 hidden=0`。
- 工作流、零重排和列表布局 fixture 已更新为最终工具条与快捷键合同，静态校验通过（21/7/11 用例）；仍等待导入 fixture 明确释放真窗，再串行执行。
- 正在核对全文搜索的防抖与大小写、连字符、拼音/简繁容错；阶段二尚未提交。
- 菜单命名与 Shift+Tab 修复已落盘；导入表单使用原生 details，局部取消内容尺寸过渡，保留快速 Space→Tab 题名字段聚焦并修复输入焦点环裁切。初轮导入 9/10、相关 editor guards 5/5，隔离 `transition:none` 的最小复现 1/1，最终回归等待统一构建。
- 项目移除/撤销按项接住意外拒绝，保留其他项成功与撤销重试；PDF 拖入改按真实容器边界退出，避免嵌套 dragenter 使提示滞留；Hub 异常反馈改绝对浮层，不压缩列表并避免重复播报。
- StatusBadge 已改为真实三段轨迹，解析请求 0、索引 1、完整就绪 3，不增加计时进度。主进程中文检索容错与 RagStudio 实时防抖进入实施，新增依赖只进入 Main/worker。
- 恢复后继续核对主进程 / 只读 worker 的检索路径：新增内容投影仅用于读取，不改变数据库、源文本或快照；既有 FTS / 字面命中排在容错候选前，列表 / 总数 / 游标使用同一条件。补充 1000+ 记录成本与大文本窗口上界验证。
- 全文检索采用 250ms 防抖、一个运行请求加一个最新排队请求，问 AI 仍需显式动作；正在补齐清空 / IME / 重新访问相同查询与意外拒绝回归。阶段二源码冻结后统一构建，真窗 fixture 串行运行。
- 阶段二源码已冻结；最终 `pnpm build > /tmp/roc-ui-phase2-build-final.log 2>&1` 通过。`pnpm check:ipc && pnpm audit:design && pnpm audit:motion && git diff --check` 通过（design 289 文件，motion 420 文件）。
- 新 dist 搜索与只读 worker 回归：`node --test --test-concurrency=1 tests/unit/research-search-normalization.test.mjs tests/unit/latest-search-queue.test.mjs tests/unit/research-library-pagination.test.mjs tests/unit/knowledge-vector-search.test.mjs tests/unit/knowledge-candidate-parity.test.mjs tests/unit/scientific-retrieval.test.mjs tests/unit/scientific-query-orchestrator.test.mjs tests/unit/research-search-worker.test.mjs tests/unit/readonly-query-worker.test.mjs`，53/53 通过，34.85 秒。覆盖原始回执字节、10000 chunk 容错、取消/恢复、WAL 事务与改源拒绝。
- 1200 条文献 page+count 查询 cold 96.2ms、warm 9.5/8.5ms；10002 个原始 chunk 的四组生产 Main/只读 worker 容错对照合计 894.3ms。内容投影缓存上界 2048 条 / 8MiB，不写入数据库。真窗验证从菜单与导入开始串行执行，阶段二尚未提交。
- 浮层最终 Electron 回归 ContextMenu 5/5、ImportDialog 10/10、AnchoredPopover 12/12 通过；15 张真实截图已走查，明暗主题与窄窗角落均 `cut=0 hidden=0`。
- 工作流首轮 22/23 通过，定向复现确认键盘 Undo 恢复行后 `activeElement=BODY`。零重排 7/7、列表布局 11/11 通过；所有 fixture 已正常关闭并释放窗口。4x CPU / 20 次选择：16 个挂载行，raw CLS=0，最长 task 15.61ms、RAF p95 10.3ms、输入到第二次 RAF p95 25.4ms；不视为物理帧率证明。
- Undo Hook 现返回实际成功恢复的 IDs；列表等待恢复行挂载后经现有虚拟导航路径返回焦点，保留选中文献。异步期间的用户点击、滚动、焦点转移，以及项目 / 查询 / 排序 / 权限变化取消旧恢复意图。正在补充迟到刷新与虚拟行回归，修复后统一构建。
- Undo 修复后的 `pnpm build > /tmp/roc-ui-phase2-build-undo.log 2>&1 && pnpm check:ipc && pnpm audit:design && pnpm audit:motion && git diff --check` 已通过。只读复核发现成功 DOI 的 requestId 被永久保留，移除后再次粘贴会被旧导入 ledger 收据短路；正在释放成功终态身份并补充真实 ledger 模拟回归，需再次统一构建。
- DOI 与在线候选都在观察到终态收据后释放自己的 requestId；排队 / 执行中及未知传输失败保留身份，迟到请求不能清除新意图。两处修复后 `pnpm typecheck` 与 `git diff --check` 通过，真实收据缓存工作流回归待运行。
- 已保留文献的刷新错误和批量处理状态核验错误现在提供独立重试，手动刷新同时读取文献与状态。新增 retention 回归覆盖初次失败、背景失败保留行 / 滚动 / 草稿焦点与相同 IDs 的状态重试。
- `pnpm build > /tmp/roc-ui-phase2-build-recovery.log 2>&1 && pnpm check:ipc && pnpm audit:design && pnpm audit:motion && git diff --check` 通过；29 项工作流 fixture 完成后独占 Electron 运行，其他真窗测试等待释放。
- 最终工作流 28/29 通过；1000 行虚拟 Undo 焦点正确但严格完整可见性失败。定位实证：视口高 736.90625px，Virtuoso 使用整数 offsetHeight 737，恢复行底部溢出 0.09375px；原生 nearest 也舍入不移动。保留断言，焦点导航在既有所有权守卫后按实际边界一次补偿，待新构建与完整 29 项复测。

- 最终批量 117 项中 104 通过，13 失败。工作流 29/29、后台保留与错误恢复 2/2 通过。失败集中于 Discovery 结构化文案、PDF 补充的严格回执夹具、工作区夹具与分页旧结果发布。分页真实缺陷已修复：刷新排队后丢弃更早回执，保留已提交行；新增持有新快照时旧 append 不能写回的断言。待重新构建与定向验证。
- 分页修复后构建与 IPC / design / motion / diff 审计通过；工作流、分页、retention 共 33/33 通过。后台错误与重试截图已查看。PDF 补充 fixture 已对齐精确任务重试的 parseAutomatically:false 与 document/libraryItemId 真实返回字段，最后定向运行中。
- PDF 精确任务重试 25/25，Discovery 7/7；工作区 fixture 补齐 sources 和显式阅读交互后 7/7。真窗测量确认 240px 导航栏行中部被 132px 快捷操作覆盖，正在减少窄栏外露操作并保留菜单 / 快捷键；生产修改需统一构建后复测。

- 阶段二最终 workspace 7/7、list-layout 11/11 通过；窄栏保留阅读 / 更多，A/C 与菜单保留完整能力。170/240/420px 明暗 cut=0，64px 行高与标题中心命中已验证。Electron 已释放，进入阶段二提交。

- 阶段二提交 `e85d64a`。阶段三首轮 typecheck、build、design 295 / motion 428 文件审计通过。共享 live reduced store、浮层复开 latch、Inspector交接、分段滑块、图标/数字反馈与可视行移除已落盘。首轮浮层20/23通过：两项高刷采样不足，另发现退出中切reduced残留极小scale；局部呈现层将立即归零，待统一重建。

- 阶段三通用桌面真窗 90/90、浮层 13/13、按钮 4/4；shared motion 单测 7/7。按压断言更新为 scale .97 并等待回弹后做静态尺寸审计；测试夹具补齐 Motion Provider。
- 只读复核发现 AnimatedCount generic span 的 aria-label 不能可靠提供读屏值，已改独立 sr-only 当前文本并增加 AX tree 断言；Inspector 切换方向现由可见排序计算，新增反向题名排序的键盘回归。
- `pnpm build > /tmp/roc-ui-phase3-build-accessibility.log 2>&1 && pnpm check:ipc && pnpm audit:design && pnpm audit:motion && git diff --check` 通过。8 套文献 fixture 正串行运行，捕获 `/tmp/roc-ui-phase3-final/`。

- 文献组合首轮 79/87；七项 AX matcher 与 node:test 不兼容，改为直接轮询真实 ariaSnapshot 后计数 / 列表 / 分页 / retention 25/25。最后 zero-reflow 9/9，工作流 29、工作区 7、操作守卫 17 已全部通过；第三阶段最终去重并集 Renderer 194/194、unit 7/7。
- 最终 4x CPU / 20 次切换：1000 文献仅挂载 17 行，raw CLS=0，最长 task 36.838ms，RAF P95 32.5ms / max 34.3ms，输入到第二次 RAF P95 42.4ms。严格 8/16ms 帧预算仍未达，不能报告物理 60/120fps 通过。
- LayerTree 无 layerPainted 事件，不能把空数组当零重绘；改用真实 Paint / invalidation 对照 Inspector 的 124 个 backend node IDs，明暗均 0 命中。Paint Flashing 截图已查看，绿色限于悬停行及附近控件。节点追踪和截图不等于逐帧光栅损伤证明。
- 最终构建 eager JS 621105 bytes / 17 files，设计 295 文件、动效 428 文件 / 0 违规。最终代码只读复核与文档收尾；按显式文件清单提交阶段三，保护未跟踪的界面优化.md。
- 收尾核对发现此前浮层 13/13 缺少完整命令日志，独占 Electron 补跑 `node --test --test-concurrency=1 tests/renderer/surface-motion.test.mjs`：13/13、11.40s，日志 `/tmp/roc-ui-phase3-surface-final.log`。已更新验收文档、Motion 合同和计划，将代码 / 自动化完成与性能目标缺口分别记录；本记录随阶段三本地提交交付。

- 用户授权推送远程。起始工作区干净，main 本地提交为 05cf648 / e85d64a / 3c52fa8；fetch 后发现远程新增 20b7e43 / 25d85cb / d10d8ee。常规 merge --no-commit 出现 6 个文件冲突；分工处理前后端，保留双方行为，随后验证与正常推送。
- 后端两处冲突已解决：同时保留导入任务 libraryItemId 跟踪、automaticMetadata，以及删除用 peekDocuments 和元数据补全 prepareDocumentDoi。后端针对性单测运行中。
- 合并首轮 pnpm build / pnpm check:ipc 通过。导入、PDF、阅读、文献状态与格式测试 153/153；schema/migration 76/76、历史卡片与科学代际恢复 18/18。独立临时输出目录打包中，准备验证实际 packaged build 对填充历史 v76 数据的启动兼容。
- 后端合并回归 21/21；删除测试曾因夹具未按真实索引流程绑定 canonical root 而留下索引文件，已补齐 bindRoot，保留全部删除断言，生产删除逻辑未改。真实下载/解析/SQLite/索引/Wiki 集成 4/4。
- pnpm audit:design（295 文件）、pnpm audit:motion（428 文件、0 违规）、git diff --check 通过。合并构建临时包 /tmp/roc-push-merge-package-cdA6A7/mac-arm64/Roc.app 已完成；原 release 安装包与实际用户数据未动。
- Electron 合并首轮 66/75：3 项新永久删除检查暴露菜单关闭回焦覆盖确认框初始焦点；6 项旧工作流检查仍用 End 定位旧菜单尾项“移除”。列表布局、零重排、保留与分页均通过。局部修复菜单到确认框的焦点交接；键盘用例改为 End 定位删除后 ArrowUp 定位移除，保留目标身份断言，待复测。
- 最终 Renderer 去重 75/75（action/workflow 50/50 复测 + 未受影响四套 25/25），1100/420px 明暗删除确认框 cut=0；最终 build / IPC / design / motion 通过。
- 最终独立安装包历史启动通过：/tmp/roc-push-merge-package-final-GDXYaP/mac-arm64/Roc.app；v76→77，20 张表指纹与源文件/附件保留，removedRows=0，历史项目/文献/文档真实读取及可见窗口确认。合成旧关系科学后台警告保留，无 fatal。完整命令和范围已写入 docs/ui-library-refinement-2026-11-27.md。
- 合并提交 3bc321a 已通过 git push origin main 发布；git ls-remote origin refs/heads/main 与本地 HEAD 同为 3bc321aefe14b7c39df26d46e46bd1f98e2d9d0f，工作区干净。推送前远程仍为 d10d8ee，无新增分叉。此完成记录作为后续文档提交一并同步。
