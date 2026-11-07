# 结构化阅读、笔记与学术雷达

本次以 Agentero 的「结构化阅读与笔记系统」「学术雷达与文献发现」为功能参照，接入 Roc 现有文献画布。参照版本为 `poco-ai/Agentero@7cbdf46e5322bf0db1fb4b59f52c29920b21dbf1`（MIT）。窗口、导航、主题和科学溯源合同沿用 Roc。

## 使用入口与功能对应

打开项目的 **文献** 画布：

| Agentero 功能 | Roc 入口与行为 | 主要实现 |
| --- | --- | --- |
| PDF 阅读与批注 | 「阅读」：目录、适页/适宽、页码导航、原始 PDF 文本选择、全文搜索、四色高亮及备注；选区可摘录为关联笔记 | `PaperPdfView.tsx`、`PdfReadingTools.tsx`、`PdfTextLayer.tsx` |
| 图表、公式与算法提取 | 复用现有轻量/深度解析；按章节、图、表、公式、算法筛选，核对原 PDF 和解析图像，渲染 LaTeX、复制 Markdown | `PaperReader.tsx`、`ReadingFormula.tsx` 与既有解析管线 |
| 双向链接笔记 | 「笔记」或阅读器「论文笔记」：富文本/Markdown 切换、`[[标题]]` 链接、反向链接、`/` 插入块、公式、表格、文献关联、自动保存、⌘S、归档恢复、导出 `.md` | `ReadingNotesPanel.tsx`、`ReadingNoteEditor.tsx`、`reading-repository.ts` |
| 多模式翻译 | PDF 选区/本页/全文、解析文本选区/内容块/全文；原文译文对照，译文可存为笔记 | `ReadingTranslationPanel.tsx`、`reading-translation.ts` |
| 多渠道论文发现 | 「学术雷达」：Cool Papers、魔搭论文原生内嵌浏览，读取当前页论文并入库；RSS/Atom 订阅、刷新、置顶、已读与批量入库 | `AcademicRadarPanel.tsx`、`RadarBrowser.tsx`、`radar-browser-ipc.ts`、`radar-parser.ts` |
| 个性化每日推荐 | 「学术雷达 → 每日 arXiv」：根据项目书库标题/摘要的嵌入相似度排序；支持分类、当天缓存和重新计算 | `radar-service.ts`、`embedding-service.ts` |
| 引用关系与批量导入 | 阅读器「引文发现 / 批量入库」：参考文献/后续被引、分页、刷新、选择入库；Semantic Scholar、Crossref 回退、本地参考文献 DOI 提取；既有「学术关系」「监控」继续提供关系与跟踪 | `ReadingDiscoveryPanel.tsx`、`reading-discovery.ts` |

解析需要现有解析模型就绪；普通 PDF 的文本阅读、搜索和高亮不依赖 OCR。每日推荐需在检索设置启用嵌入模型。翻译提供 Google、腾讯及 OpenAI 兼容、DeepL、Azure、Google Cloud 渠道；后四者需相应配置和密钥。

## 数据与边界

- Migration 65 新增项目隔离的笔记、高亮、订阅、文章与推荐缓存。笔记/高亮有版本冲突检查；高亮绑定 PDF 内容哈希，现有不可变证据批注继续保留。
- 笔记当前存入 Roc 数据库，可显式导出 Markdown；本次未迁移为 Agentero 的文件夹存储模型。笔记切换、退出和工作区导航保护未保存内容。
- 外部网页运行于独立、临时 `WebContentsView` 会话，没有 preload、Node 或 Roc bridge；模态面板出现时隐藏原生网页。应用内导航限制在对应站点，权限申请和下载默认拒绝。
- 网络请求在主进程执行，验证 HTTPS 和公开目标地址，并限制响应大小、重定向与超时。翻译密钥走已有 secret storage，不写入 renderer 持久化状态。
- 新增页面仍在唯一 AppShell 内，笔记编辑器和雷达按需加载；PDF 使用 `roc-preview`。修复了首次导航前未注册预览协议和适宽渲染被高度抖动反复触发的问题。

## 验证记录

