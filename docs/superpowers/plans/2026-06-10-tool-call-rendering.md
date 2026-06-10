# 工具调用渲染重新设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将工具调用渲染从左边框风格重构为现代扁平设计，包含圆形状态图标、状态徽章和完整的深色模式支持。

**Architecture:** 保持 ActivityBlockShell 容器不变，完全重写 ToolCallBlock 组件的视觉层，新增完整的 CSS 样式系统支持浅色/深色主题。

**Tech Stack:** React 19, TypeScript, lucide-react, CSS variables

---

## 文件结构

**修改文件:**
- `src/renderer/chat/tool-call/ToolCallBlock.tsx` - 重写组件结构和状态映射
- `src/renderer/styles/tool-call.css` - 完全重写样式系统

**保持不变:**
- `src/renderer/chat/activity-block/ActivityBlockShell.tsx` - 复用现有容器
- `src/renderer/chat/activity-block/ActivityBlockBody.tsx` - 复用现有内容容器
- `src/renderer/chat/activity-block/use-activity-block-state.ts` - 复用状态管理
- `src/renderer/chat/activity-block/use-copy-content.ts` - 复用复制功能
- `src/renderer/chat/tool-call/ToolDataSection.tsx` - 保持数据展示逻辑

---

### Task 1: 重写 ToolCallBlock 组件 - 状态映射和图标

**Files:**
- Modify: `src/renderer/chat/tool-call/ToolCallBlock.tsx:1-68`

- [ ] **Step 1: 更新导入和状态文案映射**

```tsx
import { CheckCircle2, CirclePlay, LoaderCircle, XCircle } from 'lucide-react';
import type { ChatTranscriptActivityBlock } from '../../chat-transcript';
import { ActivityBlockBody } from '../activity-block/ActivityBlockBody';
import { ActivityBlockShell } from '../activity-block/ActivityBlockShell';
import { useActivityBlockState } from '../activity-block/use-activity-block-state';
import { ToolDataSection } from './ToolDataSection';

type ToolCallBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>;

type ToolCallBlockProps = {
  block: ToolCallBlockModel;
};

const STATUS_LABEL = {
  start: '开始',
  progress: '执行中',
  end: '成功',
  error: '错误'
} satisfies Record<ToolCallBlockModel['status'], string>;
```

- [ ] **Step 2: 创建状态图标组件**

```tsx
function ToolStatusIcon({ status }: { status: ToolCallBlockModel['status'] }): React.JSX.Element {
  if (status === 'start') {
    return <CirclePlay aria-hidden="true" size={12} strokeWidth={2.5} />;
  }
  if (status === 'progress') {
    return <LoaderCircle aria-hidden="true" size={12} strokeWidth={2.5} />;
  }
  if (status === 'end') {
    return <CheckCircle2 aria-hidden="true" size={12} strokeWidth={2.5} />;
  }
  return <XCircle aria-hidden="true" size={12} strokeWidth={2.5} />;
}
```

- [ ] **Step 3: 验证导入和类型**

运行: `pnpm typecheck`
预期: 通过类型检查，无错误

- [ ] **Step 4: 提交状态映射和图标组件**

```bash
git add src/renderer/chat/tool-call/ToolCallBlock.tsx
git commit -m "refactor: 更新工具调用状态映射和图标组件"
```

---

### Task 2: 重写 ToolCallBlock 组件 - 头部结构

**Files:**
- Modify: `src/renderer/chat/tool-call/ToolCallBlock.tsx:34-68`

- [ ] **Step 1: 重写组件主体和头部结构**

```tsx
export function ToolCallBlock({ block }: ToolCallBlockProps): React.JSX.Element {
  const hasInput = block.input !== null && block.input !== undefined;
  const hasOutput = block.output !== null && block.output !== undefined;
  const hasError = block.error !== null && block.error !== undefined;
  const hasData = hasInput || hasOutput || hasError;
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: block.status === 'error'
  });

  return (
    <ActivityBlockShell
      className={`tool-call-modern tool-call-modern--${block.status}`}
      dataTestId="chat-activity-tool"
      open={hasData && open}
      onToggle={setOpen}
      header={
        <summary className="tool-call-modern__header">
          <div className="tool-call-modern__icon">
            <ToolStatusIcon status={block.status} />
          </div>
          <span className="tool-call-modern__name">{block.name}</span>
          <div className="tool-call-modern__badge">{STATUS_LABEL[block.status]}</div>
          {hasData ? (
            <svg className="tool-call-modern__expand" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          ) : null}
        </summary>
      }
    >
      {hasData ? (
        <ActivityBlockBody className="tool-call-modern__body">
          {hasInput ? <ToolDataSection label="输入" data={block.input} /> : null}
          {hasOutput ? <ToolDataSection label="输出" data={block.output} /> : null}
          {hasError ? <ToolDataSection label="错误" data={block.error} variant="error" /> : null}
        </ActivityBlockBody>
      ) : null}
    </ActivityBlockShell>
  );
}
```

