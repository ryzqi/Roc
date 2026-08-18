# Roc

Roc 是一个基于 **Electron + React** 的本地 AI Agent 桌面应用。它把 LangGraph / DeepAgents 执行时、插件化 Kernel、类型安全 IPC、工作区/终端/MCP/Skills/Memory/Task 工作台，以及面向生产的工具调用护栏整合进同一套 desktop runtime。

设计目标不是“又一个聊天壳”，而是一个可在真实 Windows 工作区上持续跑任务的 **Agent Harness**：路径边界清晰、工具调用可恢复、上下文可控、密钥不进仓库。

- 平台：Windows 11 优先（也打包了 macOS/Linux 的 RTK binary）
- 运行时：Electron main / preload / renderer 三层隔离
- Agent 内核：`deepagents` + LangGraph checkpointer / store
- 数据面：SQLite + Electron `safeStorage` 加密密钥
- 包管理：`pnpm`

---

## 功能总览

### 1. Chat Agent Runtime

- 多线程会话、流式消息、工具调用过程可视化
- run / plan 双模式：plan 侧收紧写能力与工具可见性
- 图片附件、中断/继续、run event 队列
- Provider 配置支持 OpenAI 兼容链路与 Anthropic 系模型

### 2. Agent Harness（核心）

Roc 的 harness 不是单独服务，而是把 DeepAgents 原生能力与 Roc 本地边界粘合起来的执行栈：

```
UI / Task Workbench
        │ IPC (Zod schema)
        ▼
Agent Plugin (run lifecycle / recovery / event queue)
        ▼
DeepAgent Executor
        ▼
Context Harness + createDeepAgent(buildDeepAgent)
        ▼
Middleware stack + CompositeBackend + Tools
        ▼
Workspace FS / Shell / MCP / Skills / Memory / Background Tasks
```

#### 2.1 `createDeepAgent` 构建入口

主入口：`src/main/services/deep-agent/agent-builder.ts`

每次 run 会：

1. 注册 Roc harness profile（见下）
2. 按 mode 选择 tools / subagents / memory
3. 组装 middleware 护栏栈
4. 调用 DeepAgents `createDeepAgent(...)`

关键配置：

- **model / systemPrompt / tools / subagents**
- **backend**：Roc `CompositeBackend`（虚拟路由）
- **store / checkpointer**：LangGraph 持久化与 memory 后端
- **permissions**：文件系统 allow/deny
- **interruptOn**：需要用户确认的工具中断点
- **middleware**：Forge 护栏 + Roc 路径策略 + RTK + 幂等 + compaction

#### 2.2 Harness Profile

文件：`src/main/services/deep-agent/harness-profiles.ts`

Roc 通过 DeepAgents `createHarnessProfile` / `registerHarnessProfile` 注册 provider 级 profile：

- 对 `anthropic` / `openai` 都生效（Roc 模型最终落在这两类 provider key）
- **排除** 内置 `SummarizationMiddleware`  
  原因：Roc 使用自研分层压缩，不走 DeepAgents 默认 `/conversation_history` 卸载路径
- **排除** 内置 `execute` shell 工具  
  原因：DeepAgents native `execute` 不受 Roc shell 风险策略约束；Roc 只暴露受控 `run_shell_command`

#### 2.3 Context Harness

文件：`src/main/services/deep-agent/context/context-assembler.ts`

在真正建 agent 前，Roc 先组装一轮“上下文装备”：

- 生成稳定分层 system prompt blocks（利于 prompt cache）
- 注入 mode / workspace / workflow / skill 说明
- 附加 `session_search` 等上下文工具
- 解析 memory / skills 源路径
- 绑定 runtime workspace identity

这层把“提示词拼装 + 工具装配 + 作用域”从执行器里抽出来，避免每次 run 各写一套。

#### 2.4 虚拟文件系统路由

文件：

- `src/main/services/deep-agent/backend.ts`
- `src/main/services/deep-agent/filesystem-tool-contract.ts`

Agent 文件工具只认三条虚拟路由：

| 路由 | 含义 | 权限 |
| --- | --- | --- |
| `/workspace/**` | 当前选中工作区 | 读写（plan 模式只读） |
| `/memory/**` | DeepAgents 语义 memory（如 `AGENTS.md` / `USER.md`） | 受 memory 策略与安全扫描约束 |
| `/skills/**` | 技能目录 | 只读 |

硬边界：

- 拒绝 Windows 绝对路径 / UNC / `..` 穿越
- `write_file` 只创建新文件；改已有文件必须 `read_file` + `edit_file`
- `delete_file` 仅允许 `/workspace/` 下目标
- **不要把 `/workspace/...` 当 shell cwd**。shell 使用真实 Windows 工作目录

