# Progress Log

## Session: 2026-11-27

### Current Status
- **Phase:** 2 - Automatic Workflow & Reduced Controls
- **Scope:** 三阶段界面优化，每阶段本地 Git 提交
- **Started:** 2026-11-27

### Actions Taken
- 读取需求、项目规则、B 端/桌面 Skill、TypeScript、React 与 UI/UX 验证指导。
- 轻量 memory 查询无命中，后续以当前仓库为准。
- 初始化根目录文件计划；检查起始 Git 状态。
- CodeGraph 查询文献 store、处理面板、虚拟列表及受影响调用关系。
- 校验文件计划格式通过；按任务分离只读管线调查、真实窗口基线与 Floating UI 原语实现。
- 明确阶段一保留 wheel/thumb/键盘接管与跨项目请求守卫，外部阅读深链保持完整阅读模式。
- 恢复依赖和当前 diff；新浮层、固定网格 / 64px 行高 / gutter / 绝对定位行尾动作已在工作区，尚未执行修改后的 build 与测试。
- 确认按阶段显式暂存；用户提供的界面优化.md 保持未跟踪。
- 文献宿主加入列表浏览 / 全文阅读模式；详情与后台处理进入 340px 独立 Inspector，窄画布通过 Portal 覆盖。
- 修正 Inspector 使用不存在的 document.relativePath；托管 PDF 使用文献 / parse 身份打开既有 Reader 预览。
- 浮层层级区分 modal 语义与键盘所有权，非模态 Inspector 保留列表焦点和行间切换。
- 首轮运行发现浮层快速重开定位失效、窄窗 Inspector 初挂载未读到父级 ref，以及处理详情插入造成 Inspector 内 CLS；分别修定位重算、提交后测量、固定详情槽位。
- 更新旧列表测试的全选入口和归档状态断言以匹配 Portal 披露；原滚动、查询和跨项目保留断言继续执行。

### Test Results
修改前基线：`ROC_WORKSPACE_CAPTURE=/tmp/roc-ui-baseline node --test --test-concurrency=1 tests/renderer/literature-list-layout.test.mjs`，11/11 通过；200 篇 / 13 DOM 行。后续验证必须重新构建。

| Test | Expected | Actual | Status |
|------|----------|--------|--------|

### Errors
| Error | Resolution |
|-------|------------|
| 初次计划 patch 使用错误标题 | 改为匹配 progress.md 的三级标题 |
| 恢复时猜测不存在的 CSS / 测试名 | 使用真实目录与精确选择器定位 |
| 规划 patch 表头不匹配 | 重新以已读取的段落为锚点应用 |

### Floating surface verification
- 新增 AnchoredPopover：固定定位、Portal、flip/shift/size、关闭立即 inert、焦点等待定位完成后移交。
- overlay-stack 区分键盘所有权与 modal；useOverlayBehavior 增加独立 modal 标记，Radix 保留 modal:true，Esc 增加 composition 守卫。
- `node --test tests/unit/renderer-overlay-stack.test.mjs`：7/7 通过；新增测试先复现非模态背景误判，再验证修复。
- `node --test --test-concurrency=1 tests/renderer/anchored-popover.test.mjs`：11/11 通过；16 组明暗 / 700px 与 380px / 四角菜单阴影均 cut=0、hidden=0。
- 该轮 `pnpm typecheck` 仅发现并已通知 parent 修正 LibraryInspector.tsx 的两处 relativePath 字段；浮层、栈与 hook 无类型错误。继续检查既有 Radix 键盘兼容与截图，不触发全仓构建。
| Inspector typecheck 报 ResearchDocument 无 relativePath | 使用现有 openLiterature 阅读请求与 parseId，不构造工作区路径 |

### Phase 1 final verification
- 工作目录均为 `/Users/Apple_501/Desktop/Roc/Roc`。`pnpm build` 已通过（包含 typecheck 与 renderer chunk gate）；`pnpm audit:design`、`pnpm audit:motion`、`git diff --check` 通过。
- 受影响 renderer 回归首轮 63/64 通过。唯一失败是复制拒绝提示挡住重试按钮；已将提示移至动作区左侧并取消提示的指针事件，正在重新构建并执行真实点击回归。
- `node --test tests/unit/renderer-overlay-stack.test.mjs`：7/7；`node --test --test-concurrency=1 tests/renderer/anchored-popover.test.mjs`：12/12；Radix 设置浮层相关回归 4/4。
- `ROC_LITERATURE_CAPTURE=/tmp/roc-ui-zero-reflow-20261127 node --test --test-concurrency=1 tests/renderer/literature-zero-reflow.test.mjs`：7/7，无页面错误。默认、悬停、展开、最终状态的 clip-audit 全部 `cut=0`。
- 1000 篇文献仅挂载 15 行。4x CPU、连续选择 20 篇，原始 layout-shift 总和为 0；RAF 间隔 p95 10.1ms，输入至第 2 个 RAF p95 25.4ms，最长 task 17.244ms。RAF 测量不等于物理帧率，不能宣称严格 120fps 或所有任务低于 16ms。
- 最新 trace：`/tmp/roc-ui-zero-reflow-20261127/zero-reflow-4x-1795753742947.trace.json`；明暗与窄窗截图保存在同目录。
- 最终 `pnpm build > /tmp/roc-ui-phase1-final-build.log 2>&1` 通过；`node --test --test-concurrency=1 --test-name-pattern='library citation copy' tests/renderer/literature-action-guards.test.mjs` 已通过真实失败后重试。提示保持可访问且不遮挡复制动作。
- 阶段一变更已完成审阅，准备显式暂存和独立提交；下一阶段继续真实状态、自动导入和项目解除关联 / 撤销。
