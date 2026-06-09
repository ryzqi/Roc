# 推理块渲染重设计实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重新设计推理块渲染,采用极简卡片式设计,移除时间轴样式,将复制按钮移至回答底部,实现自动折叠功能

**Architecture:** 简化 ReasoningBlock 组件为流式文本展示,移除 ReasoningTimeline 的步骤解析逻辑,在 chat-message-row 中添加底部复制按钮和自动折叠行为,重写 reasoning.css 样式

**Tech Stack:** React, TypeScript, CSS, motion/react (动画)

---

## 文件结构概览

### 需要修改的文件
- `src/renderer/chat/reasoning/ReasoningBlock.tsx` - 移除复制按钮,简化为流式文本渲染
- `src/renderer/chat/reasoning/ReasoningTimeline.tsx` - 改为简单的段落渲染
- `src/renderer/chat/reasoning/reasoning-parser.ts` - 不再需要步骤解析(保留但不使用)
- `src/renderer/chat/chat-message-row.tsx` - 添加底部复制按钮
- `src/renderer/chat/activity-block/use-activity-block-state.ts` - 添加自动折叠逻辑
- `src/renderer/styles/reasoning.css` - 完全重写样式

### 需要创建的文件
- `src/renderer/chat/CopyAnswerButton.tsx` - 新的复制按钮组件

---

## Task 1: 创建复制回答按钮组件

**Files:**
- Create: `src/renderer/chat/CopyAnswerButton.tsx`
- Test: 手动测试(UI 组件)

- [ ] **Step 1: 创建 CopyAnswerButton 组件文件**

```typescript
import { Check, Copy } from 'lucide-react';
import { useState, useCallback } from 'react';

type CopyAnswerButtonProps = {
  content: string;
};

export function CopyAnswerButton({ content }: CopyAnswerButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('复制失败:', error);
    }
  }, [content]);

  return (
    <div className="chat-answer-actions">
      <button
        className="copy-answer-button"
        onClick={handleCopy}
        aria-label={copied ? '已复制回答' : '复制回答'}
        type="button"
      >
        {copied ? (
          <>
            <Check aria-hidden="true" size={14} />
            已复制
          </>
        ) : (
          <>
            <Copy aria-hidden="true" size={14} />
            复制回答
          </>
        )}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 验证组件编译**

运行: `npm run dev` 或 `pnpm dev`
预期: 无编译错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/chat/CopyAnswerButton.tsx
git commit -m "feat: 添加复制回答按钮组件"
```

---

## Task 2: 简化推理内容渲染为流式文本

**Files:**
- Modify: `src/renderer/chat/reasoning/ReasoningTimeline.tsx`

- [ ] **Step 1: 重写 ReasoningTimeline 组件为流式文本渲染**

完全替换文件内容:

```typescript
type ReasoningTimelineProps = {
  content: string;
};

export function ReasoningTimeline({ content }: ReasoningTimelineProps): React.JSX.Element {
  const paragraphs = content
    .split('\n\n')
    .map(p => p.trim())
    .filter(p => p.length > 0);

  return (
    <div className="reasoning-content">
      {paragraphs.map((para, index) => (
        <p key={index}>{para}</p>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 验证编译**

运行: `npm run dev` 或 `pnpm dev`
预期: 无编译错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/chat/reasoning/ReasoningTimeline.tsx
git commit -m "refactor: 简化推理内容为流式文本渲染"
```

---

## Task 3: 移除推理块复制按钮并更新为流式内容

**Files:**
- Modify: `src/renderer/chat/reasoning/ReasoningBlock.tsx`

- [ ] **Step 1: 更新 ReasoningBlock 组件**

修改文件,移除复制按钮和 steps 逻辑:

```typescript
import { useMemo } from 'react';
import { ActivityBlockBody } from '../activity-block/ActivityBlockBody';
import { ActivityBlockHeader } from '../activity-block/ActivityBlockHeader';
import { ActivityBlockShell } from '../activity-block/ActivityBlockShell';
import { useActivityBlockState } from '../activity-block/use-activity-block-state';
import { ReasoningTimeline } from './ReasoningTimeline';

type ReasoningBlockProps = {
  id: string;
  content: string;
  isStreaming: boolean;
};

export function ReasoningBlock({ content, isStreaming }: ReasoningBlockProps): React.JSX.Element {
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: isStreaming,
    forceOpenWhileStreaming: true,
    isStreaming
  });

  return (
    <ActivityBlockShell
      className="chat-bubble-reasoning"
      dataTestId="chat-activity-reasoning"
      open={open}
      onToggle={setOpen}
      header={
        <ActivityBlockHeader
          className="reasoning-header"
          status={isStreaming ? '思考中' : '已完成'}
          statusClassName="reasoning-status"
          title="推理"
          titleClassName="reasoning-label"
        />
      }
    >
      <ActivityBlockBody className="reasoning-body">
        <ReasoningTimeline content={content} />
      </ActivityBlockBody>
    </ActivityBlockShell>
  );
}
```

