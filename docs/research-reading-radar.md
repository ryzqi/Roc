# 结构化阅读、笔记与学术雷达

功能设计以 Agentero 的「结构化阅读与笔记系统」「学术雷达与文献发现」为功能参照，接入 Roc 现有文献画布。参照版本为 `poco-ai/Agentero@7cbdf46e5322bf0db1fb4b59f52c29920b21dbf1`（MIT）。窗口、导航、主题和科学溯源合同沿用 Roc。

## 使用入口

打开项目的 **文献** 画布：

| 功能 | Roc 入口与行为 | 主要实现 |
| --- | --- | --- |
| PDF 阅读与批注 | 「阅读」：原 PDF / 解析文本、导航、选择、高亮与固定来源定位，详见[阅读导航](research-pdf-navigation.md) | `PaperPdfView.tsx`、`PdfReadingTools.tsx`、`PdfTextLayer.tsx` |
| 图表、公式与算法提取 | 复用现有轻量/深度解析；按章节、图、表、公式、算法筛选，核对原 PDF 和解析图像，渲染 LaTeX、复制 Markdown | `PaperReader.tsx`、`ReadingFormula.tsx` 与既有解析管线 |
| 双向链接笔记 | 「笔记」或阅读器「论文笔记」：富文本/Markdown 切换、`[[标题]]` 链接、反向链接、`/` 插入块、公式、表格、文献关联、自动保存、⌘S、归档恢复、导出 `.md` | `ReadingNotesPanel.tsx`、`ReadingNoteEditor.tsx`、`reading-repository.ts` |
| 多模式翻译 | PDF 选区/本页/全文、解析文本选区/内容块/全文；原文译文对照，译文可存为笔记 | `ReadingTranslationPanel.tsx`、`reading-translation.ts` |
| 多渠道论文发现 | 「学术雷达」：Cool Papers、魔搭论文原生内嵌浏览，读取当前页论文并入库；RSS/Atom 订阅、刷新、置顶、已读与批量入库 | `AcademicRadarPanel.tsx`、`RadarBrowser.tsx`、`radar-browser-ipc.ts`、`radar-parser.ts` |
| 个性化每日推荐 | 「学术雷达 → 每日 arXiv」：根据项目书库标题/摘要的嵌入相似度排序；支持分类、当天缓存和重新计算 | `radar-service.ts`、`embedding-service.ts` |
| 引用关系与批量导入 | 阅读器「引文发现 / 批量入库」：参考文献/后续被引、分页、刷新、选择入库；独立的[学术关系](research-scholarly-relations.md)和[监控](research-monitors.md)提供来源快照与持续跟踪 | `ReadingDiscoveryPanel.tsx`、`reading-discovery.ts` |

解析需要现有解析模型就绪；普通 PDF 的文本阅读、搜索和高亮不依赖 OCR。每日推荐需在检索设置启用嵌入模型。翻译提供 Google、腾讯及 OpenAI 兼容、DeepL、Azure、Google Cloud 渠道；后四者需相应配置和密钥。

## 阅读与笔记布局

