# UI 重构验证记录

## 2026-11-23 P7.3：工件只读资源释放

状态：**Verified passing**（工件生命周期范围）。隐藏检视器释放只读Markdown、JSON、来源图像、综述报告/记录与生产文件字节；编辑器、草稿、协议版本、未决保存和关闭守卫继续存活。返回按同一版本恢复展开、分页、文件选择及阅读位置，不抢当前焦点；异步文件重新按原SHA读取。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`node --test --test-concurrency=1 tests/renderer/artifact-dock.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs` **52/53**。唯一失败为夹具在原生宽度变化尚未显示助手覆盖层时提前发Escape；改为等待真实覆盖层可见再关闭，`node --test --test-concurrency=1 tests/renderer/artifact-dock.test.mjs tests/renderer/authoring-tools-layout.test.mjs` **21/21**，其中Dock **5/5**。未放宽编辑器身份、保存锁、阅读位置或资源释放断言。此前全量renderer **944/944**，新变更以本段定向复验为准。文档见[工件检查器](research-artifact-inspector.md)。

## 2026-11-23 P4.4：检索快照分页与来源进度合同

状态：**Verified passing**（主进程与IPC合同）。发现页可显式请求每页30条，后续页读取同一可信owner/project和7天有效期快照；最多保留本次实际获取的900条融合候选，普通Agent工具仍受原limit限制。每个来源真实完成后只向发起窗口发送只读原始记录；候选身份仅在最终融合后生成，完成顺序不改变融合排序。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`node --test tests/unit/literature-import.test.mjs tests/unit/literature-query-planner.test.mjs tests/unit/literature-domain-sources.test.mjs tests/unit/literature-search-progress-ipc.test.mjs` **103/103**；`pnpm check:ipc`通过。覆盖65条分30/30/5页、后页真实导入、旧limit、窗口/项目/过期隔离、先完成来源事件、相同requestId的不同窗口不串流。前端交互和真实外部服务另验；快照total不代表来源全部命中。合同见[文献融合](research-literature-fusion.md)。

## 2026-11-23 P6.4：设置布局与首个 Escape

状态：**Verified passing**。设置分类宽度统一 208px，表单上限 680px；即时主题、密度和字号附影响说明及可访问描述。设置、模型表单与粘底保存继续共享原浮层和草稿守卫。

此前两次设置 Escape 偶发已定位为 Radix 最高层监听器更新落后于新确认框 autofocus：父层旧监听器先消费 Escape，确认框没有关闭。新增确定性回归在首次 focusin 同步发键，修复前稳定失败。Roc 浮层归属改在 layout 阶段登记，仅纯确认框启用 window capture 按当前栈处理 Escape；设置主窗、远端模型选择器的焦点、Tab 与 Escape 仍由 Radix 管理，原生 select 先关闭自身选择层。没有增加固定等待或放宽断言。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm typecheck`、`node --check tests/renderer/radix-settings-dialog.test.mjs`、`git diff --check` 通过；overlay stack 单元 4/4；`node --test --test-concurrency=1 tests/renderer/radix-settings-dialog.test.mjs tests/renderer/desktop-interactions.test.mjs tests/renderer/artifact-dock.test.mjs` **58/58**，54.7 秒。包含首聚焦 Escape、原生选择层两次 Escape、放弃/重置/删除、模型及密钥、背景抽屉、内联/覆盖 Dock、输入与导航，浅深两密度及 1440/1280/1184/800/640px 无横溢出且裁切为零。系统输入法和 VoiceOver 不由这些浏览器键盘事件代替。

## 2026-11-23 P7.2：终端隐藏、恢复与进程归属

状态：**Verified passing**。终端隐藏时释放 xterm DOM、尺寸观察和 IPC 订阅，主进程继续运行 PTY；按真实窗口、项目和目录恢复同一会话。输出使用有界 256 Ki UTF-16 缓冲和连接令牌，裁掉重播/实时重复区间并拒绝旧连接输入；超过容量明确提示截断。输出只发回所属窗口。显式结束需确认，窗口销毁和应用退出清理进程，项目归档/工作区变化重新校验权限。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm typecheck`、`pnpm check:ipc`、`git diff --check` 通过；`node --test tests/unit/terminal-session-lifecycle.test.mjs tests/unit/terminal-ipc-owner.test.mjs tests/integration/terminal-session-reattach.test.mjs` **20/20**；`node --test --test-concurrency=1 tests/renderer/authoring-tools-layout.test.mjs` **13/13**。真实 node-pty 验证隐藏前后 shell PID 不变、隐藏期间输出恢复、结束/owner销毁/shutdown 后 PID 消失；界面验证 DOM 释放、重新连接、截断提示和结束回调先于 IPC 返回时确认框仍能正确关闭。完整窗口/打包路径另在 P8 验收，不能据此宣称所有子进程树或备用屏幕程序均可完整恢复。合同见[终端会话](terminal-sessions.md)；测试临时资料根自动清理。

## 2026-11-23 P8准备：原子写入并发夹具

状态：**Verified passing**（修正后的单文件范围）。仓库根 `pnpm test:unit` 首轮共2697项，2695通过、1失败、1跳过，446.1秒；失败为既有 `tests/unit/agent-filesystem-path-invalidation.test.mjs` 对同路径两次相互依赖编辑错误要求调用先后FIFO。路径规范化在入锁之前异步执行，第二次可先入锁；一次性门控探针证明入锁顺序反转但最大临界区并发仍为1，未发现生产互斥故障。

现两次并发编辑分别更新同文件的独立原文，仍要求两次成功、最终两处更新和prepared/published/durable真实回执。`node --test tests/unit/agent-filesystem-path-invalidation.test.mjs` 连续20轮 **80/80**；移除锁的一次性探针确认相同检查会发现版本冲突/丢更新。生产写入合同未修改，所有探针已清理。定向结果不写成全量一次通过，最终全量另记。

## 2026-11-23 P6.3：隐藏窗口的审批与继续状态

状态：**Verified passing**。原逻辑暂停隐藏窗口RAF，也延迟了run_interrupted/resumed/continued状态；现在三类控制事件同步冲刷同一顺序队列，先提交之前的文字再更新控制状态。文字增量仍按帧合批，原始序号事件先记录后投影，主进程权限、回执持久化及输入回执路径未改变。

工作目录及完整串行命令见P5.2，`tests/renderer/lifecycles.test.mjs` **86/86**。新增真实hook用例在隐藏状态立即读取权威状态，覆盖双审批逐个消费、前序文字、failed→continued、重复序号拒绝、显示恢复与卸载清理；共享assistant/目录/workspace单元组合43/43通过。界面及时投影不替代后端实际批准结果，最终smoke另验证副作用。

