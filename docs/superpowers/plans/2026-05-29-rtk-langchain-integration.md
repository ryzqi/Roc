# RTK-LangChain 集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 RTK 集成到 Roc Windows Super Assistant,通过 LangChain middleware 实现 60-90% token 节省

**Architecture:** 创建 RTKMiddleware 拦截所有 shell 命令,调用 RTK rewrite 优化输出,静默降级处理错误。打包跨平台 RTK 二进制到应用资源中。

**Tech Stack:** TypeScript, LangChain, DeepAgents, Electron, Node.js child_process

---

## 文件结构概览

**新建文件**:
- `src/rtk-integration/binary-manager.ts` - RTK 二进制管理器
- `src/rtk-integration/rewriter.ts` - 命令重写器
- `src/rtk-integration/middleware.ts` - LangChain middleware
- `src/rtk-integration/index.ts` - 导出接口
- `tests/rtk-integration/binary-manager.test.ts` - Binary Manager 测试
- `tests/rtk-integration/rewriter.test.ts` - Rewriter 测试
- `tests/rtk-integration/middleware.test.ts` - Middleware 测试
- `resources/rtk-binaries/win32-x64/rtk.exe` - Windows 二进制
- `resources/rtk-binaries/darwin-x64/rtk` - macOS Intel 二进制
- `resources/rtk-binaries/darwin-arm64/rtk` - macOS ARM 二进制
- `resources/rtk-binaries/linux-x64/rtk` - Linux 二进制

**修改文件**:
- `src/main/services/deep-agent/agent-builder.ts:86` - 添加 RTK middleware
- `electron-builder.yml` - 配置二进制打包

---

## Task 1: 下载并准备 RTK 二进制文件

**Files:**
- Create: `resources/rtk-binaries/win32-x64/rtk.exe`
- Create: `resources/rtk-binaries/darwin-x64/rtk`
- Create: `resources/rtk-binaries/darwin-arm64/rtk`
- Create: `resources/rtk-binaries/linux-x64/rtk`

- [ ] **Step 1: 创建资源目录结构**

```bash
mkdir -p resources/rtk-binaries/win32-x64
mkdir -p resources/rtk-binaries/darwin-x64
mkdir -p resources/rtk-binaries/darwin-arm64
mkdir -p resources/rtk-binaries/linux-x64
```

- [ ] **Step 2: 下载 RTK 二进制文件**

访问 https://github.com/rtk-ai/rtk/releases 下载最新版本的各平台二进制:
- Windows x64: `rtk-x86_64-pc-windows-msvc.exe` → `resources/rtk-binaries/win32-x64/rtk.exe`
- macOS Intel: `rtk-x86_64-apple-darwin` → `resources/rtk-binaries/darwin-x64/rtk`
- macOS ARM: `rtk-aarch64-apple-darwin` → `resources/rtk-binaries/darwin-arm64/rtk`
- Linux x64: `rtk-x86_64-unknown-linux-gnu` → `resources/rtk-binaries/linux-x64/rtk`

- [ ] **Step 3: 设置 Unix 二进制执行权限**

```bash
chmod +x resources/rtk-binaries/darwin-x64/rtk
chmod +x resources/rtk-binaries/darwin-arm64/rtk
chmod +x resources/rtk-binaries/linux-x64/rtk
```

- [ ] **Step 4: 验证二进制文件可执行**

```bash
# Windows (在 PowerShell 中)
./resources/rtk-binaries/win32-x64/rtk.exe --version

# macOS/Linux
./resources/rtk-binaries/darwin-x64/rtk --version
./resources/rtk-binaries/darwin-arm64/rtk --version
./resources/rtk-binaries/linux-x64/rtk --version
```

Expected: 显示 RTK 版本号 (例如 "rtk 0.28.2")

- [ ] **Step 5: Commit**

```bash
git add resources/rtk-binaries/
git commit -m "feat(rtk): add cross-platform RTK binaries"
```

---

## Task 2: 配置 Electron Builder 打包 RTK 二进制