- [ ] **Step 2: 验证组件编译**

运行: `pnpm typecheck`
预期: 通过类型检查，无错误

- [ ] **Step 3: 提交组件重构**

```bash
git add src/renderer/chat/tool-call/ToolCallBlock.tsx
git commit -m "refactor: 重写工具调用组件头部和展开逻辑"
```

---

### Task 3: 重写样式系统 - 基础容器和图标

**Files:**
- Modify: `src/renderer/styles/tool-call.css:1-365`

- [ ] **Step 1: 移除旧样式，添加容器基础样式**

```css
/**
 * 工具调用现代样式
 */

.tool-call-modern {
  background: rgba(245, 248, 252, 0.5);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
  border: 1px solid rgba(120, 144, 184, 0.14);
}

.tool-call-modern__header {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.tool-call-modern__header::-webkit-details-marker,
.tool-call-modern__header::marker {
  display: none;
  content: '';
}

.tool-call-modern__icon {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.tool-call-modern__name {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 500;
  font-feature-settings: var(--font-feature-mono);
  color: var(--text);
  flex: 1;
  min-width: 0;
}

.tool-call-modern__badge {
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  flex-shrink: 0;
}

.tool-call-modern__expand {
  margin-left: 4px;
  color: var(--subtle);
  flex-shrink: 0;
}
```

- [ ] **Step 2: 验证基础样式**

运行: `pnpm dev`，在开发模式下打开聊天界面查看工具调用
预期: 容器显示扁平背景，图标和徽章位置正确

- [ ] **Step 3: 提交基础样式**

```bash
git add src/renderer/styles/tool-call.css
git commit -m "style: 添加工具调用现代样式基础容器"
```

---

### Task 4: 样式系统 - 浅色模式状态颜色

**Files:**
- Modify: `src/renderer/styles/tool-call.css` (追加)

- [ ] **Step 1: 添加 start 状态样式**

```css
/* 开始状态 */
.tool-call-modern--start .tool-call-modern__icon {
  background: #e3f2fd;
  color: #2d477a;
}

.tool-call-modern--start .tool-call-modern__badge {
  background: #e3f2fd;
  color: #2d477a;
}
```

- [ ] **Step 2: 添加 progress 状态样式和旋转动画**

```css
/* 进行中状态 */
.tool-call-modern--progress .tool-call-modern__icon {
  background: #fff3e0;
  color: #8a5a17;
}

.tool-call-modern--progress .tool-call-modern__badge {
  background: #fff3e0;
  color: #8a5a17;
}

@keyframes tool-spin {
  to {
    transform: rotate(360deg);
  }
}

.tool-call-modern--progress .tool-call-modern__icon svg {
  animation: tool-spin 1s linear infinite;
}
```

- [ ] **Step 3: 添加 end 状态样式**

```css
/* 完成状态 */
.tool-call-modern--end .tool-call-modern__icon {
  background: #e8f5e9;
  color: #166c4a;
}

.tool-call-modern--end .tool-call-modern__badge {
  background: #e8f5e9;
  color: #166c4a;
}
```

- [ ] **Step 4: 添加 error 状态样式**

```css
/* 错误状态 */
.tool-call-modern--error .tool-call-modern__icon {
  background: #ffebee;
  color: #9c3a3a;
}

.tool-call-modern--error .tool-call-modern__badge {
  background: #ffebee;
  color: #9c3a3a;
}
```

- [ ] **Step 5: 验证状态颜色**

运行: `pnpm dev`，触发不同状态的工具调用
预期: 各状态显示对应颜色，progress 状态图标旋转

- [ ] **Step 6: 提交状态样式**

```bash
git add src/renderer/styles/tool-call.css
git commit -m "style: 添加工具调用浅色模式状态颜色"
```

---

### Task 5: 样式系统 - 深色模式适配

**Files:**
- Modify: `src/renderer/styles/tool-call.css` (追加)

- [ ] **Step 1: 添加深色模式容器样式**

```css
/* 深色模式 */
:root[data-theme='dark'] .tool-call-modern {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(190, 205, 228, 0.12);
}
```

- [ ] **Step 2: 添加深色模式状态颜色**

