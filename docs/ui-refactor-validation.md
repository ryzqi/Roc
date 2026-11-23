# UI 重构验证记录

## 2026-11-23 P1.3：页头、信息区与标准条目

状态：**Verified passing**。`shared/page-ui.tsx` 提供 PageHeader、PageSection、原生 PageListRow，复用 EmptyState/ErrorBar；导航、选择与异步状态仍归业务所有。永久夹具覆盖正常、空、加载、错误、受限状态。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm build`、`pnpm check:renderer-chunks`、`pnpm audit:design` 通过；`ROC_UI_AUDIT_DIR=/tmp/roc-ui-p1-p2-captures-20261123 node --test --test-concurrency=1 tests/renderer/workspace-frame.test.mjs tests/renderer/page-ui.test.mjs tests/renderer/shell-management-guards.test.mjs` 最终 **19/19**，其中页面组件 **2/2**。浅深主题、紧凑/舒适、1184/1280/1440px、320px 长标题无横溢出，裁切为零；原生 Enter/Space、禁用与焦点检查通过。已查看浅色紧凑1184px、深色舒适1440px截图，截图审阅后清理。壳体部分见独立 P2.1 记录。

## 2026-11-23 重构计划 P0.1：可复现审计

本轮执行[2026-11-23 重构计划](../Roc_UI_UX_重构计划_2026-11-23.md)，代码基线为 `85e92a4bf0bfccda1a4d77a65373067139da13ce`。下方 11 月 20–21 日记录属于历史轮次，与本计划 P0–P8 分开。

状态：**Verified passing**（审计依赖和测试准备范围）。两套本机 Skill 审计脚本原先被 Git 忽略，布局与 renderer 测试无法在干净检出中找到它们。现统一读取 `scripts/ui-audit/`，包含 MIT 许可、原始/当前 SHA256 与修改说明；`pnpm audit:design` 为固定入口。

新增阳性测试复现纯黑阴影漏报：原 `rgba?` 正则把 `rgb(0, 0, 0)` 的蓝通道零视为 alpha 零。修复只改变透明度识别，不改变裁切几何与容差；回归覆盖纯黑、零蓝通道、hover、足够留白、整边隐藏及显式透明。公共 Vite 夹具也在创建随机目录前建立 `.runtime/tmp/`，消除首次运行的 `ENOENT`。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
node --test tests/renderer/ui-clip-audit.test.mjs tests/unit/ui-audit.test.mjs
pnpm audit:design
node --test tests/renderer/literature-list-layout.test.mjs
git diff --check
```

结果：审计行为与来源校验 **3/3**；设计扫描 **270 文件**；文献列表完整回归 **3/3**；差异检查通过。首次 103 项基线因缺少临时目录在准备阶段失败；修复后 102/103，一项虚拟列表滚动断言失败，单项及完整文件随后通过。保留这次偶发记录，不把定向重跑写成整套一次通过。

本部分不改变生产 UI。当前构建、全布局与性能数字在 P0.2 记录；T1/T2/T3 外部服务、人工输入法和 VoiceOver 仍需各自验证。临时日志与截图在本轮审阅后清理。

## 2026-11-23 P0 基线修复：导入请求只消费一次

状态：**Verified passing**（导入请求生命周期）。全布局检查发现：从侧栏打开并关闭导入弹窗，返回项目入口，再进入同一项目，已关闭弹窗会重开并遮住发现页。原因是请求存在共享 store，而已消费标记仅存在 Hub 的局部 ref，卸载后丢失。消费确认现保存在共享 store，按请求 ID 确认，保留冷挂载前和非活动期间的新请求。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`node --test --test-name-pattern='sidebar import requests' tests/renderer/literature-workspace-layout.test.mjs` 修复前复现失败；修复后 `node --test tests/renderer/literature-workspace-layout.test.mjs` **5/5**，`pnpm typecheck`、`git diff --check` 通过。完整应用的返回项目路径将在 P0.2 重新构建后复跑，不以组件回归代替全布局结果。