#### 2.5 Shell 与 RTK

- `run_shell_command`：Roc 自定义 command tool
- shell 默认 cwd = 当前 workspace 根
- `shell-path-policy` / `shell-path-guard` 拦截虚拟路径泄漏
- RTK（`resources/rtk-binaries/**`）压缩常见 shell 输出，降低上下文膨胀
- RTK 不可用时按 shell 风险策略回退，不静默绕过 deny

详见 [docs/rtk-integration.md](docs/rtk-integration.md)。

#### 2.6 工具面

内置 DeepAgents 可见工具 allowlist（Roc 主动暴露）：

- `write_todos`, `task`
- `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`

Roc 追加 / 编排的能力包括：

- `run_shell_command`
- `ask_user`
- `web_read` / research subagent
- background task tools（创建/查询/更新/取消后台任务）
- `session_search`（SQLite FTS）
- MCP tools / Skills / runtime-tools（由 enabled capabilities 注入）

Plan 模式会进一步：

- 隐藏高风险写工具
- 挂载只读 memory middleware
- 限制 subagent 工具范围

#### 2.7 Middleware 护栏栈（Forge + Roc）

构建顺序（逻辑上从外到内，见 `agent-builder.ts`）：

1. Hooks middleware（可选）
2. Plan-mode guards（只读 memory / tool exposure / default path）
3. Shell path policy
4. RTK middleware
5. Network-sensitive tool retry（如 `web_read` / `web_search`）
6. Tool protocol 规范化
7. Tool-effect idempotency（side-effect 幂等）
8. Error budget / iteration tracking
9. Filesystem path policy + filesystem tool error 映射
10. Context compaction（Roc 分层压缩；可叠加 Forge tiered compaction）
11. Rescue parsing（修复野生 tool-call 格式）
12. Tool resolution / runtime error mapping
13. Forge cleanup

Forge 模块说明见 `src/main/services/forge-guardrails/`。目标是把“模型想调用工具”和“框架强制可执行、可恢复、可审计”分开。

#### 2.8 上下文压缩与 Checkpoint

- **cheap-first compaction**：先砍超大 tool result / 中段历史 / 旧 tool payload，必要时再做摘要
- protected head 保留任务意图与关键配对
- tool pair 按 `tool_call_id` 恢复，避免截断后 API 报错
- LangGraph checkpointer + SQLite：支持 run 恢复、thread 连续性
- recovery policy：对 transient provider/network/5xx/429 等做有限次退避恢复

#### 2.9 Memory / Skills / Background Tasks

- Memory：DeepAgents native memory 语义 + Roc store backend + capacity / security scan
- Skills：`/skills/` 挂载，支持显式 skill 注入与回合级启用
- Background Tasks：任务工作台与 chat 隔离；创建时绑定 runtime workspace 与 capability 快照，避免“聊天线程能力”和“后台任务能力”漂移

### 3. 插件化 Kernel

`src/main/plugins/`：

| 插件 | 职责 |
| --- | --- |
| `agent` | DeepAgents 执行器、会话、run 生命周期 |
| `workspace` | 工作区、文件、Git、终端 |
| `mcp` | MCP server 注册与工具/资源调用 |
| `skills` | 技能发现与启用 |
| `task` | 任务看板 / 详情 / 后台任务 |
| `memory` | memory 存储与预览 |
| `app` | 应用设置与主题 |
| `diagnostics` | 诊断与指标 |
| `runtime-tools` | 运行时小工具 |

插件经 Capability Registry 暴露能力；renderer 不直接碰 Node/Electron 内部 API。

### 4. 类型安全 IPC

- 合同注册：`src/shared/ipc-registry.ts`；payload Zod schema 位于 `src/shared/schemas/`
- 生成：`pnpm generate:ipc`
- 漂移检查：`pnpm check:ipc`
- preload 只暴露受控 bridge

### 5. 工作区与终端

- 多工作区选择
- 文件浏览 / diff
- `node-pty` 终端会话
- Git workbench 能力（本地仓库场景）

### 6. 设置与密钥

- Provider / 模型 / 高级参数
- API Key 走 `SecretManager` + Electron `safeStorage`，落本地加密存储（默认 `~/.roc`）
- **仓库内不保存真实密钥**

### 7. 数据与运维

- SQLite 连接策略、migration ledger、backup/restore/rebuild
- retention cleanup / health probe
- 打包脚本处理 `better-sqlite3` / `node-pty` ABI 与 asarUnpack

---

## 架构分层

