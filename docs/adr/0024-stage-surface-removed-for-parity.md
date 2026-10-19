# 阶段面已删除：画布与 research-studio 对齐

`research-studio/` 的画布只有一条一级 tab 条（文献 / LaTeX / 终端），项目内没有第二个导航层级。
本仓库的前端在迁移期（P2–P7）长出了一整套 research-studio 没有的「科研流程」面，而且是**横跨整条
画布的常驻阶段条**：

- `view=overview` 总览（当前下一步细条 + 分组入口）
- `view=stage` 阶段工作区：全宽阶段条 + 六个阶段组 + 十一个阶段的内部分组规则
- `view=activity` 活动流
- `view=provenance` 溯源
- 人工闸门审批、阶段运行面板及其 inline 审批卡
- 挂在这些位置里的 8 个产物面板：构思 / 实验 / 图稿 / 正文 / 证据与主张 / 导出 / 模板包 / 阶段策略
- `view=diagnostics` 诊断（读阶段运行错误，随上面一起失去意义）
- `view=tasks` 任务看板（同一次收敛里删的第二层：后台任务在参考里只有一个家 —— 管理抽屉的
  任务 tab，两份界面盯一个数据集就是 P9 建 `management-shell-parts` 要防的那种发散）

它们全部在截图里可见的那条阶段条之下，也正是「没有对齐 research-studio」最显眼的一处。

## 决定

- **删掉整个阶段面**（`src/renderer/canvas/workflow/**`、`src/renderer/production/**`、
  `src/renderer/diagnostics/**`，共 8.4k 行），**以及任务看板**
  （`src/renderer/tasks/TaskDetailView.tsx` / `TasksView.tsx` / `use-tasks.ts`）。
  画布只剩 research-studio 有的入口（文献 / LaTeX / 终端）与项目工具视图
  （文件 / 改动 / MCP / 技能 / 记忆）。
- **任务看板删了，后台任务的数据层没删**：`tasks/task-model.ts` 与 `tasks/task-store.ts` 留下，
  因为管理抽屉的「任务」分区本来就是它们的消费者。删掉的只是第二个界面。
- **文稿（LaTeX）面板留下，换个家**：`production/LatexPanel.tsx` 移到 `src/renderer/latex/`，
  成为画布一级 tab 的视图。research-studio 本来就有这个编辑器（`LatexEditorView`），
  它只是过去挂在阶段工作区里；现在它和参考里的位置一样。
- **路由契约随之收敛**：`AppViewId` 去掉 `overview` / `stage` / `activity` / `provenance` /
  `diagnostics` / `tasks`，`?stage=` **不再读写**（来的值直接忽略，所以原生菜单与旧深链不会报错）。
  默认视图从 P2 以来的 `overview` 改成 **`latex`** —— 这是参考 `App` 自己的画布默认 tab
  （`useState<WorkspaceTab>('latex')`）。
- **一个入口换一条路，没有丢**：`⌘K` 的「后台任务」与原生菜单的任务项现在开管理抽屉的「任务」
  分区（参考里这个分区就叫「定时任务」），而不是跳一个已经不存在的画布页。
- **快捷键表减一条**：`1 / 2 / 3` → 总览 / 活动 / 溯源 随视图一起删除。
- **判据同步**：`verify-p6-workflow` / `verify-p7-production` 两个闸门整体删除，对应的两份单测删除；
  其余六个闸门里凡是用阶段面当「项目路由已就绪」代理或当承载页的断言，改到真的承载页上。

## 理由

1. **对齐是用户裁定，而且这一处是分歧最大的一处。** research-studio 是设计权威；阶段条是唯一一处
   「同一个壳里比参考多出一整层导航」的地方。
2. **阶段面不能靠隐藏来对齐。** 它是常驻 `<div>` 而不是 tab 页，只要它还在，任何画布视图头上都会顶着
   一条参考里没有的横条。
3. **留下的面板在原参考里有对应物，而阶段机制没有。** 文稿编辑器对应 `LatexEditorView`；阶段条、
   阶段分组、人工闸门、阶段运行在 research-studio 里都不存在。

## 代价

- **后端能力暂时没有界面**：`research.ideas/experiments/figures/manuscript/exports/templates/policies`
  这些域仍在契约与数据库里，`pnpm check:ipc` 仍然是 current，但渲染层不再调用它们。这属于有意保留的
  能力，不是回归；重新接界面时它们是现成的。
- **五份文档与 20 份 ADR 讲的是被删掉的面**（`docs/research-workbench.md` 与 ADR 0003–0020 大多在描述
  总览、阶段条、人工闸门与下一步细条）。它们**没有**在本次改动里重写：先保留为历史记录，避免在一份
  尚未复核的改动里顺手改写二十份决定记录。ADR 0023/0024 是本轮的口径来源。
- **视图 id 的深链会退化**：`?view=overview` 这类旧书签会落到默认视图，而不是原页面。
  单测里有一条专门守这个（`a retired view id falls back instead of leaking into the URL`），
  原生菜单的任务项另有一条（`the native menu's task item stays reachable now that the board is gone`）。
- **`verify-p6-workflow` / `verify-p7-production` 的断言不能复用**：它们断言的对象已经不存在。
  IPC 与规则层本身没有回退，只是「界面真的把它做对了」这件事不再有端到端证据。