## 2026-11-23 P5.2：知识证据与隐藏资源

状态：**Verified passing**。RAG宽容器采用70:30原文/证据导航，窄窗折叠目录；支持关系明确标为待核验，唯一回答仍在实际助手中。打开来源沿用parse/source/locator身份，返回保留问题并恢复源按钮焦点；检索失败保留上次结果与对应原查询。Wiki/关系图模块首次进入才加载，隐藏时清理只读派生和重DOM，保留筛选、分页、选中及Wiki草稿；科学源预览隐藏后释放PDF资源。已有关系图为有界SVG，无新增无用Worker。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。P2.3记录的组合65/67，其中RAG7/7、图谱7/7、科学知识10/10通过。知识宿主探针位于Vite类型擦除之后，计数注入未命中；改成pre转换并检查正计数，下一阅读测试显式恢复自己的活动视图。随后 `node --test --test-concurrency=1 tests/renderer/literature-workspace-layout.test.mjs tests/renderer/radix-settings-dialog.test.mjs tests/renderer/lifecycles.test.mjs` **113/114**，知识宿主完整 **6/6**，唯一失败为设置新增断言缺少expect导入，另记P6.4。知识范围累计30/30；静态类型、设计审计、derive单测15/15通过。图谱和科学知识截图现放自动清理的夹具目录。

## 2026-11-23 P2.3：壳控制层与右侧对象检视

状态：**Verified passing**（以下壳与对象回归范围）。AppShellContent只组合启动、主题、布局与快捷键；共享资源、对象动作及运行关注分别由workspace/panel/run-attention控制层持有，use-app-route保持唯一URL写入点。对象动作沿用同一导航、脏草稿和待保存守卫，未创建任务状态副本。

