# 原 PDF 与解析定位

当前支持测量坐标、原子解析快照、安全预览元数据、原 PDF/解析文本并排阅读及 Evidence/Claim 关系的固定来源阅读。块与 PDF 的双向定位、批注保存和 Evidence 转换已接入；表格/公式解析资产核对及具体质量提示已接入；受控无文本层扫描夹具有独立测试；更广泛 OCR 质量与真实科研样本代表性仍需独立验收。

## 坐标与版本

解析器保留 PDF.js 实测的页视口、CropBox、UserUnit、旋转及仿射变换。解析区域使用实测 raster-pixel 坐标；不假设所有页都是 PDF points，也不使用固定 1.5 缩放推算位置。图像页单独记录 image frame，HTML 页没有 raster frame。

独立坐标快照与原文件 sourceHash、规范化解析内容 parseHash、结构化工件 SHA-256/大小绑定。将快照和标记放入解析发布事务：坐标失败不能留下成功解析、新索引或已失效证据。原有解析与历史证据不重写。

旧解析没有测量快照时返回显式 `coordinates: null`。带快照标记但记录缺失、损坏或工件变更时返回失败，不能当成没有坐标继续投影。原始页面 bbox 与 PDF 坐标互转见 `src/shared/research-document-coordinates.ts`。

## 安全预览接口

预加载方法 `research.previewDocument` 调用 `research.document.preview`，请求为：

```typescript
{
  projectId: string;
  documentId: string;
  parseId: string;
  sourceHash: string;
  parseHash: string | null;
}
```

`parseHash` 为已知的固定解析哈希；普通阅读首次获取时显式传 null，由主进程返回实际哈希。Evidence/Claim 跳转应传来源快照中的哈希。不得把“当前解析”替换成请求的历史 parseId。

`research.getDocumentContent` 使用同一版本请求合同，移除无项目的旧请求。`research.resolveDocumentParse({projectId, parseId})` 通过主进程解析实际文档身份并验证项目关联，不根据当前文档顺序猜测历史版本。

主进程先核对文档所属文献是否关联请求项目，再验证解析内容、原文件字节及坐标工件。异步文件读取后重新核对项目关联与解析/快照身份。响应包含来源版本、页数、原文件 URL、解析图像 ID/类型/页/哈希/大小/URL，以及测量 frame 和 snapshotHash；没有绝对文件路径、原始字节或写权限。

协议 URL 为：

```text
roc-preview://research/projects/<projectId>/documents/<documentId>/source/<sourceHash>
roc-preview://research/projects/<projectId>/documents/<documentId>/parses/<parseId>/<assetId>/<sha256>.png
```

每个 ID 使用 `encodeURIComponent`。协议调用同一文档 source/asset 能力，必需 projectId。无项目的旧文档 URL 已删除，没有兼容别名。

原文件访问仍可用于未解析文档。source 能力校验记录 SHA-256/大小，asset 能力校验实际 PNG 字节 SHA-256/大小和指定 parseId。解除项目关联、来源损坏、资源缺失及符号链接访问均拒绝；协议能力失败返回 404，不返回成功 PDF。文件响应使用 `no-store` 与 `nosniff`，HTML 原文按下载附件返回。

`roc-preview` 注册 `supportFetchAPI` 和 `corsEnabled`。后者是 Chromium 支持跨协议 fetch 的必要条件，不关闭 webSecurity，也不绕过 CSP。

协议在调用能力之前验证 Electron 提供的 `request.initiatorOrigin`。允许文件 renderer、明确配置的开发 renderer 来源和主进程/浏览器自身发起的请求；其他来源及不透明 iframe 拒绝。实际 Electron45 请求即使来自 HTTP 页面也可能没有 `Origin` header，不能用 header 或可由页面隐藏的 referrer 代替该检查。只有配置的开发来源获得对应的 CORS 响应，不使用通配来源。

## 阅读器版本选择

普通阅读按文档记录的 `currentParseId` 请求内容。历史深链先解析请求的 parseId，再核对属于当前文献，读取该确切版本。未完成、已失效、不存在或未关联当前项目的解析显示可重读错误，不打开其他文档或邻近解析。

旧辅助函数从倒序解析列表取末项，会选择最旧 ready 解析，现已删除；未保留别名。locator 跳转要求一个精确匹配；前缀、子串、重复定位均不自动选择。

读取状态按项目、文献、文档、解析、来源哈希及重读次数绑定。选择变化立即阻止旧内容显示，迟到响应不能覆盖新选择。文档 tab 支持左右方向键、Home/End 和可见焦点；选择其他文档会清除历史深链。

## 并排阅读与资源

