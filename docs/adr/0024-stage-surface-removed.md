# 阶段面已删除

画布只有一条一级 tab 条（文献 / LaTeX / 终端），项目内没有第二个导航层级。本仓库的前端在迁移期（P2–P7）长出了一整套「科研流程」面，而且是**横跨整条画布的常驻阶段条**：

- `view=overview` 总览（当前下一步细条 + 分组入口）
- `view=stage` 阶段工作区：全宽阶段条 + 六个阶段组 + 十一个阶段的内部分组规则
- `view=activity` 活动流
- `view=provenance` 溯源
- 人工闸门审批、阶段运行面板及其 inline 审批卡
- 挂在这些位置里的 8 个产物面板：构思 / 实验 / 图稿 / 正文 / 证据与主张 / 导出 / 模板包 / 阶段策略
- `view=diagnostics` 诊断
- `view=tasks` 任务看板

## 决定

- **删掉整个阶段面**（`src/renderer/canvas/workflow/**`、`src/renderer/production/**`、`src/renderer/diagnostics/**`，共 8.4k 行），**以及任务看板**（`src/renderer/tasks/TaskDetailView.tsx` / `TasksView.tsx` / `use-tasks.ts`）。画布只剩一级 tab（文献 / LaTeX / 终端）与管理视图（记忆 / 技能 / MCP）。
- **任务看板删了，后台任务的数据层没删**：`tasks/task-model.ts` 与 `tasks/task-store.ts` 留下，因为管理抽屉的「任务」分区本来就是它们的消费者。删掉的只是第二个界面。
- **文稿（LaTeX）面板留下，换个家**：`production/LatexPanel.tsx` 移到 `src/renderer/latex/`，成为画布一级 tab 的视图。
- **路由契约随之收敛**：`AppViewId` 去掉 `overview` / `stage` / `activity` / `provenance` / `diagnostics` / `tasks`；`?stage=` **不再读写**（来的值直接忽略，所以原生菜单与旧深链不会报错）。默认视图改为 **`latex`**。
- **一个入口换一条路，没有丢**：`⌘K` 的「后台任务」与原生菜单的任务项现在开管理抽屉的「任务」分区。
- **快捷键表减一条**：`1 / 2 / 3` → 总览 / 活动 / 溯源 随视图一起删除。
- **判据同步**：`verify-p6-workflow` / `verify-p7-production` 两个闸门整体删除，对应的两份单测删除；其余闸门里凡是用阶段面当「项目路由已就绪」代理的断言，改到真的承载页上。

## 理由

1. **阶段条是唯一一处「同一个壳里多出一整层导航」的地方**，与「项目内只有一个画布面」的 IA（ADR 0021）直接冲突。
2. **阶段面不能靠隐藏来对齐。** 它是常驻 `<div>` 而不是 tab 页，只要它还在，任何画布视图头上都会顶着一条多余的横条。
3. **人工闸门与阶段推进已经在对话里**（ADR 0020），独立的阶段面没有必须存在的理由。

## 代价

- **后端能力暂时没有界面**：`research.ideas/experiments/figures/manuscript/exports/templates/policies` 这些域仍在契约与数据库里，`pnpm check:ipc` 仍然是 current，但渲染层不再调用它们。这是有意保留的能力，不是回归；重新接界面时它们是现成的。它们登记在 `src/shared/surfaces.ts` 的 `PARKED_CAPABILITIES`，深链会明确失败而不是静默落回默认视图。
- **视图 id 的深链会退化**：`?view=overview` 这类旧书签会落到默认视图，而不是原页面。单测里有一条专门守这个。
- **`verify-p6-workflow` / `verify-p7-production` 的断言不能复用**：它们断言的对象已经不存在。IPC 与规则层本身没有回退，只是「界面真的把它做对了」这件事不再有端到端证据。
