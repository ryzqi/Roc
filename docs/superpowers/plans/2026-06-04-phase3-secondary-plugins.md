# Phase 3: 次要插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Workspace、MCP、RTK 三个次要插件,完成插件生态的功能完整性

**Architecture:** 继续遵循插件化架构,每个插件独立实现,通过事件总线与其他插件通信。这些插件主要负责与外部系统集成。

**Tech Stack:** TypeScript 6.0.3, node-pty 1.1.0, @langchain/mcp-adapters 1.1.3

**Timeline:** Week 6-7 (10 个工作日)

**Dependencies:** 必须完成 Phase 1 (基础设施层) 和 Phase 2 (核心插件)

---

## 文件结构规划

### Workspace 插件 (~500 lines)

```
src/plugins/workspace/
├── index.ts                    # 插件入口 (~150 lines)
├── services/
│   ├── file-service.ts         # 文件操作 (~150 lines)
│   ├── git-service.ts          # Git 集成 (~120 lines)
│   └── terminal-service.ts     # 终端管理 (~100 lines)
└── package.json
```

### MCP 插件 (~400 lines)

```
src/plugins/mcp/
├── index.ts                    # 插件入口 (~150 lines)
├── services/
│   └── mcp-manager.ts          # MCP 服务器管理 (~200 lines)
├── adapters/
│   └── langchain-adapter.ts    # LangChain 适配器 (~80 lines)
└── package.json
```

### RTK 插件 (~300 lines)

```
src/plugins/rtk/
├── index.ts                    # 插件入口 (~120 lines)
├── services/
│   └── rtk-executor.ts         # RTK 执行器 (~150 lines)
└── package.json
```

---

## Week 6: Workspace 插件

### Task 1: 文件服务实现

**Files:**
- Create: `src/plugins/workspace/services/file-service.ts`
- Migrate from: `src/main/services/file-service.ts`
- Test: `tests/plugins/workspace/file-service.test.ts`

- [ ] **Step 1: 编写文件服务测试**

```typescript
// tests/plugins/workspace/file-service.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileService } from '../../../src/plugins/workspace/services/file-service';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

describe('FileService', () => {
  const testDir = './test-workspace';
  let fileService: FileService;
  
  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    fileService = new FileService();
  });
  
  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
  
  it('应该读取文件内容', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'Hello World', 'utf-8');
    
    const content = await fileService.readFile(filePath);
    expect(content).toBe('Hello World');
  });
  
  it('应该写入文件内容', async () => {
    const filePath = join(testDir, 'output.txt');
    
    await fileService.writeFile(filePath, 'Test Content');
    
    const content = await fileService.readFile(filePath);
    expect(content).toBe('Test Content');
  });
  
  it('应该列出目录内容', async () => {
    writeFileSync(join(testDir, 'file1.txt'), 'content1');
    writeFileSync(join(testDir, 'file2.txt'), 'content2');
    mkdirSync(join(testDir, 'subdir'));
    
    const entries = await fileService.listDirectory(testDir);
    
    expect(entries).toHaveLength(3);
    expect(entries.some(e => e.name === 'file1.txt' && e.type === 'file')).toBe(true);
    expect(entries.some(e => e.name === 'subdir' && e.type === 'directory')).toBe(true);
  });
  
  it('应该监听文件变化', async () => {
    const filePath = join(testDir, 'watched.txt');
    writeFileSync(filePath, 'initial');
    
    const changes: string[] = [];
    const unwatch = await fileService.watchFile(filePath, (event) => {
      changes.push(event.type);
    });
    
    // 修改文件
    writeFileSync(filePath, 'changed');
    await new Promise(resolve => setTimeout(resolve, 100));
    
    expect(changes).toContain('change');
    
    unwatch();
  });
  
  it('文件不存在时应抛出错误', async () => {
    await expect(
      fileService.readFile('/nonexistent/file.txt')
    ).rejects.toThrow('File not found');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/plugins/workspace/file-service.test.ts`