- [ ] **Step 2: 验证编译**

运行: `npm run dev` 或 `pnpm dev`
预期: 无编译错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/chat/reasoning/ReasoningBlock.tsx
git commit -m "refactor: 移除推理块复制按钮,简化为流式内容"
```

---

## Task 4: 添加自动折叠逻辑

**Files:**
- Modify: `src/renderer/chat/activity-block/use-activity-block-state.ts`

- [ ] **Step 1: 读取现有代码**

运行: 读取 `src/renderer/chat/activity-block/use-activity-block-state.ts` 查看当前实现

- [ ] **Step 2: 添加自动折叠逻辑**

在 `useActivityBlockState` hook 中添加 useEffect:

```typescript
import { useEffect, useRef, useState } from 'react';

type UseActivityBlockStateParams = {
  defaultOpen: boolean;
  forceOpenWhileStreaming: boolean;
  isStreaming: boolean;
};

export function useActivityBlockState({
  defaultOpen,
  forceOpenWhileStreaming,
  isStreaming
}: UseActivityBlockStateParams): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpen] = useState(defaultOpen);
  const wasStreamingRef = useRef(isStreaming);

  useEffect(() => {
    if (forceOpenWhileStreaming && isStreaming) {
      setOpen(true);
    }
  }, [forceOpenWhileStreaming, isStreaming]);

  // 自动折叠逻辑
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;

    if (wasStreaming && !isStreaming && open) {
      const timer = setTimeout(() => {
        setOpen(false);
      }, 1000);

      return () => clearTimeout(timer);
    }
  }, [isStreaming, open]);

  return { open, setOpen };
}
```

- [ ] **Step 3: 验证编译**

运行: `npm run dev` 或 `pnpm dev`
预期: 无编译错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/chat/activity-block/use-activity-block-state.ts
git commit -m "feat: 添加推理块完成后自动折叠逻辑"
```

---

## Task 5: 在聊天消息中添加底部复制按钮

**Files:**
- Modify: `src/renderer/chat/chat-message-row.tsx`

- [ ] **Step 1: 导入 CopyAnswerButton 组件**

在文件顶部添加导入:

```typescript
import { CopyAnswerButton } from './CopyAnswerButton';
```

- [ ] **Step 2: 在助手消息的内容区域末尾添加复制按钮**

找到助手内容渲染部分 (`isAssistant` 分支),在 `</div>` 结束标签之前添加:

```typescript
// 在 chat-assistant-content div 内,打字光标之后
{message.isStreaming ? (
  <span className="chat-typing-cursor" aria-hidden="true" />
) : null}
{!message.isStreaming && message.content.length > 0 ? (
  <CopyAnswerButton content={message.content} />
) : null}
```

完整的助手内容部分应该类似:

```typescript
{isAssistant ? (
  <div className="chat-assistant-content" data-testid="chat-assistant-content">
    {activityBlocks.map((block) => (
      <ChatActivityBlockView key={block.id} block={block} />
    ))}
    {message.content.length === 0 ? null : <MarkdownView text={message.content} />}
    {approval !== null && isTaskApproval(approval) ? (
      <TaskApprovalCard approval={approval} onApprovalDecision={onApprovalDecision} />
    ) : approval === null ? null : (
      <motion.div ...>
        {/* 现有的 approval 渲染 */}
      </motion.div>
    )}
    {message.isStreaming ? (
      <span className="chat-typing-cursor" aria-hidden="true" />
    ) : null}
    {!message.isStreaming && message.content.length > 0 ? (
      <CopyAnswerButton content={message.content} />
    ) : null}
  </div>
) : (
  <p>{message.content}</p>
)}
```

- [ ] **Step 3: 验证编译**

