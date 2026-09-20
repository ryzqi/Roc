# 发现与决策

## 用户需求

- Roc 不再把科研工作台当作普通功能；科研工作台成为产品主功能与默认工作上下文。
- Roc 定位为专门为科研设计的工作台。
- 当前通用功能迁移到“科研服务”下，以项目/研究阶段为组织中心。
- 重新设计页面；先分析代码库，再搜索开源科研工作台，吸收优秀设计。
- 交付物：当前目录 `plan/` 下的详细、分阶段开发计划。

## 代码库发现

### 当前入口与路由

- `src/renderer/app/nav-items.ts` 将“科研工作台”“任务工作台”“任务诊断包”放在工作区 dock 中；科研入口不是主壳层。
- `src/renderer/app/view-routing.ts` 将 `research` 与 `chat`、`workspace`、`git`、`terminal`、`memory`、`mcp`、`skills` 等作为同级 `ViewId`。
- `src/renderer/views/ViewContent.tsx` 以单一 `activeView` 分支渲染 `ResearchView`，科研页面与通用页面共享路由壳层但没有科研上下文壳层。
- `src/renderer/app/AppSidebar.tsx` 侧栏顶部是工作区路径和新建对话，中部历史会话，底部 dock 放科研、任务与控制类入口。

### 当前科研 UI

- `src/renderer/views/research/ResearchView.tsx` 已有项目选择/创建、阶段 tab、工作流、想法、文献库、实验、稿件、编辑器、生产导出、知识库、策略、嵌入配置等面板。
- `src/renderer/views/research/research-workbench.ts` 已有 renderer 侧 workbench projection/adapter，说明科研状态可集中成工作台快照。
- `src/renderer/styles/research.css` 以纵向页面 + 横向 tabs + 工具面板为主；页面更像功能集合，缺少项目首页、阶段总览、服务目录与活动/溯源总览。

### 当前后端与数据基础

- `src/main/plugins/research/index.ts` 注册 research plugin 及 project、workflow、literature、embedding、artifact、events、evidence、idea、document、index、experiment、figure、template、export、production 等 capability。
- `src/main/infrastructure/database-schemas.ts` 已有 `research_projects`、`research_stage_states`、`research_artifacts`、`research_provenance`、`research_workflow_events`、文献表、知识文档/片段/向量表等基础表。
- `src/shared/schemas/research.ts` 阶段枚举覆盖 discovery、retrieval、reading、ideation、planning、experiment、figure、writing、review、revision、export；项目状态与阶段门槛已类型化。
- `src/main/main-kernel-bootstrap.ts` 将科研 library、index、experiment、figure、template、export 等服务接入 kernel；科研能力是可复用服务层，适合重新组织 UI。
- README 将 Roc 描述为通用 Electron + React AI Agent 桌面应用，科研能力与 Chat/Task/Workspace/MCP/Memory 并列，产品叙事尚未切换为科研主工作台。

## 开源项目调研初步记录

### OpenScience / synthetic-sciences/openscience

- 研究闭环表达为“Plan. Run. Check.”，把目标、方法、执行、验证、写作放在同一连续 session。
- 强调 papers、data、code、results 同一 workspace；项目保存 session、上传、生成文件、preview。
- 单一 adaptive research agent 面向用户，内部可委派 Explore/Execute/Review；plan mode 保持只读。
- 科学数据库以连接器形式提供，技能、MCP、插件可扩展；产物与 provenance 同时可检查。
- 可借鉴：主界面以研究目标/项目为中心，不以工具类型为一级导航；将 agent、文件、终端、来源、结果编排在同一研究上下文。
- 来源：`https://github.com/synthetic-sciences/openscience`、`https://openscience.sh/`、Exa 搜索摘要。

### aipoch/open-science

