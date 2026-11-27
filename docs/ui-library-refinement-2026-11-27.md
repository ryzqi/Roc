# 文献库界面优化验证

本记录对应《界面优化.md》的三个阶段。所有命令工作目录为
`/Users/Apple_501/Desktop/Roc/Roc`，运行使用临时夹具与隔离数据；
构建和读取 dist 样式的 Electron 夹具串行执行。

## 阶段一

状态：**Verified passing**（定向自动化范围）。提交 `05cf648`。

筛选与单篇菜单通过 Portal / Floating UI 定位；文献行固定 64px，
列表轨道与滚动槽位固定，详情进入 340px Inspector。宽屏预留检查器轨道，
窄屏覆盖，不创建第二个壳或新路由。

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | 通过，含类型与 Renderer chunk gate |
| `pnpm audit:design && pnpm audit:motion && git diff --check` | 通过 |
| `node --test tests/unit/renderer-overlay-stack.test.mjs` | 7/7 |
| `node --test --test-concurrency=1 tests/renderer/anchored-popover.test.mjs` | 12/12 |
| `node --test --test-concurrency=1 tests/renderer/literature-zero-reflow.test.mjs` | 7/7，`cut=0` |

截图与布局报告位于 `/tmp/roc-ui-zero-reflow-20261127/`。
1000 条文献仅挂载 15 行；4x CPU、连续选择 20 篇时 raw layout shifts=0，
RAF P95 10.1ms、输入到第二次 RAF P95 25.4ms、最长主线程 task 17.244ms。
这些指标不证明物理 60/120fps 或每帧低于 8/16ms。

## 阶段二

状态：**Verified passing**（定向自动化范围）。提交 `e85d64a`。

工具条收拢为状态、搜索、筛选与导入。多选动作只在有选择时浮出；
默认本地 PDF 自动补全并接续已有解析 / 索引，行状态来自真实回执。
项目移除与六秒撤销只改变成员关系。中文容错与实时全文检索保留原有
查询范围、源身份及索引 freshness 检查。

| 命令 | 结果 |
| --- | --- |
| `pnpm build > /tmp/roc-ui-phase2-build-compact.log 2>&1` | 含窄栏操作覆盖修复的最终构建通过 |
| `pnpm check:ipc && pnpm audit:design && pnpm audit:motion && git diff --check` | 通过，289 设计文件 / 420 动效文件 |
| `node --test --test-concurrency=1 tests/unit/research-document-auto-import.test.mjs tests/unit/research-document-status.test.mjs tests/unit/literature-document-pipeline.test.mjs tests/unit/research-scientific-library-publication.test.mjs tests/unit/research-grobid-publication.test.mjs tests/unit/literature-import.test.mjs tests/unit/zotero-import.test.mjs` | 168/168 |
| `node --test --test-concurrency=1 tests/unit/research-search-normalization.test.mjs tests/unit/latest-search-queue.test.mjs tests/unit/research-library-pagination.test.mjs tests/unit/knowledge-vector-search.test.mjs tests/unit/knowledge-candidate-parity.test.mjs tests/unit/scientific-retrieval.test.mjs tests/unit/scientific-query-orchestrator.test.mjs tests/unit/research-search-worker.test.mjs tests/unit/readonly-query-worker.test.mjs` | 53/53 |
| `node --test --test-concurrency=1 tests/renderer/pdf-drop-bridge.test.mjs` | 3/3 |
| `ROC_CONTEXT_CAPTURE=/tmp/roc-context-menu-phase2-final node --test --test-concurrency=1 tests/renderer/context-menu.test.mjs` | 5/5 |
| `ROC_IMPORT_CAPTURE=/tmp/roc-import-dialog-phase2-final node --test --test-concurrency=1 tests/renderer/literature-import-state.test.mjs` | 10/10 |
| `ROC_POPOVER_CAPTURE=/tmp/roc-anchored-popover-phase2-final node --test --test-concurrency=1 tests/renderer/anchored-popover.test.mjs` | 12/12 |
| `node --test --test-concurrency=1 tests/renderer/literature-zero-reflow.test.mjs` | 7/7 |
| `node --test --test-concurrency=1 tests/renderer/literature-list-layout.test.mjs` | 最终窄栏回归 11/11 |
| `node --test --test-concurrency=1 tests/renderer/literature-workspace-layout.test.mjs` | 7/7 |
| `node --test --test-concurrency=1 tests/renderer/literature-pagination.test.mjs tests/renderer/literature-retention.test.mjs tests/renderer/literature-automatic-workflow.test.mjs` | 33/33 |
| `node --test --test-concurrency=1 tests/renderer/literature-processing.test.mjs` | 25/25 |
| `node --test --test-concurrency=1 tests/renderer/discovery-search.test.mjs` | 7/7（最终组合命令日志） |
| `node --test --test-concurrency=1 tests/renderer/literature-action-guards.test.mjs tests/renderer/retrieval-workspace.test.mjs tests/renderer/desktop-editor-guards.test.mjs` | 最终批量回归内全部通过 |

