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
| list-small | 仅稳定、可见且小规模的项目重排提供位置连续性 | 搜索结果立即更新；大集合、虚拟行和正文高度变化不做整列 FLIP |
| drag | 指针位置直接映射宽度，RAF 合并重复输入 | 不加 tween；释放或键盘结束才持久化；Escape 还原起点且不写中间值 |
| disclosure | 原生 `details` 保持双向展开与读屏语义 | 允许 `::details-content` 的尺寸过渡；阅读恢复时取消过渡以保持滚动锚点 |

P2 的 `motionTransitions` 提供上述七个事件入口，原有面板导出引用同一对象；遮罩保持原有独立预设。
CSS 的 micro/fast/base/overlay 与 Motion 秒值由合同检查对应，原有 fast/base/slow 数值保留，
slow 明确指向兼容刻度。普通 utility 使用 `ui-motion-*`，属性仍由调用者明确指定。
P3 的活动栏和画布子导航共用 `SelectionIndicator`，每个实例以 `useId` 隔离
layout identity；只测量指示条，活动栏提供实际滚动容器的 `layoutScroll`。

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

原生 CSS transitions 优先用于受控显示、选中和 anchored popover；需要保留卸载视觉时才引入 presence。已有 `AnimatePresence` 必须让退出子树读取实时 presence，不能依靠卸载前捕获的 `open=true`。View Transition 只作用于附件等局部稳定身份，检查支持与拒绝并在反向、换对象或卸载时跳过旧 transition。

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

根 `MotionConfig reducedMotion="user"` 禁用 transform 与布局动画，仍可能保留 opacity。全局 CSS 同时抑制 transition、循环动画和 `::details-content`。用文字、状态属性和焦点保留同等信息；不要让“没有位移”成为菜单或抽屉仍可交互的关闭状态。

原生 `scroll`、文本输入、拖动和布局恢复直接落到最终态。组件依赖系统偏好只用于必须立即改变视觉生命周期的场景，不新建独立偏好存储。

## 静态约束

禁止 `transition-all` 和任意写死的 Tailwind `duration-[…]`。优先声明 opacity、transform、color、background-color、border-color 等具体属性。高频输入路径不动画 filter、blur、shadow、width、height 或整个虚拟列表的 layout。原生披露尺寸过渡是明确例外。

共享状态组件只处理文字、图标、可访问属性和短反馈，不持有业务服务、权限判断、请求身份或编辑草稿。失败原因和授权内容常驻可达；技术版本、请求 ID 与完整原值进入明确的诊断或来源入口。