```css
:root[data-theme='dark'] .tool-call-modern--start .tool-call-modern__icon {
  background: rgba(45, 71, 122, 0.15);
  color: #7a9bd8;
}

:root[data-theme='dark'] .tool-call-modern--start .tool-call-modern__badge {
  background: rgba(45, 71, 122, 0.15);
  color: #7a9bd8;
}

:root[data-theme='dark'] .tool-call-modern--progress .tool-call-modern__icon {
  background: rgba(229, 189, 108, 0.15);
  color: #e5bd6c;
}

:root[data-theme='dark'] .tool-call-modern--progress .tool-call-modern__badge {
  background: rgba(229, 189, 108, 0.15);
  color: #e5bd6c;
}

:root[data-theme='dark'] .tool-call-modern--end .tool-call-modern__icon {
  background: rgba(121, 210, 166, 0.15);
  color: #79d2a6;
}

:root[data-theme='dark'] .tool-call-modern--end .tool-call-modern__badge {
  background: rgba(121, 210, 166, 0.15);
  color: #79d2a6;
}

:root[data-theme='dark'] .tool-call-modern--error .tool-call-modern__icon {
  background: rgba(238, 146, 146, 0.15);
  color: #ee9292;
}

:root[data-theme='dark'] .tool-call-modern--error .tool-call-modern__badge {
  background: rgba(238, 146, 146, 0.15);
  color: #ee9292;
}
```

- [ ] **Step 3: 验证深色模式**

手动切换到深色主题，查看工具调用
预期: 深色模式下颜色适配正确，状态清晰可见

- [ ] **Step 4: 提交深色模式**

```bash
git add src/renderer/styles/tool-call.css
git commit -m "style: 添加工具调用深色模式适配"
```

---

### Task 6: 样式系统 - 详情区和过渡效果

**Files:**
- Modify: `src/renderer/styles/tool-call.css` (追加)

- [ ] **Step 1: 添加详情区样式**

```css
.tool-call-modern__body {
  border-top: 1px solid rgba(120, 144, 184, 0.14);
  padding: 12px;
  background: rgba(255, 255, 255, 0.5);
}

:root[data-theme='dark'] .tool-call-modern__body {
  border-top-color: rgba(190, 205, 228, 0.12);
  background: rgba(0, 0, 0, 0.2);
}
```

- [ ] **Step 2: 添加展开过渡效果**

```css
.tool-call-modern[open] .tool-call-modern__body {
  animation: tool-expand 200ms var(--easing-standard);
}

@keyframes tool-expand {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

- [ ] **Step 3: 验证详情区和动画**

运行: `pnpm dev`，点击展开工具调用详情
预期: 详情区平滑展开，背景和边框正确显示

- [ ] **Step 4: 提交详情区样式**

```bash
git add src/renderer/styles/tool-call.css
git commit -m "style: 添加工具调用详情区和展开动画"
```

---

### Task 7: 端到端验证

**Files:**
- Test: 手动测试所有场景

- [ ] **Step 1: 验证所有状态显示**

手动触发工具调用，验证：
- start 状态：蓝色圆形图标 + "开始" 徽章
- progress 状态：橙色旋转图标 + "执行中" 徽章
- end 状态：绿色勾选图标 + "成功" 徽章
- error 状态：红色叉号图标 + "错误" 徽章，默认展开

预期: 所有状态视觉正确，图标和徽章颜色匹配

- [ ] **Step 2: 验证展开/收起交互**

点击不同状态的工具调用头部：
- 有详情时：平滑展开/收起
- 无详情时：不显示箭头，点击无效果
- error 状态：默认展开

预期: 交互符合预期，动画流畅

- [ ] **Step 3: 验证深色模式**

切换到深色主题，检查所有状态
预期: 深色模式下颜色适配良好，对比度足够

- [ ] **Step 4: 验证复制功能**

展开工具调用详情，点击复制按钮
预期: 复制功能正常工作（依赖现有 ToolDataSection）

- [ ] **Step 5: 最终提交**

```bash
git add -A
git commit -m "feat: 完成工具调用渲染现代化重构"
```

---

## 自检清单

**规格覆盖:**
- ✓ 圆形状态图标 (Task 1, 3)
- ✓ 状态徽章 (Task 2, 4)
- ✓ 浅色模式状态颜色 (Task 4)
- ✓ 深色模式适配 (Task 5)
- ✓ 旋转动画 (Task 4)
- ✓ 展开动画 (Task 6)
- ✓ 详情区样式 (Task 6)
- ✓ 无详情时隐藏箭头 (Task 2)
- ✓ error 默认展开 (Task 2)

**类型一致性:**
- ✓ STATUS_LABEL 映射类型正确
- ✓ ToolStatusIcon 接收 status 参数类型正确
- ✓ CSS 类名与 HTML 一致

**占位符检查:**
- ✓ 无 TBD 或 TODO
- ✓ 所有代码块完整
- ✓ 所有步骤包含具体命令和预期输出
