# Motion Contract

语义预设的实现入口是 [shared/motion.ts](../../src/renderer/shared/motion.ts)，CSS 刻度入口是 [tokens.css](../../src/renderer/styles/tokens.css)，全局抑制和原生披露位于 [index.css](../../src/renderer/styles/index.css)。本文件规定事件与生命周期，不另存时长数值。视觉理由见 [ADR 0023](../adr/0023-visual-and-motion-spec.md)。

## 事件映射

| 事件 | 呈现合同 | 生命周期和例外 |
| --- | --- | --- |
| feedback | 点击立即进入 pending；成功和失败留在原操作处，文字与图标表达状态 | 服务结果决定成功，错误保持可重试；短暂成功仅用于真实完成的低风险动作 |
| selection | 选中属性、可见标记和键盘焦点同步 | 小型导航可移动指示器；筛选与虚拟列表不做整体布局测量 |
| popover | 从原生锚点弱淡入，同一方向退出 | 再次点击立即反向；关闭后退出内容不可交互，Escape 和焦点恢复保留原生语义 |
| modal | 居中弱淡入和小范围缩放 | `ModalShell` 继续拥有遮罩、焦点、关闭守卫；退出树不能再次触发操作 |
| drawer | 从所在边缘进入，遮罩同期开关 | 重资源保持挂载；逻辑 open、视觉 present、可交互状态分开；断点转换先稳定几何 |
| content-handoff | 新模块 ready 后交接，加载期间保持原页，明确目标 | 正文、PDF、图谱、终端不做整页截图或缩放；草稿宿主身份不变 |
| list-small | 仅稳定、可见且小规模的项目重排提供位置连续性 | 大集合筛选仅淡入；文献移除只对可视区且位移不超过两行的保留行补位，不测量整列 |
| icon / number | 同位图标交叉淡入；计数仅个位过渡 | 结果必须来自真实回执；新计数立即可访问 |
| removal / error | 移除像素短暂消隐；新错误原位短微震 | 退出像素立即 inert；错误正文保持，不延迟业务提交 |
| drag | 指针位置直接映射宽度，RAF 合并重复输入 | 不加 tween；释放或键盘结束才持久化；Escape 还原起点且不写中间值 |
| disclosure | 原生 `details` 保持双向展开与读屏语义 | 不做尺寸动画，立即反映 open 状态并保持滚动锚点 |

`motionTransitions` 与 `getMotionTransition` / `getMotionVariants` 是唯一 JS 时序入口；
CSS 毫秒与 Motion 秒值由合同检查对应。微交互 90ms、快速 150ms、浮层进入 220ms、
退出 150ms、内容进入 150ms / 退出 110ms；图标 140ms、移除 110ms、数字 180ms、
错误 260ms，全部单次过渡不超过 300ms。弹簧使用 duration 与 bounce:0，避免物理
弹簧尾部超出预算。遮罩沿用所属 modal/drawer 的同一进退时序。

活动栏、画布导航与文献分段共用 `SelectionIndicator`，以 `useId` 隔离 layout identity。
减少动态效果时移除装饰层 projection，控制本身不重挂；活动栏提供实际滚动容器的 layoutScroll。

共享 [ActionStatus / TransientStatus](../../src/renderer/shared/action-status.tsx)只接收展示状态。
`ActionStatus` 的 pending/success 默认使用 `status`，error 使用常驻 `alert`；若外层已拥有
live region，传 `announce={false}`，避免重复播报。`TransientStatus` 只接受真实完成身份，
新完成重新计时，换对象传 null，卸载清理计时器。错误、脏草稿和高风险结果不用短暂成功替代。
已有复制提示等自带计时器的反馈继续复用原入口，不叠加第二个倒计时。

## 中断

第二次操作直接更新最新目标，不等待动画完成，不排队。WorkspacePane、共享 ModalShell
和原生标题栏菜单关闭立即隔离退出内容的指针、键盘和可访问树；返回焦点不等待淡出。
重新打开撤销旧退出，旧完成回调不得关闭新对象。设置的独立 Radix pilot 保留
FocusScope 到退出结束的既有合同，避免改变 Radix 的隐藏、滚动锁和嵌套焦点生命周期；
它的关闭守卫与快速重开仍由原逻辑控制，是本阶段的明确例外。