工件在默认344px右栏显示，与助手互斥；宽窗内联，窄窗复用已有覆盖策略。嵌入检查器复用ModalShell标题与滚动正文，不增加portal/模态焦点圈。切助手仅隐藏检查器、保留编辑器草稿与待完成写入；关闭/替换仍走原工件守卫。内联与覆盖互换保留输入焦点，阅读位置捕获涵盖已接受的卸载。已查看1440px浅色内联与620px深色覆盖截图。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm typecheck`通过；路由/守卫单测21/21（命令见P5.1）。P2.2记录的Electron组合 **107/108**，Dock3/3、工作区4/4、桌面31/31、综述9/9、壳14/14、冷加载10/10通过。唯一旧迁移测试切回后无条件Enter，关闭了现在正确恢复的details；修正为先确认恢复展开再用幂等展开helper，完整 `tests/renderer/artifact-inspector.test.mjs` **37/37**，随 `node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/retrieval-workspace.test.mjs tests/renderer/literature-workspace-layout.test.mjs tests/renderer/knowledge-graph.test.mjs tests/renderer/scientific-wiki.test.mjs` 执行。后组65/67，2项知识夹具失败见P5.2；未把跨阶段组合记作一次全绿。

## 2026-11-23 P7.1：画布宿主保留预算

状态：**Verified passing**（宿主生命周期范围）。成功切换后卸载只读总览，后台只读预算为0；文献、写作、运行三个草稿/会话宿主明确固定保留。发现/知识/文献仍为同一宿主，冷加载失败不移除当前画布，切项目释放旧宿主。此策略没有把全部重DOM独立于状态，也不宣称已经实现PTY重连；终端cleanup仍会终止PTY，故不能直接卸载写作。

工作目录及单测命令见P5.1（保留预算3/3）；Electron完整组合命令见P2.2，其中 `tests/renderer/canvas-view-loading.test.mjs` **10/10**，覆盖20次切换、草稿/选区/导航监听、共享身份、导入失败和项目重建。此前新增测试在只读宿主外层出现时立即读取leaf数量，遇到React.lazy尚未提交而得到0；改为等待同一严格数量断言，复跑全部10项通过。实际内存/CPU和trace另由P7正式基准记录，不能以生命周期计数替代。

## 2026-11-23 P5.1：共享目录与写作问题面板

状态：**Verified passing**。文件树与写作复用同一目录索引、待完成请求及watcher，200ms合并后续文件变化，隔离不同工作区的迟到响应。隐藏写作暂停目录扫描与全局保存快捷键，保留正文草稿和导航/卸载保护，重新显示时读取最新元数据。编译问题移入160–240px可折叠底部区域，保留真实文件/行号、草稿保护、取消和导出；编辑/预览按55:45分配。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`ROC_UI_CAPTURE_DIR=/tmp/roc-ui-p5-captures-20261123 node --test --test-concurrency=1 tests/renderer/authoring-tools-layout.test.mjs tests/renderer/manuscript-sync.test.mjs tests/renderer/file-tree-virtualization.test.mjs` **13/13**，包括两个消费者合并读取、隐藏停止子目录扫描、恢复新增文件且脏草稿保留、真实组件错误行定位和取消/导出。`node --test tests/unit/renderer-directory-index.test.mjs tests/unit/renderer-view-retention.test.mjs tests/unit/renderer-routes.test.mjs tests/unit/renderer-navigation-guard.test.mjs` **30/30**，其中目录索引6/6。此次编译服务为受控返回，实际离线编译另由最终smoke验证。

## 2026-11-23 P2.2：按项目和模式恢复布局

状态：**Verified passing**。探索/专注/运行保留兼容URL标识，宽度与左栏折叠分别按项目/模式保存，最多60组；首次沿用旧全局宽度，新模式独立修改。当前模式重置恢复232/344px，侧栏200–340px、Dock280–520px；缩放覆盖状态不持久化，助手开关继续来自URL。ADR0023和工作台合同已同步。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`node --test tests/unit/renderer-layout-preferences.test.mjs` **3/3**，覆盖损坏/不可用存储、旧宽度兼容、独立重置和60组保留；`pnpm typecheck`通过。串行组合 `node --test --test-concurrency=1 tests/renderer/artifact-dock.test.mjs tests/renderer/workspace-frame.test.mjs tests/renderer/desktop-interactions.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/review-protocol-inspector.test.mjs tests/renderer/shell-management-guards.test.mjs tests/renderer/canvas-view-loading.test.mjs` 为107/108，其中工作区 **4/4**，拖拽取消、左右分隔条、断点草稿和项目/模式隔离通过；唯一失败是旧工件迁移用例在阅读位置恢复期间选择目标超时，P2.3继续定位。没有把该组合记作全绿。

## 2026-11-23 P6.2：运行任务列表与详情

状态：**Verified passing**。运行画布以260px任务列表配合既有TaskDetail，700px以下堆叠；管理抽屉保留原选择器。任务每页25条并去重，未加载的深链目标仍可打开独立详情，列表失败显式重试。任务事实、审批、恢复、回执与诊断沿用同一权威数据和草稿守卫；高级诊断按需展开。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`ROC_UI_CAPTURE_DIR=/tmp/roc-ui-p6-captures-20261123 node --test --test-concurrency=1 tests/renderer/research-tasks.test.mjs tests/renderer/shell-management-guards.test.mjs` **40/40**。已查看深色宽窗任务主从截图，另覆盖浅深窄窗、长目标、键盘焦点、分页/失败/深链、项目切换与编辑保护。

此前跨阶段组合70/75：4项壳夹具仍等待已移除的任务下拉框，1项焦点断言在鼠标模式下仅调用focus。现改用真实任务行aria-pressed与Tab/Shift+Tab后确认焦点和outline，未放宽运行或编辑守卫。截图审阅后清理。P2对象Dock接线与最终全量回归另行验证。

## 2026-11-23 P6.1：工具失败与执行反馈

状态：**Verified passing**。工具、Hook与子代理失败状态首次出现时展开真实原因；用户随后手动折叠不会被重复事件强制展开，新的失败边沿可再次提示。成功历史继续按需挂载，保留原始参数、输出、顺序与回执，自动披露不移动输入焦点。

工作目录及完整组合命令见本日P3记录；`tests/renderer/assistant-activity-layout.test.mjs` **6/6**，覆盖连续流式完成、真实失败、手动披露、焦点保留及浅深320/400px，裁切为零。停止、批准与运行投影权威没有改写，实际副作用由最终smoke验证。

## 2026-11-23 P4.3：阅读检视器

状态：**Verified passing**。阅读检视器提供笔记、引用、证据三个原生键盘标签；笔记切换后保留草稿，引用复用BibTeX复制/导出与命名动作。证据来自wikiSnapshot，明确失效历史摘录，按实际parseId/rawLocator定位；PDF选中文字仍写入私人笔记，不伪造支持证据。窄窗检视器展开与原文回跳沿用已有阅读位置保护。

工作目录及完整组合命令见本日P3记录；其中 `tests/renderer/reading-layout.test.mjs`、`tests/renderer/reading-note-guards.test.mjs`、`tests/renderer/reading-tool-guards.test.mjs` **21/21**。覆盖笔记跨标签保留、引用输出、历史解析定位、翻译取消、删除/冲突保护、IME公式、晚到保存与重复提交。截图改放夹具临时目录并自动清理。真实PDF长翻页及完整外部服务T2另在P7/P8验收。

## 2026-11-23 P4.2：发现列表与候选预览

状态：**Verified passing**。900px容器起结果与预览按65:35排列，预览展示真实摘要、来源冲突、DOI和原入库动作；窄容器改为内联详情，返回/Escape恢复原候选焦点、筛选与滚动。部分来源失败保留有效结果；批量导入仍使用真实回执。

工作目录及完整组合命令见本日P3记录；其中 `tests/renderer/discovery-search.test.mjs` 与 `tests/renderer/literature-review.test.mjs` **6/6**，覆盖重复提交、部分来源、已入库排除、键盘披露、未知/归档权限和浅深窄宽布局。全应用布局快照另见P2.1记录；外部学术源T1尚未被受控夹具验证。

## 2026-11-23 P3：项目门户与研究总览

状态：**Verified passing**。门户每次挂载40项，搜索、计数与键盘Home/End仍遍历完整项目集合；总览按当前任务、最多3项待处理与真实类型成果组织，长目标可展开。继续研究的文案来自实际诊断，按钮只导航；不存在项目归属的会话不会被伪造。技术原因保留在可展开的错误标识中。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。串行执行 `node --test --test-concurrency=1 tests/renderer/project-overview.test.mjs tests/renderer/project-session-layout.test.mjs tests/renderer/discovery-search.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/reading-layout.test.mjs tests/renderer/reading-note-guards.test.mjs tests/renderer/reading-tool-guards.test.mjs tests/renderer/authoring-tools-layout.test.mjs tests/renderer/manuscript-sync.test.mjs tests/renderer/file-tree-virtualization.test.mjs tests/renderer/assistant-activity-layout.test.mjs tests/renderer/canvas-view-loading.test.mjs`：总计66/67，P3两文件11/11及阅读文件的任务原因测试通过；唯一失败为P7新增切页生命周期夹具，另行修复记录。组合设置 `ROC_UI_AUDIT_DIR=/tmp/roc-ui-p3-captures-20261123` 与 `ROC_UI_CAPTURE_DIR=/tmp/roc-ui-p6-captures-20261123`，截图审阅后清理。已查看1184px浅色紧凑与1440px深色舒适总览，长目标、焦点与内容边界正常。

此前44/45组合中TaskSummary夹具仍要求主层显示原始错误码；现改为检查可读原因与键盘展开原始标识，未删除诊断信息。真实外部服务恢复不在此夹具的证明范围。

## 2026-11-23 P4.1：文献游标分页

状态：**Verified passing**（分页接口和界面回归范围）。新 `research.library.listPage` 保留旧数组接口，按(updatedAt DESC,id ASC)稳定排序，单页事务返回真实total/hasMore/nextCursor；项目、归档和搜索由后端完整集合过滤，特殊LIKE字符按字面处理。前端每页200条，显式加载更多/重试；查询、刷新与项目切换隔离迟到响应，追加去重并保留选择与阅读详情，不跳回先前选中行。标题/年份排序和类型分类仍仅作用于已加载条目，界面已明确标记；不是全库排序。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm check:ipc`、`pnpm typecheck`；`node --test tests/unit/research-plugin-lazy.test.mjs tests/unit/research-library-pagination.test.mjs` **15/15**。`ROC_UI_AUDIT_DIR=/tmp/roc-ui-p3-captures-20261123 node --test --test-concurrency=1 tests/renderer/project-overview.test.mjs tests/renderer/project-session-layout.test.mjs tests/renderer/literature-pagination.test.mjs tests/renderer/literature-retention.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/literature-workspace-layout.test.mjs tests/renderer/literature-processing.test.mjs tests/renderer/literature-action-guards.test.mjs tests/renderer/wiki.test.mjs tests/renderer/lifecycles.test.mjs` **146/147**。唯一失败为旧夹具仍查找“当前结果排序”，已更新为真实“已加载结果排序”；完整`node --test tests/renderer/literature-workspace-layout.test.mjs`随后 **5/5**。

