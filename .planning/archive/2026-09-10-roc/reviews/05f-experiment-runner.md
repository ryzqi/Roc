# Renderer 5f：实验运行界面

状态：Verified passing。基点：`9ff0fe2`。

## 范围

- 科研页增加实验视图：校验项目环境后启动 Python、Notebook、R、Julia 或 Matplotlib 运行。
- 运行列表支持取消、读取日志；完成后发布实验产物或图稿。
- 不在本增量接入参数 JSON 编辑、工作区文件选择器、索引状态或文献互操作。

## Standards / Spec

硬违反 0，判断项 0，未解决 0。启动走 inspect → expectedEnvironmentHash → startExperiment。Matplotlib 强制 `network=disabled` 并携带 figure 选项。日志优先读取 stdout。

独立回归：research-view 8/8，含环境校验后启动实验。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
```
