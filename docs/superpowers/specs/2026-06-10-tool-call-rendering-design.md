# 工具调用渲染重新设计

**日期**: 2026-06-10  
**状态**: 已批准  
**设计方案**: 现代扁平方案

## 概述

重新设计聊天页面的工具调用渲染组件，采用现代扁平设计风格，提升视觉一致性和状态识别度。

## 当前问题

当前工具调用使用左边框 + 文字状态的设计，存在以下问题：

1. 状态识别度不够高，需要阅读文字才能识别状态
2. 视觉层次不够清晰
3. 与整体界面风格的现代化程度不匹配

## 设计目标

1. **状态清晰**：通过视觉元素（颜色、图标）快速识别工具调用状态
2. **视觉一致**：与现有聊天气泡、审批卡片等组件风格统一
3. **渐进展开**：默认收起详情，减少视觉干扰
4. **主题适配**：完整支持浅色和深色主题
5. **简洁高效**：去除不必要的装饰，关注核心信息

## 设计方案

### 视觉风格

采用**现代扁平设计**，核心特征：

- **扁平容器**：浅色背景 + 细边框，圆角 8px
- **圆形状态图标**：20×20px 圆形容器，状态色背景 + 对应图标
- **状态徽章**：小型胶囊状徽章，状态色背景，大写文字
- **Monospace 字体**：工具名称使用等宽字体突出技术属性

### 组件结构

```
ActivityBlockShell (可展开容器)
├─ 头部 (summary)
│  ├─ 圆形图标容器 (20×20px, 状态色背景)
│  │  └─ 状态图标 (12×12px SVG)
│  ├─ 工具名称 (Consolas 字体, 12.5px)
│  ├─ 状态徽章 (圆角 12px, 大写文字)
│  └─ 展开箭头 (14×14px, 仅在有详情时显示)
└─ 内容区 (展开时显示)
   ├─ 输入区块 (可选)
   │  ├─ 标签 + 复制按钮
   │  └─ 代码块 (JSON/文本)
   ├─ 输出区块 (可选)
   │  ├─ 标签 + 复制按钮
   │  └─ 代码块 (JSON/文本)
   └─ 错误区块 (可选)
      ├─ 标签 + 复制按钮
      └─ 代码块 (JSON/文本)
```

### 状态设计

#### 浅色模式

| 状态 | 图标 | 图标背景 | 图标颜色 | 徽章背景 | 徽章文字 | 文案 |
|------|------|----------|----------|----------|----------|------|
| start | CirclePlay | `#e3f2fd` | `#2d477a` | `#e3f2fd` | `#2d477a` | 开始 |
| progress | LoaderCircle (旋转) | `#fff3e0` | `#8a5a17` | `#fff3e0` | `#8a5a17` | 执行中 |
| end | CheckCircle2 | `#e8f5e9` | `#166c4a` | `#e8f5e9` | `#166c4a` | 成功 |
| error | XCircle | `#ffebee` | `#9c3a3a` | `#ffebee` | `#9c3a3a` | 错误 |

#### 深色模式

| 状态 | 图标背景 | 图标颜色 |
|------|----------|----------|
| start | `rgba(45,71,122,0.15)` | `#7a9bd8` |
| progress | `rgba(229,189,108,0.15)` | `#e5bd6c` |
| end | `rgba(121,210,166,0.15)` | `#79d2a6` |
| error | `rgba(238,146,146,0.15)` | `#ee9292` |

### 尺寸规格

- **容器**：圆角 8px，内边距 10px 12px，外边距 8px 0
- **容器背景**：`rgba(245, 248, 252, 0.5)` (浅色) / `rgba(255, 255, 255, 0.05)` (深色)
- **容器边框**：`1px solid rgba(120, 144, 184, 0.14)` (浅色) / `rgba(190, 205, 228, 0.12)` (深色)
- **圆形图标容器**：20×20px，圆角 50%，flex-shrink: 0
- **图标**：12×12px，stroke-width 2.5
- **工具名称**：字号 12.5px，字重 500，Consolas 字体，flex: 1
- **状态徽章**：圆角 12px，内边距 2px 8px，字号 10px，字重 600，大写，letter-spacing 0.05em
- **展开箭头**：14×14px，stroke-width 2，margin-left 4px
- **详情区**：上边框 1px，内边距 12px，背景 `rgba(255, 255, 255, 0.5)` (浅色)
- **标签**：字号 11px，字重 600，大写，letter-spacing 0.05em，颜色 `#7a8390`
- **复制按钮**：14×14px 图标，4px 内边距
- **代码块**：圆角 6px，内边距 8px 10px，字号 11.5px，行高 1.55，背景 `#f7f8fa` (浅色)