## 2026-11-23 P0.2：当前工程基线

状态：**Verified passing**（以下工程基线范围）。应用基线为 `42c3a78`（包含 P0.1 和导入请求修复）。本次布局驱动按当前可见列表选择唯一导入入口，仍校验恰有一个入口；完整 smoke 的 P4 子闸门也支持把诊断放入指定临时目录。没有放宽几何、业务或分包门槛。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`，以下命令通过：

```sh
pnpm build
pnpm check:ipc
pnpm check:renderer-chunks
pnpm audit:design
ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-ui-p0-layout-complete-20261123 pnpm audit:layout
node scripts/performance/bench-macos-app.mjs /tmp/roc-ui-p0-performance-final-20261123.json --samples 5 --idle-minutes 0
ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-ui-p0-smoke-final-20261123 pnpm smoke:electron
```

- 构建含类型检查通过；eager JS **503389 bytes / 10 files**，各应用 chunk 低于 500000 bytes。保留上游 Mermaid/ELK 提示，未改预算。
- 布局 **771 状态 / 2079 次焦点与无遮挡检查**通过，阴影裁切最大 `cut=0`。浅/深各覆盖 1440×900、1280×820、1100×820、1099×820、1184×820、720×760、380×760、1200×540，以及普通/减弱动效。原生最小宽度保持 1184px，较窄尺寸是测试窗口内的 CSS 视口模拟。已查看浅色工作台、深色文献阅读、380px 模型设置截图。夹具为空/少量受控内容，不能当海量真实文献或 PDF 证据。
- 前次矩阵在浅色 1099px 的截图步骤出现 `Target page, context or browser has been closed`，无足够诊断确定原因；完整同参数重跑通过，保留中断记录，不声明已修复其根因。此前导入入口和请求重放两处阻塞已分别修正。
- **15 次**同机启动/历史加载量测完成，结果与逐样本证据见[性能方法及基线](research-performance.md#2026-11-23-ui-工程基线)。0/1,000/10,000 合成消息的主窗就绪 P95 分别 1289.8/1347.2/1276.6ms；后两组采样均挂载 13 条消息。测量期间没有并行运行 Electron 测试或构建。
- 完整 smoke：核心 **23/23**，助手深度路径 **64/64**。涵盖隔离工作区真实文件/Git/PTY、本地受控 provider、批准/拒绝的实际文件结果、停止与恢复、检查点进程重启、516 条消息下有界回放与滚动、125% 缩放。首轮深度路径打开侧栏后未关闭覆盖抽屉，助手正确处于 inert；修复脚本操作顺序后完整重跑通过。运行应用仍是上述 P0 构建，末尾类型检查同时覆盖工作区中正在实现的 P1.1 源码。真实外部模型和人工输入法未由这些结果验证。

P0 尚有独立验收缺口：100 个项目，100/2,000/10,000 篇文献，500/5,000 条流式消息，200 页 PDF 连续翻页，20 次面板切换，30 分钟空闲 CPU/RSS、输入到绘制/FPS/Profiler，以及真实服务 T1/T2/T3、系统输入法与 VoiceOver。P1 可在已固定的工程基线上按切片推进，这些缺口不记为已完成。

## 2026-11-23 P1.1：共享按钮六态

状态：**Verified passing**（按钮及设置接入范围；全量 renderer 有下述失败）。

`ActionButton` 在既有 `shared/form-ui.tsx` 中复用按钮类；默认/悬停/按下/禁用/加载/可见焦点使用同一契约。加载由调用方控制，显示图标与真实操作文案，设置 `aria-busy` 并禁用。模型设置的保存密钥、测试连通和设置保存栏已接入，原有密钥保存同步防重、失败重试、草稿和供应商身份隔离保持在业务层。保存栏按下位移现在尊重减弱动效。

永久组件画廊属于测试，不增加产品入口。真实 CSS 下检查浅/暗、两种密度和 1184/1280/1440px，驱动 hover/按下/Tab，校验最小字号 12px、点击目标 28px、无横溢出及 `clip.cut=0`。已查看浅色紧凑 1184px 和深色舒适 1440px 截图。回归还覆盖外部表单提交、原生 name/value/ref、disabled fieldset、加载防点击、恢复后键盘可达，以及 busy 与 saving 的区别。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
pnpm build
pnpm check:renderer-chunks
pnpm audit:design
ROC_UI_AUDIT_DIR=/tmp/roc-ui-p1-gallery-20261123 node --test --test-concurrency=1 tests/renderer/action-button.test.mjs tests/renderer/settings-write-guards.test.mjs tests/renderer/model-provider-settings.test.mjs
pnpm test:renderer
node --test --test-name-pattern='rendered transcript keeps|intentional scroll away' tests/renderer/lifecycles.test.mjs
node --test tests/renderer/literature-list-layout.test.mjs
```

