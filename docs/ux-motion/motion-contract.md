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

P0 源码已确认：现有 CSS 与 Motion 分别保存数值，`tabIndicatorTransition` 尚无实际调用点；P2 将语义名称接入同一刻度，并修正文档中的预设调用假设。P0 不改变现有外观。

## 中断

第二次操作直接更新最新目标，不等待动画完成，不排队。关闭立即隔离退出内容的指针、键盘和可访问树；返回焦点不等待淡出。重新打开撤销旧退出，旧完成回调不得关闭新对象。

原生 CSS transitions 优先用于受控显示、选中和 anchored popover；需要保留卸载视觉时才引入 presence。已有 `AnimatePresence` 必须让退出子树读取实时 presence，不能依靠卸载前捕获的 `open=true`。View Transition 只作用于附件等局部稳定身份，检查支持与拒绝并在反向、换对象或卸载时跳过旧 transition。

## 减少动态效果

根 `MotionConfig reducedMotion="user"` 禁用 transform 与布局动画，仍可能保留 opacity。全局 CSS 同时抑制 transition、循环动画和 `::details-content`。用文字、状态属性和焦点保留同等信息；不要让“没有位移”成为菜单或抽屉仍可交互的关闭状态。

原生 `scroll`、文本输入、拖动和布局恢复直接落到最终态。组件依赖系统偏好只用于必须立即改变视觉生命周期的场景，不新建独立偏好存储。

## 静态约束

禁止 `transition-all` 和任意写死的 Tailwind `duration-[…]`。优先声明 opacity、transform、color、background-color、border-color 等具体属性。高频输入路径不动画 filter、blur、shadow、width、height 或整个虚拟列表的 layout。原生披露尺寸过渡是明确例外。

共享状态组件只处理文字、图标、可访问属性和短反馈，不持有业务服务、权限判断、请求身份或编辑草稿。失败原因和授权内容常驻可达；技术版本、请求 ID 与完整原值进入明确的诊断或来源入口。
