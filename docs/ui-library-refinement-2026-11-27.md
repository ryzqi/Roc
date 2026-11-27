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

状态：**Verified passing**（定向自动化范围）。

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

## 证据边界

工程回归使用真实 Electron 窗口与受控服务；它不代替外部 Provider、
物理触控板、系统中文输入法、VoiceOver、另一台 Mac 或实际屏幕刷新率验收。
RAF、输入响应与主线程 trace 分别报告。未改变数据库 schema 或持久化收据，
本次不涉及真实 `~/.roc` 数据迁移。