现有阅读器通过「原 PDF / 解析文本」切换进入并排模式；块的「原文位置」按钮选择确切位置，多位置块可选择其中一页。原 PDF 先读取该解析内容的规范化 SHA-256，再请求同版本预览；没有新版或近似 locator 替代。PDF.js 和 worker 只在打开并排模式后加载，原 PDF 字节通过已有协议取得，不创建 Blob URL。

读页提供上一页、下一页、明确页码，以及 PageUp/PageDown/Home/End。页码输入使用原文件实际页数；缩放为适宽的 0.5–3 倍。投影使用记录的仿射 frame 和当前 PDF.js viewport 的四角变换，覆盖 CropBox、UserUnit 与旋转；不使用固定缩放或假设原始 bbox 为 PDF points。

缺少区域 frame 时明确提示仅页定位。解析器记录整页 bbox 时明确说明没有细分块区域；高亮整页不会被描述为精确段落。原文件、版本、坐标或页数不一致时显示可重试错误。

每次只保留一个可见页的 DOM canvas，页位图上限为 400 万像素。翻页/缩放/重绘取消旧 render 并释放页资源；关闭或切换来源取消 fetch/loading，销毁 PDF 文档、PDF worker 和原生 Worker。框选区域与页级研究批注已接入；没有逐字文本选择。

阅读器测试由 Vite8.3.5 实际构建并加载 Electron/Chromium，直接使用 `?worker` 生成的独立 worker 文件，不模拟 worker import。场景覆盖冻结 PDF 真实文本位图、缩放、三个窗口边界、无坐标历史、原文损坏、CropBox/90°/UserUnit2、32 页跳转与关闭清理。32 页 PDF 只解析第一页，测试仍可读取原文件其他页面，不制造未解析页的区域。

## PDF 反向定位

点击原 PDF 的位置，用当前实际绘制视口中所有该页解析区域做命中判断。只有一个命中且所有页块都有区域时，选择该块的确切 `locationIndex`。多个区域覆盖位置时展示原始标签、locator 和位置序号，必须明确选择；没有命中时不选择附近块。此前选择会保持到用户作出新选择。

「本页解析块」提供同等键盘入口，包括只记录页定位的历史解析。缺少区域时点击不会产生空间匹配，而是提供本页块列表并明确提示。跨页块选择保留用户所选位置，不能改回其第一个位置。

返回解析块后，焦点移到可程序聚焦的块 section，并滚动到该块。选择块有背景与可见焦点；目标是内容组，避免一次 Enter 又激活块内「原文位置」按钮。

反向测试使用真实 PDF/worker 和实测 crop/rotation/UserUnit frame，非重叠、重叠及跨页布局明确为合成测试块，并发布独立 SHA-256 工件。此证据建立坐标交互，不声称解析器已经精确识别这些区域。实际交互保持数据库零写入。`reverse-clip-audit.json` 保存展开、明暗、hover 和键盘目标状态；`reverse-overlap-*.png` 保存候选列表布局。

## 工件 Evidence 的原文固定版本

工件证据展开区的「查看原文固定版本」读取已保存 SourceLocator。请求显式绑定 projectId、documentId、parseId、sourceHash 和 parseHash；显示前核对返回文档、解析身份、规范化内容哈希、parserFingerprint、唯一 blockId、原始 locator、证据 excerpt 及完整页/区域数组。内容不一致时拒绝显示，不读取当前解析替代。

同一原文件已重解析、该 Evidence 引用已失效时，仍可以读取原始 ready parse 和原 PDF。失效状态、旧证据文本及版本保持可见；阅读不会更改 Evidence、Claim 或审核记录。多位置来源可选确切位置；PDF 上下文选择保持同一个固定解析，并将键盘焦点移到对应的解析文本组。

非 PDF 来源显示保存版本的解析块，不加载 PDF 引擎。PDF 模块和 worker 在文档类型确认后继续懒加载；关闭、重读或换项目释放原有视图资源。读取错误可明确重试同一版本，迟到响应不能覆盖另一 Evidence。

阅读器测试包含实际 Evidence 捕获、真实重解析失效后的旧 parse/source 读取、八种身份/哈希/内容/位置不匹配拒绝、不同原文件/项目的迟到读取，以及显式合成跨页块的固定位置。Node-host 适配器窗口98是测试接缝。来源视图在现有 560px ModalShell 抽屉中验收，源码不新增 shell、路由或前端。

工件检查器、生产检查器和阅读器测试共享 Vite 实际构建入口，直接产出 lazy 模块及 worker 文件。`evidence-fixed-original.json` 保存固定来源和实际请求，`evidence-original-clip-audit.json` 保存三个窗口/主题的裁切记录；`evidence-original-*.png` 保存明暗布局。

## Claim 关系的原文入口

