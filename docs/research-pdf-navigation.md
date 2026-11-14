# 原文与解析文本阅读导航

现有文献阅读器提供原 PDF 与解析文本核对、固定来源跳转、文本选择/高亮及页级/区域批注。来源捕获与科学关系审核见[证据关系](research-evidence-relations.md)；阅读、定位和批注不会确认科学支持。

## 实测坐标与原子发布

解析 bbox 是实际 raster 的 XYXY 区域，使用记录的坐标原点。PDF frame 保存位图尺寸、PDF.js viewport、CropBox/viewBox、UserUnit、旋转、实际 scale 与六项仿射变换；image 保存实测 image frame，HTML 为 null。请求缩放可能因像素上限和取整而改变，不能使用固定 1.5 或把 raster 当作 PDF points。

`projectParsedRegionToPdf` 检查非空且在 raster 内的区域，必要时反射 bottom-left 原点，再逆变换到 PDF 用户空间；显示时使用目的 viewport 变换四角。奇异/非有限变换、越界区域和损坏 frame 报错；缺依据只能明确页定位，不能从 locator 或文件名猜区域。合同见 [research-document-coordinates.ts](../src/shared/research-document-coordinates.ts)。

坐标快照独立保存，绑定 sourceHash、规范化 parseHash、逐页 frame 及 structured artifact 的 SHA/大小。解析完成、坐标标记、索引替换和旧引用失效同事务发布；失败保留原解析/索引，知识写入在提交后排队。

历史无坐标标记的解析返回 coordinates=null。带标记而记录缺失、损坏或工件变更必须失败，不能降级为无坐标。旧解析、Evidence 和审核历史不重写；后续解析不替换原快照。

## 安全预览与版本选择

`research.previewDocument` / `research.getDocumentContent` 显式请求固定版本：

```typescript
{
  projectId: string;
  documentId: string;
  parseId: string;
  sourceHash: string;
  parseHash: string | null;
}
```

普通阅读首次获取可传 parseHash=null，由 main 返回实际哈希；Evidence/Claim 深链必须传保存哈希。`resolveDocumentParse({projectId, parseId})` 核查真实文档身份与项目关联，不以当前文档或最新解析替代历史版本。

main 在异步字节验证前后核对项目关联、解析/快照身份、原文件及资产哈希/大小。响应含版本、页数、sourceUrl、PNG 资产 ID/类型/页/哈希/大小/URL 和测量坐标，无任意磁盘路径、原始字节或写权限。

```text
roc-preview://research/projects/<projectId>/documents/<documentId>/source/<sourceHash>
roc-preview://research/projects/<projectId>/documents/<documentId>/parses/<parseId>/<assetId>/<sha256>.png
```

ID 使用 encodeURIComponent。source 能力也允许读取未解析原文件；asset 必须属于指定 parse。解除项目关联、字节损坏、资源缺失或符号链接均拒绝，协议失败返回 404；响应为 no-store/nosniff，HTML 原文按下载附件返回。PDF/PNG 使用协议 URL，不创建 Blob URL。

协议启用 supportFetchAPI/corsEnabled，并在能力调用前检查 Electron request.initiatorOrigin。只允许文件 renderer、明确配置的开发来源与主进程/浏览器自身请求；其他来源及不透明 iframe 拒绝。Origin header/referrer 不能代替 initiatorOrigin；开发 CORS 只回显获准来源，保留 webSecurity/CSP。

普通阅读使用 currentParseId；历史深链只读取确切 ready parse。不存在、未完成、失效目标或跨项目显示可重试错误。locator 必须唯一精确匹配；带检索 focusText 的跳转可在同一解析中寻找唯一完整文本或包含该片段的块，歧义不自动选择。

读取身份绑定项目、文献、文档、解析、来源哈希及重读次数，迟到响应不能覆盖新选择。文档 tab 支持方向键/Home/End 和可见焦点；换文档清除历史深链。

## PDF 阅读与反向定位

「原 PDF / 解析文本」入口按需加载 PDF.js 与 worker；未解析 PDF 也可读取原文，已有解析先计算规范化 parseHash 并请求同版本预览。页面支持明确页码、上一/下一页、PageUp/PageDown/Home/End、适宽/适页及 0.5–3 倍缩放。

每次只保留一页 DOM canvas，位图上限 400 万像素。翻页/缩放取消旧 render 并释放页资源；关闭/换来源取消 fetch/loading，销毁 PDF 文档及 worker。缺 frame 提示仅页定位；整页 bbox 明确说明未细分块，不称为精确段落。

