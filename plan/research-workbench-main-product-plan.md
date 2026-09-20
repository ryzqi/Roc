# Roc 科研主工作台重构：详细开发计划

## 1. 产品目标与边界

### 1.1 目标

Roc 默认打开即进入科研主工作台。用户围绕一个研究项目完成“提出问题 → 检索与阅读 → 形成假设 → 制定计划 → 执行实验 → 检查证据 → 写作审阅 → 导出分享”，所有会话、文件、运行、产物和来源都挂在项目上下文下。

### 1.2 产品定位变化

| 当前 | 目标 |
|---|---|
| 通用 AI Agent 应用，科研工作台是侧栏功能 | 面向科研的本地优先工作台，Agent 与工具是科研服务 |
| Chat、任务、工作区、科研并列 | 研究项目是一级上下文，服务在项目内按阶段提供 |
| 科研页面是多个功能 tab | 首页聚合项目状态，页面围绕研究阶段和产物组织 |
| 文件/命令/任务与科研数据分离 | 代码、文件、终端、运行和证据可追溯关联 |
| 状态通过手工刷新和单面板查看 | 长任务、审批、失败、恢复、索引状态在全局活动面板可见 |

### 1.3 明确不做

- 不重写已有 research plugin 的领域服务；优先复用现有 capability、repository、schema 与 renderer projection。
- 不在首个版本引入云端账号、团队协作、在线同步或新的远程控制面。
- 不把模型、MCP、Skill、终端等能力删除；它们迁移到科研服务入口，并保留独立设置/诊断的可达性。
- 不在页面重构阶段修改科研工具链、模型打包策略或实验运行安全边界，除非新 UI 暴露出契约缺陷。

## 2. 目标信息架构

### 2.1 应用壳层

```
Roc
├── 全局顶栏：Roc / 当前项目 / 当前阶段 / 运行与审批状态 / 全局搜索
├── 项目侧栏
│   ├── 最近项目与项目切换
│   ├── 研究阶段进度
│   ├── 项目视图：总览、活动、溯源
│   └── 服务区：研究助手、文献与知识、实验与计算、写作与导出、文件与代码、连接器与技能
└── 主画布
    ├── 项目总览
    ├── 阶段工作区
    ├── 服务工作区
    └── 产物/来源/运行详情
```

### 2.2 一级入口

一级入口只保留科研上下文相关内容：

- `项目总览`：默认首页，回答“项目现在到哪里、下一步做什么、什么被阻塞”。
- `研究阶段`：沿阶段流切换，不再把十个工具 tab 直接铺在同一层。
- `活动与运行`：汇总 Agent run、实验 run、索引、编译、导出、审批与错误。
- `溯源与产物`：查看 artifact、证据、代码、运行、图表、稿件之间的关系。
- `科研服务`：按服务域进入能力，而不是按基础设施模块进入。

### 2.3 科研服务分组

| 服务域 | 首期能力 | 现有来源 |
|---|---|---|
| 研究助手 | 阶段指令、对话、计划、审批、恢复 | Agent run、任务工作台、`research-workbench.ts` |
| 文献与知识 | 文献检索、DOI/Bib 导入、PDF 解析、知识库、证据捕获 | library/document/index/knowledge/evidence capability |
| 假设与计划 | 构思画布、研究计划、阶段策略、评审循环 | idea/workflow/policy/review capability |
| 实验与计算 | Python/R/Julia 环境、实验启动/取消/重试、日志、指标 | experiment/figure/environment capability |
| 写作与导出 | 稿件、引用、LaTeX 编译、图稿、导出包 | manuscript/template/production/export capability |
| 文件与代码 | 项目文件、Git、终端、PDF/图表预览 | workspace/git/terminal/preview workbench |
| 连接器与技能 | MCP、科研连接器、Skill、权限 | MCP/skills/permissions |
| 项目记忆 | 项目记忆、会话历史、自动记忆、运行记录 | memory/chat/history/task |