主张关系记录的「固定来源与版本」展开区提供「查看关系原文固定版本」。读取该关系保存的 `relation.source`，复用上述严格来源阅读器，不改用工件中另一条当前 Evidence。即使关系在重解析后已失效，原始 ready parse/source 仍可核查。

## 批注目标契约

`research-document-annotations.ts` 定义必需的 project/document/parse、sourceHash/parseHash/parserFingerprint、页和可空 blockId。坐标依据显式为 null 或同一页的实测 PDF frame 与 snapshotHash。位置只能是明确页定位，或带 `pdf-user-space` 单位的非空 XYXY 区域；区域必须位于实际 CropBox 内，并有捕获坐标依据。没有坐标时不能发送猜测区域。

问题类型为笔记、数字、单位、公式、表格和识别问题，必需用户说明。请求没有 actor 或科学审核状态。契约、可信存储、PDF 框选和批注/Evidence 转换界面已接入。

## 批注存储与证据转换

保存不可变批注快照：完整请求及其 SHA-256、所选原始解析块、用户窗口身份、时间和快照哈希。独立转换收据保存批注哈希、用户身份和实际捕获的 Evidence/SourceLocator。不补写历史用户笔记。

四个生成的 preload 方法为 `createDocumentAnnotation`、`listDocumentAnnotations`、`getDocumentAnnotation`、`captureDocumentAnnotation`，对应 `research.annotations.create/list/get/capture`。创建请求没有 wire actor；主进程适配器验证请求，再绑定有效窗口/项目的可信人工上下文。直接工具调用不能获得人工写权限。归档项目不能创建或转换批注。

创建先验证准确来源、解析、页、块和保存坐标依据，再通过现有 preview 验证实际原文件和坐标工件字节。返回文件验证后，在同步写事务再次核对完整目标。相同项目/requestId/请求哈希/窗口重放返回已有记录，变化则拒绝。读取记录检查固定快照与哈希，不能修复或更新损坏记录。

历史批注保存原页/区域/文本，即使当前解析和索引已更新也可核查。转换需要明确文本块、当前 parse 和实际索引 chunk，不能从历史文本构造 chunk ID。复用 `Evidence.capture`，Evidence 与收据在同一事务中写入；收据失败必须撤回该事务的 Evidence/SourceLocator。区域保存在链接的批注快照，Evidence SourceLocator 保留原始解析块的完整位置，不能把人工框选区域说成解析器识别区域。

已捕获后重解析仍保留原始收据；当前引用失效状态单独返回。批注和转换不修改主张、关系或科学审核。实际原生流程保存 `p0-production/<taskId>/document-annotation.json`，窗口99是明确合成身份；验证真实解析、注册器、生成适配器、Evidence复用及重放/读取零写入。单元集成还覆盖越界身份、坐标/字节变化、旧解析拒绝转换、索引损坏零写入和收据回滚。

## 阅读器批注界面

原 PDF 工具栏的「批注」展开所选解析的固定记录。可写项目中，「本页批注」提供键盘入口；框选按钮进入拖选模式，Escape 取消。框选用实际绘制视口换算 PDF 用户坐标，并把边界限定到该页实际 CropBox。页或绘制状态变化结束原框选；空区域显示错误，不自动改成页定位。缺少测量依据时框选按钮禁用，可显式保存页级批注。

表单默认不关联解析块，必须明确选择本页块才能以后捕获该块为证据。可选笔记、数字、单位、公式、表格、识别问题并填写说明；保存前虚线显示用户框选区域，与解析器区域区分。保存与捕获期间相关输入禁用。失败重试保留原请求 ID，编辑内容开始另一请求；跨来源/项目或关闭后的迟到结果不会显示在新页面。重新打开可读取已提交收据，不重复写入。

已保存记录显示原页、问题、说明、所选块和可展开的来源哈希/解析版本/用户时间。「回到批注位置」使用原页和区域，不猜附近块。可写当前解析中的文本块提供明确证据转换操作，历史/只读来源不提供新捕获；已捕获记录显示独立的当前引用失效状态。Evidence/Claim 原文视图可读取已保存批注，保持只读。

## 解析图像与质量提示

保存了图像资产的块提供「核对解析图像」；表格和公式块缺少资产时明确提示。该入口将保存的 PNG 与未经重新解释的原始文本并排显示；每次只展开一个图像。模块独立懒加载，单独核对 PNG 不加载 PDF 引擎；与原 PDF 比较时仍只保留一个页 canvas/worker。没有 `imageAssetId` 时明确说明未保存图像，不用整页图片替代缺失块图像。HTML/LaTeX 保持原始文本，不执行为页面或数学排版。

