# 阶段面已删除

## 决定

项目内保持一套壳和一条画布一级页签：文献、LaTeX、终端；记忆、技能和 MCP 可作为画布管理视图。阶段推进和人工闸门由助手承载，删除原总览、阶段、活动、溯源、诊断和任务看板页面。任务留在管理抽屉，当前科研任务界面为 `src/renderer/management/sections/ResearchTasksSection.tsx`。

构思、实验、图稿、正文、导出、模板和策略保留服务与数据合同，在 `src/shared/surfaces.ts` 的 `PARKED_CAPABILITIES` 中登记。已有[工件检查器](../research-artifact-inspector.md)提供来源、生产文件和人工审核，不恢复阶段导航。

路由不再读写 `?stage=`；旧阶段视图和任务视图归一到默认 `latex`。原 `1 / 2 / 3` 阶段导航快捷键、P6 工作流与 P7 生产页面闸门随页面删除。`⌘K` 和原生菜单的任务入口打开管理抽屉。

## 理由与代价

常驻阶段条会为所有画布增加一层导航，与[三栏 IA](0021-three-column-workbench-ia.md)冲突；助手已经负责[对话驱动阶段](0020-conversation-drives-stages.md)。删除重复页面后，阶段能力需经助手和检查器使用，旧深链回到默认视图。

现行路由、界面入口和验证方法以[工作台](../research-workbench.md)及[验证说明](../verification.md)为准。