设置、诊断、模型与运行时状态保留全局入口，但默认从服务状态或错误状态进入。

## 3. 分阶段执行计划

每个阶段按“实现 → review → 修复 → 测试 → 提交”完成。阶段之间只传递已验证的契约，不跨阶段堆积未验收 UI。

### 阶段 0：基线、设计约束与迁移开关

**目的**：固定当前行为，避免页面重构同时破坏深链接、项目选择和已有面板。

**工作项**：

1. 为当前 `ResearchView`、`research-session`、`research-workbench`、`view-routing` 建立行为基线。
2. 记录现有 `?page=research`、刷新恢复、项目选择、空项目、模型未安装、运行失败、取消/重试路径。
3. 增加新壳层 feature flag/迁移开关；旧 `research` 页面保留为回退路径。
4. 定义统一的研究上下文类型：`ResearchContext` 至少包含 `projectId`、`project`、`workflow`、`currentStage`、`activeRuns`、`pendingGates`、`recentEvents`、`artifactSummary`、`indexStatus`、`serviceHealth`。

**主要文件**：

- `src/renderer/app/types.ts`
- `src/renderer/app/view-routing.ts`
- `src/renderer/app/AppShell.tsx`
- `src/renderer/views/research/ResearchView.tsx`
- `src/renderer/views/research/research-session.ts`
- `tests/renderer/research-view.test.tsx`

**验收**：新开关关闭时现有页面测试全部通过；开关打开时能显示空项目和选中项目两种壳层；旧 URL 不丢失且可回退。

### 阶段 1：科研主壳层与项目上下文

**目的**：把科研工作台从侧栏 dock 提升为默认应用壳层。

**工作项**：

1. 新建 `ResearchAppShell`/`ResearchWorkspaceShell`，承载项目侧栏、阶段导航、主画布和活动抽屉。
2. 顶栏显示项目、阶段、运行状态、审批数量和全局搜索入口；禁止只显示普通 workspace 路径作为主要上下文。
3. 项目侧栏支持最近项目、创建项目、归档/暂停状态、项目搜索和当前项目切换。
4. 默认启动策略：有最近项目进入项目总览；无项目进入创建/导入研究项目空态；普通 Chat 作为项目内“研究助手”服务打开。
5. 保留全局工作区路径作为项目的可选计算目录，不把文件夹选择等同于研究项目。

**主要文件**：

- `src/renderer/app/AppShell.tsx`
- `src/renderer/app/AppSidebar.tsx`
- `src/renderer/app/AppWorkspaceShell.tsx`
- `src/renderer/app/nav-items.ts`
- `src/renderer/app/view-routing.ts`
- 新增 `src/renderer/views/research/ResearchAppShell.tsx`
- 新增 `src/renderer/views/research/research-context.ts`
- `src/renderer/styles/app-shell.css`
- `src/renderer/styles/app-sidebar.css`
- `src/renderer/styles/research.css`

**验收**：启动后默认可进入科研主壳层；项目切换不会丢失服务状态；窗口缩放和最小窗口尺寸不出现遮挡；旧页面可通过迁移开关访问。

### 阶段 2：项目总览、活动与溯源

**目的**：先解决“打开后不知道下一步做什么”的核心问题。

**工作项**：

1. 新增 `ResearchOverviewView`：研究目标、当前阶段、阶段进度、下一步动作、待审批/阻塞、索引/模型状态、最近活动、关键产物。
2. 新增 `ResearchActivityView`/抽屉：统一展示工作流事件、Agent run、实验 run、文档解析、索引、LaTeX 编译、导出任务；支持状态过滤和跳转详情。
3. 新增 `ResearchProvenanceView`：以 artifact 为中心展示来源、证据片段、实验输入/输出、代码文件、运行记录、稿件引用和版本。
4. 后端优先复用 `research.workflow.events`、`research.artifacts.list/get`、`research.evidence.list`、实验/导出列表；缺少聚合时新增只读 `research.project.snapshot`，避免 renderer 并行请求过多。
5. 明确所有状态的可操作下一步：启动、继续、审批、重试、查看日志、打开来源、修复配置。