- 定位为 local-first、model-agnostic AI research workbench；项目绑定 sessions、uploads、generated files、preview。
- 生成 artifact 以 immutable、checksummed version 保存；Provenance 视图展示创建时可验证的证据、代码与执行历史。
- 提供 scientific skills catalog、connectors catalog，工具拥有 Always allow / Ask each time / Block 权限策略。
- 研究流程覆盖 literature review、hypothesis、code execution、analysis、visualization、reproducible outputs。
- 可借鉴：项目级持久上下文、产物版本与来源图、科研连接器/技能目录、明确的工具权限状态。
- 来源：`https://github.com/aipoch/open-science`、GitHub 搜索结果。

### ai4s-research/open-science

- GitHub 搜索描述：local-first、model-agnostic、macOS/Windows/Linux 的 AI research workbench，Tauri + MCP + agent skills。
- 可借鉴：本地优先、跨平台运行时、MCP 与 Skill 作为科研扩展面，而非设置页里的孤立能力。
- 来源：`https://github.com/ai4s-research/open-science`。

### xuzhougeng/wisp-science

- GitHub 搜索描述：local-first scientific computing，支持 Python/R、MCP bioinformatics tools、SSH/WSL/GPU runtimes、模型提供商。
- 可借鉴：计算运行时作为研究项目的一部分，远程/HPC 与本地环境统一到 execution service。
- 来源：`https://github.com/xuzhougeng/wisp-science`。

### 1692775560/dsh-Mimir-Academic-research

- GitHub 搜索描述：LaTeX 边写边编译、arXiv 文献管理、实验追踪、指标图表、GPU SSH 任务编排，覆盖科研全周期。
- 可借鉴：写作、文献、实验、图表、远程任务应在主工作台中形成可切换但连续的阶段流。
- 来源：`https://github.com/1692775560/dsh-Mimir-Academic-research`。

## 设计原则提炼

1. 一级组织单位是研究项目/目标；工具不是一级导航。
2. 项目首页必须同时显示当前阶段、下一步动作、阻塞/审批、最近活动和关键产物。
3. 研究动作围绕 Plan → Run → Check → Write/Share 形成闭环，长任务和恢复状态可见。
4. 来源、证据、代码、运行、图表、稿件、导出包形成 provenance 链，可回看、可核验。
5. Chat、文件、终端、Git、MCP、Skill、记忆成为项目内服务；服务需要状态、权限、失败与恢复反馈。
6. 默认 local-first；模型、连接器、远程计算按可用性降级，不阻塞项目浏览与已有产物查看。

## 核验结论

- 同类项目的公开定位与仓库描述已足以提炼本计划需要的结构性设计：项目/会话上下文、Plan-Run-Check 闭环、产物溯源、技能/连接器目录、本地优先和远程计算统一入口。页面像素级复刻不属于本计划目标。
- `research-workbench.ts` 已聚合项目、workflow、events、runs、artifacts、indexStatus，并通过 `research-session.ts` 为文献、知识、实验、策略、模板、稿件、想法、生产服务提供项目绑定；新首页可先复用这些投影。
- `src/preload/ipc-api-generated.ts` 与 `src/shared/ipc-registry.ts` 已覆盖 research 项目、workflow、run、artifact、evidence、claims、manuscript、library、document、knowledge、experiment、figure、export 等契约；新增 IPC 应限于必要的只读聚合快照。
- `src/renderer/app/view-routing.ts` 当前将 `research` 与通用 `ViewId` 同级，且 `tests/renderer/research-view.test.tsx` 直接挂载旧 `ResearchView`；因此计划要求 feature flag、旧 URL 映射和逐阶段回归。

## 阶段 0 实现记录

- 新壳层开关：URL `?page=research&shell=research` 或 `localStorage.roc.research.shell=research`。
- 查询参数优先于 storage；`shell=legacy` 强制旧页，即使 storage 已启用新壳层。
- `ResearchContext` 由 workbench snapshot 投影，不新增 IPC。
- 旧 `ResearchView` 测试继续直接挂载，不经过 feature flag。

## 阶段 0 行为基线