数据库覆盖437条跨页、时间戳相同、总数、引用键、归档、游标行删除及新前置记录；Electron覆盖400条追加、多选保留、页失败重试、查询/项目隔离与独立详情。2k/10k资源测量在P7记录，不以小夹具替代。临时测试数据库由夹具清理。

## 2026-11-23 P2.1：画布优先与右侧助手

状态：**Verified passing**（几何、导航和以下回归范围）。栏序改为左栏、画布、右侧助手，默认232/344px；1440px起且画布保留760px才内联助手，1100–1439px保留左栏、助手覆盖，1099px以下双抽屉。分隔条向左扩大右侧助手，Home重置，Escape撤销；断点变化不卸载输入草稿。打开文件、文献、任务或引导会关闭覆盖助手，原导航与草稿守卫决定实际跳转。WorkspaceScope新增仅打开输入区的openAssistant命令。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm build`、`pnpm check:renderer-chunks`、`pnpm audit:design` 通过；`node --test --test-concurrency=1 tests/renderer/workspace-frame.test.mjs tests/renderer/page-ui.test.mjs tests/renderer/shell-management-guards.test.mjs` **19/19**。`ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-ui-p2-layout-20261123 pnpm audit:layout` **771状态、2079焦点检查**通过，裁切为零，包含浅深、1184/1280/1440px及缩放对应窄窗、hover/展开/动效落点。已查看宽窗写作与右侧助手、原生最小宽暗色助手、阅读页面截图。运行使用隔离profile，截图、日志和审计临时目录已清理。

首次组合16/19揭示覆盖助手阻挡画布与旧测试假设；修正对象导航后第二轮10/14，原因是旧openTask夹具再次点击助手开关，将已关闭的助手重新打开。改为断言导航后已关闭，未放宽草稿/审批/副作用断言；最终19/19通过。完整布局另包含并行开发中P3/P4的当时快照，各阶段行为验证仍单独记录。AGENTS.md在本机被忽略，其栏序说明已同步但不强制加入仓库。

## 2026-11-23 P1.3：页头、信息区与标准条目

状态：**Verified passing**。`shared/page-ui.tsx` 提供 PageHeader、PageSection、原生 PageListRow，复用 EmptyState/ErrorBar；导航、选择与异步状态仍归业务所有。永久夹具覆盖正常、空、加载、错误、受限状态。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm build`、`pnpm check:renderer-chunks`、`pnpm audit:design` 通过；`ROC_UI_AUDIT_DIR=/tmp/roc-ui-p1-p2-captures-20261123 node --test --test-concurrency=1 tests/renderer/workspace-frame.test.mjs tests/renderer/page-ui.test.mjs tests/renderer/shell-management-guards.test.mjs` 最终 **19/19**，其中页面组件 **2/2**。浅深主题、紧凑/舒适、1184/1280/1440px、320px 长标题无横溢出，裁切为零；原生 Enter/Space、禁用与焦点检查通过。已查看浅色紧凑1184px、深色舒适1440px截图，截图审阅后清理。壳体部分见独立 P2.1 记录。

## 2026-11-23 重构计划 P0.1：可复现审计

本轮执行[2026-11-23 重构计划](../Roc_UI_UX_重构计划_2026-11-23.md)，代码基线为 `85e92a4bf0bfccda1a4d77a65373067139da13ce`。下方 11 月 20–21 日记录属于历史轮次，与本计划 P0–P8 分开。

状态：**Verified passing**（审计依赖和测试准备范围）。两套本机 Skill 审计脚本原先被 Git 忽略，布局与 renderer 测试无法在干净检出中找到它们。现统一读取 `scripts/ui-audit/`，包含 MIT 许可、原始/当前 SHA256 与修改说明；`pnpm audit:design` 为固定入口。

新增阳性测试复现纯黑阴影漏报：原 `rgba?` 正则把 `rgb(0, 0, 0)` 的蓝通道零视为 alpha 零。修复只改变透明度识别，不改变裁切几何与容差；回归覆盖纯黑、零蓝通道、hover、足够留白、整边隐藏及显式透明。公共 Vite 夹具也在创建随机目录前建立 `.runtime/tmp/`，消除首次运行的 `ENOENT`。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
node --test tests/renderer/ui-clip-audit.test.mjs tests/unit/ui-audit.test.mjs
pnpm audit:design
node --test tests/renderer/literature-list-layout.test.mjs
git diff --check
```

结果：审计行为与来源校验 **3/3**；设计扫描 **270 文件**；文献列表完整回归 **3/3**；差异检查通过。首次 103 项基线因缺少临时目录在准备阶段失败；修复后 102/103，一项虚拟列表滚动断言失败，单项及完整文件随后通过。保留这次偶发记录，不把定向重跑写成整套一次通过。

本部分不改变生产 UI。当前构建、全布局与性能数字在 P0.2 记录；T1/T2/T3 外部服务、人工输入法和 VoiceOver 仍需各自验证。临时日志与截图在本轮审阅后清理。

## 2026-11-23 P0 基线修复：导入请求只消费一次

状态：**Verified passing**（导入请求生命周期）。全布局检查发现：从侧栏打开并关闭导入弹窗，返回项目入口，再进入同一项目，已关闭弹窗会重开并遮住发现页。原因是请求存在共享 store，而已消费标记仅存在 Hub 的局部 ref，卸载后丢失。消费确认现保存在共享 store，按请求 ID 确认，保留冷挂载前和非活动期间的新请求。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`node --test --test-name-pattern='sidebar import requests' tests/renderer/literature-workspace-layout.test.mjs` 修复前复现失败；修复后 `node --test tests/renderer/literature-workspace-layout.test.mjs` **5/5**，`pnpm typecheck`、`git diff --check` 通过。完整应用的返回项目路径将在 P0.2 重新构建后复跑，不以组件回归代替全布局结果。

## 2026-11-23 P0.2：当前工程基线

状态：**Verified passing**（以下工程基线范围）。应用基线为 `42c3a78`（包含 P0.1 和导入请求修复）。本次布局驱动按当前可见列表选择唯一导入入口，仍校验恰有一个入口；完整 smoke 的 P4 子闸门也支持把诊断放入指定临时目录。没有放宽几何、业务或分包门槛。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`，以下命令通过：

```sh
pnpm build
pnpm check:ipc
pnpm check:renderer-chunks
pnpm audit:design
ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-ui-p0-layout-complete-20261123 pnpm audit:layout
node scripts/performance/bench-macos-app.mjs /tmp/roc-ui-p0-performance-final-20261123.json --samples 5 --idle-minutes 0
ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-ui-p0-smoke-final-20261123 pnpm smoke:electron
```