### 交互行为

1. **默认状态**：收起（除了 error 状态默认展开）
2. **点击头部**：切换展开/收起
3. **展开动画**：使用 CSS transition，过渡 200ms
4. **旋转动画**：progress 状态的加载图标持续旋转，1s 线性循环
5. **复制按钮**：悬停显示高亮，点击后复制内容
6. **无详情时**：不显示展开箭头，点击头部无效果

### 样式实现

#### CSS 类名

- `.tool-call-modern` - 工具调用容器
- `.tool-call-modern__header` - 头部
- `.tool-call-modern__icon` - 圆形图标容器
- `.tool-call-modern__name` - 工具名称
- `.tool-call-modern__badge` - 状态徽章
- `.tool-call-modern__expand` - 展开箭头
- `.tool-call-modern__body` - 内容区
- `.tool-call-modern__section` - 输入/输出/错误区块
- `.tool-call-modern__label` - 标签
- `.tool-call-modern__copy` - 复制按钮
- `.tool-call-modern__code` - 代码块

状态修饰类：
- `.tool-call-modern--start`
- `.tool-call-modern--progress`
- `.tool-call-modern--end`
- `.tool-call-modern--error`

#### 关键 CSS

```css
.tool-call-modern {
  background: rgba(245, 248, 252, 0.5);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
  border: 1px solid rgba(120, 144, 184, 0.14);
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

.tool-call-modern--start .tool-call-modern__icon {
  background: #e3f2fd;
  color: #2d477a;
}

.tool-call-modern__badge {
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

@keyframes tool-spin {
  to { transform: rotate(360deg); }
}

.tool-call-modern--progress .tool-call-modern__icon svg {
  animation: tool-spin 1s linear infinite;
}
```

## 实现计划

### 阶段 1：组件重构

1. 修改 `ToolCallBlock.tsx`，实现新的视觉设计
2. 更新状态图标映射
3. 实现圆形图标容器和状态徽章
4. 保持现有的 `ActivityBlockShell` 和 `ActivityBlockBody` 复用

### 阶段 2：样式实现

1. 更新 `tool-call.css`，实现新的样式系统
2. 添加深色模式适配
3. 实现旋转动画
4. 优化展开/收起过渡效果

### 阶段 3：测试验证

1. 验证所有状态的视觉效果
2. 验证深色模式
3. 验证展开/收起交互
4. 验证复制功能

## 技术注意事项

1. **复用现有组件**：使用 `ActivityBlockShell` 和 `ActivityBlockBody`
2. **图标库**：使用 `lucide-react` 的 CirclePlay、LoaderCircle、CheckCircle2、XCircle
3. **状态管理**：保持现有的 `use-activity-block-state` hook
4. **复制功能**：保持现有的 `use-copy-content` hook
5. **代码格式化**：JSON 使用 `JSON.stringify(data, null, 2)`，字符串直接显示
6. **动画实现**：旋转动画通过 CSS keyframes，不使用 JavaScript

## 兼容性

- 保持现有的 `ChatTranscriptActivityBlock` 数据结构不变
- 保持现有的 `ToolCallView` 组件接口不变
- 向后兼容现有的工具调用日志

## 未来扩展

1. 可考虑添加工具调用时长显示
2. 可考虑添加工具调用统计（同一工具的调用次数）
3. 可考虑添加工具调用性能指标

## 参考

- 当前实现：`src/renderer/chat/tool-call/ToolCallBlock.tsx`
- 当前样式：`src/renderer/styles/tool-call.css`
- 设计原型：`.superpowers/brainstorm/614-1781094050/content/`