菜单、导入与 Popover 的 15 张真实截图已人工检查，明暗主题、窄窗与角落
均 `cut=0 hidden=0`。阶段二布局 4x CPU / 20 次选择仅挂载 16 行，
raw CLS=0、最长 task 15.61ms、RAF P95 10.3ms、输入到第二次 RAF P95 25.4ms。
证据位于 `/tmp/roc-ui-phase2-workflow-20261127/`。

首轮工作流 22/23 通过；失败实证为键盘 Undo 后焦点回落 body。修复等待
恢复行挂载，并取消用户已转移的焦点意图。随后只读复核发现成功 DOI
永久复用旧请求身份，会使解除关联后的再次粘贴只返回旧 ledger 收据；
成功终态释放自己的身份，并加入 DOI / 候选重加、未知失败重试与迟到收据回归。
已有行的后台列表和处理状态核验失败现在提供独立重试，保留列表挂载与旧状态。
工作流、分页与错误恢复最终 33/33 通过；PDF 精确任务重试 25/25 通过。
刷新排队时会丢弃较早分页回执，保留已提交窗口；虚拟 Undo 以真实 viewport 边界
修正 offsetHeight 整数舍入导致的 0.09375px 溢出，没有放宽可见性断言。
Discovery 7/7、工作区 7/7、最终列表布局 11/11 通过。窄栏保留阅读与更多两个
外露动作，复制和问 AI 继续支持菜单及 C/A 快捷键；240px 栏标题中心命中行，
170/240/420px 明暗裁切均为 0。截图在 `/tmp/roc-ui-fixture-navigation-fixed/`
与 `/tmp/roc-ui-fixture-list-fixed/`。

1200 条文献 page+count 的 cold 为 96.2ms，warm 为 9.5/8.5ms；
10002 原始 chunk 的四组 Main / 只读 worker 容错对照合计 894.3ms。
测试核验原始正文及回执字节保持一致，投影缓存上界 2048 条 / 8MiB。

## 阶段三

状态：**Verified passing**（下表功能、布局与无障碍自动化范围）；严格帧预算仍未达标，
物理刷新率与完整 raster damage 验收尚未完成，不表示所有性能目标通过。

环境：macOS 27.2.1（26B131），Node 26.13.1，Electron 45.3.4。

沿用共享 Motion 与 tokens，新增 live reduced-motion 适配；五类浮层支持中途反向，
内容交接与退出交互隔离。文献增加分段指示器、复制／计数反馈、延迟骨架、
真实状态呼吸与完成标记、可视行删除补位；滚动和新输入立即取消装饰动画。

核心改动位于 `src/renderer/shared/motion.ts`、`motion-preference.tsx`、
`shell/OverlayMotionSurface.tsx`、`use-floating-surface-presence.ts`，以及
`literature/LibraryPresence.tsx`、`LibraryInspector.tsx`、`LibraryList.tsx`、
`use-library-row-motion.ts`。共享设置、画布、项目门户与助手消费同一实时偏好；
定位 wrapper 和虚拟列表的结构 transform 保留，装饰位移在 reduced 中立即取消。
计数使用独立的可访问文本，旧动画数字不重复读出；Inspector 切换方向来自可见排序。

| 实际执行命令 | 最终结果 |
| --- | --- |
| `pnpm build > /tmp/roc-ui-phase3-build-accessibility.log 2>&1` | 通过，含 typecheck / Renderer chunk gate；eager JS 621105 bytes / 17 files |
| `pnpm check:ipc && pnpm audit:design && pnpm audit:motion && git diff --check` | 通过；设计 295 文件、动效 428 文件 / 0 违规 |
| `node --test tests/unit/motion-contract.test.mjs` | 7/7 |
| `node --test --test-concurrency=1 tests/renderer/desktop-interactions.test.mjs tests/renderer/project-session-layout.test.mjs tests/renderer/radix-settings-dialog.test.mjs tests/renderer/shell-management-guards.test.mjs` | 90/90；IME 事件守卫、拖拽取消/持久化、400% zoom、主题与草稿守卫 |
| `node --test --test-concurrency=1 tests/renderer/surface-motion.test.mjs` | 13/13；含独立 MotionConfig always、无 Provider 的 body 偏好、中途 reduced 与快速反向 |
| `node --test --test-concurrency=1 tests/renderer/action-button.test.mjs` | 4/4；按下 scale .97、释放尺寸、reduced scale 1 |
| `ROC_LITERATURE_CAPTURE=/tmp/roc-ui-phase3-final node --test --test-concurrency=1 tests/renderer/library-state-motion.test.mjs tests/renderer/literature-zero-reflow.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/literature-workspace-layout.test.mjs tests/renderer/literature-automatic-workflow.test.mjs tests/renderer/literature-retention.test.mjs tests/renderer/literature-pagination.test.mjs tests/renderer/literature-action-guards.test.mjs` | 首轮 79/87；其中工作流 29、工作区 7、操作守卫 17 全部通过；其余修正与补跑如下 |
| `node --test --test-concurrency=1 tests/renderer/library-state-motion.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/literature-pagination.test.mjs tests/renderer/literature-retention.test.mjs` | 最终 25/25（9 + 12 + 2 + 2） |
| `ROC_LITERATURE_CAPTURE=/tmp/roc-ui-phase3-final node --test --test-concurrency=1 tests/renderer/literature-zero-reflow.test.mjs` | 最终 9/9；零偏移、虚拟化、宽窄窗、明暗主题、内容交接、重绘观测与 4x CPU |