- 构建含类型检查通过；eager JS **503389 bytes / 10 files**，各应用 chunk 低于 500000 bytes。保留上游 Mermaid/ELK 提示，未改预算。
- 布局 **771 状态 / 2079 次焦点与无遮挡检查**通过，阴影裁切最大 `cut=0`。浅/深各覆盖 1440×900、1280×820、1100×820、1099×820、1184×820、720×760、380×760、1200×540，以及普通/减弱动效。原生最小宽度保持 1184px，较窄尺寸是测试窗口内的 CSS 视口模拟。已查看浅色工作台、深色文献阅读、380px 模型设置截图。夹具为空/少量受控内容，不能当海量真实文献或 PDF 证据。
- 前次矩阵在浅色 1099px 的截图步骤出现 `Target page, context or browser has been closed`，无足够诊断确定原因；完整同参数重跑通过，保留中断记录，不声明已修复其根因。此前导入入口和请求重放两处阻塞已分别修正。
- **15 次**同机启动/历史加载量测完成，结果与逐样本证据见[性能方法及基线](research-performance.md#2026-11-23-ui-工程基线)。0/1,000/10,000 合成消息的主窗就绪 P95 分别 1289.8/1347.2/1276.6ms；后两组采样均挂载 13 条消息。测量期间没有并行运行 Electron 测试或构建。
- 完整 smoke：核心 **23/23**，助手深度路径 **64/64**。涵盖隔离工作区真实文件/Git/PTY、本地受控 provider、批准/拒绝的实际文件结果、停止与恢复、检查点进程重启、516 条消息下有界回放与滚动、125% 缩放。首轮深度路径打开侧栏后未关闭覆盖抽屉，助手正确处于 inert；修复脚本操作顺序后完整重跑通过。运行应用仍是上述 P0 构建，末尾类型检查同时覆盖工作区中正在实现的 P1.1 源码。真实外部模型和人工输入法未由这些结果验证。

P0 尚有独立验收缺口：100 个项目，100/2,000/10,000 篇文献，500/5,000 条流式消息，200 页 PDF 连续翻页，20 次面板切换，30 分钟空闲 CPU/RSS、输入到绘制/FPS/Profiler，以及真实服务 T1/T2/T3、系统输入法与 VoiceOver。P1 可在已固定的工程基线上按切片推进，这些缺口不记为已完成。

## 2026-11-23 P1.1：共享按钮六态

状态：**Verified passing**（按钮及设置接入范围；全量 renderer 有下述失败）。

`ActionButton` 在既有 `shared/form-ui.tsx` 中复用按钮类；默认/悬停/按下/禁用/加载/可见焦点使用同一契约。加载由调用方控制，显示图标与真实操作文案，设置 `aria-busy` 并禁用。模型设置的保存密钥、测试连通和设置保存栏已接入，原有密钥保存同步防重、失败重试、草稿和供应商身份隔离保持在业务层。保存栏按下位移现在尊重减弱动效。

永久组件画廊属于测试，不增加产品入口。真实 CSS 下检查浅/暗、两种密度和 1184/1280/1440px，驱动 hover/按下/Tab，校验最小字号 12px、点击目标 28px、无横溢出及 `clip.cut=0`。已查看浅色紧凑 1184px 和深色舒适 1440px 截图。回归还覆盖外部表单提交、原生 name/value/ref、disabled fieldset、加载防点击、恢复后键盘可达，以及 busy 与 saving 的区别。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
pnpm build
pnpm check:renderer-chunks
pnpm audit:design
ROC_UI_AUDIT_DIR=/tmp/roc-ui-p1-gallery-20261123 node --test --test-concurrency=1 tests/renderer/action-button.test.mjs tests/renderer/settings-write-guards.test.mjs tests/renderer/model-provider-settings.test.mjs
pnpm test:renderer
node --test --test-name-pattern='rendered transcript keeps|intentional scroll away' tests/renderer/lifecycles.test.mjs
node --test tests/renderer/literature-list-layout.test.mjs
```

构建、分包、设计门禁和按钮定向检查通过：定向 **14/14**；eager JS **503800 bytes / 10 files**，比 P0 增加 411 bytes，分包预算未改变；设计扫描 270 文件。

完整 renderer **895/898 通过**，耗时 1875 秒，3 个失败均为滚动断言：`lifecycles.test.mjs` 历史裁剪后原消息锚点不可见（当时 1376 行），下一会话未到初始底部（当时 1447 行）；`literature-list-layout.test.mjs` 滚到顶部后第 120 行仍挂载（135 行）。未修改测试的定向复跑中，文献完整文件 **3/3**，两项消息流测试 **1/2**（初始底部失败仍复现）。文献同类失败在 P0 已出现；消息流后续诊断与修复见下节，不把重跑结果写成全量通过，不改动断言容差或延长超时。

本子项不代表 P1 的 tokens、输入/菜单、状态、列表与检视器全部完成。临时日志和截图在审阅、提取必要诊断后清理，正式组件夹具和验证记录保留。

## 2026-11-23 P0.3：消息流回归夹具校正

状态：**Verified passing**（夹具校正及以下组合验证范围）。

全量失败的两个消息流用例已定位到夹具问题。旧夹具没有应用 CSS，默认段落外边距使测量行高约 22.5px、实际行距 38.5px；80 条消息的初始滚动停在 1520px，而实际内容高度为 2244px、视口 320px。几何相交检查还把 Virtuoso `visibility:hidden` 的初始化行当作可见锚点，历史更新会与尚未结束的初始化定位重叠。探针确认 `checkVisibility()` 默认不检查 CSS visibility，必须显式传入 `visibilityProperty: true`。

夹具现与其他 renderer 测试一致读取本轮 `pnpm build` 生成的 CSS，等待真实可见的初始化列表，并按 Virtuoso `data-index` 确认 prepend/trim 已应用。保锚场景明确先上滚阅读历史；位于底部时继续追随新尾部仍由独立用例验证。原 2px 断言和超时保留，未新增固定等待或改动生产消息流。仅保留失败时的几何诊断，临时滚动钩子、轨迹及探针均已删除。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
node --test tests/renderer/lifecycles.test.mjs
node --test --test-concurrency=1 tests/renderer/lifecycles.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/action-button.test.mjs tests/renderer/settings-write-guards.test.mjs tests/renderer/model-provider-settings.test.mjs
node --check tests/renderer/lifecycles.test.mjs
git diff --check
```

最终生命周期完整文件连续 **5 轮 85/85**；消息流、文献列表、按钮和设置组合 **102/102**；语法与差异检查通过。先前 898 项全量运行仍按原成绩保留；文献列表偶发失败的根因尚未证实，不标为已修复。

## 2026-11-23 P1.2：共享表单反馈、只读与模型字段校验

状态：**Verified passing**（本子项和最终 70 项组合范围；首次 Escape 偶发仍记录如下）。

共享 `TextField`、`NumberField`、`SelectField` 统一独立标签、说明和错误关联，`CheckboxField` 将说明从名称中分离。文本/数值使用原生只读并显示标记；数值提交检查只读、自身及祖先 fieldset 的禁用状态，复用 IME 守卫，保留空值、零及失焦/Enter 提交契约。沿用现有 tokens，不新增校验规则。

模型设置接入当前 `validateDraft`：名称、类型、接入地址、模型标识/显示名及高级数值的错误显示在对应字段，供应商重排后按 ID 重新定位校验路径；错误首次出现时展开高级参数，修正后保持展开。既有嵌入配置 ID 改为可聚焦、可选择复制的只读字段；新配置 ID 可编辑，保存期间仍由整个 fieldset 禁用。全局校验汇总与既有写入、草稿、密钥保护继续保留。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
pnpm build
pnpm check:renderer-chunks
pnpm audit:design
ROC_UI_AUDIT_DIR=/tmp/roc-ui-p1-form-fields-captures node --test tests/renderer/form-fields.test.mjs
node --test --test-concurrency=1 tests/renderer/form-fields.test.mjs tests/renderer/model-provider-settings.test.mjs tests/renderer/settings-write-guards.test.mjs tests/renderer/action-button.test.mjs tests/renderer/radix-settings-dialog.test.mjs tests/renderer/management-draft-guards.test.mjs
node --test --test-name-pattern='settings dialog layers|reset confirmation accepts' tests/renderer/radix-settings-dialog.test.mjs
node --test tests/renderer/radix-settings-dialog.test.mjs
node --test --test-name-pattern='reduced motion preserves' tests/renderer/action-button.test.mjs
node --check tests/renderer/form-fields.test.mjs
node --check tests/renderer/model-provider-settings.test.mjs
node --check tests/renderer/settings-write-guards.test.mjs
node --check tests/renderer/action-button.test.mjs
git diff --check
```

表单语义回归先复现缺少 NumberField 描述、只读属性及 IME Enter 误提交，再修正实现。最终表单 **4/4**；画廊检查浅/深 × 紧凑/舒适 × 1184/1280/1440px，以及 320px 容器，无横溢出、`clip.cut=0`、焦点可见；已人工查看浅色紧凑 1184px、深色舒适 1440px 与模型设置高级参数截图。构建（含类型检查）、分包及设计扫描 270 文件通过；eager JS **505042 bytes / 10 files**，应用 entry chunk 预算未改变。

首轮设置集成 **12/14**，两项新增断言错误分别为 Zod 实际提示 `>0` 与 macOS 全选键；修正后该组全部通过。首次扩大组合 **68/70**：设置放弃确认的 Escape 未关闭，导致下一用例被残留弹窗阻挡；未修改弹窗，原失败对 **2/2**、完整文件 **22/22** 均通过，偶发根因尚未确认。第二次组合 **69/70**，失败为既有 ActionButton 的减弱动效即时取样。单项复现和探针确认 `:active=true`，CSS 过渡为 0.01ms，同帧 opacity 为 1、下一帧为 0.9；改用既有超时内轮询视觉生效，保留无位移断言，未改生产样式或增加固定等待。最终结果见本节末尾。

最终六文件组合 **70/70**，耗时 58.5 秒；语法和差异检查通过。合成 composition 事件与复制事件只验证浏览器交互，不代表系统中文输入法、系统剪贴板服务或 VoiceOver 已人工验收。本次未重跑 898 项全量 renderer；P0.3 中的历史成绩和文献列表偶发问题仍保留。截图、日志与临时运行目录审阅后删除；只保留正式代码、回归夹具和文档。模型设置独立测试改为仅在指定 `ROC_UI_AUDIT_DIR` 时导出截图。

## P0 工程基线（2026-11-20）

macOS 27.2.1 arm64，Electron 45，基线提交 `dd7511a`。隔离数据根启动当天既有 dist，窗口 1320×860，原生最小 1184×640。门户、默认写作、文献、发现（雷达）、知识（RAG）五面均成功加载，无 pageerror、无页面横向溢出，阴影审计均 `cut=0`。截图检查确认默认空写作页、重复文件列表，以及文献七标签带来的多层导航。

仓库根执行：

- `pnpm check:renderer-chunks`：通过，eager JS 481730 bytes / 10 files。
- `python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer`：239 文件通过。
- `pnpm typecheck`：通过。

导航诊断仅在当前窗口内存保留最近 500 个事件，记录页面类别和相对耗时，不含项目标识、查询、文件路径或凭据，不自动上传。任务事件继续使用实际运行事件；本地诊断不构成第二套任务状态。

用户访谈、T1–T3 真实外部服务任务、SUS 与灰度发布尚无证据；工程检查不能代替这些验收。临时截图和隔离运行数据在检查后清理，不进入版本库。

## P1 信息架构与设计契约

[设计契约](design-system.md)固定五目的地、对象与动作归属、十个关键状态的文字线框、集中旧深链迁移、抽屉与原生窗口边界及组件 Do/Don't。复用现有 token、组件和单壳，草稿与业务事实保持原有权威来源。文档与本地引用已检查；这些线框未冒充真人可用性测试结论。

## P2 壳体与系统

五目的地、工作台、集中旧深链迁移、写作内终端、共享文献宿主与 1200px 抽屉阈值已接入。仓库根 `pnpm build`、`pnpm check:renderer-chunks`、设计规则审计通过；eager JS 482999 bytes / 10 files。

`node --test tests/unit/renderer-routes.test.mjs tests/unit/surfaces.test.mjs`：29/29，通过 1920 路由组合。`node --test --test-concurrency=1 tests/renderer/canvas-view-loading.test.mjs tests/renderer/literature-workspace-layout.test.mjs`：10/10，覆盖共享宿主与草稿保留。

隔离 Electron 实窗完成默认工作台、冷入口导入、五目的地、终端、管理深链、1280px 列布局及 1184px 抽屉检查；浅/深主题无 pageerror、无横溢出，`clip.cut=0`。

## P3 文献与发现

发现页默认搜索，来源部分失败保留结果，批量收录展示后端原始分项回执。导入四入口、六能力；阅读器与后台处理展示五阶段，解析不推断索引，缺记录明确待核验。列表增加当前结果排序与批量引用导出。

仓库根 `pnpm typecheck`、设计规则审计通过。`node --test tests/unit/literature-pipeline-state.test.mjs` 5/5；发现 Electron 回归 1/1；导入状态与编辑保护 12/12；阅读与后台处理 20 项均通过（修正旧文案断言后单独复跑失败项）；文献列表与复制动作测试通过。外部搜索和下载未以 fixture 冒充验收。

## P4 知识与写作

提问先检索真实证据，再通过现有助手通路生成答案；知识画布保留检索上下文。问答与知识页是二级入口，关系图从知识页进入。文献/概念跳转携带稳定对象与定位信息，阅读及路由守卫放行后才提交选择。

写作新增工作区编译、取消与原生导出，复用离线 Tectonic、工作区路径校验和资源预算。编译先保存草稿，PDF 使用既有预览协议；只保留 PDF 成果，任务快照与日志在结束后清理。

仓库根 `pnpm build`、`pnpm check:ipc`、设计规则审计通过；`pnpm check:renderer-chunks` 为 486244 bytes / 10 eager files。`node --test tests/renderer/retrieval-workspace.test.mjs` 5/5；`node --test --test-name-pattern='RAG' tests/renderer/desktop-action-guards.test.mjs` 2/2。问答 1100/420px、索引 1100/380px 浅深主题均 `clip.cut=0`，截图检查后删除。

`ROC_WORKSPACE_LATEX_TOOLCHAIN=.runtime/research-toolchain/darwin-arm64 node --test tests/unit/research-workspace-latex.test.mjs` 4/4：含本机真实离线编译，验证有效 PDF、保存内容快照、失败/取消清理及越界/归档/符号链接拒绝。知识问答的模型回答仍需真实模型配置后的 T2 任务验收，不将受控 IPC 测试计为模型质量结果。

`node --test tests/renderer/authoring-tools-layout.test.mjs` 6/6，含保存→编译、构建问题行定位、PDF 预览、导出取消和取消等待回执；浅深色 440/820/1200px 均 `clip.cut=0`。原生另存对话框未手工操作，受控 IPC 只证明界面正确处理成功/取消回执。`node --test --test-concurrency=1 tests/renderer/literature-workspace-layout.test.mjs tests/renderer/literature-retention.test.mjs` 相关 4 项通过（旧 fixture 补齐 `updatedAt` 后复跑）：覆盖双守卫、笔记页跳阅读器、重复概念/证据定位、查询保留。

## P5 助手与任务中心

顶栏和管理抽屉共享一次读取的任务投影；研究任务、后台任务、文献处理各自保留权威来源与错误。分页结果明确标为近期，项目后台任务按工作区筛选。总览提供当前、待处理、最近结束及失败分组，打开原有详情与恢复操作。助手优先展示任务阶段、最近完成与真实成果，完整参数、用量和诊断按需展开。批准/拒绝保持同等视觉权重；停止请求保留等待清理回执，失败不冒充已停止。

仓库根 `pnpm build`、`pnpm typecheck`、设计规则审计、`git diff --check` 通过。`pnpm check:renderer-chunks` 为 491998 bytes / 10 eager files。

- `node --test tests/renderer/task-center.test.mjs`：2/2，覆盖三来源、作用域、分页口径、失败与晚回包、键盘打开；440/720px 浅深主题与 hover 均 `clip.cut=0`。
- `node --test tests/renderer/shell-management-guards.test.mjs`：8/8，顶栏与工作区进入同一任务中心，保留管理草稿、导航、工件与 Git 保护。
- `node --test --test-name-pattern='task categories' tests/renderer/management-draft-guards.test.mjs`：1/1。
- `node --test tests/renderer/native-state-guards.test.mjs`：7/7，原生窗口与项目绑定保护。已删除被任务中心替代的顶栏轮询 hook。
- `node --test tests/renderer/assistant-panel-guards.test.mjs`：15/15，IME、草稿隔离、停止、检查点恢复和三类审批。
- `node --test tests/renderer/research-tasks.test.mjs`：23 项均通过；首次 20/23，更新阶段文案断言和原生折叠展开等待后定向 3/3。覆盖真实成果、停止清理、恢复能力、诊断与草稿保护。

## P6 引导、可读性与交付检查

工作台加入三步内联引导，可跳过并从帮助重开，沿用导航守卫。只保存版本化关闭偏好，不保存业务进度。设置提供本次窗口匿名诊断的显式复制出口；复制失败可重试，提交中锁定按钮。界面中点分隔文案已移除。

弱化文字使用同一语义 token 修正。按 sRGB 相对亮度计算：暗色 `#909099` 在最弱的已检查面板 `#27272a` 上为 4.71:1；浅色 muted `#596579`、subtle `#606774` 在 `#e2e8f0` 上分别为 4.78:1、4.62:1。该结果限定这些文字/背景组合，不等同整应用 WCAG 认证。

以下命令均在仓库根 `/Users/Apple_501/Desktop/Roc/Roc` 执行：

- `pnpm build`、`pnpm typecheck`、`pnpm check:ipc`：通过。
- `pnpm check:renderer-chunks`：493155 bytes / 10 eager files，低于 500000 bytes 预算；相对 P0 增加约 2.4%。大型编辑器、PDF、终端和图谱仍按需加载。
- `python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer`：247 个组件通过脚本已实现的规则。
- `node --test --test-name-pattern='first steps' tests/renderer/shell-management-guards.test.mjs`：1/1，覆盖关闭偏好、重新挂载、导航拒绝、重开后的焦点及匿名事件字段。
- `node --test --test-name-pattern='application session diagnostics' tests/renderer/settings-write-guards.test.mjs`：1/1，覆盖 500 条上限、字段白名单、复制 pending/失败/重试；480px 浅深主题无横溢出、`clip.cut=0`。

`ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-p6-layout-XC81zK/retry pnpm audit:layout`：762 个状态通过，2063 次控件焦点与无遮挡检查通过；浅/深主题各覆盖 1440×900、1280×820、1200×820、1199×820、1184×820、720×760、380×760、1200×540，并检查减弱动效与普通动效的最终落点。原生最小窗口保持 1184×640；窄尺寸通过可丢弃 Electron 窗口的 renderer viewport 模拟，不宣称原生窗口可缩至 380px。无页面横溢出、低于 12px 字体、低于 24px 点击目标，阴影审计最大 `cut=0`。浅深引导、1184 抽屉、1280 任务中心与发现页截图已人工检查。

首轮布局在知识页面发现搜索输入框仅高 19px；为共享知识搜索框设置 24px 最小高度，运行 `pnpm exec electron-vite build` 后再完成上述全矩阵。没有降低审计门槛或跳过该控件。

`ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-p6-smoke-xyadu1 node scripts/smoke-electron.mjs` 的核心 16 项通过，包括首次引导、统一任务入口、真实工作区文件/Git/PTY、本地受控 provider 的运行和设置保存。新增缩放段最初因自动化在响应式抽屉落地前检查侧栏而失败；修复脚本等待布局与引导焦点的时机，未改应用代码。修复后未重复整轮 smoke，不能将本轮记作整套脚本全绿。

随后在仓库根通过 `ROC_SMOKE_TARGET=dist node --input-type=module` 的隔离 harness，直接读取并执行 `scripts/smoke-electron.mjs` 中 `// One real zoom pass` 开始的最新缩放段，工作台/设置 2/2 通过。真实窗口 1280×820、倍率 1.25、CSS 视口 1024×656；关键控件获得键盘焦点且 `elementFromPoint` 命中，字号、目标尺寸、溢出和裁切均通过。脚本等待响应式布局完成后关闭导航抽屉，最终恢复倍率和窗口尺寸。该倍率的实际鼠标点击尚未验证。Playwright 缩放截图存在导出裁切，改用 Electron `capturePage()` 获取完整 2560×1640 原生截图，人工检查通过后删除。

最终 `node --check scripts/smoke-electron.mjs`、`node --check scripts/ui-layout-audit.mjs`、`git diff --check` 通过。检查脚本在结束时清理自己创建的隔离数据根，截图目录可通过环境变量指定。

## 验收边界与回滚

本轮完成本地工程实施和已记录的工程检查，不声明用户研究或发布门槛全部达成。5–8 名真实目标用户的 T1–T3 测试、SUS、真实外部搜索/下载与模型质量、人工 VoiceOver、操作系统输入法和滚轮体验、长期 CPU/内存及崩溃恢复、安装包分发和灰度发布尚未完成。受控 IPC 与本地 smoke provider 的通过只证明相应工程通路，不代替外部服务和用户体验结果。

每阶段使用独立本地提交：P0 `243720b`、P1 `39d940b`、P2 `cec5f23`、P3 `cb8644b`、P4 `e13e0e9`、P5 `320766b`，P6 为本节及最终收尾所在提交。需要回滚时，从目标阶段的后续提交开始逆序 `git revert`，再构建并运行受影响的检查；不使用 reset 清除历史。本轮未执行回滚或远端发布。回滚代码不会删除已有文献、项目文件、编译 PDF 或用户数据，也不应为回滚界面而重置数据库。

工程截图、隔离 smoke 数据和临时计划在检查后清理；保留本记录、设计契约、回归检查及用户原始方案。


## 2026-11-21 页面密度与组件复用

本轮以 `1d6865c` 为起点，核对 Apple HIG、Microsoft Fluent、IBM Carbon 的布局与组件指导，参考成熟 Sidebar、Radix Dialog 和 Virtuoso，沿用既有 token、单壳与依赖。来源和应用位置见[设计契约](design-system.md#官方参考与组件复用)。没有新增组件库，也没有新增临时方案文档。

完成项目门户固定查询区、工作台成果/文献自适应并列、文献两层工具栏与虚拟列表、助手分层输入与历史成功工具披露、后台任务平面列表和筛选。补齐虚拟行卸载后的键盘焦点、流式结束后的工具 DOM/展开态保留、高缩放短视口门户滚动。现有文档的栏序、断点、四目的地与设置分组同步到当前代码。

本地提交：`3de1ce0` 项目布局、`5cc2603` 后台任务、`38ef779` 文献列表、`0a14048` 虚拟焦点、`3d33800` 助手、`75405a3` 高缩放与对齐；文档收尾使用后续独立提交。

环境：macOS 27.2.1 arm64，Electron 45.3.4。以下命令在 `/Users/Apple_501/Desktop/Roc/Roc` 执行：

```sh
pnpm build
pnpm check:renderer-chunks
python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer
node --test --test-concurrency=1 tests/renderer/project-session-layout.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/literature-action-guards.test.mjs tests/renderer/management-draft-guards.test.mjs tests/renderer/task-center.test.mjs tests/renderer/assistant-activity-layout.test.mjs tests/renderer/assistant-panel-guards.test.mjs tests/renderer/desktop-interactions.test.mjs
ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-ui-refactor-MS2nxb/final-layout pnpm audit:layout
git diff 1d6865c --check
```

- 构建、内含类型检查、chunk 门禁、差异检查通过；258 个组件通过脚本已实现的设计规则。
- 合并 Electron 回归 **101/101**，无跳过。覆盖项目筛选/编辑、文献虚拟列表/批选/复制、后台刷新失败与草稿、助手输入/停止/审批、CJK 事件守卫、浮层焦点与缩放对应短视口。
- 全应用布局 **771 状态**、**2079 次控件焦点与无遮挡检查**通过，所有阴影审计 `cut=0`。浅/深主题覆盖 1440×900、1280×820、1100×820、1099×820、1184×820、720×760、380×760、1200×540，以及减弱动效、hover、展开和普通动效落点。门户、工作台并列、助手模型浮层、窄设置等截图已查看。原生最小窗口仍为 1184×640；低于此尺寸使用隔离 Electron 窗口内的 renderer viewport 模拟。
- 审查在真实 Electron 1184×640、400% 缩放复现门户列表归零后，新增不超过 400px 高度的整页滚动规则；随后上述最终 101 项回归在 296×160 CSS 视口及 244×122 壳内内容空间验证入口与搜索均可聚焦。此追加规则只影响全矩阵未覆盖的极短视口，未重复整套矩阵。
- 文献 200 条实测只挂载 13 行；按需加载虚拟组件，首末跳转、排序、外部选择、手动滚动卸载和复制动作均有行为回归。
- 历史 500 次成功工具调用折叠时组内 DOM 少于 20 个节点；展开可查看全部回执。当前流式消息完成后保留同一焦点节点与输出节点，错误、审批、推理和可导航综述回执不被聚合隐藏。
- 最终 eager JS **502830 bytes / 10 files**，对比本轮既有构建基线 **501716 bytes** 增加 1114 bytes（约 0.22%）。应用入口与各应用懒模块均低于 500000 bytes 门禁；总 eager 预算由脚本维护。编辑器、PDF、终端与图谱继续懒加载。构建保留 Mermaid/ELK 上游大模块提示，未调整门槛。
- 更新的 Markdown 本地链接已核验。所有本轮临时截图、日志、隔离运行目录已清理；未创建中间计划或报告文件。

状态为 **Verified passing**，范围是本轮代码与上述工程检查。未重新打包或发布应用；人工系统输入法、VoiceOver、真实滚轮、长期 CPU/内存和真实外部服务任务不属于这些自动化结果。README 保留注明日期的既有真实业务截图，不把受控测试截图替换成真实业务证据。