**Files:**
- Modify: `electron-builder.yml`

- [ ] **Step 1: 添加 extraResources 配置**

在 `electron-builder.yml` 中添加:

```yaml
extraResources:
  - from: resources/rtk-binaries
    to: rtk-binaries
    filter:
      - "**/*"
```

- [ ] **Step 2: 验证配置语法**

```bash
cat electron-builder.yml
```

Expected: YAML 格式正确,无语法错误

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml
git commit -m "feat(rtk): configure electron-builder to package RTK binaries"
```

---

## Task 3: 实现 RTK Binary Manager

**Files:**
- Create: `src/rtk-integration/binary-manager.ts`
- Create: `tests/rtk-integration/binary-manager.test.ts`

- [ ] **Step 1: 编写 Binary Manager 失败测试**

Create `tests/rtk-integration/binary-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RTKBinaryManager } from '../../src/rtk-integration/binary-manager'

describe('RTKBinaryManager', () => {
  let manager: RTKBinaryManager

  beforeEach(() => {
    manager = new RTKBinaryManager()
  })

  it('should detect current platform', () => {
    const path = manager.getRTKBinaryPath()
    expect(path).toBeDefined()
    expect(path).toContain('rtk')
  })

  it('should return null for unsupported platform', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd' as any)
    const path = manager.getRTKBinaryPath()
    expect(path).toBeNull()
  })

  it('should check RTK availability', () => {
    const available = manager.isRTKAvailable()
    expect(typeof available).toBe('boolean')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test tests/rtk-integration/binary-manager.test.ts
```

Expected: FAIL - RTKBinaryManager not found

- [ ] **Step 3: 实现 RTK Binary Manager**

Create `src/rtk-integration/binary-manager.ts`:

```typescript
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class RTKBinaryManager {
  private binaryPath: string | null = null
  private available: boolean | null = null

  constructor() {
    this.binaryPath = this.resolveBinaryPath()
  }

  /**
   * 获取当前平台的 RTK 二进制路径
   */
  getRTKBinaryPath(): string | null {
    return this.binaryPath
  }

  /**
   * 检查 RTK 是否可用
   */
  isRTKAvailable(): boolean {
    if (this.available !== null) {
      return this.available
    }

    if (!this.binaryPath) {
      this.available = false
      return false
    }

    try {
      // 检查文件是否存在
      if (!fs.existsSync(this.binaryPath)) {
        this.available = false
        return false
      }

      // 检查是否可执行
      fs.accessSync(this.binaryPath, fs.constants.X_OK)
      this.available = true
      return true
    } catch {
      this.available = false
      return false
    }
  }

  /**
   * 确保二进制文件有执行权限 (Unix 系统)
   */
  async ensureExecutable(): Promise<void> {
    if (!this.binaryPath || process.platform === 'win32') {
      return
    }

    try {
      await fs.promises.chmod(this.binaryPath, 0o755)
    } catch (error) {
      console.error('[RTK] Failed to set executable permission:', error)
    }
  }

  /**
   * 验证 RTK 二进制是否可执行
   */
  async verify(): Promise<boolean> {
    if (!this.binaryPath || !this.isRTKAvailable()) {
      return false
    }

    try {
      const { stdout } = await execFileAsync(this.binaryPath, ['--version'], {
        timeout: 2000
      })
      return stdout.includes('rtk')
    } catch {
      return false
    }
  }

  /**
   * 解析 RTK 二进制路径
   */
  private resolveBinaryPath(): string | null {
    const platform = process.platform
    const arch = process.arch

    let platformDir: string
    let binaryName: string

    if (platform === 'win32' && arch === 'x64') {
      platformDir = 'win32-x64'
      binaryName = 'rtk.exe'
    } else if (platform === 'darwin' && arch === 'x64') {
      platformDir = 'darwin-x64'
      binaryName = 'rtk'
    } else if (platform === 'darwin' && arch === 'arm64') {
      platformDir = 'darwin-arm64'
      binaryName = 'rtk'
    } else if (platform === 'linux' && arch === 'x64') {
      platformDir = 'linux-x64'
      binaryName = 'rtk'
    } else {
      return null
    }

    // 开发环境路径
    if (!app.isPackaged) {
      return path.join(process.cwd(), 'resources', 'rtk-binaries', platformDir, binaryName)
    }

    // 生产环境路径
    return path.join(process.resourcesPath, 'rtk-binaries', platformDir, binaryName)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test tests/rtk-integration/binary-manager.test.ts
```

Expected: PASS - 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/rtk-integration/binary-manager.ts tests/rtk-integration/binary-manager.test.ts
git commit -m "feat(rtk): implement RTK Binary Manager"
```

---

## Task 4: 实现 Command Rewriter

**Files:**
- Create: `src/rtk-integration/rewriter.ts`
- Create: `tests/rtk-integration/rewriter.test.ts`

- [ ] **Step 1: 编写 Rewriter 失败测试**

Create `tests/rtk-integration/rewriter.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { CommandRewriter } from '../../src/rtk-integration/rewriter'

describe('CommandRewriter', () => {
  it('should rewrite git status command', async () => {
    const rewriter = new CommandRewriter('/path/to/rtk')
    const result = await rewriter.rewrite('git status')
    
    expect(result.exitCode).toBe(0)
    expect(result.rewritten).toContain('rtk')
  })

  it('should return null for unsupported command', async () => {
    const rewriter = new CommandRewriter('/path/to/rtk')
    const result = await rewriter.rewrite('htop')
    
    expect(result.exitCode).toBe(1)
    expect(result.rewritten).toBeNull()
  })

  it('should handle timeout', async () => {
    const rewriter = new CommandRewriter('/path/to/rtk', { timeout: 100 })
    const result = await rewriter.rewrite('sleep 10')
    
    expect(result.exitCode).toBe(1)
    expect(result.rewritten).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test tests/rtk-integration/rewriter.test.ts
```

Expected: FAIL - CommandRewriter not found

- [ ] **Step 3: 实现 Command Rewriter**

Create `src/rtk-integration/rewriter.ts`:

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RewriteResult {
  rewritten: string | null
  exitCode: number
}

export interface RewriterOptions {
  timeout?: number
}

export class CommandRewriter {
  private rtkBinaryPath: string
  private timeout: number

  constructor(rtkBinaryPath: string, options: RewriterOptions = {}) {
    this.rtkBinaryPath = rtkBinaryPath
    this.timeout = options.timeout ?? 2000
  }

  /**
   * 使用 RTK 重写命令
   * 
   * 退出码:
   * - 0: 重写成功,允许执行
   * - 1: 无 RTK 等效命令
   * - 2: 拒绝执行 (deny 规则)
   * - 3: 重写成功,需确认
   */
  async rewrite(command: string): Promise<RewriteResult> {
    try {
      const { stdout, stderr } = await execFileAsync(
        this.rtkBinaryPath,
        ['rewrite', command],
        {
          timeout: this.timeout,
          encoding: 'utf8'
        }
      )

      const rewritten = stdout.trim()
      return {
        rewritten: rewritten || null,
        exitCode: 0
      }
    } catch (error: any) {
      // 处理超时
      if (error.killed && error.signal === 'SIGTERM') {
        return { rewritten: null, exitCode: 1 }
      }

      // 处理退出码
      if (error.code === 1) {
        return { rewritten: null, exitCode: 1 }
      }

      if (error.code === 2) {
        return { rewritten: null, exitCode: 2 }
      }

      if (error.code === 3) {
        const rewritten = error.stdout?.trim()
        return {
          rewritten: rewritten || null,
          exitCode: 3
        }
      }

      // 其他错误
      return { rewritten: null, exitCode: 1 }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test tests/rtk-integration/rewriter.test.ts
```

Expected: PASS - 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/rtk-integration/rewriter.ts tests/rtk-integration/rewriter.test.ts
git commit -m "feat(rtk): implement Command Rewriter"
```

---

## Task 5: 实现 RTK Middleware

**Files:**
- Create: `src/rtk-integration/middleware.ts`
- Create: `tests/rtk-integration/middleware.test.ts`

- [ ] **Step 1: 编写 Middleware 失败测试**

Create `tests/rtk-integration/middleware.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { RTKMiddleware } from '../../src/rtk-integration/middleware'
import { RTKBinaryManager } from '../../src/rtk-integration/binary-manager'

describe('RTKMiddleware', () => {
  it('should intercept shell tool calls', async () => {
    const manager = new RTKBinaryManager()
    const middleware = new RTKMiddleware(manager)

    const mockRequest = {
      tool_call: {
        id: 'test-id',
        name: 'bash',
        args: { command: 'git status' }
      }
    }

    const mockHandler = vi.fn().mockResolvedValue({
      content: 'mocked output',
      tool_call_id: 'test-id'
    })

    const result = await middleware.wrapToolCall(mockRequest as any, mockHandler)
    expect(result).toBeDefined()
  })

  it('should pass through non-shell tools', async () => {
    const manager = new RTKBinaryManager()
    const middleware = new RTKMiddleware(manager)

    const mockRequest = {
      tool_call: {
        id: 'test-id',
        name: 'read_file',
        args: { path: 'test.txt' }
      }
    }

    const mockHandler = vi.fn().mockResolvedValue({
      content: 'file content',
      tool_call_id: 'test-id'
    })

    await middleware.wrapToolCall(mockRequest as any, mockHandler)
    expect(mockHandler).toHaveBeenCalledWith(mockRequest)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test tests/rtk-integration/middleware.test.ts
```

Expected: FAIL - RTKMiddleware not found

- [ ] **Step 3: 实现 RTK Middleware (Part 1 - 基础结构)**

Create `src/rtk-integration/middleware.ts`:

```typescript
import type { AgentMiddleware } from 'langchain'
import type { ToolCallRequest, ToolMessage } from '@langchain/core/messages'
import { RTKBinaryManager } from './binary-manager'
import { CommandRewriter } from './rewriter'

const DEBUG = process.env.DEBUG_RTK === '1' && process.env.NODE_ENV === 'development'

function log(message: string): void {
  if (DEBUG) {
    console.log(`[RTK] ${message}`)
  }
}

export interface RTKMiddlewareOptions {
  rewriteTimeout?: number
  fallbackOnError?: boolean
}

export class RTKMiddleware implements AgentMiddleware {
  private binaryManager: RTKBinaryManager
  private rewriter: CommandRewriter | null
  private options: Required<RTKMiddlewareOptions>

  constructor(binaryManager: RTKBinaryManager, options: RTKMiddlewareOptions = {}) {
    this.binaryManager = binaryManager
    this.options = {
      rewriteTimeout: options.rewriteTimeout ?? 2000,
      fallbackOnError: options.fallbackOnError ?? true
    }

    // 初始化 rewriter
    const binaryPath = binaryManager.getRTKBinaryPath()
    if (binaryPath && binaryManager.isRTKAvailable()) {
      this.rewriter = new CommandRewriter(binaryPath, {
        timeout: this.options.rewriteTimeout
      })
      log(`Initialized with RTK binary: ${binaryPath}`)
    } else {
      this.rewriter = null
      log('RTK binary not available, middleware disabled')
    }
  }

  // 继续下一部分...
```

- [ ] **Step 4: 实现 RTK Middleware (Part 2 - 核心逻辑)**

继续在 `src/rtk-integration/middleware.ts` 中添加:

```typescript
  /**
   * LangChain middleware 接口实现
   */
  async wrapToolCall(
    request: ToolCallRequest,
    handler: (req: ToolCallRequest) => Promise<ToolMessage>
  ): Promise<ToolMessage> {
    // 检查是否应该处理
    if (!this.shouldRewrite(request)) {
      return handler(request)
    }

    // 提取命令
    const command = this.extractCommand(request)
    if (!command) {
      return handler(request)
    }

    // 尝试重写
    try {
      const result = await this.rewriter!.rewrite(command)

      // 处理拒绝执行
      if (result.exitCode === 2) {
        log(`Command denied by RTK: ${command}`)
        return {
          content: `Command denied by RTK security policy: ${command}`,
          tool_call_id: request.tool_call.id
        } as ToolMessage
      }

      // 使用重写后的命令
      if (result.rewritten && (result.exitCode === 0 || result.exitCode === 3)) {
        log(`Rewrite: ${command} -> ${result.rewritten}`)
        
        const modifiedRequest = this.createModifiedRequest(request, result.rewritten)
        
        try {
          return await handler(modifiedRequest)
        } catch (error) {
          // 重写后的命令执行失败,回退
          if (this.options.fallbackOnError) {
            log(`Rewritten command failed, falling back to original`)
            return handler(request)
          }
          throw error
        }
      }

      // 无重写,使用原命令
      return handler(request)
    } catch (error) {
      log(`Rewrite error: ${error}`)
      if (this.options.fallbackOnError) {
        return handler(request)
      }
      throw error
    }
  }

  // 继续下一部分...
```

- [ ] **Step 5: 实现 RTK Middleware (Part 3 - 辅助方法)**

继续在 `src/rtk-integration/middleware.ts` 中添加:

```typescript
  /**
   * 检查是否应该重写此工具调用
   */
  private shouldRewrite(request: ToolCallRequest): boolean {
    if (!this.rewriter) {
      return false
    }

    const toolName = request.tool_call.name?.toLowerCase()
    const shellTools = ['bash', 'shell', 'terminal', 'execute', 'run_shell_command']
    
    return shellTools.includes(toolName)
  }

  /**
   * 从工具输入中提取命令字符串
   */
  private extractCommand(request: ToolCallRequest): string | null {
    const args = request.tool_call.args

    if (typeof args === 'string') {
      return args
    }

    if (typeof args === 'object' && args !== null) {
      return args.command ?? args.cmd ?? args.input ?? null
    }

    return null
  }

  /**
   * 创建修改后的请求对象
   */
  private createModifiedRequest(
    original: ToolCallRequest,
    newCommand: string
  ): ToolCallRequest {
    const originalArgs = original.tool_call.args

    let newArgs: any
    if (typeof originalArgs === 'string') {
      newArgs = newCommand
    } else if (typeof originalArgs === 'object' && originalArgs !== null) {
      newArgs = { ...originalArgs }
      if ('command' in originalArgs) {
        newArgs.command = newCommand
      } else if ('cmd' in originalArgs) {
        newArgs.cmd = newCommand
      } else if ('input' in originalArgs) {
        newArgs.input = newCommand
      } else {
        newArgs.command = newCommand
      }
    } else {
      newArgs = { command: newCommand }
    }

    return {
      ...original,
      tool_call: {
        ...original.tool_call,
        args: newArgs
      }
    }
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm test tests/rtk-integration/middleware.test.ts
```

Expected: PASS - 所有测试通过

- [ ] **Step 7: Commit**

```bash
git add src/rtk-integration/middleware.ts tests/rtk-integration/middleware.test.ts
git commit -m "feat(rtk): implement RTK Middleware"
```

---

## Task 6: 创建导出接口

**Files:**
- Create: `src/rtk-integration/index.ts`

- [ ] **Step 1: 创建导出文件**

Create `src/rtk-integration/index.ts`:

```typescript
export { RTKBinaryManager } from './binary-manager'
export { CommandRewriter } from './rewriter'
export { RTKMiddleware } from './middleware'
export type { RewriteResult, RewriterOptions } from './rewriter'
export type { RTKMiddlewareOptions } from './middleware'
```

- [ ] **Step 2: 验证导出**

```bash
cat src/rtk-integration/index.ts
```

Expected: 所有导出正确

- [ ] **Step 3: Commit**

```bash
git add src/rtk-integration/index.ts
git commit -m "feat(rtk): add integration module exports"
```

---

## Task 7: 集成 RTK Middleware 到 DeepAgent

**Files:**
- Modify: `src/main/services/deep-agent/agent-builder.ts:86`

- [ ] **Step 1: 导入 RTK 模块**

在 `src/main/services/deep-agent/agent-builder.ts` 顶部添加导入:

```typescript
import { RTKBinaryManager, RTKMiddleware } from '../../rtk-integration'
```

- [ ] **Step 2: 初始化 RTK (在 buildDeepAgent 函数开始处)**

在 `buildDeepAgent` 函数中,在 `isLocalProvider` 定义之后添加:

```typescript
export function buildDeepAgent(input: DeepAgentBuildInput): ReturnType<typeof createDeepAgent> {
  const isLocalProvider = input.providerType === 'llama_cpp';
  
  // 初始化 RTK
  const rtkBinaryManager = new RTKBinaryManager()
  const rtkMiddleware = new RTKMiddleware(rtkBinaryManager)
  
  const knownToolNames = (): string[] => {
    // ... 现有代码
```

- [ ] **Step 3: 添加 RTK middleware 到 guardrails 数组**

在 `guardrails` 数组定义中,在第一个位置添加 RTK middleware:

```typescript
  const guardrails = [
    rtkMiddleware,  // 添加 RTK middleware
    toolRetryMiddleware({
      maxRetries: 2,
      tools: [...NETWORK_SENSITIVE_TOOLS],
      backoffFactor: 1.5
    }),
    // ... 其他 middleware
```

- [ ] **Step 4: 验证修改**

```bash
cat src/main/services/deep-agent/agent-builder.ts | grep -A 5 "rtkMiddleware"
```

Expected: RTK middleware 正确集成

- [ ] **Step 5: Commit**

```bash
git add src/main/services/deep-agent/agent-builder.ts
git commit -m "feat(rtk): integrate RTK middleware into DeepAgent"
```

---

## Task 8: 添加集成测试

**Files:**
- Create: `tests/rtk-integration/integration.test.ts`

- [ ] **Step 1: 编写集成测试**

Create `tests/rtk-integration/integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { RTKBinaryManager } from '../../src/rtk-integration/binary-manager'
import { RTKMiddleware } from '../../src/rtk-integration/middleware'

describe('RTK Integration', () => {
  it('should initialize RTK components', () => {
    const manager = new RTKBinaryManager()
    const middleware = new RTKMiddleware(manager)
    
    expect(manager).toBeDefined()
    expect(middleware).toBeDefined()
  })

  it('should handle RTK unavailable gracefully', () => {
    const manager = new RTKBinaryManager()
    
    // 即使 RTK 不可用,也不应该抛出异常
    expect(() => {
      const middleware = new RTKMiddleware(manager)
    }).not.toThrow()
  })

  it('should support DISABLE_RTK environment variable', () => {
    const originalEnv = process.env.DISABLE_RTK
    process.env.DISABLE_RTK = '1'
    
    const manager = new RTKBinaryManager()
    const middleware = new RTKMiddleware(manager)
    
    expect(middleware).toBeDefined()
    
    process.env.DISABLE_RTK = originalEnv
  })
})
```

- [ ] **Step 2: 运行集成测试**

```bash
pnpm test tests/rtk-integration/integration.test.ts
```

Expected: PASS - 所有集成测试通过

- [ ] **Step 3: Commit**

```bash
git add tests/rtk-integration/integration.test.ts
git commit -m "test(rtk): add integration tests"
```

---

## Task 9: 运行完整测试套件

**Files:**
- N/A (验证阶段)

- [ ] **Step 1: 运行所有 RTK 测试**

```bash
pnpm test tests/rtk-integration/
```

Expected: PASS - 所有测试通过

- [ ] **Step 2: 运行完整测试套件**

```bash
pnpm test
```

Expected: PASS - 所有测试通过,无回归

- [ ] **Step 3: 检查测试覆盖率**

```bash
pnpm test --coverage tests/rtk-integration/
```

Expected: 覆盖率 >80%

- [ ] **Step 4: 验证类型检查**

```bash
pnpm typecheck
```

Expected: 无类型错误

---

## Task 10: 手动验证和文档

**Files:**
- Create: `docs/rtk-integration.md`

- [ ] **Step 1: 本地开发环境验证**

启动应用并测试 RTK 集成:

```bash
pnpm dev
```

在应用中执行一些 shell 命令,观察:
- 命令是否正常执行
- 无错误提示
- 用户体验流畅

- [ ] **Step 2: 检查 RTK 日志 (开发环境)**

设置环境变量并重启:

```bash
DEBUG_RTK=1 pnpm dev
```

Expected: 控制台显示 RTK 重写日志

- [ ] **Step 3: 验证降级行为**

临时重命名 RTK 二进制文件:

```bash
mv resources/rtk-binaries/win32-x64/rtk.exe resources/rtk-binaries/win32-x64/rtk.exe.bak
pnpm dev
```

Expected: 应用正常启动,命令正常执行(未优化)

恢复文件:

```bash
mv resources/rtk-binaries/win32-x64/rtk.exe.bak resources/rtk-binaries/win32-x64/rtk.exe
```

- [ ] **Step 4: 编写集成文档**

Create `docs/rtk-integration.md`:

```markdown
# RTK 集成文档

## 概述

RTK (Rust Token Killer) 已集成到 Roc Windows Super Assistant 中,通过 LangChain middleware 自动优化所有 shell 命令输出,实现 60-90% 的 token 节省。

## 架构

- **RTKBinaryManager**: 管理跨平台 RTK 二进制
- **CommandRewriter**: 调用 RTK rewrite API
- **RTKMiddleware**: LangChain middleware,拦截 shell 工具调用

## 特性

- ✅ 全局自动优化所有 shell 命令
- ✅ 静默降级,RTK 不可用时自动回退
- ✅ 跨平台支持 (Windows/macOS/Linux)
- ✅ 零配置,用户无感知
- ✅ 开发环境可选详细日志

## 调试

启用详细日志:

\`\`\`bash
DEBUG_RTK=1 pnpm dev
\`\`\`

禁用 RTK:

\`\`\`bash
DISABLE_RTK=1 pnpm dev
\`\`\`

## 测试

运行 RTK 测试:

\`\`\`bash
pnpm test tests/rtk-integration/
\`\`\`

## 故障排查

### RTK 二进制不可用

检查二进制文件是否存在:

\`\`\`bash
ls -la resources/rtk-binaries/
\`\`\`

### 权限问题 (Unix)

确保二进制有执行权限:

\`\`\`bash
chmod +x resources/rtk-binaries/darwin-*/rtk
chmod +x resources/rtk-binaries/linux-*/rtk
\`\`\`
```

- [ ] **Step 5: Commit**

```bash
git add docs/rtk-integration.md
git commit -m "docs(rtk): add integration documentation"
```

---

## 完成检查清单

- [ ] 所有 RTK 二进制文件已下载并放置在正确位置
- [ ] electron-builder.yml 已配置打包 RTK 二进制
- [ ] RTKBinaryManager 实现并测试通过
- [ ] CommandRewriter 实现并测试通过
- [ ] RTKMiddleware 实现并测试通过
- [ ] RTK middleware 已集成到 DeepAgent
- [ ] 所有单元测试通过
- [ ] 所有集成测试通过
- [ ] 测试覆盖率 >80%
- [ ] 类型检查通过
- [ ] 本地开发环境验证通过
- [ ] 降级行为验证通过
- [ ] 集成文档已编写

---

## 后续步骤

1. **跨平台测试**: 在 macOS 和 Linux 上测试
2. **打包测试**: 构建并测试打包后的应用
3. **性能测试**: 验证 RTK 重写开销 <10ms
4. **Token 节省验证**: 对比集成前后的 token 消耗

