# RTK 与 LangChain/DeepAgents 集成设计文档

**日期**: 2026-05-29  
**版本**: 1.0  
**状态**: 设计阶段

---

## 1. 概述

### 1.1 目标

将 RTK (Rust Token Killer) 集成到 Roc Windows Super Assistant 中,通过透明的 middleware 层优化所有 LangChain/DeepAgents 的 shell 命令执行,实现 60-90% 的 token 节省,降低 API 成本。

### 1.2 核心需求

- **全局优化**: 自动应用到所有 shell 命令,无需逐个配置
- **静默降级**: RTK 不可用或失败时自动回退,不影响用户体验
- **跨平台支持**: 打包 RTK 二进制到应用中,支持 Windows/macOS/Linux
- **零配置**: 完全依赖 RTK 内置判断,无需用户配置排除规则
- **用户无感知**: 后台静默优化,不显示统计或提示

### 1.3 非目标

- 不提供用户界面配置 RTK 行为
- 不展示 token 节省统计
- 不支持用户自定义排除规则
- 不在生产环境输出日志

---

## 2. 整体架构

### 2.1 系统架构图

```
┌─────────────────────────────────────────────────────────┐
│                    Electron 应用                         │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  DeepAgent 初始化                                        │
│         │                                                │
│         ▼                                                │
│  ┌──────────────────┐                                   │
│  │ RTKMiddleware    │ ◄─── 全局注册                     │
│  │  (拦截层)        │                                    │
│  └──────────────────┘                                   │
│         │                                                │
│         ▼                                                │
│  Shell 命令执行                                          │
│         │                                                │
│    ┌────┴────┐                                          │
│    │         │                                          │
│  调用 RTK   无需重写                                     │
│  rewrite      │                                          │
│    │         │                                          │
│    ▼         ▼                                          │
│  执行优化  执行原始                                      │
│  命令      命令                                          │
│    │         │                                          │
│    └─────────┘                                          │
│         │                                                │
│         ▼                                                │
│  返回过滤后的输出                                        │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心组件

| 组件 | 职责 | 位置 |
|------|------|------|
| **RTKMiddleware** | 拦截 shell 工具调用,重写命令 | `src/rtk-integration/middleware.ts` |
| **RTK Binary Manager** | 管理跨平台 RTK 二进制 | `src/rtk-integration/binary-manager.ts` |
| **Command Rewriter** | 调用 RTK rewrite 并处理结果 | `src/rtk-integration/rewriter.ts` |
| **Fallback Handler** | 静默降级处理 | 内置于 middleware |

---

## 3. RTK 二进制打包与管理

### 3.1 目录结构

```
resources/
├── rtk-binaries/
│   ├── win32-x64/
│   │   └── rtk.exe
│   ├── darwin-x64/
│   │   └── rtk
│   ├── darwin-arm64/
│   │   └── rtk
│   └── linux-x64/
│       └── rtk
```

### 3.2 RTK Binary Manager

**职责**:
1. 平台检测: 根据 `process.platform` 和 `process.arch` 选择正确的二进制
2. 路径解析: 在打包后的应用中定位 RTK 二进制
3. 权限管理: 确保二进制文件有执行权限(Unix 系统)
4. 可用性检查: 启动时验证 RTK 二进制是否可执行

**接口**:
```typescript
class RTKBinaryManager {
  // 获取当前平台的 RTK 二进制路径
  getRTKBinaryPath(): string | null
  
  // 检查 RTK 是否可用
  isRTKAvailable(): boolean
  
  // 确保二进制有执行权限
  ensureExecutable(): Promise<void>
}
```

### 3.3 构建集成

在 `electron-builder.yml` 中配置:
```yaml
extraResources:
  - from: resources/rtk-binaries
    to: rtk-binaries
    filter:
      - "**/*"