构建、分包、设计门禁和按钮定向检查通过：定向 **14/14**；eager JS **503800 bytes / 10 files**，比 P0 增加 411 bytes，分包预算未改变；设计扫描 270 文件。

完整 renderer **895/898 通过**，耗时 1875 秒，3 个失败均为滚动断言：`lifecycles.test.mjs` 历史裁剪后原消息锚点不可见（当时 1376 行），下一会话未到初始底部（当时 1447 行）；`literature-list-layout.test.mjs` 滚到顶部后第 120 行仍挂载（135 行）。未修改测试的定向复跑中，文献完整文件 **3/3**，两项消息流测试 **1/2**（初始底部失败仍复现）。文献同类失败在 P0 已出现；消息流后续诊断与修复见下节，不把重跑结果写成全量通过，不改动断言容差或延长超时。

本子项不代表 P1 的 tokens、输入/菜单、状态、列表与检视器全部完成。临时日志和截图在审阅、提取必要诊断后清理，正式组件夹具和验证记录保留。

## 2026-11-23 P0.3：消息流回归夹具校正

状态：**Verified passing**（夹具校正及以下组合验证范围）。

全量失败的两个消息流用例已定位到夹具问题。旧夹具没有应用 CSS，默认段落外边距使测量行高约 22.5px、实际行距 38.5px；80 条消息的初始滚动停在 1520px，而实际内容高度为 2244px、视口 320px。几何相交检查还把 Virtuoso `visibility:hidden` 的初始化行当作可见锚点，历史更新会与尚未结束的初始化定位重叠。探针确认 `checkVisibility()` 默认不检查 CSS visibility，必须显式传入 `visibilityProperty: true`。