Expected: FAIL - FileService 不存在

- [ ] **Step 3: 实现文件服务**

```typescript
// src/plugins/workspace/services/file-service.ts
import { readFile, writeFile, readdir, stat, watch } from 'fs/promises';
import { existsSync } from 'fs';
import type { FSWatcher } from 'fs';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: Date;
}

export interface FileWatchEvent {
  type: 'change' | 'rename';
  filename: string;
}

export class FileService {
  private watchers = new Map<string, FSWatcher>();
  
  async readFile(filePath: string): Promise<string> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    try {
      return await readFile(filePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read file: ${filePath}`, { cause: error });
    }
  }
  
  async writeFile(filePath: string, content: string): Promise<void> {
    try {
      await writeFile(filePath, content, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to write file: ${filePath}`, { cause: error });
    }
  }
  
  async listDirectory(dirPath: string): Promise<FileEntry[]> {
    try {
      const entries = await readdir(dirPath);
      const results: FileEntry[] = [];
      
      for (const entry of entries) {
        const fullPath = `${dirPath}/${entry}`;
        const stats = await stat(fullPath);
        
        results.push({
          name: entry,
          path: fullPath,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modifiedAt: stats.mtime
        });
      }
      
      return results;
    } catch (error) {
      throw new Error(`Failed to list directory: ${dirPath}`, { cause: error });
    }
  }
  
  async watchFile(
    filePath: string,
    callback: (event: FileWatchEvent) => void
  ): Promise<() => void> {
    const watcher = watch(filePath);
    
    watcher.on('change', (eventType, filename) => {
      callback({
        type: eventType as 'change' | 'rename',
        filename: filename || filePath
      });
    });
    
    this.watchers.set(filePath, watcher as any);
    
    // 返回取消监听函数
    return () => {
      watcher.close();
      this.watchers.delete(filePath);
    };
  }
  
  cleanup(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test tests/plugins/workspace/file-service.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/plugins/workspace/services/file-service.ts tests/plugins/workspace/file-service.test.ts
git commit -m "feat(workspace): implement FileService

- 文件读写操作
- 目录列表
- 文件监听
- 错误处理"
```

---

### Task 2: Git 服务实现

**Files:**
- Create: `src/plugins/workspace/services/git-service.ts`
- Test: `tests/plugins/workspace/git-service.test.ts`

- [ ] **Step 1: 编写 Git 服务测试**

```typescript
// tests/plugins/workspace/git-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { GitService } from '../../../src/plugins/workspace/services/git-service';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

describe('GitService', () => {
  const testRepo = './test-git-repo';
  let gitService: GitService;
  
  beforeEach(() => {
    // 创建测试 Git 仓库
    if (existsSync(testRepo)) {
      rmSync(testRepo, { recursive: true, force: true });
    }
    mkdirSync(testRepo, { recursive: true });
    
    execSync('git init', { cwd: testRepo });
    execSync('git config user.name "Test User"', { cwd: testRepo });
    execSync('git config user.email "test@example.com"', { cwd: testRepo });
    
    // 创建初始提交
    writeFileSync(join(testRepo, 'README.md'), '# Test Repo');
    execSync('git add .', { cwd: testRepo });
    execSync('git commit -m "Initial commit"', { cwd: testRepo });
    
    gitService = new GitService();
  });
  
  it('应该获取 Git 状态', async () => {
    // 修改文件
    writeFileSync(join(testRepo, 'README.md'), '# Modified');
    writeFileSync(join(testRepo, 'new.txt'), 'new file');
    
    const status = await gitService.getStatus(testRepo);
    
    expect(status.modified).toContain('README.md');
    expect(status.untracked).toContain('new.txt');
  });
  
  it('应该提交更改', async () => {
    writeFileSync(join(testRepo, 'test.txt'), 'test content');
    execSync('git add test.txt', { cwd: testRepo });
    
    await gitService.commit(testRepo, 'Add test file');
    
    const log = execSync('git log --oneline', { cwd: testRepo }).toString();
    expect(log).toContain('Add test file');
  });
  
  it('应该列出分支', async () => {
    execSync('git branch feature-branch', { cwd: testRepo });
    
    const branches = await gitService.listBranches(testRepo);
    
    expect(branches).toContain('main');
    expect(branches).toContain('feature-branch');
  });
  
  it('应该切换分支', async () => {
    execSync('git branch new-branch', { cwd: testRepo });
    
    await gitService.checkout(testRepo, 'new-branch');
    
    const currentBranch = execSync('git branch --show-current', { 
      cwd: testRepo 
    }).toString().trim();
    expect(currentBranch).toBe('new-branch');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/plugins/workspace/git-service.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 Git 服务**

```typescript
// src/plugins/workspace/services/git-service.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GitStatus {
  branch: string;
  modified: string[];
  untracked: string[];
  staged: string[];
}

export class GitService {
  async getStatus(repoPath: string): Promise<GitStatus> {
    try {
      const { stdout } = await execAsync('git status --porcelain --branch', {
        cwd: repoPath
      });
      
      const lines = stdout.trim().split('\n');
      const branchLine = lines[0];
      const branch = branchLine.match(/## (.+?)(?:\.\.\.|$)/)?.[1] || 'main';
      
      const modified: string[] = [];
      const untracked: string[] = [];
      const staged: string[] = [];
      
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        
        const status = line.substring(0, 2);
        const file = line.substring(3);
        
        if (status === '??') untracked.push(file);
        else if (status[0] !== ' ') staged.push(file);
        else if (status[1] !== ' ') modified.push(file);
      }
      
      return { branch, modified, untracked, staged };
    } catch (error) {
      throw new Error(`Failed to get git status: ${repoPath}`, { cause: error });
    }
  }
  
  async commit(repoPath: string, message: string): Promise<void> {
    try {
      await execAsync(`git commit -m "${message}"`, { cwd: repoPath });
    } catch (error) {
      throw new Error('Failed to commit', { cause: error });
    }
  }
  
  async listBranches(repoPath: string): Promise<string[]> {
    try {
      const { stdout } = await execAsync('git branch --format="%(refname:short)"', {
        cwd: repoPath
      });
      
      return stdout.trim().split('\n').filter(b => b);
    } catch (error) {
      throw new Error('Failed to list branches', { cause: error });
    }
  }
  
  async checkout(repoPath: string, branch: string): Promise<void> {
    try {
      await execAsync(`git checkout ${branch}`, { cwd: repoPath });
    } catch (error) {
      throw new Error(`Failed to checkout branch: ${branch}`, { cause: error });
    }
  }
  
  async add(repoPath: string, files: string[]): Promise<void> {
    try {
      const fileList = files.join(' ');
      await execAsync(`git add ${fileList}`, { cwd: repoPath });
    } catch (error) {
      throw new Error('Failed to add files', { cause: error });
    }
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test tests/plugins/workspace/git-service.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/plugins/workspace/services/git-service.ts tests/plugins/workspace/git-service.test.ts
git commit -m "feat(workspace): implement GitService

- Git 状态查询
- 提交更改
- 分支管理
- 文件暂存"
```

---

### Task 3: Terminal 服务与 Workspace 插件集成

**Files:**
- Create: `src/plugins/workspace/services/terminal-service.ts`
- Create: `src/plugins/workspace/index.ts`
- Test: `tests/plugins/workspace/terminal-service.test.ts`
- Test: `tests/plugins/workspace/index.test.ts`

- [ ] **Step 1: 实现 TerminalService (基于 node-pty)**

```typescript
// src/plugins/workspace/services/terminal-service.ts
import * as pty from 'node-pty';

export interface Terminal {
  id: string;
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export class TerminalService {
  private terminals = new Map<string, pty.IPty>();
  
  create(id: string, shell?: string): Terminal {
    const terminal = pty.spawn(shell || 'bash', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
      cwd: process.cwd(),
      env: process.env as any
    });
    
    this.terminals.set(id, terminal);
    
    return {
      id,
      pid: terminal.pid,
      write: (data: string) => terminal.write(data),
      resize: (cols: number, rows: number) => terminal.resize(cols, rows),
      kill: () => {
        terminal.kill();
        this.terminals.delete(id);
      }
    };
  }
  
  onData(id: string, callback: (data: string) => void): () => void {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error(`Terminal not found: ${id}`);
    
    const listener = terminal.onData(callback);
    return () => listener.dispose();
  }
  
  cleanup(): void {
    for (const terminal of this.terminals.values()) {
      terminal.kill();
    }
    this.terminals.clear();
  }
}
```

- [ ] **Step 2: 实现 Workspace 插件入口**

```typescript
// src/plugins/workspace/index.ts
import type { Plugin, PluginManifest, PluginContext } from '../../kernel/types';
import { z } from 'zod';
import { FileService } from './services/file-service';
import { GitService } from './services/git-service';
import { TerminalService } from './services/terminal-service';

export default class WorkspacePlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: '@roc/plugin-workspace',
    version: '1.0.0',
    name: 'Workspace Management',
    description: '工作区、文件、Git、终端管理',
    author: 'Roc Team',
    dependencies: { kernel: '1.0.0' },
    capabilities: [
      {
        name: 'workspace.file.read',
        version: '1.0.0',
        inputSchema: z.object({ path: z.string() }),
        outputSchema: z.string()
      },
      {
        name: 'workspace.git.status',
        version: '1.0.0',
        inputSchema: z.object({ repoPath: z.string() }),
        outputSchema: z.object({
          branch: z.string(),
          modified: z.array(z.string()),
          untracked: z.array(z.string())
        })
      },
      {
        name: 'workspace.terminal.create',
        version: '1.0.0',
        inputSchema: z.object({ id: z.string(), shell: z.string().optional() }),
        outputSchema: z.object({ id: z.string(), pid: z.number() })
      }
    ],
    core: false,
    loadPriority: 0
  };
  
  private fileService!: FileService;
  private gitService!: GitService;
  private terminalService!: TerminalService;
  
  async initialize(context: PluginContext): Promise<void> {
    this.fileService = new FileService();
    this.gitService = new GitService();
    this.terminalService = new TerminalService();
    
    context.logger.info('Workspace plugin initialized');
  }
  
  async shutdown(): Promise<void> {
    this.fileService.cleanup();
    this.terminalService.cleanup();
  }
  
  async healthCheck() {
    return { status: 'healthy' as const };
  }
  
  readonly fastPath = {
    readFile: (path: string) => this.fileService.readFile(path),
    getGitStatus: (repoPath: string) => this.gitService.getStatus(repoPath),
    createTerminal: (id: string, shell?: string) => this.terminalService.create(id, shell)
  };
}
```

- [ ] **Step 3: 测试并提交**

Run: `pnpm test tests/plugins/workspace/`
Expected: PASS

```bash
git add src/plugins/workspace/ tests/plugins/workspace/
git commit -m "feat(workspace): complete Workspace plugin

- FileService: 文件读写、监听
- GitService: Git 状态、提交、分支管理
- TerminalService: 终端创建和管理
- 插件入口和能力注册"
```

---

## Week 7: MCP & RTK 插件

### Task 4: MCP 插件实现

**Files:**
- Create: `src/plugins/mcp/index.ts`
- Create: `src/plugins/mcp/services/mcp-manager.ts`
- Test: `tests/plugins/mcp/mcp-manager.test.ts`

- [ ] **Step 1: 实现 MCP Manager**

```typescript
// src/plugins/mcp/services/mcp-manager.ts
import { MCPClient } from '@langchain/mcp-adapters';

export interface MCPServer {
  id: string;
  name: string;
  url: string;
  status: 'connected' | 'disconnected' | 'error';
}

export class MCPManager {
  private servers = new Map<string, MCPClient>();
  
  async connect(id: string, url: string): Promise<MCPServer> {
    try {
      const client = new MCPClient({ url });
      await client.connect();
      
      this.servers.set(id, client);
      
      return {
        id,
        name: id,
        url,
        status: 'connected'
      };
    } catch (error) {
      throw new Error(`Failed to connect to MCP server: ${url}`, { cause: error });
    }
  }
  
  async disconnect(id: string): Promise<void> {
    const client = this.servers.get(id);
    if (client) {
      await client.disconnect();
      this.servers.delete(id);
    }
  }
  
  async query(id: string, query: string): Promise<unknown> {
    const client = this.servers.get(id);
    if (!client) throw new Error(`MCP server not found: ${id}`);
    
    return await client.query(query);
  }
  
  async cleanup(): Promise<void> {
    for (const [id, client] of this.servers) {
      await client.disconnect();
    }
    this.servers.clear();
  }
}
```

- [ ] **Step 2: 实现 MCP 插件入口**

```typescript
// src/plugins/mcp/index.ts
import type { Plugin, PluginManifest, PluginContext } from '../../kernel/types';
import { z } from 'zod';
import { MCPManager } from './services/mcp-manager';

export default class MCPPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: '@roc/plugin-mcp',
    version: '1.0.0',
    name: 'MCP Integration',
    description: 'Model Context Protocol 集成',
    author: 'Roc Team',
    dependencies: {
      plugins: ['@roc/plugin-agent'],
      kernel: '1.0.0'
    },
    capabilities: [
      {
        name: 'mcp.connect',
        version: '1.0.0',
        inputSchema: z.object({ id: z.string(), url: z.string() }),
        outputSchema: z.object({ id: z.string(), status: z.string() })
      },
      {
        name: 'mcp.query',
        version: '1.0.0',
        inputSchema: z.object({ id: z.string(), query: z.string() }),
        outputSchema: z.unknown()
      }
    ],
    core: false,
    loadPriority: 1
  };
  
  private manager!: MCPManager;
  
  async initialize(context: PluginContext): Promise<void> {
    this.manager = new MCPManager();
    context.logger.info('MCP plugin initialized');
  }
  
  async shutdown(): Promise<void> {
    await this.manager.cleanup();
  }
  
  async healthCheck() {
    return { status: 'healthy' as const };
  }
  
  readonly fastPath = {
    connect: (id: string, url: string) => this.manager.connect(id, url),
    query: (id: string, query: string) => this.manager.query(id, query)
  };
}
```

- [ ] **Step 3: 测试并提交**

Run: `pnpm test tests/plugins/mcp/`
Expected: PASS

```bash
git add src/plugins/mcp/ tests/plugins/mcp/
git commit -m "feat(mcp): implement MCP plugin