**主要文件**：

- 新增 `src/renderer/views/research/ResearchOverviewView.tsx`
- 新增 `src/renderer/views/research/ResearchActivityView.tsx`
- 新增 `src/renderer/views/research/ResearchProvenanceView.tsx`
- `src/renderer/views/research/research-workbench.ts`
- `src/shared/schemas/research.ts`
- `src/shared/ipc-registry.ts`
- `src/main/plugins/research/index.ts`
- `src/main/plugins/research/repository.ts`

**验收**：项目总览首屏能在一次加载后回答目标、阶段、下一步、阻塞和最近活动；从活动/溯源可回到对应阶段或产物；错误状态有重试或配置入口。

### 阶段 3：按研究阶段重组现有功能

**目的**：把当前十个平级 tab 改成连续研究流程，降低工具碎片化。

**目标阶段组**：

| 阶段组 | 包含视图 | 迁移的现有面板 |
|---|---|---|
| 发现与阅读 | 搜索、文献库、文档、知识库、证据 | `ResearchLibraryPanel`、document/index/knowledge/evidence |
| 构思与计划 | 问题、假设、计划、策略、评审 | `ResearchIdeaPanel`、`ResearchPolicyPanel`、workflow |
| 实验与检查 | 环境、运行、日志、指标、图表、对比 | `ResearchExperimentPanel`、figure、run |
| 写作与审阅 | claims、正文、模板、编译、review gate | `ResearchManuscriptPanel`、`ResearchEditorPanel`、review |
| 发布与复现 | 导出包、输入检查、来源快照、复现信息 | `ResearchProductionPanel`、export/production |

**工作项**：

1. 由阶段组路由替代 `activeTab` 平铺；阶段内保留局部 tabs/子导航。
2. 每个阶段页面固定三列语义：上下文导航、主工作区、证据/运行/服务侧栏；小窗口改为抽屉。
3. 让“当前阶段”成为主操作；非当前阶段允许查看，写入动作根据 gate/status 禁用并解释原因。
4. 把模型下载、嵌入配置、阶段模型等低频配置移入服务状态/项目设置，不占主导航。
5. 统一空态、加载态、错误态、无权限态、模型未安装态和运行中态。

**主要文件**：

- `src/renderer/views/research/ResearchView.tsx`
- `src/renderer/views/research/ResearchWorkflowPanel.tsx`
- `src/renderer/views/research/ResearchLibraryPanel.tsx`
- `src/renderer/views/research/ResearchIdeaPanel.tsx`
- `src/renderer/views/research/ResearchExperimentPanel.tsx`
- `src/renderer/views/research/ResearchManuscriptPanel.tsx`
- `src/renderer/views/research/ResearchEditorPanel.tsx`
- `src/renderer/views/research/ResearchProductionPanel.tsx`
- `src/renderer/styles/research.css`

**验收**：用户可从项目总览完成一次最小闭环：创建项目 → 检索/导入文献 → 捕获证据 → 形成想法 → 启动阶段运行 → 查看产物 → 写入/导出；每次跨阶段跳转保留项目上下文。

### 阶段 4：通用能力迁移为科研服务

**目的**：让原有通用功能在科研场景中可用，同时保持可维护的边界。

**迁移规则**：

| 原入口 | 新入口 | 规则 |
|---|---|---|
| Chat | 研究助手 | 默认绑定当前项目与阶段；新会话自动带 project/stage 元数据 |
| 任务工作台 | 活动与运行 | 任务按项目、阶段、运行类型过滤；审批回到原阶段 |
| 文件工作区/Git/终端 | 文件与代码服务 | 默认打开项目 workspace；每次执行记录输入/输出与 artifact 关联 |
| MCP | 连接器服务 | 显示科研连接器、授权状态、工具级权限与最近调用 |
| Skill | 技能服务 | 按领域/阶段展示，可从阶段工作区选择，不再是孤立设置页 |
| Memory | 项目记忆 | 项目记忆、会话历史、全局记忆分层；明确写入范围 |
| Settings | 项目设置/全局设置 | 项目策略与提供商全局配置分开 |
| Diagnostics | 运行诊断 | 从失败运行、服务状态和活动事件直接进入 |