执行日期：2026-11-07。以下命令工作目录均为仓库根目录，日志和截图在 `.artifacts/reading-radar/`。Electron 脚本需串行执行，应用单实例锁会拒绝并发启动。

| 命令 | 结果 / 证据 |
| --- | --- |
| `pnpm build` | 通过，包含主进程/renderer 类型检查和生产构建；`build-final.log` |
| `pnpm check:ipc` | 通过，生成的 IPC 与声明一致；`ipc-final.log` |
| `pnpm check:renderer-chunks` | 通过，新增重依赖未进入 eager graph；`chunks-final.log` |
| `node --test tests/unit/research-reading.test.mjs` | 9/9 通过：项目/版本隔离、RSS、翻译错误与密钥边界、引文回退和导入、推荐排序/缓存/配置变化；`reading-unit-final.log` |
| `node --test tests/renderer/paper-reader.test.mjs` | 31/31 通过，含 400 页导航、单 bitmap/worker、原始证据绑定和解析图像；`reader-height-fix.log` |
| `node scripts/verify-reading-radar.mjs` | 12 项生产流程及 24 项主题/尺寸检查通过；包含冷启动 PDF、Markdown 往返、选区/高亮、笔记联动、缺密钥错误、重启持久化；`runtime-final.log`、`results.json` |
| `node scripts/verify-radar-browser.mjs` | 7 项行为检查及 8 项主题/尺寸检查通过；使用明确的合成 HTTPS 页面验证真实原生视图、IPC、隔离、导航、覆盖层、标题提取、RSS 状态；`native.log`、`native-results.json` |
| `node scripts/verify-radar-live.mjs` | 真实 Cool Papers 和魔搭均通过，分别提取 25 / 30 篇，标题与正文分离；两站均无 Node / Roc bridge；`live-native.log`、`live-native.json` |
| `node scripts/verify-reading-sources.mjs` | 真实来源检查 4/5 通过，Google 超时使脚本如实返回失败；`live-sources.json` |
| `git diff --check` | 通过 |

布局检查覆盖实际 `innerWidth` 800、1000、1099、1100，浅色/深色；测试仅降低验收窗口的原生最小宽度。原生网页另行截图，renderer 截图不能证明原生网页已显示。截图复核后增加窄笔记侧栏输入宽度和正文可编辑高度断言，最终重跑通过。

广泛回归最初为单元 1592/1597：三个迁移版本断言已更新为 65，两个执行器时序测试孤立重跑通过；相关迁移/执行器/阅读复验 22/22。另四组 renderer 工作流 32/32 通过。这里不将这些局部复验表述成整个测试套件重新全绿。

## 真实外部服务结果与限制

- Cool Papers 论文元数据提取成功，保留标题、arXiv 标识和 PDF 地址。实时浏览发现 `/arxiv` 返回 404，已改为有效的 `/arxiv/cs.AI` 分类入口。
- 魔搭真实页面加载、隔离和论文链接提取成功；优先读取卡片编码的标题元数据，Cool Papers 则读取标题链接，避免把摘要、标签或操作按钮当成标题。
- 腾讯翻译成功；Google 在当前网络 45 秒超时，错误真实显示。没有 BYOK 凭据，未宣称其余渠道已通过在线验收。
- Semantic Scholar 返回 HTTP 429，参考文献发现成功回退到 Crossref，得到 37 条。后续被引仍受 Semantic Scholar 服务可用性影响。
- 当天 arXiv RSS 明确声明周末跳过且返回零篇，服务保留真实空列表。推荐排序使用受控嵌入进行回归，未完成用户真实嵌入配置下的每日推荐在线验收。
- 本地参考文献回退识别参考文献章节中的 DOI；没有可解析标识的条目不能可靠自动入库。在线解析质量及外站页面结构仍取决于各自数据源。

新增源文件集中于 `src/main/plugins/research/{reading-*,radar-*}`、`src/renderer/literature/`、`src/main/ipc/radar-browser-ipc.ts` 和 `src/shared/schemas/research-reading.ts`；迁移、插件装配及生成的 IPC 同步更新。本次未提交 Git 或发布应用。
