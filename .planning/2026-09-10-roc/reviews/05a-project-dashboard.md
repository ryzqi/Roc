# Renderer 5a：项目仪表盘、流程轨道与审核

状态：Verified passing。基点：`8e2d5c6`。

## 范围

- 项目页显示 11 阶段流程轨道、当前阶段、下一步、当前产物和事件时间线。
- 审核交互区分普通闸门与审稿接受/修订决策。
- 可启动、取消和重试当前阶段角色，并显示运行指令与错误。
- 创建项目时可选择中英语言。文献库、阅读器、Idea Canvas 编辑器和绘图/导出视图仍待后续增量。

## Standards

硬违反：0。判断项：0。未解决：0。

判断项：流程面板从 `ResearchView` 抽出，避免主视图继续堆积检索/嵌入面板。角色启动使用浏览器 `crypto.randomUUID()` 作为 requestId，与现有运行幂等合同一致。

## Spec

未解决：0。

- 常驻流程轨道和当前阶段：pipeline 与 `research-current-stage` 显示写作/审稿等中文阶段名。
- 下一步：`research-next-action` 根据 ready/running/waiting_approval 给出开始、提交审核或审核产物。
- 时间线：加载 `listWorkflowEvents` 并按事件消息渲染。
- 审核：普通批准走 `approve`；审稿等待时必须显式 `accept`。
- 角色：输入指令后 `startStageRun`，绑定当前项目和阶段。

独立回归 3/3 通过：时间线/审核、审稿接受决策、启动角色。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/research-view.test.tsx /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/navigation-meta.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/renderer/app-shell.test.tsx
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
rtk git -C /Users/Apple_501/Desktop/Roc/Roc diff --check
```

renderer/research 3 项、导航/壳层 29 项、typecheck 通过。