**工作项**：

1. 为服务定义统一状态模型：`available`、`needs_setup`、`running`、`blocked`、`failed`、`disabled`。
2. 所有服务入口接受 `projectId`、`stage`、`workspacePath`，不能依赖隐式全局状态。
3. 统一任务确认、权限、取消、重试、恢复和错误映射。
4. 对现有 IPC 做最小新增：优先新增项目快照/服务状态聚合，不复制领域 capability。
5. 迁移期间保留旧页面别名，完成数据与 URL 迁移后再移除旧 dock 条目。

### 阶段 5：路由、性能、响应式与可访问性

**目的**：使新工作台适合长期科研使用，而非只在宽窗口演示。

**工作项**：

1. URL 结构建议：`?page=research&project=<id>&view=overview|stage|activity|provenance|service&stage=<stage>`；保留旧 `page=research` 与 tab 参数映射。
2. 项目/视图/阶段切换支持刷新恢复、浏览器后退前进、深链接和无项目降级。
3. 项目总览首屏只加载聚合摘要；文献全文、知识库、实验日志、图表和编辑器按视图懒加载。
4. 小于 1100px：服务区改为抽屉；小于 800px：侧栏改为可展开面板；不能依赖横向滚动承载主操作。
5. 键盘可操作阶段导航、项目切换、运行控制、错误关闭和抽屉；所有状态有文本/ARIA，不只依赖颜色。
6. 对长列表采用窗口化或分页；事件、运行、artifact 默认限制数量并支持继续加载。

### 阶段 6：验证、灰度与清理

**目的**：用可观察指标确认新架构真正改善科研工作流。

**测试层级**：

1. 单元：路由映射、上下文选择、阶段权限、服务状态、错误映射、聚合快照。
2. Renderer：空项目、项目切换、阶段切换、活动过滤、溯源跳转、服务抽屉、模型未安装。
3. IPC/main：快照查询、项目隔离、归档项目写入拒绝、运行恢复、事件排序、权限边界。
4. 端到端：创建项目 → 导入文献/PDF → 解析 → 捕获证据 → 运行实验 → 发布图表 → 写稿 → 编译 → 导出。
5. 回归：旧 URL、旧数据、无 workspace、无模型、索引失败、运行中退出、重启恢复、超时与取消。

**灰度策略**：

- 默认先以 feature flag 启用新壳层；旧 `ResearchView` 作为回退。
- 新旧页面共享同一 research capability 与数据库，不做双写。
- 连续两个版本通过关键流程和性能检查后，默认移除旧侧栏科研入口；保留 URL 兼容映射一个发布周期。
- 清理废弃 CSS、旧 tab 路由和重复聚合请求前，先用 `rg` 验证无引用，再删除。

## 4. 关键数据与 API 设计

### 4.1 复用的事实源

- 项目：`research.projects.*`
- 工作流：`research.workflow.*`
- 阶段运行：`research.workflow.*Run`
- 产物：`research.artifacts.*`
- 证据与 claims：`research.evidence.*`、`research.claims.*`
- 文献与文档：`research.library.*`、`research.document.*`
- 知识库：`research.knowledge.*`
- 实验与图表：`research.experiment.*`、`research.figure.*`
- 稿件、模板、导出：`research.manuscript.*`、`research.template.*`、`research.export.*`

### 4.2 建议新增的只读聚合契约

仅当并行请求造成首屏慢或状态不一致时新增：

