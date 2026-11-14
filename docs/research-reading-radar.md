# 结构化阅读、笔记与学术雷达

功能设计以 Agentero 的「结构化阅读与笔记系统」「学术雷达与文献发现」为功能参照，接入 Roc 现有文献画布。参照版本为 `poco-ai/Agentero@7cbdf46e5322bf0db1fb4b59f52c29920b21dbf1`（MIT）。窗口、导航、主题和科学溯源合同沿用 Roc。

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

- 笔记、高亮、订阅、文章与推荐缓存按项目隔离。笔记/高亮有版本冲突检查；高亮绑定 PDF 内容哈希，与不可变证据批注分别存储。
- 笔记当前存入 Roc 数据库，可显式导出 Markdown；采用数据库存储，不使用 Agentero 的文件夹存储模型。笔记切换、退出和工作区导航保护未保存内容。
- 外部网页运行于独立、临时 `WebContentsView` 会话，没有 preload、Node 或 Roc bridge；模态面板出现时隐藏原生网页。应用内导航限制在对应站点，权限申请和下载默认拒绝。
- 网络请求在主进程执行，验证 HTTPS 和公开目标地址，并限制响应大小、重定向与超时。翻译密钥走已有 secret storage，不写入 renderer 持久化状态。
- 笔记编辑器和雷达在唯一 AppShell 内按需加载；PDF 使用 `files.preview*` 返回的协议 URL。

## 外部服务边界

- Cool Papers、魔搭页面的元数据提取依赖外站结构；标题、arXiv 标识和 PDF 地址需在入库前核对。
- 翻译渠道的凭据、限流和网络错误会直接影响结果；渠道存在不代表当前网络下在线验收通过。
- 参考文献优先用 Semantic Scholar，首批无结果时回退 Crossref，再提取本地参考文献 DOI；后续被引仍依赖 Semantic Scholar。无可解析标识的条目不能可靠自动入库。
- arXiv RSS 无当日内容时保留空列表；推荐需实际嵌入配置，受控排序测试不代表在线推荐质量。

实现入口位于 `src/main/plugins/research/{reading-*,radar-*}`、`src/renderer/literature/`、`src/main/ipc/radar-browser-ipc.ts` 和 `src/shared/schemas/research-reading.ts`。验证方法见 [verification](verification.md)。