```

### 3.4 降级策略

| 场景 | 处理方式 |
|------|---------|
| RTK 二进制不存在 | 禁用 middleware,使用原始命令 |
| RTK 二进制无执行权限 | 尝试修复权限,失败则禁用 |
| RTK 执行超时(2秒) | 回退到原始命令 |
| RTK 返回错误 | 回退到原始命令 |

所有降级都是静默的,不影响用户工作流。

---

## 4. RTKMiddleware 实现

### 4.1 核心逻辑

**拦截流程**:
1. 检查工具类型(仅处理 `bash`/`shell`/`terminal`/`run_shell_command`)
2. 提取命令字符串
3. 调用 RTK rewrite 获取优化版本
4. 根据退出码决定执行策略:
   - `0`: 使用重写后的命令
   - `1`: 无 RTK 等效,使用原命令
   - `2`: 拒绝执行(不应出现)
   - `3`: 使用重写后的命令(ask 模式,静默执行)
5. 执行命令并返回结果
6. 任何错误都触发静默降级

### 4.2 接口定义

```typescript
class RTKMiddleware extends AgentMiddleware {
  constructor(
    private binaryManager: RTKBinaryManager,
    private options: {
      rewriteTimeout?: number  // 默认 2000ms
      fallbackOnError?: boolean  // 默认 true
    }
  )
  
  // LangChain middleware 接口
  async wrapToolCall(
    request: ToolCallRequest,
    handler: (req: ToolCallRequest) => Promise<ToolMessage>
  ): Promise<ToolMessage>
  
  // 内部方法
  private async rewriteCommand(command: string): Promise<{
    rewritten: string | null
    exitCode: number
  }>
  
  private shouldRewrite(toolName: string): boolean
  
  private extractCommand(toolInput: any): string | null
}
```

### 4.3 关键特性

- **超时保护**: RTK rewrite 调用设置 2 秒超时
- **进程隔离**: 每次 rewrite 都是独立的子进程调用
- **错误静默**: 所有 RTK 相关错误都被捕获并降级,不抛出异常
- **零配置**: 不需要用户配置排除列表,完全依赖 RTK 内置逻辑

### 4.4 性能考虑

- RTK rewrite 开销: <10ms (根据 RTK 文档)
- 对用户体验影响: 可忽略不计
- Token 节省收益: 60-90% (远超性能开销)

---

## 5. 集成点与初始化

### 5.1 DeepAgent 初始化修改

**位置**: Agent 初始化代码(主进程或 renderer 进程)

**修改前**:
```typescript
const agent = createDeepAgent({
  model: anthropic,
  tools: [...],
  // 其他配置
})
```

**修改后**:
```typescript
import { RTKMiddleware } from './rtk-integration/middleware'
import { RTKBinaryManager } from './rtk-integration/binary-manager'

const binaryManager = new RTKBinaryManager()
const rtkMiddleware = new RTKMiddleware(binaryManager)

const agent = createDeepAgent({
  model: anthropic,
  tools: [...],
  middleware: [rtkMiddleware],  // 添加 RTK middleware
  // 其他配置
})
```

### 5.2 初始化时机

1. **应用启动时**: 初始化 RTK Binary Manager,检查可用性
2. **Agent 创建时**: 注入 RTKMiddleware
3. **无需用户交互**: 完全自动化,用户无感知

### 5.3 向后兼容

- 如果 RTK 二进制缺失或损坏,middleware 自动禁用
- 不影响现有功能,纯增量优化
- 可以通过环境变量 `DISABLE_RTK=1` 完全禁用(用于调试)

---

## 6. 错误处理

### 6.1 错误处理层级

**Level 1 - RTK Binary 不可用**:
- **检测**: 应用启动时
- **处理**: 禁用 middleware,记录日志(仅开发环境)
- **影响**: 命令正常执行,无优化

**Level 2 - RTK Rewrite 失败**:
- **检测**: 每次命令重写时
- **处理**: 捕获异常,使用原命令
- **影响**: 单次命令无优化,不影响后续

**Level 3 - 重写后命令执行失败**:
- **检测**: 命令执行时
- **处理**: 回退到原命令重新执行
- **影响**: 轻微延迟(一次额外执行)

### 6.2 错误处理原则

- **静默优先**: 所有错误都静默处理,不打断用户
- **自动降级**: 失败时自动回退到原始行为
- **不抛异常**: RTK 相关错误不向上传播
- **日志最小化**: 仅在开发环境记录错误

---

## 7. 测试策略

### 7.1 单元测试

**RTK Binary Manager**:
- 平台检测逻辑
- 路径解析正确性
- 权限检查和修复

**RTKMiddleware**:
- 命令拦截逻辑
- 重写成功/失败场景
- 降级机制

**Command Rewriter**:
- RTK 调用和超时处理
- 退出码解析
- 错误捕获

### 7.2 集成测试

- 端到端 agent 执行流程
- RTK 优化效果验证(对比原始输出 token 数)
- 跨平台二进制加载

### 7.3 手动测试

- 各平台打包后验证(Windows/macOS/Linux)
- 常见命令优化效果检查(`git status`, `npm test`, `ls` 等)
- RTK 不可用时的降级行为

### 7.4 测试覆盖目标

- 单元测试覆盖率: >80%
- 关键路径覆盖: 100%
- 跨平台验证: 全平台

---

## 8. 日志策略

### 8.1 日志级别

| 环境 | 日志级别 | 输出内容 |
|------|---------|---------|
| **生产环境** | 无 | 完全静默 |
| **开发环境** | 可选 | 通过 `DEBUG_RTK=1` 启用详细日志 |

### 8.2 日志内容(仅开发环境)

- RTK 二进制路径和可用性
- 命令重写前后对比
- 重写失败原因
- 降级触发事件

### 8.3 实现方式

```typescript
const DEBUG = process.env.DEBUG_RTK === '1' && process.env.NODE_ENV === 'development'