运行: `npm run dev` 或 `pnpm dev`
预期: 无编译错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/chat/chat-message-row.tsx
git commit -m "feat: 在助手回答底部添加复制按钮"
```

---

## Task 6: 重写推理块样式

**Files:**
- Modify: `src/renderer/styles/reasoning.css`

- [ ] **Step 1: 完全重写 reasoning.css**

替换整个文件内容为新的极简卡片式样式:

```css
/**
 * 推理块样式 - 极简卡片式
 */

/* 推理块容器 */
.chat-bubble-reasoning {
  margin: 12px 0;
  border: 1px solid rgba(120, 144, 184, 0.18);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.5);
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

/* 标签栏 */
.reasoning-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 10px 16px;
  background: rgba(0, 0, 0, 0.015);
  border-bottom: 1px solid rgba(120, 144, 184, 0.12);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.reasoning-header:hover {
  background: rgba(0, 0, 0, 0.025);
}

.reasoning-label {
  font-weight: 500;
  color: var(--subtle);
  font-size: 12px;
  letter-spacing: 0.03em;
}

.reasoning-status {
  font-weight: 500;
  color: var(--subtle);
  font-size: 12px;
}

/* 内容区 */
.reasoning-body {
  padding: 0;
}

.reasoning-content {
  padding: 16px 20px;
  color: var(--text);
  font-size: 14.5px;
  line-height: 1.72;
}

.reasoning-content p {
  margin: 0 0 12px 0;
}

.reasoning-content p:last-child {
  margin-bottom: 0;
}

/* 折叠状态 */
.chat-bubble-reasoning:not([open]) .reasoning-header::before {
  content: "›";
  display: inline-block;
  transform: rotate(0deg);
  transition: transform 0.2s;
  margin-right: 4px;
}

.chat-bubble-reasoning[open] .reasoning-header::before {
  content: "›";
  display: inline-block;
  transform: rotate(90deg);
  transition: transform 0.2s;
  margin-right: 4px;
}

/* 复制按钮容器 */
.chat-answer-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px solid rgba(120, 144, 184, 0.12);
}

.copy-answer-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid rgba(120, 144, 184, 0.22);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.copy-answer-button:hover {
  background: rgba(120, 144, 184, 0.08);
  color: var(--text);
  border-color: rgba(120, 144, 184, 0.32);
}

.copy-answer-button:active {
  transform: scale(0.98);
}

/* 暗色模式 */
@media (prefers-color-scheme: dark) {
  .chat-bubble-reasoning {
    background: rgba(255, 255, 255, 0.03);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }

  .reasoning-header {
    background: rgba(255, 255, 255, 0.02);
  }

  .reasoning-header:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .copy-answer-button {
    border-color: rgba(190, 205, 228, 0.2);
  }

  .copy-answer-button:hover {
    background: rgba(190, 205, 228, 0.08);
    border-color: rgba(190, 205, 228, 0.32);
  }
}

/* 响应式 */
@media (max-width: 640px) {
  .reasoning-content {
    padding: 12px 16px;
  }

  .copy-answer-button {
    width: 100%;
    justify-content: center;
  }
}
```

- [ ] **Step 2: 验证样式无语法错误**

运行: `npm run dev` 或 `pnpm dev`
预期: 无 CSS 编译错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/styles/reasoning.css
git commit -m "style: 重写推理块样式为极简卡片式"
```

---

## Task 7: 集成测试和验证

**Files:**
- Test: 所有修改的组件

- [ ] **Step 1: 启动开发服务器**

运行: `npm run dev` 或 `pnpm dev`
预期: 应用正常启动,无错误

- [ ] **Step 2: 测试推理块展示**

测试步骤:
1. 触发一个包含推理内容的助手回答
2. 验证推理块在流式输出时自动展开
3. 验证推理内容以段落形式展示,无时间轴元素
4. 验证标签栏显示"推理 · 思考中"

预期结果:
- 推理块采用卡片式设计
- 背景色比正文略浅
- 内容为流式文本,无步骤标记
- 无复制按钮在推理块中

- [ ] **Step 3: 测试自动折叠**

测试步骤:
1. 等待推理完成
2. 观察标签栏更新为"推理 · 已完成"
3. 等待约 1 秒
4. 验证推理块自动折叠

预期结果:
- 推理块在完成后 1 秒自动折叠
- 折叠动画流畅
- 折叠后显示为小标签

- [ ] **Step 4: 测试展开/折叠交互**

测试步骤:
1. 点击折叠的推理块标签
2. 验证推理块展开
3. 点击标签栏
4. 验证推理块折叠