夹具现与其他 renderer 测试一致读取本轮 `pnpm build` 生成的 CSS，等待真实可见的初始化列表，并按 Virtuoso `data-index` 确认 prepend/trim 已应用。保锚场景明确先上滚阅读历史；位于底部时继续追随新尾部仍由独立用例验证。原 2px 断言和超时保留，未新增固定等待或改动生产消息流。仅保留失败时的几何诊断，临时滚动钩子、轨迹及探针均已删除。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
node --test tests/renderer/lifecycles.test.mjs
node --test --test-concurrency=1 tests/renderer/lifecycles.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/action-button.test.mjs tests/renderer/settings-write-guards.test.mjs tests/renderer/model-provider-settings.test.mjs
node --check tests/renderer/lifecycles.test.mjs
git diff --check
```

最终生命周期完整文件连续 **5 轮 85/85**；消息流、文献列表、按钮和设置组合 **102/102**；语法与差异检查通过。先前 898 项全量运行仍按原成绩保留；文献列表偶发失败的根因尚未证实，不标为已修复。

## 2026-11-23 P1.2：共享表单反馈、只读与模型字段校验

状态：**Verified passing**（本子项和最终 70 项组合范围；首次 Escape 偶发仍记录如下）。

共享 `TextField`、`NumberField`、`SelectField` 统一独立标签、说明和错误关联，`CheckboxField` 将说明从名称中分离。文本/数值使用原生只读并显示标记；数值提交检查只读、自身及祖先 fieldset 的禁用状态，复用 IME 守卫，保留空值、零及失焦/Enter 提交契约。沿用现有 tokens，不新增校验规则。

模型设置接入当前 `validateDraft`：名称、类型、接入地址、模型标识/显示名及高级数值的错误显示在对应字段，供应商重排后按 ID 重新定位校验路径；错误首次出现时展开高级参数，修正后保持展开。既有嵌入配置 ID 改为可聚焦、可选择复制的只读字段；新配置 ID 可编辑，保存期间仍由整个 fieldset 禁用。全局校验汇总与既有写入、草稿、密钥保护继续保留。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
pnpm build
pnpm check:renderer-chunks
pnpm audit:design
ROC_UI_AUDIT_DIR=/tmp/roc-ui-p1-form-fields-captures node --test tests/renderer/form-fields.test.mjs
node --test --test-concurrency=1 tests/renderer/form-fields.test.mjs tests/renderer/model-provider-settings.test.mjs tests/renderer/settings-write-guards.test.mjs tests/renderer/action-button.test.mjs tests/renderer/radix-settings-dialog.test.mjs tests/renderer/management-draft-guards.test.mjs
node --test --test-name-pattern='settings dialog layers|reset confirmation accepts' tests/renderer/radix-settings-dialog.test.mjs
node --test tests/renderer/radix-settings-dialog.test.mjs
node --test --test-name-pattern='reduced motion preserves' tests/renderer/action-button.test.mjs
node --check tests/renderer/form-fields.test.mjs
node --check tests/renderer/model-provider-settings.test.mjs
node --check tests/renderer/settings-write-guards.test.mjs
node --check tests/renderer/action-button.test.mjs
git diff --check
```

表单语义回归先复现缺少 NumberField 描述、只读属性及 IME Enter 误提交，再修正实现。最终表单 **4/4**；画廊检查浅/深 × 紧凑/舒适 × 1184/1280/1440px，以及 320px 容器，无横溢出、`clip.cut=0`、焦点可见；已人工查看浅色紧凑 1184px、深色舒适 1440px 与模型设置高级参数截图。构建（含类型检查）、分包及设计扫描 270 文件通过；eager JS **505042 bytes / 10 files**，应用 entry chunk 预算未改变。

首轮设置集成 **12/14**，两项新增断言错误分别为 Zod 实际提示 `>0` 与 macOS 全选键；修正后该组全部通过。首次扩大组合 **68/70**：设置放弃确认的 Escape 未关闭，导致下一用例被残留弹窗阻挡；未修改弹窗，原失败对 **2/2**、完整文件 **22/22** 均通过，偶发根因尚未确认。第二次组合 **69/70**，失败为既有 ActionButton 的减弱动效即时取样。单项复现和探针确认 `:active=true`，CSS 过渡为 0.01ms，同帧 opacity 为 1、下一帧为 0.9；改用既有超时内轮询视觉生效，保留无位移断言，未改生产样式或增加固定等待。最终结果见本节末尾。

最终六文件组合 **70/70**，耗时 58.5 秒；语法和差异检查通过。合成 composition 事件与复制事件只验证浏览器交互，不代表系统中文输入法、系统剪贴板服务或 VoiceOver 已人工验收。本次未重跑 898 项全量 renderer；P0.3 中的历史成绩和文献列表偶发问题仍保留。截图、日志与临时运行目录审阅后删除；只保留正式代码、回归夹具和文档。模型设置独立测试改为仅在指定 `ROC_UI_AUDIT_DIR` 时导出截图。

## P0 工程基线（2026-11-20）

macOS 27.2.1 arm64，Electron 45，基线提交 `dd7511a`。隔离数据根启动当天既有 dist，窗口 1320×860，原生最小 1184×640。门户、默认写作、文献、发现（雷达）、知识（RAG）五面均成功加载，无 pageerror、无页面横向溢出，阴影审计均 `cut=0`。截图检查确认默认空写作页、重复文件列表，以及文献七标签带来的多层导航。