布局遵循 [Apple HIG 的信息层级与渐进披露](https://developer.apple.com/design/human-interface-guidelines/layout)和 [Microsoft Fluent 的空间分组与响应式布局](https://fluent2.microsoft.design/layout)：先呈现当前任务所需内容，低频操作就近展开；按画布实际宽度分配空间。视觉继续使用 Roc 的既有 token。

- 已选择文献时，阅读器默认使用完整画布宽度。「文献列表」可展开目录；窄画布中目录占满内容区，选择后回到阅读。顶部选择器可直接切换文献。
- 标题、阅读模式和阅读操作保持可见，引用信息、导出与外部科研工具收进「文献信息与工具」；解析配置按需展开。后台任务默认只显示总数，展开后查看逐篇进度与获取偏好。
- 笔记采用目录与编辑区，窄画布使用笔记选择器。文献关联、导出、归档与删除按需展开；自动保存、⌘S、未保存保护和版本冲突处理沿用原合同。删除需确认，永久移除当前笔记及未保存修改；确认和删除期间暂停编辑与自动保存，失败保留草稿。删除检查项目写权限与笔记版本，过期窗口不能删除其他窗口已更新的笔记。
- 公式输入在插入前实时预览。Markdown 源码同步展示渲染结果，支持 `$...$` 行内公式及 `$$...$$` 独立公式；不完整输入保留编辑能力。公式使用 KaTeX，禁用可信 HTML 命令，Markdown 中的原始 HTML 不执行。
- 切换工作区后，笔记源码预览释放 Markdown/公式 DOM，源码输入框、富文本编辑器、选择区间与未决保存继续保留。雷达释放文章列表、摘要详情及已捕获网页论文的只读 DOM，保留订阅草稿、筛选、批量选择与导入状态。返回时恢复对应阅读滚动位置；恢复等待异步内容最多 1.5 秒，用户滚动或键盘操作立即接管。

PDF 查找、复制、高亮保存及归档/恢复使用公共操作反馈，等待状态来自当前真实操作，失败保留原错误。同步重复提交守卫、高亮版本校验、PDF 内容哈希与批注坐标沿用原合同。「翻译本页」「翻译全文」中的等待表示正在提取原文并准备翻译输入；交给翻译面板后，才由逐段返回的译文更新翻译进度。「摘录到笔记」「译文存为笔记」只移交编辑内容，保存结果由笔记编辑器负责呈现。

翻译面板分别显示设置读取、设置保存、翻译及停止状态。「停止后续翻译」等待当前段返回，再停止后续请求并保留实际已返回的段落；部分失败显示保留的段数。设置保存继续使用原同步守卫和草稿确认。等待反馈不会重置设置草稿、密钥或译文；关闭、换文献和工作区导航继续走既有未保存保护。

动效只用于按钮和短状态反馈。`PaperPdfView` 的翻页、选区、批注坐标和 `ReadingViewBoundary` 的阅读恢复不增加过渡，PDF、解析正文与译文正文不整体动画；文献/页码身份及滚动恢复保持原行为。

## 发现与导入布局

RSS 添加表单按需展开，筛选与订阅控制区独立滚动。雷达在宽画布并列显示列表与文章详情；窄画布选择文章后使用完整内容宽度，关闭详情将焦点返回原入口。导入窗口扩大到 860px 并适配窄窗口，导入方式导航固定在顶部，表单与结果共用内容滚动区；切换方式、草稿与导入期间的保护沿用原合同。

## 数据与边界

- 笔记、高亮、订阅、文章与推荐缓存按项目隔离。笔记/高亮有版本冲突检查；高亮绑定 PDF 内容哈希，与不可变证据批注分别存储。
- 笔记当前存入 Roc 数据库，可显式导出 Markdown；采用数据库存储，不使用 Agentero 的文件夹存储模型。笔记切换、退出和工作区导航保护未保存内容。
- 外部网页运行于独立、临时 `WebContentsView` 会话，没有 preload、Node 或 Roc bridge；模态面板出现时隐藏原生网页。应用内导航限制在对应站点，权限申请和下载默认拒绝。
- 网络请求在主进程执行，沿用应用的环境/系统代理与 `NO_PROXY`，每次请求和重定向前验证 HTTPS 与公开目标地址。直连固定已验证的 DNS 地址；代理连接由应用已配置的代理解析原域名，避免将不可用的本机 DNS 地址固定进隧道。保留原站点的 Host 和 TLS 证书校验，限制响应大小、重定向与 45 秒总超时；取消时立即停止等待并释放连接。请求超时明确提示检查网络或代理，调用方取消保留取消原因。翻译密钥走已有 secret storage，不写入 renderer 持久化状态。
- 笔记编辑器和雷达在唯一 AppShell 内按需加载；PDF 使用 `files.preview*` 返回的协议 URL。

## 外部服务边界

- Cool Papers、魔搭页面的元数据提取依赖外站结构；标题、arXiv 标识和 PDF 地址需在入库前核对。
- Hugging Face 每日论文可订阅 `https://huggingface.co/papers`；现有 `https://huggingface.co/papers/feed` 订阅在刷新时自动使用官方 `/api/daily_papers` 接口，查询参数继续保留。保留原订阅地址、订阅 ID、已读与入库记录，按 arXiv 标识生成稳定文章 ID；读取原论文标题、摘要、作者与发表日期，提供 Hugging Face 详情和 arXiv PDF。空数组表示本期无论文；接口或响应格式失败时保留已有文章并记录错误。
- 翻译渠道的凭据、限流和网络错误会直接影响结果；配置可用不代表翻译准确或外部服务始终可达。
- 参考文献优先用 Semantic Scholar，首批无结果时回退 Crossref，再提取本地参考文献 DOI；后续被引仍依赖 Semantic Scholar。无可解析标识的条目不能可靠自动入库。
- arXiv RSS 无当日内容时保留空列表；推荐需实际嵌入配置，受控排序测试不代表在线推荐质量。
- 每日推荐分别报告嵌入连接探测、arXiv 订阅读取和推荐内容向量计算阶段的失败；已配置模型时不将超时显示成“未启用模型”。配置变化、密钥错误与取消保留原领域语义，不能用网络重试代替处理。

实现入口位于 `src/main/plugins/research/{reading-*,radar-*}`、`src/renderer/literature/`、`src/main/ipc/radar-browser-ipc.ts` 和 `src/shared/schemas/research-reading.ts`。检查方法见[开发与检查](development.md)；公开文献捕获和相关性测量见[文献评测方法](literature-evaluation.md)。
