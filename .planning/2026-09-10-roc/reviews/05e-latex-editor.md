# Renderer 5e：LaTeX 模板编辑与预览

状态：Verified passing。基点：`a1321af`。

## 范围

- 科研页增加文稿视图：导入模板目录/ZIP，列出可编辑文件，按 expectedHash 保存，编译后显示 PDF 预览。
- 文件选择复用现有 files.selectFromDialog。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。预览 URL 使用已有 researchTemplatePreviewUrl。

独立回归：research-view 7/7，含导入、保存和编译预览。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
