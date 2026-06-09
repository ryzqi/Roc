# 推理块渲染重设计方案

**日期:** 2026-06-09  
**状态:** 待审核  
**方案:** 极简卡片式设计

## 一、背景与目标

### 当前问题
- 推理块采用时间轴样式,视觉复杂度较高
- 复制按钮位于推理块标题栏,容易误操作
- 步骤结构(圆点、标签、行号)增加视觉噪音
- 用户希望推理内容更简洁,与正式回答有明确区分

### 设计目标
1. 采用独立卡片式设计,视觉上明确区分推理与正式回答
2. 使用微妙的背景色差异(3-5% 透明度)
3. 推理内容采用流式文本展示,移除步骤结构
4. 流式输出时展开,完成后自动折叠
5. 复制按钮移至回答底部,只复制正式回答内容
6. 推理块不提供独立的复制功能

## 二、设计方案

### 2.1 组件结构

```
AssistantMessage
├── ReasoningBlock (可选)
│   ├── Header (标签栏)
│   └── Content (流式文本)
├── MarkdownView (正式回答)
└── CopyAnswerButton (底部复制按钮)
```

### 2.2 视觉规格

#### 推理块容器
```css
.chat-bubble-reasoning {
  /* 背景 - 比正文浅 3-5% */
  background: rgba(255, 255, 255, 0.5);  /* 亮色模式 */
  background: rgba(255, 255, 255, 0.03); /* 暗色模式 */
  
  /* 边框 - 比正文边框更细 */
  border: 1px solid rgba(120, 144, 184, 0.18);
  border-radius: 10px;
  
  /* 阴影 - 极轻微 */
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  
  /* 间距 */
  margin: 12px 0;
  overflow: hidden;
}
```

#### 标签栏
```css
.reasoning-header {
  height: 36px;
  padding: 10px 16px;
  background: rgba(0, 0, 0, 0.015);
  border-bottom: 1px solid rgba(120, 144, 184, 0.12);
  
  font-size: 12px;
  font-weight: 500;
  color: var(--subtle);
  letter-spacing: 0.03em;
}
```


**状态显示:**
- 思考中: "推理 · 思考中"
- 已完成: "推理 · 已完成"

#### 内容区
```css
.reasoning-content {
  padding: 16px 20px;
  
  font-size: 14.5px;
  line-height: 1.72;
  color: var(--text);
}

.reasoning-content p {
  margin: 0 0 12px 0;
}

.reasoning-content p:last-child {
  margin-bottom: 0;
}
```

#### 折叠状态
```css
.reasoning-collapsed {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  
  border: 1px solid rgba(120, 144, 184, 0.22);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.8);
  
  font-size: 12px;
  font-weight: 500;
  color: var(--subtle);
  cursor: pointer;
}

.reasoning-collapsed-arrow {
  display: inline-block;
  transform: rotate(0deg);
  transition: transform 0.2s;
}

.reasoning-collapsed[data-open="true"] .reasoning-collapsed-arrow {
  transform: rotate(90deg);
}
```

#### 复制按钮
```css
.chat-answer-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
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
  
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.15s;
}

.copy-answer-button:hover {
  background: rgba(120, 144, 184, 0.08);
  color: var(--text);
}
```

### 2.3 交互行为

#### 流式输出阶段
1. 推理块自动处于展开状态
2. 标签栏显示 "推理 · 思考中"
3. 内容区逐段落流式显示
4. 可选:显示打字光标效果

#### 完成后行为
1. 标签栏更新为 "推理 · 已完成"
2. 延迟 1000ms 后自动折叠
3. 折叠动画:
   - 高度: auto → 0, 持续 200ms
   - 内容透明度: 1 → 0, 持续 150ms
   - Easing: `cubic-bezier(0.16, 1, 0.3, 1)`
4. 折叠后显示为小标签按钮

#### 展开/折叠交互
1. 点击折叠标签 → 展开推理块
2. 展开动画:
   - 高度: 0 → auto, 持续 200ms
   - 内容透明度: 0 → 1, 持续 150ms
3. 点击标签栏 → 折叠推理块
4. 箭头图标旋转: 0° ↔ 90°

#### 复制功能
1. 点击 "复制回答" 按钮
2. 复制内容: 只包含正式回答,不包含推理块
3. 视觉反馈:
   - 按钮文字: "复制回答" → "已复制"
   - 图标: 复制图标 → 勾选图标
   - 持续 1500ms 后恢复

### 2.4 响应式设计

#### 移动端适配
- 推理块内边距减小: `12px 16px`
- 字体大小保持不变
- 折叠标签自动收缩
- 复制按钮全宽显示

#### 暗色模式
- 推理块背景: `rgba(255, 255, 255, 0.03)`
- 标签栏背景: `rgba(255, 255, 255, 0.02)`
- 边框透明度略微增加
- 阴影加深: `0 2px 8px rgba(0, 0, 0, 0.2)`

## 三、技术实现

### 3.1 文件改动清单

#### 需要修改的文件
1. `src/renderer/chat/reasoning/ReasoningBlock.tsx` - 移除复制按钮,简化渲染
2. `src/renderer/chat/reasoning/ReasoningTimeline.tsx` - 改为流式文本渲染
3. `src/renderer/chat/chat-message-row.tsx` - 添加底部复制按钮和自动折叠逻辑
4. `src/renderer/styles/reasoning.css` - 重写样式
5. `src/renderer/chat/activity-block/use-activity-block-state.ts` - 添加自动折叠逻辑

