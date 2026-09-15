# Production 4c2 Review

基点：`2c88502`。范围：文献原文件导入与去重、不可变解析版本、定位和 PNG 资源、当前全文索引、取消/重试/恢复、归档联动、七条 IPC 与已登记资源预览。数据库追加 v7，v1–v6 保持不变。

## Standards

独立核对附件失败清理、解析与索引事务、取消/关闭后的迟到提交、历史版本与证据保留、预览 URI 的登记和哈希边界，未发现实质缺陷。

最终 0 项未解决问题（硬违反 0，启发式判断 0）。独立定向验证 2 文件 / 21 项通过。

## Spec

已确认原文件导入后独立保存；每次解析有持久身份和资源清单；只有当前运行可发布新结果。失败或取消保留之前成功版本及其索引；重新解析替换搜索版本，但旧定位、资源和捕获的证据仍可读取。归档移除全文索引，恢复从已存解析内容重建。

最终 0 项未解决问题。独立定向验证关键生命周期、归档和预览路由共 6 项通过。

## Verification

- 科研域、IPC 和预览协议：22 文件 / 140 项通过；4 项真实资源/网络用例在常规运行中按配置跳过。
- 显式开启本增量真实资源用例：1 项通过，约 104 秒；覆盖 HTML → 导入副本 → Docling → 全文检索 → 证据捕获，以及 Tectonic PDF → 导入副本 → Docling 定位/页面图 → 哈希资源读取。
- HTML：3 个块；表格图片不可用时保留表格文本，并报告 `picture_image_unavailable`。PDF：1 页、1 个文本块、1 张页面图，无警告；解析器版本 2.126.0。
- 删除原 PDF 后，仍可读取导入副本；原 HTML 以下载响应提供，PNG/PDF 资源按登记身份和摘要读取，资源错误隐藏内部路径。
- 实际证据：`.artifacts/research-document-integration/roc document integration-nRycvI/result.json`。
- `build`（含 typecheck）、`check:ipc`、差异检查通过。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts
rtk proxy env PYTHONDONTWRITEBYTECODE=1 ROC_RESEARCH_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/document-ipc.test.ts
```

限制：本部分真实回归覆盖 HTML 和原生 PDF；扫描 OCR 底层沿用 4a/4b 已验证的私有运行时，本增量未更改 Python 或模型。当前验证为 arm64 macOS；项目监听/嵌入重建属于 4c3，Renderer、Intel 实机与最终打包继续后续阶段。

状态：Verified passing。