- MCP 服务器连接管理
- 查询功能
- 与 Agent 插件集成"
```

---

### Task 5: RTK 插件实现

**Files:**
- Create: `src/plugins/rtk/index.ts`
- Create: `src/plugins/rtk/services/rtk-executor.ts`
- Test: `tests/plugins/rtk/rtk-executor.test.ts`

- [ ] **Step 1: 实现 RTK Executor**

```typescript
// src/plugins/rtk/services/rtk-executor.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execAsync = promisify(exec);

export interface RTKTool {
  id: string;
  name: string;
  description: string;
}

export class RTKExecutor {
  constructor(private readonly rtkBinPath: string) {}
  
  async listTools(): Promise<RTKTool[]> {
    try {
      const { stdout } = await execAsync(`"${this.rtkBinPath}" list`);
      const lines = stdout.trim().split('\n');
      
      return lines.map(line => {
        const [id, name, ...desc] = line.split('\t');
        return {
          id,
          name,
          description: desc.join(' ')
        };
      });
    } catch (error) {
      throw new Error('Failed to list RTK tools', { cause: error });
    }
  }
  
  async execute(toolId: string, args: Record<string, unknown>): Promise<string> {
    try {
      const argsJson = JSON.stringify(args);
      const { stdout } = await execAsync(
        `"${this.rtkBinPath}" execute ${toolId} '${argsJson}'`
      );
      return stdout;
    } catch (error) {
      throw new Error(`Failed to execute RTK tool: ${toolId}`, { cause: error });
    }
  }
}
```

- [ ] **Step 2: 实现 RTK 插件入口**

```typescript
// src/plugins/rtk/index.ts
import type { Plugin, PluginManifest, PluginContext } from '../../kernel/types';
import { z } from 'zod';
import { RTKExecutor } from './services/rtk-executor';
import { join } from 'path';

