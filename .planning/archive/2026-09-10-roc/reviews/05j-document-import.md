# Renderer 5j：文献附件导入

状态：Verified passing。基点：`84b2e9b`。

## 范围

- 打开文献后可选择 PDF/HTML 文件导入为附件。
- 导入后立即解析，成功则显示定位文本。
- 不在本增量接入 OCR 选项、取消解析或页图预览。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。导入绑定当前文献 `library-item`，并传入当前项目 ID。解析走现有 `parseDocument` 合同。

独立回归：research-view 12/12，含导入附件后显示解析文本。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