```ts
type ResearchProjectSnapshot = {
  project: ResearchProject;
  workflow: ResearchWorkflowSnapshot;
  pendingGates: Array<{ stage: ResearchStage; reason: string }>;
  activeRuns: ResearchStageRun[];
  recentEvents: ResearchWorkflowEvent[];
  artifacts: ResearchArtifact[];
  indexStatus: ResearchIndexStatus | null;
  counts: {
    literature: number;
    documents: number;
    evidence: number;
    experiments: number;
    figures: number;
    manuscripts: number;
    exports: number;
  };
};
```

该契约只负责首屏聚合，不取全文、不返回秘密、不改变现有领域服务写入规则。聚合查询必须校验 `projectId`，对 archived 项目只读。

## 5. 设计与实现约束

- 保持 Electron main/preload/renderer 隔离；所有新数据通过类型安全 IPC。
- 复用 `research-session` 的 projection/adapter 模式，不在组件内直接散落 IPC 调用。
- 视图负责展示和用户意图，阶段门槛、项目隔离、权限、运行恢复由 main/plugin 决定。
- 不在 renderer 复制 workflow 状态机；UI 只根据 `researchWorkflowSnapshotSchema` 渲染可用动作。
- 新增文案使用中文，identifier、capability、状态码保持英文。
- 页面不依赖特殊字体、联网图片或远端服务才能完成项目浏览和已有产物查看。
- 长任务必须可见状态、可取消/重试（若 capability 支持）、可从活动面板回到来源。

## 6. 里程碑与交付物

| 里程碑 | 交付物 | 完成判定 |
|---|---|---|
| M0 基线 | feature flag、回归清单、上下文类型草案 | 旧页面与旧 URL 可回归 |
| M1 主壳层 | 默认科研入口、项目侧栏、阶段导航 | 启动即可进入项目上下文 |
| M2 总览 | 项目总览、活动、溯源 | 首屏能给出下一步与阻塞原因 |
| M3 阶段页 | 发现/构思/实验/写作/发布五组页面 | 完成最小研究闭环 |
| M4 服务集成 | Chat/Task/Files/Git/Terminal/MCP/Skill/Memory 迁移 | 每个服务显示项目上下文与状态 |
| M5 稳定性 | 深链接、响应式、可访问性、性能、回归 | 关键流程和异常路径通过 |
| M6 清理 | 旧 tab/dock 清理、文档更新、迁移说明 | 新架构成为唯一默认入口 |

## 7. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 一次性重写壳层导致回归面过大 | 高 | feature flag、旧路由回退、阶段性提交 |
| 首屏聚合请求过多 | 中 | 先复用已有 projection，必要时新增只读快照 |
| Chat/Task 与科研运行状态重复 | 高 | 明确活动事件模型和唯一运行详情页 |
| 全局 workspace 与研究项目语义冲突 | 中 | 项目持有可选 workspacePath，文件服务显式显示当前项目 |
| 模型/嵌入/连接器缺失阻塞用户 | 中 | 服务健康状态 + 降级浏览 + 就地配置入口 |
| artifact 与来源未完整关联 | 高 | 首先展示已有 provenance，缺失关联显示“未建立来源”并阻止虚假可追溯声明 |
| 小窗口信息密度过高 | 中 | 抽屉、懒加载、固定主操作区、响应式验收 |

## 8. 完成标准

计划执行完毕需同时满足：

1. Roc 默认进入科研主工作台，项目是一级上下文。
2. 用户不离开项目即可使用 Agent、文献、知识库、实验、文件、Git、终端、写作、导出和服务配置。
3. 项目总览能明确展示当前阶段、下一动作、阻塞/审批、运行与关键产物。
4. 关键产物能回看来源、证据、输入、代码、运行和版本；缺失关联不会被标记为已验证。
5. 旧项目数据、旧 URL、运行恢复、模型未安装、失败/取消/重试路径有明确行为。
6. 关键流程、IPC 契约、响应式、键盘可访问性和 macOS 打包 smoke 均通过。

