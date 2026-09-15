# Renderer 5h：项目索引状态

状态：Verified passing。基点：`6f05ac4`。

## 范围

- 项目仪表盘显示索引阶段、文件计数和错误。
- 可暂停/恢复、重建，以及在有失败文件时重试。
- 暂停后禁用重建/重试。不在本增量接入 include/exclude 编辑或文件清单。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。控制请求携带当前 `expectedRevision`。pause/resume 走同一 `controlIndex` 合同。

独立回归：research-view 10/10，含重建后暂停。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
