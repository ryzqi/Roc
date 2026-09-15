# Renderer 5g：文献互操作

状态：Verified passing。基点：`d6b76c8`。

## 范围

- 文献库可选择 BibTeX、BibLaTeX 或 CSL JSON，从文件导入到当前项目。
- 可勾选文献并导出为所选格式，预览文件名和内容。
- 不在本增量接入独立保存对话框、Zotero 直连或引用键编辑。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。导入走 `files.selectFromDialog` 与 `importBibliography`；导出走现有 `exportBibliography` 合同，返回内容在阅读器旁预览。

独立回归：research-view 9/9，含导入文件并导出选中记录。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