原生 CSS transitions 用于受控显示和 anchored popover；只在保留卸载视觉时引入 presence。Floating UI 首次定位前隐藏；同一次挂载保留 positioned/entered 历史，退出坐标不被 isPositioned=false 清空，快速重开从当前插值点折返。已有 `AnimatePresence` 必须让退出子树读取实时 presence，不能依靠卸载前捕获的 `open=true`。View Transition 只作用于附件等局部稳定身份，检查支持与拒绝并在反向、换对象或卸载时跳过旧 transition。

`ModalShell` 的焦点恢复保留首次打开者（包含无打开者的情况），以实际 panel DOM 是否脱离文档判断卸载。React StrictMode 的 effect 重放和 ref detach 不代表弹层已移除；不能在模拟清理时把焦点还给背景。结束交互只尝试一次恢复，即使旧打开者处于父层的 inert 树内，也不在视觉卸载时重试，防止父层重开后抢焦点。父级直接卸载仍 present 的弹层保留真实恢复。

## P3 壳体与内容接线

WorkspacePane 的资源和 DOM 保持挂载，`data-open` 表示逻辑状态，`inert/aria-hidden`
立即隔离关闭或被另一栏覆盖的内容。CSS 的 display 离散过渡保留退出像素，
opacity/transform 负责边缘移动；scrim 同步过渡，关闭时不接收指针。
断点先改变布局属性；不对宽度加 tween，不以计时器维护第二套 present 状态。
标题栏菜单保留原生 popover、Escape 和焦点回位，`beforetoggle` 同步隔离退出树；
几何样式不依赖 `:popover-open`，display/overlay 离散过渡维持同一退场位置。

分隔条在 RAF 中只更新视觉偏好，释放时合并最终帧并写一次；Escape、pointercancel、
丢失 capture 或断点卸载回滚尺寸且不写中间值。项目/布局键变化后旧回调不写新作用域。
拖动期间的收起或重置单独更新已存基线，取消尺寸不会重新展开用户已收起的左栏。
现有 UI 偏好格式和键保持不变。

画布仍在目标模块 ready 后切换；加载目标提示不占正文高度，交接只淡出一个轻量遮层。
草稿宿主、选区、阅读位置和 ViewActivity 身份保持原逻辑。设置现有 keyed panel
只做短 opacity 进入，不保留退出表单。项目置顶只有完整集合 ≤20、显示 ID 集合稳定、
两端都在可见区时做局部 translate；大集合即使筛为少量结果也立即更新。
再次置顶先读当前视觉位置再取消旧动画；搜索、筛选、布局、滚动、窗口尺寸、
减少动态效果和卸载立即取消。项目焦点按 ID 保留，包含置顶按钮和原生披露入口。

## 减少动态效果

`MotionPreferenceProvider` 与 `useEffectiveReducedMotion` 共用一个 live store，合并系统媒体查询、
html/body/#root 的 `data-reduce-motion` / `data-reduced-motion` 输入，以及继承的
`MotionConfig always`。输出 `data-motion-reduced` 不作为输入，避免自我锁定。
Provider 不创建 DOM 容器或重挂业务树；Portals 和独立浮层也消费同一偏好。

减少动态效果时位移、缩放、微震立即归零，只保留 100ms opacity。Motion 已在退出的
视觉子层通过局部 transformTemplate 立即清除残留变换；定位 wrapper、虚拟滚动和
居中所需结构 transform 保留。CSS 停止循环动画，保留 display/overlay 离散退场。
原生 scroll、文本输入、拖动与布局恢复直接落到最终态。ViewTransition / WAAPI
在偏好变更、滚动或卸载时取消，不等待旧动画完成。

## 文献状态过渡

Inspector 固定外框，只交接内部页面；旧页退出立即 inert/aria-hidden，当前页保留独立
ResourceStatus 身份。方向取自列表当前可见排序中的前后位置，非列表选择不推测方向。
批量栏与 Undo 退出同样隔离交互；六秒撤销窗口和焦点所有权
仍由原业务 hook 决定。复制使用请求序号与卸载守卫，旧回执不能覆盖最新结果。