仓库根执行：

- `pnpm check:renderer-chunks`：通过，eager JS 481730 bytes / 10 files。
- `python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer`：239 文件通过。
- `pnpm typecheck`：通过。

导航诊断仅在当前窗口内存保留最近 500 个事件，记录页面类别和相对耗时，不含项目标识、查询、文件路径或凭据，不自动上传。任务事件继续使用实际运行事件；本地诊断不构成第二套任务状态。

用户访谈、T1–T3 真实外部服务任务、SUS 与灰度发布尚无证据；工程检查不能代替这些验收。临时截图和隔离运行数据在检查后清理，不进入版本库。

## P1 信息架构与设计契约

[设计契约](design-system.md)固定五目的地、对象与动作归属、十个关键状态的文字线框、集中旧深链迁移、抽屉与原生窗口边界及组件 Do/Don't。复用现有 token、组件和单壳，草稿与业务事实保持原有权威来源。文档与本地引用已检查；这些线框未冒充真人可用性测试结论。

## P2 壳体与系统

五目的地、工作台、集中旧深链迁移、写作内终端、共享文献宿主与 1200px 抽屉阈值已接入。仓库根 `pnpm build`、`pnpm check:renderer-chunks`、设计规则审计通过；eager JS 482999 bytes / 10 files。

`node --test tests/unit/renderer-routes.test.mjs tests/unit/surfaces.test.mjs`：29/29，通过 1920 路由组合。`node --test --test-concurrency=1 tests/renderer/canvas-view-loading.test.mjs tests/renderer/literature-workspace-layout.test.mjs`：10/10，覆盖共享宿主与草稿保留。

隔离 Electron 实窗完成默认工作台、冷入口导入、五目的地、终端、管理深链、1280px 列布局及 1184px 抽屉检查；浅/深主题无 pageerror、无横溢出，`clip.cut=0`。

## P3 文献与发现

发现页默认搜索，来源部分失败保留结果，批量收录展示后端原始分项回执。导入四入口、六能力；阅读器与后台处理展示五阶段，解析不推断索引，缺记录明确待核验。列表增加当前结果排序与批量引用导出。

仓库根 `pnpm typecheck`、设计规则审计通过。`node --test tests/unit/literature-pipeline-state.test.mjs` 5/5；发现 Electron 回归 1/1；导入状态与编辑保护 12/12；阅读与后台处理 20 项均通过（修正旧文案断言后单独复跑失败项）；文献列表与复制动作测试通过。外部搜索和下载未以 fixture 冒充验收。

## P4 知识与写作

提问先检索真实证据，再通过现有助手通路生成答案；知识画布保留检索上下文。问答与知识页是二级入口，关系图从知识页进入。文献/概念跳转携带稳定对象与定位信息，阅读及路由守卫放行后才提交选择。

写作新增工作区编译、取消与原生导出，复用离线 Tectonic、工作区路径校验和资源预算。编译先保存草稿，PDF 使用既有预览协议；只保留 PDF 成果，任务快照与日志在结束后清理。

仓库根 `pnpm build`、`pnpm check:ipc`、设计规则审计通过；`pnpm check:renderer-chunks` 为 486244 bytes / 10 eager files。`node --test tests/renderer/retrieval-workspace.test.mjs` 5/5；`node --test --test-name-pattern='RAG' tests/renderer/desktop-action-guards.test.mjs` 2/2。问答 1100/420px、索引 1100/380px 浅深主题均 `clip.cut=0`，截图检查后删除。

`ROC_WORKSPACE_LATEX_TOOLCHAIN=.runtime/research-toolchain/darwin-arm64 node --test tests/unit/research-workspace-latex.test.mjs` 4/4：含本机真实离线编译，验证有效 PDF、保存内容快照、失败/取消清理及越界/归档/符号链接拒绝。知识问答的模型回答仍需真实模型配置后的 T2 任务验收，不将受控 IPC 测试计为模型质量结果。