图像先使用所选内容的规范化 parseHash 请求完整版本 preview，核对项目/文档/解析/来源，以及该块实际 asset ID、SHA-256、大小、类型、页和项目协议 URL。PNG 字节继续由主进程 asset 能力校验，使用已有 `roc-preview` URL，没有 Blob URL。来源或图像损坏显示可重试错误，原始块文本始终保留。Evidence/Claim 固定原文视图复用同一模块，旧解析图像仍绑定原始版本，迟到元数据不能替换另一来源。

质量信息只使用所选解析的事实：OCR/mixed 模式提示核对数字、单位、公式；实际 native-only 警告说明没有 OCR 核查；空块提示核对原文。未知解析警告保留原记录文本。稳定内容没有校准置信分数，因此界面没有生成百分比或从 raw structured score 推断准确率。

## 受控扫描验证边界

`tests/fixtures/research-scanned-source.mjs` 生成无文本层的三页受控扫描 PDF 与独立源真值：正文数值/单位、合并表头和重复组表格、带分数/求和上下标的公式。测试使用仓库固定的 complete CPU 模型包和生产 sandbox worker，覆盖实际解析、采集、入库、索引、Evidence、固定坐标与 PNG 校验；不合成识别块，不调用付费语言模型。模型包使用任务工件目录并按 manifest SHA/大小校验。这类受控夹具不证明复杂科研扫描识别质量；Node host/合成窗口接缝也不等于完整生产 kernel/preload E2E。

### Measured coordinate frames

Parser bounding boxes are XYXY rectangles in the actual rendered raster, with a top-left
origin. They are not PDF user-space coordinates. PaddleOCR1.2.0 crops regions using
x2-x1/y2-y1; native text uses the full measured raster bounds. The PDF renderer requests
scale1.5 but clamps oversized viewports to25,000,000 pixels, then rounds bitmap dimensions.
A page rotation, CropBox offset or UserUnit changes the PDF-to-raster affine transform.

New middle/structured JSON records coordinateFrameContractVersion1 and a coordinateFrame
for each processed page. A PDF frame preserves raster width/height and the actual PDF.js6.4.299
viewport width/height, scale, rotation, UserUnit, viewBox and six affine matrix values. Image
frames contain only their actual raster basis; HTML records null. No coordinate basis is
invented for an old source or unavailable metadata.

projectParsedRegionToPdf validates a nonempty region within the captured raster and inverts
the saved viewport transform. Bottom-left raw regions are reflected within the recorded raster
before inversion. The output is a PDF user-space XYXY rectangle; consumers must apply the
actual destination viewport when drawing it. Rotation and nondefault scale are never inferred
from a locator string, filename or a universal1.5 ratio.

A malformed frame, singular/nonfinite transform or invalid/out-of-raster region is an error.
A missing basis cannot produce a guessed region; the reader must explicitly use page-only
location. Frame capture does not approve scientific support or migrate a source to a new parse.

### Verification and current limits

Actual generated PDFs with crop[20,30,500,700], rotations90/270, UserUnit2 and a12000x15000
page are parsed through the real PDF.js path. Projection matches independent
PageViewport.convertToPdfPoint results, including bottom-left regions. The large page records
actual scale0.37267799624996495 rather than1.5. Native text without a page image and the
actual OCR raster renderer share the same measured-frame path.

Primary API reference: https://github.com/mozilla/pdf.js/blob/v6.4.299/docs/contents/examples/index.md
Installed implementation: pdfjs-dist6.4.299 PageViewport and paddleocr1.2.0 structure pipeline.

### Atomic coordinate snapshot publication

The database stores coordinate snapshots separately from the original parse JSON. New captures
bind sourceHash, canonical parsed-content SHA, processed-page frames and exact structured artifact
path/hash/size. collectDocumentContent normalizes through the persisted schema before hashing.
Its result carries data and an explicit nullable coordinate input; complete requires that input.
Synthetic or historical page-only records explicitly use null, with no old write-signature alias.

Parse completion, coordinate insertion/hash marker, index replacement and previous source
invalidation share a transaction. Insertion failure retains the old parse/index/source and queues
no phantom publication. New parse records carry coordinate_snapshot_hash, allowing a lost snapshot
to raise a missing-data error. Stored-frame corruption, changed source/parse, wrong page/region
or an unexpected snapshot also fail. Existing rows receive only a null marker; no old parse JSON,
Evidence, user predecessor selection or scientific history is rewritten and no frame is invented.

Marked current structured artifacts must provide valid matching frames. Markerless historical
artifacts have no captured basis and cannot be projected to a region. Coordinates are read by
fixed document/parse identity; a later parse never replaces the old saved snapshot during reads.
The preview boundary validates file bytes and exposes matching frame metadata.