点击 PDF 用本页已记录区域命中：所有页块都有区域且唯一命中时选确切 block/locationIndex；重叠须明确选择候选，无命中不猜邻近块。缺区域时提供「本页解析块」键盘入口。跨页块保留所选位置，返回解析文本后聚焦并滚动到内容组。

有原生文本层的 PDF 支持逐字选择、复制、摘录到笔记、选区翻译和保存高亮；另有原文件目录、全文查找、匹配页跳转及本页/全文翻译。高亮按项目/document/sourceHash 保存页、归一化矩形、文本、颜色和备注，可归档/恢复。扫描件无可提取文字时明确提示使用解析文本翻译；文本层不会为扫描件自动生成 OCR。入口见 [PdfTextLayer.tsx](../src/renderer/literature/PdfTextLayer.tsx) 与 [PdfReadingTools.tsx](../src/renderer/literature/PdfReadingTools.tsx)。

## Evidence / Claim 固定原文

工件「查看原文固定版本」绑定保存的 project/document/parse/sourceHash/parseHash，并核对 parserFingerprint、唯一 blockId、原始 locator、完整 excerpt 与页/区域数组。不一致拒绝显示，不换当前解析。

重解析后的失效 Evidence/关系仍可读取原 ready parse/source，并同时显示原文、原版本和当前失效状态。关系入口使用 relation.source，不替换为工件中的另一 Evidence。多位置可明确选择；阅读不修改 Evidence、Claim 或审核。非 PDF 读取保存块，不加载 PDF 引擎；关闭、重读或换来源释放资源。

## 不可变批注与 Evidence 转换

批注目标固定项目、document/parse、sourceHash/parseHash/parserFingerprint、页与可空 blockId。位置为明确页定位或 pdf-user-space 的非空区域；区域必须有同页实测 frame/snapshotHash 且在 CropBox 内。问题类型为笔记、数字、单位、公式、表格和识别问题，说明必填，wire 无 actor 或科学审核状态。合同见 [research-document-annotations.ts](../src/shared/schemas/research-document-annotations.ts)。

| preload 方法 | 能力 | 行为 |
| --- | --- | --- |
| createDocumentAnnotation | research.annotations.create | 固定请求/哈希、原块、可信窗口用户与时间 |
| listDocumentAnnotations / getDocumentAnnotation | research.annotations.list/get | 核查不可变快照，读取不修复损坏记录 |
| captureDocumentAnnotation | research.annotations.capture | 显式转换当前文本块，保存独立 Evidence 收据 |

main 先验证完整目标和实际 source/坐标字节，再在同步事务重验身份。用户身份来自有效窗口/项目/能力上下文；直接工具无人工写权限，归档项目不能创建/转换。相同完整请求/requestId/窗口重放只返回原记录，变化拒绝。

转换必须是当前 parse 的明确文本块和实际索引 chunk，复用 Evidence.capture；Evidence/SourceLocator 与转换收据同事务，失败全撤回。历史批注可读但不能构造新 chunk。人工区域留在批注快照，Evidence 保留原始解析块完整位置，不能冒充解析器识别区域。后续重解析保留原收据，当前 capturedReferenceStatus 单独返回；不改主张或科学关系。

界面提供「本页批注」与拖动框选，Escape 取消。缺测量依据时禁用框选，可明确页定位；空区域报错。表单默认不关联块，须显式选择本页块才能转换。保存期间禁用输入，相同请求重试保留 requestId，编辑另建请求；历史/只读来源只读，迟到响应不影响新页面。

## 图像核对与质量边界

块的「核对解析图像」并排显示保存 PNG 与原始文本；表格/公式无资产时明确提示，不拿整页图替代。一次展开一个资产，模块独立懒加载，单独看 PNG 不加载 PDF。HTML/LaTeX 作为原文，不执行成页面或公式排版。

预览核对完整固定版本及资产 ID、SHA、大小、类型、页与项目 URL；PNG 字节由 main asset 能力继续校验。损坏可重试，原始文本保持可见；Evidence/Claim 历史资产仍绑定原版本。

质量提示只陈述所选解析的 OCR/mixed、native-only 警告和空块事实；没有校准置信度，不生成准确率百分比。受控三页扫描 fixture 覆盖实际模型/worker、入库、索引、Evidence、坐标与 PNG 校验；合成区域仅验证交互。两者都不证明复杂科研 OCR 质量，Node host/合成窗口接缝不等于完整生产 kernel/preload E2E。验证入口见[验证说明](verification.md)。