#### 需要创建的文件
1. `src/renderer/chat/CopyAnswerButton.tsx` - 新的复制按钮组件

### 3.2 核心实现逻辑

#### 自动折叠逻辑
```typescript
// 在 use-activity-block-state.ts 中添加
useEffect(() => {
  if (!isStreaming && wasStreaming && defaultOpen) {
    const timer = setTimeout(() => {
      setOpen(false);
    }, 1000); // 1秒延迟
    
    return () => clearTimeout(timer);
  }
}, [isStreaming]);
```

#### 流式文本渲染
```typescript
// ReasoningTimeline.tsx 简化为
export function ReasoningTimeline({ content }: { content: string }) {
  const paragraphs = content.split('\n\n').filter(p => p.trim());
  
  return (
    <div className="reasoning-content">
      {paragraphs.map((para, index) => (
        <p key={index}>{para}</p>
      ))}
    </div>
  );
}
```

#### 复制按钮实现
```typescript
// CopyAnswerButton.tsx
export function CopyAnswerButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  
  return (
    <button className="copy-answer-button" onClick={handleCopy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? '已复制' : '复制回答'}
    </button>
  );
}
```

### 3.3 数据流处理

#### 提取正式回答内容
```typescript
// 在 chat-message-row.tsx 中
function extractAnswerContent(message: ChatTranscriptMessage): string {
  // 只返回 message.content,不包含 reasoning
  return message.content;
}
```

## 四、实现优先级

### P0 - 核心功能
- [ ] 移除推理块的复制按钮
- [ ] 简化推理内容为流式文本渲染
- [ ] 更新推理块样式(背景色、边框、圆角)
- [ ] 在回答底部添加复制按钮
- [ ] 实现自动折叠逻辑

### P1 - 交互优化
- [ ] 添加折叠/展开动画
- [ ] 优化折叠标签样式
- [ ] 复制按钮的视觉反馈
- [ ] 暗色模式适配

### P2 - 细节打磨
- [ ] 移动端响应式优化
- [ ] 无障碍支持(ARIA 标签)
- [ ] 性能优化(动画性能)

## 五、设计权衡

### 优势
1. **视觉简洁** - 流式文本比时间轴更干净,减少视觉噪音
2. **自动管理** - 自动折叠保持界面整洁,用户无需手动操作
3. **明确区分** - 独立卡片式设计清晰区分推理与正式回答
4. **复制便捷** - 底部统一的复制按钮更符合用户预期
5. **实现简单** - 移除复杂的时间轴逻辑,代码更易维护

### 劣势与缓解
1. **信息密度** - 长推理内容可能难以快速浏览
   - 缓解:保持段落间距,提供展开功能
   
2. **自动折叠可能过快** - 用户可能还没看完就折叠了
   - 缓解:设置 1 秒延迟,足够用户注意到完成状态
   
3. **无法复制推理内容** - 某些场景下用户可能需要
   - 缓解:用户可以展开后手动选择文本复制

### 未来可能的增强
- 推理块内容搜索/高亮功能
- 推理块折叠时显示简短摘要
- 推理内容的导出功能(独立于复制)
- 推理步骤的可选视图切换(流式 vs 结构化)

## 六、验收标准

### 功能验收
- [ ] 推理块在流式输出时自动展开
- [ ] 推理块完成后 1 秒自动折叠
- [ ] 折叠后显示为可点击的小标签
- [ ] 点击折叠标签可重新展开
- [ ] 推理内容以流式文本展示,无时间轴元素
- [ ] 推理块无复制按钮
- [ ] 回答底部有复制按钮
- [ ] 复制按钮只复制正式回答内容
- [ ] 复制后显示"已复制"反馈

### 视觉验收
- [ ] 推理块背景比正文浅 3-5%
- [ ] 推理块有细边框和轻微阴影
- [ ] 推理块圆角为 10px
- [ ] 标签栏字体大小为 12px
- [ ] 内容区字体与正文一致(14.5px)
- [ ] 段落间距为 12px
- [ ] 折叠标签按钮样式正确
- [ ] 复制按钮在底部右对齐
- [ ] 暗色模式样式正确

### 交互验收
- [ ] 折叠/展开动画流畅(200ms)
- [ ] 箭头图标旋转正常
- [ ] 复制按钮 hover 效果正常
- [ ] 复制反馈持续 1.5 秒
- [ ] 移动端布局正常
- [ ] 键盘导航可用

## 七、参考资料

### 设计参考
- Claude.ai 的思考块设计
- ChatGPT 的推理展示方式
- Linear 的折叠面板设计
- Vercel 的卡片组件设计

### 技术参考
- React details/summary 最佳实践
- CSS 动画性能优化
- Clipboard API 使用指南

## 八、变更历史

| 日期 | 版本 | 变更内容 | 作者 |
|------|------|----------|------|
| 2026-06-09 | 1.0 | 初始设计方案 | AI Assistant |

---

**审批状态:** 待用户审核  
**下一步:** 用户审核通过后,创建实现计划
