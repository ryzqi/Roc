# 原 PDF 与解析定位

PR-07 当前已完成测量坐标、原子解析快照、安全预览元数据和原 PDF/解析文本并排阅读。块与 PDF 的双向定位已接入；Evidence/Claim 固定来源深链及标注捕获仍待完成。

## 坐标与版本

解析器保留 PDF.js 实测的页视口、CropBox、UserUnit、旋转及仿射变换。解析区域使用实测 raster-pixel 坐标；不假设所有页都是 PDF points，也不使用固定 1.5 缩放推算位置。图像页单独记录 image frame，HTML 页没有 raster frame。

独立坐标快照与原文件 sourceHash、规范化解析内容 parseHash、结构化工件 SHA-256/大小绑定。DB25 将快照和标记放入解析发布事务：坐标失败不能留下成功解析、新索引或已失效证据。原有解析与历史证据不重写。

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

## 验证与证据

在仓库根目录运行：

```bash
pnpm typecheck
node --test tests/unit/research-document-coordinates.test.mjs tests/unit/zotero-import.test.mjs
node --test tests/renderer/document-preview-protocol.test.mjs
pnpm test:unit
pnpm harness:eval
pnpm build
node scripts/run-research-p0.mjs
pnpm check:ipc
pnpm check:renderer-chunks
git diff --check
```

单元场景覆盖真实原 PDF 解析到坐标/工件发布、精确版本读取、篡改/缺失、历史无坐标、跨项目和读取过程中解除关联。原生 P0 使用实际文档服务、注册器和生成适配器，保存 `document-preview.json` 及 `document-coordinate-snapshot.json`。sender97 是明确标记的合成窗口身份，不声称真实用户预加载操作。

协议测试使用实际 Electron 和 Chromium fetch，核对冻结 PDF 字节、编码 ID、PNG 路由及能力失败响应。此测试的能力响应明确注入；真实 repository/文件验证由原生 P0 和单元集成建立。协议记录位于 `.artifacts/research-optimization/pr07-preview-protocol/original-byte-routing.json`。

## 阅读器版本选择

普通阅读按文档记录的 `currentParseId` 请求内容。历史深链先解析请求的 parseId，再核对属于当前文献，读取该确切版本。未完成、已失效、不存在或未关联当前项目的解析显示可重读错误，不打开其他文档或邻近解析。

旧辅助函数从倒序解析列表取末项，会选择最旧 ready 解析，现已删除；未保留别名。locator 跳转要求一个精确匹配；前缀、子串、重复定位均不自动选择。

读取状态按项目、文献、文档、解析、来源哈希及重读次数绑定。选择变化立即阻止旧内容显示，迟到响应不能覆盖新选择。文档 tab 支持左右方向键、Home/End 和可见焦点；选择其他文档会清除历史深链。

`node --test tests/renderer/paper-reader.test.mjs` 检查实际组件和生成适配器的版本、错误、键盘、迟到响应、显式重读及明暗/窄窗路径。版本选择场景明确使用合成解析快照；PDF 阅读场景使用冻结原文件或明确生成的多页/旋转 PDF，经实际解析器、工件收集器、repository、能力注册器及生成适配器读取。Node-host 桥和 sender98 是明确标记的测试接缝，不声称完整生产 kernel/preload E2E。布局截图与读取请求记录保存在 `.artifacts/research-optimization/pr07-reader-selection/`。

## 并排阅读与资源

现有阅读器通过「原 PDF / 解析文本」切换进入并排模式；块的「原文位置」按钮选择确切位置，多位置块可选择其中一页。原 PDF 先读取该解析内容的规范化 SHA-256，再请求同版本预览；没有新版或近似 locator 替代。PDF.js 和 worker 只在打开并排模式后加载，原 PDF 字节通过已有协议取得，不创建 Blob URL。

读页提供上一页、下一页、明确页码，以及 PageUp/PageDown/Home/End。页码输入使用原文件实际页数；缩放为适宽的 0.5–3 倍。投影使用记录的仿射 frame 和当前 PDF.js viewport 的四角变换，覆盖 CropBox、UserUnit 与旋转；不使用固定缩放或假设原始 bbox 为 PDF points。

缺少区域 frame 时明确提示仅页定位。解析器记录整页 bbox 时明确说明没有细分块区域；高亮整页不会被描述为精确段落。原文件、版本、坐标或页数不一致时显示可重试错误。

每次只保留一个可见页的 DOM canvas，页位图上限为 400 万像素。翻页/缩放/重绘取消旧 render 并释放页资源；关闭或切换来源取消 fetch/loading，销毁 PDF 文档、PDF worker 和原生 Worker。尚未实现文本选择和研究标注。

阅读器测试由 Vite8.3.5 实际构建并加载 Electron/Chromium，直接使用 `?worker` 生成的独立 worker 文件，不模拟 worker import。场景覆盖冻结 PDF 真实文本位图、缩放、三个窗口边界、无坐标历史、原文损坏、CropBox/90°/UserUnit2、32 页跳转与关闭清理。32 页 PDF 只解析第一页，测试仍可读取原文件其他页面，不制造未解析页的区域。

`actual-pdf-bitmap.json` 保存真实位图和编译 worker URL；`rotated-original-projection.json` 保存测量 frame/投影；`large-original-resources.json` 保存六次跳页的实际非零位图/worker 数量、耗时和进程内存。内存记录是观测值，不声称 RSS 硬上限。`comparison-clip-audit.json` 覆盖并排、hover 和缩放最终状态；截图保存明暗模式及 800/1099/1100 宽度。

## PDF 反向定位

点击原 PDF 的位置，用当前实际绘制视口中所有该页解析区域做命中判断。只有一个命中且所有页块都有区域时，选择该块的确切 `locationIndex`。多个区域覆盖位置时展示原始标签、locator 和位置序号，必须明确选择；没有命中时不选择附近块。此前选择会保持到用户作出新选择。

「本页解析块」提供同等键盘入口，包括只记录页定位的历史解析。缺少区域时点击不会产生空间匹配，而是提供本页块列表并明确提示。跨页块选择保留用户所选位置，不能改回其第一个位置。

返回解析块后，焦点移到可程序聚焦的块 section，并滚动到该块。选择块有背景与可见焦点；目标是内容组，避免一次 Enter 又激活块内「原文位置」按钮。

反向测试使用真实 PDF/worker 和实测 crop/rotation/UserUnit frame，非重叠、重叠及跨页布局明确为合成测试块，并发布独立 SHA-256 工件。此证据建立坐标交互，不声称解析器已经精确识别这些区域。实际交互保持数据库零写入。`reverse-clip-audit.json` 保存展开、明暗、hover 和键盘目标状态；`reverse-overlap-*.png` 保存候选列表布局。