`node --test tests/renderer/authoring-tools-layout.test.mjs` 6/6，含保存→编译、构建问题行定位、PDF 预览、导出取消和取消等待回执；浅深色 440/820/1200px 均 `clip.cut=0`。原生另存对话框未手工操作，受控 IPC 只证明界面正确处理成功/取消回执。`node --test --test-concurrency=1 tests/renderer/literature-workspace-layout.test.mjs tests/renderer/literature-retention.test.mjs` 相关 4 项通过（旧 fixture 补齐 `updatedAt` 后复跑）：覆盖双守卫、笔记页跳阅读器、重复概念/证据定位、查询保留。

## P5 助手与任务中心

顶栏和管理抽屉共享一次读取的任务投影；研究任务、后台任务、文献处理各自保留权威来源与错误。分页结果明确标为近期，项目后台任务按工作区筛选。总览提供当前、待处理、最近结束及失败分组，打开原有详情与恢复操作。助手优先展示任务阶段、最近完成与真实成果，完整参数、用量和诊断按需展开。批准/拒绝保持同等视觉权重；停止请求保留等待清理回执，失败不冒充已停止。

仓库根 `pnpm build`、`pnpm typecheck`、设计规则审计、`git diff --check` 通过。`pnpm check:renderer-chunks` 为 491998 bytes / 10 eager files。

- `node --test tests/renderer/task-center.test.mjs`：2/2，覆盖三来源、作用域、分页口径、失败与晚回包、键盘打开；440/720px 浅深主题与 hover 均 `clip.cut=0`。
- `node --test tests/renderer/shell-management-guards.test.mjs`：8/8，顶栏与工作区进入同一任务中心，保留管理草稿、导航、工件与 Git 保护。
- `node --test --test-name-pattern='task categories' tests/renderer/management-draft-guards.test.mjs`：1/1。
- `node --test tests/renderer/native-state-guards.test.mjs`：7/7，原生窗口与项目绑定保护。已删除被任务中心替代的顶栏轮询 hook。
- `node --test tests/renderer/assistant-panel-guards.test.mjs`：15/15，IME、草稿隔离、停止、检查点恢复和三类审批。
- `node --test tests/renderer/research-tasks.test.mjs`：23 项均通过；首次 20/23，更新阶段文案断言和原生折叠展开等待后定向 3/3。覆盖真实成果、停止清理、恢复能力、诊断与草稿保护。

## P6 引导、可读性与交付检查

工作台加入三步内联引导，可跳过并从帮助重开，沿用导航守卫。只保存版本化关闭偏好，不保存业务进度。设置提供本次窗口匿名诊断的显式复制出口；复制失败可重试，提交中锁定按钮。界面中点分隔文案已移除。

弱化文字使用同一语义 token 修正。按 sRGB 相对亮度计算：暗色 `#909099` 在最弱的已检查面板 `#27272a` 上为 4.71:1；浅色 muted `#596579`、subtle `#606774` 在 `#e2e8f0` 上分别为 4.78:1、4.62:1。该结果限定这些文字/背景组合，不等同整应用 WCAG 认证。

以下命令均在仓库根 `/Users/Apple_501/Desktop/Roc/Roc` 执行：

- `pnpm build`、`pnpm typecheck`、`pnpm check:ipc`：通过。
- `pnpm check:renderer-chunks`：493155 bytes / 10 eager files，低于 500000 bytes 预算；相对 P0 增加约 2.4%。大型编辑器、PDF、终端和图谱仍按需加载。
- `python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer`：247 个组件通过脚本已实现的规则。
- `node --test --test-name-pattern='first steps' tests/renderer/shell-management-guards.test.mjs`：1/1，覆盖关闭偏好、重新挂载、导航拒绝、重开后的焦点及匿名事件字段。
- `node --test --test-name-pattern='application session diagnostics' tests/renderer/settings-write-guards.test.mjs`：1/1，覆盖 500 条上限、字段白名单、复制 pending/失败/重试；480px 浅深主题无横溢出、`clip.cut=0`。

`ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-p6-layout-XC81zK/retry pnpm audit:layout`：762 个状态通过，2063 次控件焦点与无遮挡检查通过；浅/深主题各覆盖 1440×900、1280×820、1200×820、1199×820、1184×820、720×760、380×760、1200×540，并检查减弱动效与普通动效的最终落点。原生最小窗口保持 1184×640；窄尺寸通过可丢弃 Electron 窗口的 renderer viewport 模拟，不宣称原生窗口可缩至 380px。无页面横溢出、低于 12px 字体、低于 24px 点击目标，阴影审计最大 `cut=0`。浅深引导、1184 抽屉、1280 任务中心与发现页截图已人工检查。

首轮布局在知识页面发现搜索输入框仅高 19px；为共享知识搜索框设置 24px 最小高度，运行 `pnpm exec electron-vite build` 后再完成上述全矩阵。没有降低审计门槛或跳过该控件。

`ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-p6-smoke-xyadu1 node scripts/smoke-electron.mjs` 的核心 16 项通过，包括首次引导、统一任务入口、真实工作区文件/Git/PTY、本地受控 provider 的运行和设置保存。新增缩放段最初因自动化在响应式抽屉落地前检查侧栏而失败；修复脚本等待布局与引导焦点的时机，未改应用代码。修复后未重复整轮 smoke，不能将本轮记作整套脚本全绿。

随后在仓库根通过 `ROC_SMOKE_TARGET=dist node --input-type=module` 的隔离 harness，直接读取并执行 `scripts/smoke-electron.mjs` 中 `// One real zoom pass` 开始的最新缩放段，工作台/设置 2/2 通过。真实窗口 1280×820、倍率 1.25、CSS 视口 1024×656；关键控件获得键盘焦点且 `elementFromPoint` 命中，字号、目标尺寸、溢出和裁切均通过。脚本等待响应式布局完成后关闭导航抽屉，最终恢复倍率和窗口尺寸。该倍率的实际鼠标点击尚未验证。Playwright 缩放截图存在导出裁切，改用 Electron `capturePage()` 获取完整 2560×1640 原生截图，人工检查通过后删除。

最终 `node --check scripts/smoke-electron.mjs`、`node --check scripts/ui-layout-audit.mjs`、`git diff --check` 通过。检查脚本在结束时清理自己创建的隔离数据根，截图目录可通过环境变量指定。

## 验收边界与回滚

本轮完成本地工程实施和已记录的工程检查，不声明用户研究或发布门槛全部达成。5–8 名真实目标用户的 T1–T3 测试、SUS、真实外部搜索/下载与模型质量、人工 VoiceOver、操作系统输入法和滚轮体验、长期 CPU/内存及崩溃恢复、安装包分发和灰度发布尚未完成。受控 IPC 与本地 smoke provider 的通过只证明相应工程通路，不代替外部服务和用户体验结果。

每阶段使用独立本地提交：P0 `243720b`、P1 `39d940b`、P2 `cec5f23`、P3 `cb8644b`、P4 `e13e0e9`、P5 `320766b`，P6 为本节及最终收尾所在提交。需要回滚时，从目标阶段的后续提交开始逆序 `git revert`，再构建并运行受影响的检查；不使用 reset 清除历史。本轮未执行回滚或远端发布。回滚代码不会删除已有文献、项目文件、编译 PDF 或用户数据，也不应为回滚界面而重置数据库。

工程截图、隔离 smoke 数据和临时计划在检查后清理；保留本记录、设计契约、回归检查及用户原始方案。


## 2026-11-21 页面密度与组件复用