export default class RTKPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: '@roc/plugin-rtk',
    version: '1.0.0',
    name: 'RTK Tools',
    description: 'RTK 工具集成',
    author: 'Roc Team',
    dependencies: {
      plugins: ['@roc/plugin-workspace'],
      kernel: '1.0.0'
    },
    capabilities: [
      {
        name: 'rtk.list',
        version: '1.0.0',
        inputSchema: z.object({}),
        outputSchema: z.array(z.object({
          id: z.string(),
          name: z.string(),
          description: z.string()
        }))
      },
      {
        name: 'rtk.execute',
        version: '1.0.0',
        inputSchema: z.object({
          toolId: z.string(),
          args: z.record(z.unknown())
        }),
        outputSchema: z.string()
      }
    ],
    core: false,
    loadPriority: 1
  };
  
  private executor!: RTKExecutor;
  
  async initialize(context: PluginContext): Promise<void> {
    // RTK 二进制路径从配置读取
    const rtkPath = await context.config.get('rtk.binaryPath') as string 
      || join(process.resourcesPath, 'rtk-binaries/win32-x64/rtk.exe');
    
    this.executor = new RTKExecutor(rtkPath);
    context.logger.info('RTK plugin initialized');
  }
  
  async shutdown(): Promise<void> {}
  
  async healthCheck() {
    return { status: 'healthy' as const };
  }
  
  readonly fastPath = {
    listTools: () => this.executor.listTools(),
    execute: (toolId: string, args: Record<string, unknown>) => 
      this.executor.execute(toolId, args)
  };
}
```

- [ ] **Step 3: 测试并提交**

Run: `pnpm test tests/plugins/rtk/`
Expected: PASS

```bash
git add src/plugins/rtk/ tests/plugins/rtk/
git commit -m "feat(rtk): implement RTK plugin

