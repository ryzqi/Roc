# Renderer 5d：图稿列表与最终导出

状态：Verified passing。基点：`8d1cfa4`。

## 范围

- 科研页增加图稿导出视图：列出已发布图稿、选择图稿、用已批准正文准备导出。
- 准备完成后可发布到审核闸门；已批准导出填写绝对 ZIP 路径后保存，不覆盖已有文件。
- 本增量不接入图稿代码编辑或 PDF 预览。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。导出标题与新建项目标题分开。ZIP 路径沿用现有绝对路径合同。

独立回归：research-view 6/6，含准备导出并保存 ZIP。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
