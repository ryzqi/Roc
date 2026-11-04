# 原 PDF 与解析定位

PR-07 当前已完成测量坐标、原子解析快照和安全预览元数据。阅读器并排显示、双向选择及标注捕获仍待接入，不能将本节的接口验收当成完整阅读流程验收。

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

主进程先核对文档所属文献是否关联请求项目，再验证解析内容、原文件字节及坐标工件。异步文件读取后重新核对项目关联与解析/快照身份。响应包含来源版本、页数、原文件 URL、解析图像 ID/类型/页/哈希/大小/URL，以及测量 frame 和 snapshotHash；没有绝对文件路径、原始字节或写权限。

协议 URL 为：

```text
roc-preview://research/projects/<projectId>/documents/<documentId>/source/<sourceHash>
roc-preview://research/projects/<projectId>/documents/<documentId>/parses/<parseId>/<assetId>/<sha256>.png
```

每个 ID 使用 `encodeURIComponent`。协议调用同一文档 source/asset 能力，必需 projectId。无项目的旧文档 URL 已删除，没有兼容别名。

原文件访问仍可用于未解析文档。source 能力校验记录 SHA-256/大小，asset 能力校验实际 PNG 字节 SHA-256/大小和指定 parseId。解除项目关联、来源损坏、资源缺失及符号链接访问均拒绝；协议能力失败返回 404，不返回成功 PDF。文件响应使用 `no-store` 与 `nosniff`，HTML 原文按下载附件返回。

`roc-preview` 注册 `supportFetchAPI` 和 `corsEnabled`。后者是 Chromium 支持跨协议 fetch 的必要条件，不关闭 webSecurity，也不绕过 CSP。

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