预期结果:
- 点击交互正常
- 箭头图标旋转(0° ↔ 90°)
- 展开/折叠动画流畅

- [ ] **Step 5: 测试复制按钮**

测试步骤:
1. 等待助手回答完成
2. 验证底部出现"复制回答"按钮
3. 点击复制按钮
4. 验证按钮文字变为"已复制"
5. 粘贴剪贴板内容
6. 验证只包含正式回答,不包含推理内容

预期结果:
- 复制按钮在回答底部右对齐
- 点击后正确复制内容
- 视觉反馈正常(图标和文字变化)
- 1.5 秒后恢复原状

- [ ] **Step 6: 测试暗色模式**

测试步骤:
1. 切换到暗色模式
2. 验证推理块样式正确
3. 验证复制按钮样式正确

预期结果:
- 推理块背景色适配暗色模式
- 边框和阴影正确
- 所有交互正常

- [ ] **Step 7: 测试响应式布局**

测试步骤:
1. 调整浏览器窗口到移动端尺寸
2. 验证推理块布局正常
3. 验证复制按钮全宽显示

预期结果:
- 移动端布局正确
- 内边距适配
- 复制按钮全宽

- [ ] **Step 8: 最终提交**

```bash
git add -A
git commit -m "test: 验证推理块重设计功能完整性"
```

---

## 自审检查清单

### 1. 规格覆盖检查

| 规格需求 | 对应任务 | 状态 |
|---------|---------|------|
| 独立卡片式设计 | Task 6 - CSS 重写 | ✅ |
| 微妙背景色差异(3-5%) | Task 6 - CSS 重写 | ✅ |
| 推理内容流式文本展示 | Task 2, Task 3 | ✅ |
| 移除步骤结构(时间轴) | Task 2, Task 3 | ✅ |
| 流式时展开,完成后自动折叠 | Task 4 | ✅ |
| 复制按钮移至回答底部 | Task 1, Task 5 | ✅ |
| 只复制正式回答内容 | Task 1, Task 5 | ✅ |
| 推理块不提供复制功能 | Task 3 | ✅ |
| 折叠后可重新展开 | Task 4, Task 6 | ✅ |
| 暗色模式适配 | Task 6 | ✅ |
| 移动端响应式 | Task 6 | ✅ |

### 2. 占位符检查

✅ 无 TBD、TODO 或待填充内容  
✅ 所有代码块完整可用  
✅ 所有命令具体明确  
✅ 所有测试步骤详细清晰

### 3. 类型一致性检查

✅ `CopyAnswerButton` 接收 `content: string`  
✅ `ReasoningTimeline` 接收 `content: string`  
✅ `message.content` 传递给 `CopyAnswerButton`  
✅ CSS 类名与组件一致  
✅ 所有导入路径正确

### 4. 任务依赖关系

```
Task 1 (创建复制按钮) → 独立,可先行
Task 2 (简化 Timeline) → 独立
Task 3 (更新 ReasoningBlock) → 依赖 Task 2
Task 4 (自动折叠) → 独立
Task 5 (添加底部按钮) → 依赖 Task 1
Task 6 (重写样式) → 独立,可并行
Task 7 (集成测试) → 依赖所有前置任务
```

建议执行顺序: 1 → 2 → 3 → 4 → 5 → 6 → 7

---

## 执行说明

### 开发环境
- Node.js 版本: 按项目 package.json 要求
- 包管理器: npm 或 pnpm
- 开发服务器: `npm run dev` 或 `pnpm dev`

### 代码规范
- 使用 TypeScript 严格模式
- 遵循项目现有代码风格
- 所有文件使用 UTF-8 编码
- 注释使用简体中文

### Commit 规范
- feat: 新功能
- refactor: 重构
- style: 样式修改
- test: 测试相关

### 注意事项
1. 每个任务完成后立即提交,不要累积多个任务
2. 验证编译无错误后再提交
3. 保持组件的纯函数特性
4. 确保无障碍支持(ARIA 标签)
5. 测试时注意检查控制台是否有错误或警告

---

## 预估工作量

- Task 1: 5 分钟
- Task 2: 5 分钟
- Task 3: 10 分钟
- Task 4: 15 分钟
- Task 5: 10 分钟
- Task 6: 15 分钟
- Task 7: 20 分钟

**总计:** 约 1.5 小时

---

**计划状态:** 就绪  
**创建日期:** 2026-06-09  
**对应设计文档:** docs/superpowers/specs/2026-06-09-reasoning-block-redesign.md