最终去重并集为 **194 项 Renderer + 7 项 unit** 全部通过。最后生产构建后仅调整测试和文档。
日志分别在 `/tmp/roc-ui-phase3-{generic-runtime,literature-runtime,count-runtime,zero-final}.log`。
浮层独立补跑 13/13（11.40s）的完整日志在 `/tmp/roc-ui-phase3-surface-final.log`。
零重排和列表布局中的 clip-audit 覆盖实际 hover、展开及动效落点，裁切 `cut=0`。
最终截图位于 `/tmp/roc-ui-phase3-final/`，已检查明暗 Inspector、筛选和窄窗浮层。

首轮浮层 20/23：两项高刷新率三帧采样不足，改为每段 55ms 且五次低于 500ms；
退出中切 reduced 的残留 scale 由视觉子层立即清除。计数的 generic span aria-label
不能可靠提供读屏值，改为 sr-only 当前文本，并检查真实 AX snapshot。
文献组合首轮七项失败来自 Playwright 的 `toMatchAriaSnapshot` 不支持 node:test，
改为轮询 `locator.ariaSnapshot()` 的真实输出；另一项来自当前 Chromium 无
`LayerTree.layerPainted` 事件，按下述证据边界改用节点追踪并保留 Paint Flashing。

### 4x CPU 与重绘证据

1000 条文献、连续切换 20 篇并开关筛选 / 处理面板，保持 64px 行高，最终挂载 17 行。
最终 trace 为 `/tmp/roc-ui-phase3-final/zero-reflow-4x-1795769776199.trace.json`。

| 指标 | 最终观测 |
| --- | --- |
| raw layout shift 总和（包含 hadRecentInput） | 0 |
| CrRendererMain 最长完整 task | 36.838ms |
| RAF 间隔 P50 / P95 / max | 8.6 / 32.5 / 34.3ms |
| 输入到第二次 RAF P95 / max | 42.4 / 44.9ms |
| 全段 Layout / Paint inclusive 时间 | 113.202 / 130.337ms |

最长 task 内键盘触发的 click 处理为 26.529ms；这是主线程处理观测，不是独立合成动画帧时长。
RAF P95 高于 8/16ms 预算，当前结果不支持声称帧率稳定 60/120fps；输入到第二次 RAF
也只是下一次绘制机会代理，不是 EventTiming 或物理屏显延迟。性能目标仍有缺口。

hover / filter 工作负载分别采集 light 75、dark 77 个真实 Paint 事件，各 646 个 invalidation。
提前记录 Inspector 的 124 个 backend node IDs，两个主题均未发现事件命中这些无关节点。
`paint-invalidation-{light,dark}.json` 是原始节点追踪，`paint-damage-{light,dark}.json`
记录摘要；`paint-flashing-hover-{light,dark}.png` 显示绿色仅位于悬停行、动作与筛选 / 搜索处，
Inspector 没有绿色覆盖。单张截图不证明每一帧的 raster damage 边界。

此 Chromium 的 LayerTree 未输出 layerPainted；摘要中的 0 表示未收到该 API 的事件，
不能解释为“零重绘”。Paint 的全页 clip 是 display-list recording bounds，
不能当作真实 raster damage。完整逐帧光栅损伤与物理 FPS 仍需实机验证。

## 证据边界

工程回归使用真实 Electron 窗口与受控服务；它不代替外部 Provider、
物理触控板、系统中文输入法、VoiceOver、另一台 Mac 或实际屏幕刷新率验收。
RAF、输入响应与主线程 trace 分别报告。未改变数据库 schema 或持久化收据，
本次不涉及真实 `~/.roc` 数据迁移。