function log(message: string) {
  if (DEBUG) {
    console.log(`[RTK] ${message}`)
  }
}
```

---

## 9. 实施计划

### 9.1 阶段划分

**Phase 1: 基础设施**
- 下载并打包 RTK 二进制(Windows/macOS/Linux)
- 实现 RTK Binary Manager
- 配置 electron-builder

**Phase 2: 核心功能**
- 实现 Command Rewriter
- 实现 RTKMiddleware
- 集成到 DeepAgent 初始化

**Phase 3: 测试与验证**
- 编写单元测试
- 编写集成测试
- 跨平台手动测试

**Phase 4: 优化与文档**
- 性能优化
- 错误处理完善
- 编写使用文档

### 9.2 预估工作量

- Phase 1: 4-6 小时
- Phase 2: 6-8 小时
- Phase 3: 4-6 小时
- Phase 4: 2-4 小时

**总计**: 16-24 小时

---

## 10. 风险与缓解

### 10.1 风险识别

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| RTK 二进制不兼容某些平台 | 高 | 低 | 充分测试,提供降级机制 |
| RTK 重写导致命令失败 | 中 | 低 | 自动回退到原命令 |
| 打包后二进制路径错误 | 高 | 中 | 多环境测试,路径解析健壮性 |
| 性能开销超预期 | 低 | 低 | 性能测试,超时保护 |

### 10.2 回滚计划

如果集成出现严重问题:
1. 通过环境变量 `DISABLE_RTK=1` 禁用
2. 移除 middleware 注册代码
3. 回滚到集成前的版本

---

## 11. 成功标准

### 11.1 功能标准

- ✅ 所有 shell 命令自动通过 RTK 优化
- ✅ RTK 不可用时自动降级,不影响功能
- ✅ 跨平台支持(Windows/macOS/Linux)
- ✅ 用户无感知,无需配置

### 11.2 性能标准

- ✅ RTK 重写开销 <10ms
- ✅ Token 节省 60-90%
- ✅ 无明显用户体验延迟

### 11.3 质量标准

- ✅ 单元测试覆盖率 >80%
- ✅ 所有平台手动测试通过
- ✅ 无生产环境日志输出
- ✅ 错误静默处理,不抛异常

---

## 12. 附录

### 12.1 RTK 退出码说明

| 退出码 | 含义 | 处理方式 |
|-------|------|---------|
| 0 | 重写成功,允许执行 | 使用重写后的命令 |
| 1 | 无 RTK 等效命令 | 使用原始命令 |
| 2 | 拒绝执行(deny 规则) | 使用原始命令(理论上不应出现) |
| 3 | 重写成功,需确认 | 使用重写后的命令(静默执行) |

### 12.2 参考资料

- RTK 项目: https://github.com/rtk-ai/rtk
- RTK 文档: https://www.rtk-ai.app/guide
- LangChain Middleware: https://docs.langchain.com/oss/python/langchain/middleware/built-in
- DeepAgents 文档: https://docs.langchain.com/oss/python/deepagents

---

**文档结束**