本轮以 `1d6865c` 为起点，核对 Apple HIG、Microsoft Fluent、IBM Carbon 的布局与组件指导，参考成熟 Sidebar、Radix Dialog 和 Virtuoso，沿用既有 token、单壳与依赖。来源和应用位置见[设计契约](design-system.md#官方参考与组件复用)。没有新增组件库，也没有新增临时方案文档。

完成项目门户固定查询区、工作台成果/文献自适应并列、文献两层工具栏与虚拟列表、助手分层输入与历史成功工具披露、后台任务平面列表和筛选。补齐虚拟行卸载后的键盘焦点、流式结束后的工具 DOM/展开态保留、高缩放短视口门户滚动。现有文档的栏序、断点、四目的地与设置分组同步到当前代码。

本地提交：`3de1ce0` 项目布局、`5cc2603` 后台任务、`38ef779` 文献列表、`0a14048` 虚拟焦点、`3d33800` 助手、`75405a3` 高缩放与对齐；文档收尾使用后续独立提交。

环境：macOS 27.2.1 arm64，Electron 45.3.4。以下命令在 `/Users/Apple_501/Desktop/Roc/Roc` 执行：

```sh
pnpm build
pnpm check:renderer-chunks
python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer
node --test --test-concurrency=1 tests/renderer/project-session-layout.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/literature-action-guards.test.mjs tests/renderer/management-draft-guards.test.mjs tests/renderer/task-center.test.mjs tests/renderer/assistant-activity-layout.test.mjs tests/renderer/assistant-panel-guards.test.mjs tests/renderer/desktop-interactions.test.mjs
ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-ui-refactor-MS2nxb/final-layout pnpm audit:layout
git diff 1d6865c --check
```

- 构建、内含类型检查、chunk 门禁、差异检查通过；258 个组件通过脚本已实现的设计规则。
- 合并 Electron 回归 **101/101**，无跳过。覆盖项目筛选/编辑、文献虚拟列表/批选/复制、后台刷新失败与草稿、助手输入/停止/审批、CJK 事件守卫、浮层焦点与缩放对应短视口。
- 全应用布局 **771 状态**、**2079 次控件焦点与无遮挡检查**通过，所有阴影审计 `cut=0`。浅/深主题覆盖 1440×900、1280×820、1100×820、1099×820、1184×820、720×760、380×760、1200×540，以及减弱动效、hover、展开和普通动效落点。门户、工作台并列、助手模型浮层、窄设置等截图已查看。原生最小窗口仍为 1184×640；低于此尺寸使用隔离 Electron 窗口内的 renderer viewport 模拟。
- 审查在真实 Electron 1184×640、400% 缩放复现门户列表归零后，新增不超过 400px 高度的整页滚动规则；随后上述最终 101 项回归在 296×160 CSS 视口及 244×122 壳内内容空间验证入口与搜索均可聚焦。此追加规则只影响全矩阵未覆盖的极短视口，未重复整套矩阵。
- 文献 200 条实测只挂载 13 行；按需加载虚拟组件，首末跳转、排序、外部选择、手动滚动卸载和复制动作均有行为回归。
- 历史 500 次成功工具调用折叠时组内 DOM 少于 20 个节点；展开可查看全部回执。当前流式消息完成后保留同一焦点节点与输出节点，错误、审批、推理和可导航综述回执不被聚合隐藏。
- 最终 eager JS **502830 bytes / 10 files**，对比本轮既有构建基线 **501716 bytes** 增加 1114 bytes（约 0.22%）。应用入口与各应用懒模块均低于 500000 bytes 门禁；总 eager 预算由脚本维护。编辑器、PDF、终端与图谱继续懒加载。构建保留 Mermaid/ELK 上游大模块提示，未调整门槛。
- 更新的 Markdown 本地链接已核验。所有本轮临时截图、日志、隔离运行目录已清理；未创建中间计划或报告文件。

状态为 **Verified passing**，范围是本轮代码与上述工程检查。未重新打包或发布应用；人工系统输入法、VoiceOver、真实滚轮、长期 CPU/内存和真实外部服务任务不属于这些自动化结果。README 保留注明日期的既有真实业务截图，不把受控测试截图替换成真实业务证据。