- `?page=research`：`parseViewId` 识别为 `research`；无 `shell` 且 storage 未启用时渲染旧 `ResearchView`。
- 刷新恢复：`AppShell` 用 `page` 恢复视图；新壳层额外用 `shell` 或 `roc.research.shell` 恢复。
- 项目选择：旧页与新壳层都走 `workbench.selectProject`；`load()` 默认选第一个项目。
- 空项目：旧页 `research-empty`；新壳层 `research-shell-empty`。
- 模型未安装：旧页横幅 `research-models-banner`；新壳层写入 `serviceHealth.modelsReady`。
- 运行失败/取消/重试：仍由 `research-workbench` 的 `startRun`/`cancelRun`/`retryRun` 处理，阶段 0 不改路径。

## 阶段 0 回归清单

1. `?page=research` 无 `shell`：旧 `ResearchView`（`tests/renderer/research-view.test.tsx`、`bundle-boundaries` 默认旧页断言）。
2. `?page=research&shell=research` 或 storage `roc.research.shell=research`：新壳层空项目/选中项目（`research-app-shell.test.tsx`）。
3. `?page=research&shell=legacy` 覆盖 storage，仍回退旧页（`view-routing.test.ts`）。
4. 返回旧页面写入 `shell=legacy` 并清除 storage。
5. 项目选择、空项目、模型未安装、运行失败/取消/重试仍走 `research-workbench`；旧测试覆盖这些路径。

## 阶段 1 实现记录

- `parseViewId(null)` 默认 `research`；无 query/storage 时新壳层开启。
- 裸 `?page=research` 仍是旧页，避免旧深链接跳进新壳层。
- `syncRendererUrl` 在改 `page` 之前解析 shell mode，避免默认入口被写成旧页。

## 阶段 1 审查修复

- 顶栏 `thread-meta` 在科研页使用 `ResearchContext` 投影，不再只显示工作区路径。
- `ResearchAppShell` 增加阶段进度条、活动抽屉、项目搜索；文件夹选择改称计算目录。
- Chat 仍是独立视图，从壳层「研究助手」进入；项目/阶段元数据绑定留到服务集成阶段。

## 阶段 2 实现记录

- 首屏不新增 `research.project.snapshot`；总览/活动用 workbench 已加载的 workflow、events、runs、artifacts、indexStatus。
- 溯源进入视图后才请求 `listProvenance` 与 `listEvidence`。
- 缺失 provenance 显示「未建立来源」，不宣称已验证。

## 阶段 2 审查修复

- 总览补阶段进度条；活动抽屉改为快捷入口，详情进 `ResearchActivityView`。
- 溯源可返回总览；事件带 `payload.artifactId` 才跳产物，避免按阶段猜产物。
- 实验/导出/编译列表仍走后续阶段页，本阶段不并行拉领域全文。

## 现状问题清单

1. 科研入口在侧栏 dock，与 Chat、任务、文件、Git、终端、MCP、Skill、记忆同级，产品主叙事不一致。
2. `ResearchView` 以十个平级 tab 承载流程、文献、构思、实验、正文、编辑器、导出、知识库、嵌入配置、阶段模型，阶段上下文和下一步动作不突出。
3. 项目状态、活动、运行、产物、证据、来源没有统一首页；用户需要在多个面板间手工拼接状态。
4. 通用工具没有明确的 project/stage 绑定展示，执行结果与研究产物的关联不够显式。
5. 运行、模型、索引、审批、错误状态虽有后端能力，但没有统一活动/恢复入口。

## 计划验收指标

- 启动默认进入科研主壳层；有项目进入项目总览，无项目进入创建/导入空态。
- 项目总览一次加载能显示研究目标、当前阶段、下一步、阻塞/审批、运行状态、最近活动、关键产物。
- 用户可在项目上下文内完成最小闭环：创建 → 检索/导入 → 证据 → 构思 → 运行 → 产物 → 写作/导出。
- 旧 `?page=research`、刷新恢复、旧数据与回退开关在迁移期可用。
- 模型未安装、索引失败、运行失败/取消/重试、项目归档等异常有明确页面行为。
- 关键视图在最小支持窗口、键盘操作和无颜色辅助条件下可用。
