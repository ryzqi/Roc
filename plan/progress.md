# 进度日志

## 会话：2026-09-20

### 阶段 1：需求与代码库发现

- **状态：** 完成
- 已读取项目 README、CONTEXT、package.json、渲染器路由/侧栏、科研视图与样式、科研 plugin、数据库 schema、共享 research schemas。
- 已运行 `agent-reach doctor --json`；GitHub CLI、Exa 为配置存在但 doctor 未做实时验证，Jina/Web 可用。
- 已用 GitHub 搜索与 Exa 搜索收集 OpenScience、aipoch/open-science、ai4s-research/open-science、wisp-science、Mimir 等项目。
- 已创建 `plan/task_plan.md`、`plan/findings.md`。
- 已核验 `research-workbench.ts`、`research-session.ts`、renderer 路由、IPC registry、现有 renderer 测试约束。
- 已将现状问题、验收指标、同类项目设计提炼写入 `plan/findings.md`。

### 阶段 2：规划与结构

- **状态：** 完成
- 已创建 `plan/research-workbench-main-product-plan.md`。
- 计划冻结目标壳层、一级信息架构、科研服务分组、阶段迁移、API 聚合边界、测试、灰度和清理策略。

### 阶段 0：基线、设计约束与迁移开关

- **状态：** 完成
- 新增 `shell=research` / `roc.research.shell` feature flag；默认仍渲染旧 `ResearchView`。
- 新增 `ResearchContext` 与 `ResearchAppShell`；开关打开时区分空项目与选中项目壳层。
- 旧 `?page=research` 与显式 `shell=legacy` 可回退。

### 阶段 1：科研主壳层与项目上下文

- **状态：** 完成
- 无 `page` 时默认进入 `research` 新壳层；`?page=research` 无 `shell` 仍回退旧页。
- 侧栏「研究助手」替代「新建对话」；顶栏科研页不再用文件夹路径当主上下文。
- Chat 相关 AppShell 测试显式使用 `?page=chat`。

### 阶段 1 审查修复

- 顶栏接入 `buildResearchTopMeta`：项目、阶段、运行、人工闸门。
- 壳层补阶段导航、活动抽屉、项目搜索；工作区 pill 在科研页标为计算目录。
- 「研究助手」从壳层打开现有 Chat 视图。

### 阶段 2：项目总览、活动与溯源

- **状态：** 完成
- 新增 `ResearchOverviewView`、`ResearchActivityView`、`ResearchProvenanceView`，复用 workbench 快照与现有 provenance/evidence IPC。
- 总览给出下一步、审批/重试/索引修复；活动可过滤并跳转溯源；无来源产物明确写「未建立来源」。

### 阶段 3：按研究阶段重组现有功能

- **状态：** 完成
- 阶段导航改为发现/构思/实验/写作/发布五组；嵌入配置和阶段模型移入「项目设置」。
- `ResearchStageWorkspace` 三列：阶段上下文、主面板、证据/运行/活动。
- 非当前阶段组只读，写入按钮禁用并说明原因；当前组保留审批/继续/重试。
- 总览可进入当前阶段工作区；切换项目回到总览并保留项目上下文。

## 验证结果

| 检查 | 结果 |
|---|---|
| 代码库文件与入口搜索 | 已完成，路径与关键模块已记录 |
| Agent Reach doctor | 已完成；GitHub/Exa 为 warn，Web/Jina 为 ok |
| 开源项目搜索 | 已完成初筛，待核验项目细节 |
| 同类设计提炼 | 已完成，已记录 OpenScience、aipoch/open-science、ai4s-research/open-science、wisp-science、Mimir 的结构性设计 |
| 计划文档审阅 | 已完成，已检查阶段、文件路径、契约边界、验收与风险 |

## 错误日志

| 时间 | 错误 | 尝试 | 处理 |
|---|---|---:|---|
| 2026-09-20 | `rtk HOME=...` 被当作命令 | 1 | 使用 `rtk proxy env HOME=... agent-reach doctor --json` |