```
src/
  main/           # Electron 主进程：Kernel、插件、Agent、DB、IPC
  preload/        # 类型安全 bridge
  renderer/       # React 19 UI
  shared/         # 跨进程 schema / types / IPC 合同
  rtk-integration/# shell 输出压缩中间件
tests/            # main / renderer / shared / smoke
scripts/          # dev、打包、IPC 生成、验证
resources/        # 图标与 RTK binaries
```

进程边界：

1. **renderer**：只做 UI 与用户交互
2. **preload**：白名单 IPC
3. **main**：真实文件系统、网络、密钥、Agent 执行

---

## 快速开始

### 环境要求

- Windows 11 + PowerShell（主要开发/验证环境）
- Node.js（与仓库当前 Electron/Vite 工具链兼容）
- `pnpm`

### 安装与开发

```powershell
pnpm install
pnpm dev
```

`pnpm dev` 会先处理 native module ABI，再启动 Electron + Vite。

### 常用命令

```powershell
pnpm typecheck
pnpm test
pnpm test -- tests/main/path/to/file.test.ts
pnpm build
pnpm package:dir
pnpm generate:ipc
pnpm check:ipc
pnpm smoke:electron
pnpm verify:native-packaging
pnpm verify:paths
```

---

## Agent Harness 开发入口

如果你要改 agent 行为，优先从这些文件读起：

| 区域 | 路径 |
| --- | --- |
| Agent 构建 | `src/main/services/deep-agent/agent-builder.ts` |
| 执行器 | `src/main/plugins/agent/deep-agent-executor.ts` |
| Harness profile | `src/main/services/deep-agent/harness-profiles.ts` |
| Context 组装 | `src/main/services/deep-agent/context/` |
| 文件路由合同 | `src/main/services/deep-agent/filesystem-tool-contract.ts` |
| Backend 路由 | `src/main/services/deep-agent/backend.ts` |
| Shell 边界 | `src/main/services/deep-agent/shell-path-*.ts` |
| 护栏 | `src/main/services/forge-guardrails/` |
| 恢复策略 | `src/main/plugins/agent/recovery-policy.ts` |
| RTK | `src/rtk-integration/` |

验收时重点盯：

1. `/workspace` 只用于 file tools，不泄漏进 shell cwd
2. plan/run 工具可见性符合预期
3. compaction 后 tool pair 仍合法
4. 后台任务 workspace / capability 与创建快照一致
5. 密钥只出现在本地 secret storage，不进日志明文

---

## 安全与隐私

Roc 默认把敏感状态放在用户本机：

- 配置/日志/memory/skills/artifacts：`~/.roc`（或运行时 paths 覆盖）
- Provider secrets：SQLite + `safeStorage` 加密
- 本地 runtime 缓存：`.runtime/`、`.artifacts/`（已 gitignore）

推送/贡献前请确认：

- 不要提交 `.env`、真实 API Key、私钥、导出的 chat 数据库
- 不要提交 `~/.roc`、本机路径下的用户 memory
- 测试里只允许明显假数据（如 `sk-ant-test`、AWS 文档示例 `AKIAIOSFODNN7EXAMPLE`）
- 二进制与大文件：仓库已包含跨平台 RTK binary，新增大文件请先评估必要性

当前仓库安全扫描结论（推送前）：

- 未发现真实私钥 / GitHub PAT / 生产 API Key
- 命中的 credential 样式字符串均位于测试夹具或安全扫描自身规则
- `.runtime/`、`.artifacts/`、`dist/`、`node_modules/`、本地 `AGENTS.md` / `CLAUDE.md` 已被忽略

注意：git commit author 使用开发者身份信息；推送到 GitHub 后提交元数据会公开。

---

## 测试约定

- Vitest，测试位于 `tests/**`
- 断言要钉业务结果 / 错误分支，避免空洞的 `toBeDefined()`
- bug fix 优先 red-green
- UI 改动补 renderer 测试；响应式风险可跑 smoke 脚本

---

## 打包

```powershell
pnpm build
pnpm package:dir
```

`electron-builder.yml` 会：

- 打包 `dist/**`
- 解包 `better-sqlite3` / `node-pty`
- 附带当前平台需要的 RTK binary 与图标

---

## 状态

当前版本：`0.1.0`（积极开发中）

公开仓库目标：

- 让他人理解 Roc 的 agent harness 边界
- 方便 issue / PR 对齐执行层而不是只改提示词
- 保持密钥与本机运行态默认不进 Git

---

## License

未单独声明许可证前，默认保留所有权利。如需开源许可，请在仓库中补充 `LICENSE`。
