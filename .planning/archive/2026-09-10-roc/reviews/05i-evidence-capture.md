# Renderer 5i：证据捕获

状态：Verified passing。基点：`afe5c99`。

## 范围

- 知识库命中可捕获为当前项目证据。
- 已捕获片段显示状态，并列出摘录。
- 不在本增量接入主张编辑、正文闸门或阅读器内划词捕获。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。捕获走 `captureEvidence({projectId, chunkId})`，成功后刷新 `listEvidence`。无项目时禁用捕获。

独立回归：research-view 11/11，含搜索命中后捕获证据。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