## 推送前远程合并验证（2026-11-27）

用户授权推送后，fetch 发现 `origin/main` 已有 `20b7e43`、`25d85cb`、`d10d8ee` 三个新提交，与本地三个 UI 阶段提交分叉。采用普通合并，保留双方历史。

六处冲突集中于 `document-service.ts`、`research-plugin-literature.ts`、`LibraryList.tsx`、`LiteratureHubView.tsx`、`library-list.css`、`use-literature-store.ts`。结果保留固定行高、Inspector、项目解除关联与撤销，并接入远程永久删除、arXiv 精确导入及发现全文处理。永久删除使用菜单和明确确认；菜单回焦结束后再打开确认框，防止抢走取消按钮焦点。旧键盘测试改为定位实际“项目移除”菜单项；删除测试夹具按真实扫描流程绑定 canonical workspace root，保留删除断言。

以下命令均从 `/Users/Apple_501/Desktop/Roc/Roc` 执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | 通过，含类型、技能、Renderer chunks 检查 |
| `pnpm check:ipc` | 生成接口与源码一致 |
| `pnpm audit:design` / `pnpm audit:motion` | 295 / 428 文件，已实现规则无违规 |
| `node --test --test-concurrency=2 tests/unit/renderer-literature.test.mjs tests/unit/literature-import.test.mjs tests/unit/literature-pdf-acquisition.test.mjs tests/unit/research-reading.test.mjs tests/unit/research-document-status.test.mjs` | 153/153 |
| `node --test --test-concurrency=1 tests/unit/literature-deletion.test.mjs tests/unit/research-document-auto-import.test.mjs` | 21/21 |
| `node --test --test-concurrency=1 tests/unit/database-schema.test.mjs tests/unit/research-schema-migration.test.mjs tests/unit/database-migrations.test.mjs` | 76/76 |
| `node --test --test-concurrency=1 tests/unit/research-paper-card-versions.test.mjs tests/unit/research-scientific-generations.test.mjs` | 18/18 |
| `node --test --test-concurrency=1 tests/integration/literature-auto-ingestion.test.mjs` | 4/4，实际下载、解析、SQLite、索引、Wiki 与服务重启恢复 |
| `ROC_REDESIGN_SCREENSHOTS=/tmp/roc-push-merge-renderer node --test --test-concurrency=1 tests/renderer/literature-action-guards.test.mjs tests/renderer/literature-automatic-workflow.test.mjs` | 最终 50/50 |
| `ROC_REDESIGN_SCREENSHOTS=/tmp/roc-push-merge-renderer node --test --test-concurrency=1 tests/renderer/literature-action-guards.test.mjs tests/renderer/literature-automatic-workflow.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/literature-zero-reflow.test.mjs tests/renderer/literature-retention.test.mjs tests/renderer/literature-pagination.test.mjs` | 首轮 66/75；后四套分别 12/12、9/9、2/2、2/2，9 项失败由最终 action/workflow 50/50 复测覆盖 |
| `git diff --check` / `git diff --cached --check` | 通过 |

去重结果：unit 268/268、integration 4/4、renderer 75/75。永久删除确认框在 1100/420px 明暗主题下裁切审计均 `cut=0`，已查看截图。证据位于 `/tmp/roc-push-merge-*.log`、`/tmp/roc-merge-*-validation.log` 和 `/tmp/roc-push-merge-renderer/`。此前严格帧预算与物理设备验收缺口仍保留。

打包使用 `createPackagingEnvironment()` 环境执行 `pnpm exec electron-builder --mac --dir --arm64 --publish never --config electron-builder.yml --config.directories.output=/tmp/roc-push-merge-package-final-GDXYaP`。原 release 包和默认用户数据未修改。最终包 `app.asar` SHA-256 为 `3b37ce698030fe92a9473c1d809c6cdc83c372e3176dfdc32e4b9a94758f2a3f`。

实际 packaged 历史启动命令：`node /tmp/roc-merge-packaged-history-probe.mjs /tmp/roc-push-merge-package-final-GDXYaP/mac-arm64/Roc.app /tmp/roc-merge-packaged-history-final-20261127`。填充 v76 历史夹具的独立副本成功升级至 v77；20 张业务表指纹、源数据库、PDF 和解析附件保持不变，removedRows=0，备份已验证。真实 `app.isPackaged=true`，1320×860 原生窗口显示历史项目，项目、文献和文档 IPC 读取成功，两处日志无致命启动错误。报告和截图位于 `/tmp/roc-merge-packaged-history-final-20261127/`。合成旧关系仍触发严格证据校验及科学后台警告，报告已保留；本项证明启动、读取与内容保留，不宣称后台科学处理全路径无警告。