列表删除立即提交真实成员关系；可见旧行最多保留 110ms 的 inert 装饰副本，
移除全部 ID/test hooks，不保留 React 事件。后续行最多移动两行距离，测量最多 30
可见行，不改 Virtuoso 定位 wrapper。新变更、滚动、缩放或减少动态效果立即取消；
筛选不生成删除副本，大集合筛选只轻淡入。滚动用 passive capture 与 scrollend
（含静止回退）暂停行级悬停和循环反馈，不劫持原生滚轮。

首次加载延迟 150ms 才显示 64px 同高骨架；进度仅来自回执，进行中 1.8s 透明呼吸，
完成转为静态勾号。计数等宽、仅个位过渡；独立可访问文本立即提供当前完整数值，
装饰数字整体 aria-hidden，旧数字退出期间也不进入可访问树。

## P4 助手与任务反馈

Composer 在提交时记录此次操作的展示意图：发送、回答、纠正或排队跟进。请求未结束时，
运行状态或回答模式的变化不能把“正在提交纠正”改成“正在发送”。现有同步提交锁、
输入身份、IME、附件和草稿守卫继续决定能否派发；停止按钮保持键盘焦点。
批准与拒绝共用受控 pending，仍由后端允许的决定、完整影响范围、工件版本与回执决定结果。
已不在当前运行中的审批只读提示不作为新的 live 状态播报。

工具、Hook 和子 Agent 只有属于当前流式消息、且自身仍运行时才展示 busy 与持续图标。
历史快照保留记录的状态及输入/输出，避免把未收到终态的旧记录表现为仍在运行。
子 Agent 的 busy 同时受父级活动限制；结束后回到静态状态，失败原因与回执保持可展开。
流式正文、token、进度数字和整个转录列不新增动画，用户上滚后继续拥有滚动位置。

任务状态采用同一个纯展示投影，后台枚举、控制 API 和恢复合同不变：

| 任务事实 | 文字 | 任务中心分组 |
| --- | --- | --- |
| 清理等待 `research_task_cleanup_pending` | 正在取消 | 当前任务 |
| 清理失败 `research_task_cleanup_failed` | 资源清理未确认 | 失败任务 |
| 取消已确认且无清理问题 | 已取消 | 已结束任务 |

助手进度、任务详情、项目总览、任务选择器和任务中心使用同一口径。
清理状态变化也算展示变化，不能仅因后台 `status` 枚举相同而漏掉更新。
取消请求已接收不表示资源已释放；清理失败保持可读，不提供虚假的完成或恢复反馈。

## P5 业务操作反馈

发现、导入、阅读工具、RAG/Wiki、文件与编译、Git、发布清单和技能管理复用
`ActionButton/ActionStatus`。`variant="unstyled"` 仅保留原调用点的几何、焦点和按钮样式，
loading 仍由调用者已有的 pending 决定；不增加请求锁、完成计时器或业务状态。
同一个操作的按钮已有持续图标时，邻近状态只显示文字；外层已有 live region 时
内层不重复播报。成功回执继续可查，复制等已有短反馈沿用原完成身份和计时器。

题录收录、后台处理、索引发布和助手移交分别反馈；移交或提交不表示全链完成。
处理作业按真实 job ID 显示一次提交状态，不让所有可用操作同时旋转。
Zotero 暂停与当前题录收录/取消保留独立锁，取消请求等待最终回执；编译和逐段翻译
同样等待真实终态或当前段返回。Wiki 的来源、BasisDigest、修订和发布身份、
工件的 sourceHash 和 expectedRevision 不作为动画计时或虚构成功的依据。

除上文明确的可视行移除外，PDF 正文、图谱、CodeMirror、Git diff 和 xterm 不扩大动效范围；
选择、滚动定位、草稿、来源检视和后端授权继续由原模块控制。

## 静态约束

禁止 `transition-all` 和任意写死的 Tailwind `duration-[…]`。优先声明 opacity、transform、color、background-color、border-color 等具体属性。高频输入路径不动画 filter、blur、shadow、width、height 或整个虚拟列表的 layout。原生披露保留语义且不做尺寸动画。

共享状态组件只处理文字、图标、可访问属性和短反馈，不持有业务服务、权限判断、请求身份或编辑草稿。失败原因和授权内容常驻可达；技术版本、请求 ID 与完整原值进入明确的诊断或来源入口。
