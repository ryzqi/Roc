# S07：真实执行安全与单壳桌面观察

优先级：P1。依赖：S02、S04、S05、S06 后端合同。
来源：WP-10/WP-12、RH-17/RH-15/RH-07。
实施状态：complete（工程）；Verified passing，见 [执行报告](s07-execution-report.md)。建议时间：第 11～14 周。

## 目标与关口

对重构后的组合执行路径验证真实权限、I/O、资源和取消边界。
研究者在原助手、任务抽屉和工件检查器中理解等待、证据、费用和恢复。
安全合同随各阶段实现，本阶段完成组合攻击与真实桌面检查。

## 当前起点

- [grant broker](../src/main/services/deep-agent/execution-grant-broker.ts)、
  [resource coordinator](../src/main/services/deep-agent/tool-resource-coordinator.ts)
  和原生 process/Seatbelt 治理已存在，不从提示词推断隔离。
- [ResearchTasksSection](../src/renderer/management/sections/ResearchTasksSection.tsx)已有任务/观测；
  [任务观测文档](../docs/research-task-observability.md)已有本地脱敏诊断包。
- [AppShell](../src/renderer/app/AppShell.tsx)、[surfaces](../src/shared/surfaces.ts)、
  [view registry](../src/renderer/app/view-registry.ts)是唯一布局和落点。

## 按顺序执行

- [x] **RH-17.1 权限矩阵**：actor（human/main/worker）× tool × scope
  （project/global literature/MCP/network/environment/publish）× effectClass × approval；
  每格注明真实执行边界、grant、resource、receipt 与拒绝结果。
- [x] **RH-17.2 真实路径检查**：项目/目录 canonical identity、symlink 目标、
  执行时 source/input/request hash、过期 grant、归档状态都在实际 I/O 前检查。
  以实际文件/网络/进程权限为准，不把 renderer schema 当授权。
- [x] **RH-17.3 攻击样本**：构造文献正文、网页、MCP description/result 注入，
  traversal/symlink/TOCTOU、跨项目窗、伪造人类决定、旧 approval、旧 Worker、
  越权上传/发布与任意 shell 读用户目录。
  100～200 个独立攻击场景注明覆盖边界和真实到达层。
- [x] **RH-17.4 Side-effect 观察**：使用隔离目录 sentinel、受控网络接收器、
  进程/文件/hash/receipt 确认真 effect；分别记录 policy denied、
  sandbox denied、not dispatched、unknown effect，不能仅看模型拒绝语句。
- [x] **RH-17.5 资源边界**：核验超时、取消、父进程崩溃、child cleanup、
  native code/input/environment receipt；CPU/RSS 采样治理不宣称内核硬配额。
  未支持硬限制必须拒绝该要求，不伪造 enforcement 成功。
- [x] **RH-15.2 任务抽屉**：同一 task source 展示依赖、节点/attempt、等待和失败原因、
  预算/资源、结果链接、取消/继续；恢复继续同一 run。
  执行发起仍由助手，观察视图不另建“运行工作流”按钮。
- [x] **RH-07.4 工件核验**：使用原检查器展示主张 verdict、反证、方法 finding、
  版本失效与人工接受/退回；打开真实 PDF locator，不复制证据正文存储。
- [x] **RH-12/15.3 助手与诊断**：计划摘要、批准卡片、等待、取消、恢复沿现有 conversation
  和 IPC；unknown cost、replay gap、source changed、未科学验证清楚可见。
  内部 lease/grant/receipt 细节按需展开，不默认灌入普通操作流程。
- [x] **RH-15.4 Desktop states**：loading/empty/error/pending/disabled、
  late response/project switch/archive readonly、取消 cleanup 和恢复状态逐项验收。
  迟到回复不得填入另一项目/task 的面板。
- [x] **RH-15.5 键盘与布局**：主动作可键盘操作，focus visible、抽屉焦点捕获/返回、
  IME 不误提交、reduced motion、light/dark、宽窄窗无裁切。
  `data-testid` 使用当前 shell area 命名，不添加 legacy prefix。
- [x] **RH-17/15.6 删除旧边界**：切换后去掉重复 UI store、旧 IPC action、独立 task page、
  绕过 broker 的 Worker 工具和仅靠 prompt 的权限承诺。

## 交付物

权限/威胁矩阵、攻击样本、实际 effect 报告，当前单壳 UI 与对应 IPC/read models，
诊断包边界说明、深浅主题/键盘/恢复截图和 clip audit。
测试与工具仅使用 task-created 隔离数据，不扫描或导出真实用户目录。
没有真实 Container/Remote 需求时本阶段完成 local backend，远程方案在 S09。

## 删除范围

双任务数据源、旧 session/run UI 状态拼接、legacy testid alias、第二个任务/阶段页面、
renderer Node/native 调用、直接暴露 ipcRenderer、绕过 grant 的实际 I/O 分支。
新 heavy UI 模块仍懒加载，不为小任务图引入未经证明的重依赖。
不将有效未知状态改为“已完成”，不保留旧壳或旧组件回退。

## 验证

```bash
pnpm test:research-resources
pnpm test:research-environment-boundaries
pnpm test:research-native-code
node --test tests/renderer/research-tasks.test.mjs tests/renderer/research-search-plan.test.mjs
pnpm check:ipc
pnpm check:renderer-chunks
pnpm build
node scripts/smoke-electron.mjs
```

实际攻击 integration 在本阶段创建并执行，核对外部动作 dispatch=0 和 sentinel。
关键桌面流程用本次 build 驱动 Electron，保存普通窗口 1440/1100、
阈值 1099、窄窗 720 和 380 的 renderer 布局证据；380 是否可作为真实原生窗宽
以主进程 minWidth 为准，不能把 fixture 截图称为原生窗口检查。
light/dark、focus、pending approval、error/unknown/gap/source invalidation 各有代表性状态。
静态 testid 或 CSS 检查不能代替实际键盘/页面行为。

## 接受标准与下一步

AC-03/12/13 成立：真实未授权 effect 数 0，覆盖和 unknown 清楚，
任务单一抽屉、重要动作键盘可达、IPC/懒加载当前一致。
通过 G-D 后进入 S08 全链路和打包；安全失败不得以禁用测试或隐藏状态通过。
