# Renderer 5b：文献库与阅读器

状态：Verified passing。基点：`306f217`。

## 范围

- 科研页增加文献库视图：开放检索、DOI 导入、检索结果导入、当前项目/全局筛选。
- 文献条目可关联当前项目，并打开已解析附件的定位文本。
- 不在本增量接入文件选择导入 PDF、知识库检索面板重构、Idea Canvas 编辑器。

## Standards

硬违反：0。判断项：0。未解决：0。

判断项：阅读器先展示已解析文本块和 locator，不在本增量做 PDF 页预览。关联按钮按当前项目 ID 判断，而不是文献是否关联过任何项目。

## Spec

未解决：0。

- 检索结果可导入文献库。
- 文献列表可打开阅读器并显示解析文本。
- DOI 导入和项目关联走现有 IPC。

独立回归：research-view 4/4，含导入并打开解析文本。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