- RTK 工具列表
- 工具执行
- 与 Workspace 插件集成"
```

---

## 验收标准

- [ ] Workspace 插件所有测试通过
- [ ] MCP 插件能成功连接和查询
- [ ] RTK 插件能列出和执行工具
- [ ] 所有插件文件 <200 lines
- [ ] 插件间依赖正确配置
- [ ] 集成测试通过

---

## 集成测试

```typescript
// tests/integration/phase3-integration.test.ts
describe('Phase 3 Integration', () => {
  it('Workspace + Agent: 读取文件并发送到 Agent', async () => {
    const workspacePlugin = await loader.loadPlugin(WorkspacePlugin);
    const agentPlugin = await loader.loadPlugin(AgentPlugin);
    
    const content = await workspacePlugin.fastPath.readFile('/test/file.txt');
    const sessionId = await agentPlugin.fastPath.createSession('/test', { model: 'gpt-4' });
    
    const stream = agentPlugin.fastPath.streamMessage(sessionId, `Analyze: ${content}`);
    
    expect(stream).toBeDefined();
  });
});
```

---

## Phase 3 完成标志

✅ Workspace/MCP/RTK 三个插件全部实现  
✅ 所有测试通过  
✅ 集成测试通过  
✅ 代码已提交  

**预计完成时间:** 2 周 (10 个工作日)

---

*Plan generated on 2026-06-04*
*Based on design document: docs/superpowers/specs/2026-06-04-architecture-modernization-design.md*

