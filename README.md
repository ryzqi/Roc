# Roc

Roc 是面向个人研究者的 **macOS 科研工作台**。默认入口是研究项目，而不是通用对话页。项目下组织文献、证据、想法、实验、图稿和论文；研究助手、文件、任务、连接器、技能和诊断作为科研服务挂在当前项目上。

底层仍是 Electron + React 本地桌面运行时：LangGraph / DeepAgents、插件化 Kernel、类型安全 IPC、SQLite，以及受控工具调用。路径边界清晰，密钥不进仓库。

- 平台：仅 macOS，Apple Silicon 与 Intel（按架构打包 RTK 与科研工具链）
- 默认界面：科研工作台（`page=research`）
- Agent：研究助手与阶段角色，不是产品主页
- 数据面：SQLite + Electron `safeStorage`，默认落 `~/.roc`
- 包管理：`pnpm@12.5.1`

术语见 [CONTEXT.md](CONTEXT.md)。壳层与阶段界面见 [docs/research-workbench.md](docs/research-workbench.md)。

---

## 科研工作台

打开应用后进入项目壳层。没有项目时是空态，创建后进入该项目的总览，而不是 Chat。

| 区域 | 作用 |
| --- | --- |
| 项目总览 | 当前阶段、人工闸门、索引、运行与产物。只读。 |
| 阶段工作区 | 按阶段组编辑文献、知识、构思、实验、图稿、正文、文稿与导出。 |
| 活动与运行 | 阶段运行、任务审批、后台作业。 |
| 溯源 | 工件、证据、实验/图稿/模型来源。 |
| 科研服务 | 研究助手、文件与代码、连接器、技能、项目记忆、运行诊断。 |

11 个研究阶段：发现、检索、阅读、构思、方案、实验/数据、绘图、写作、审稿、修订、导出。证据集、提纲、正文改写、图稿和最终导出走人工闸门。

阶段工作区已接入：

- 文献库 / 知识库 / Idea Canvas
- Python、R、Julia 实验运行
- Matplotlib 图稿渲染与发布
- LaTeX 文稿、模板编译
- 批准正文与图稿的最终 ZIP 导出

合同细节：

- [Idea Canvas](docs/research-ideas.md)
- [实验运行](docs/research-experiments.md)
- [图稿](docs/research-figures.md)
- [最终导出](docs/research-exports.md)

---

## 架构分层

```
src/
  main/           # Kernel、插件、Agent、科研域、DB、IPC
  preload/        # 类型安全 bridge
  renderer/       # React 19 UI；默认科研壳
  shared/         # schema / types / IPC 合同
  rtk-integration/# shell 输出压缩
tests/
scripts/
resources/        # 图标、RTK binaries、科研工具链源、阶段 Skill
```

进程边界：renderer 只做 UI；preload 白名单 IPC；main 负责文件系统、网络、密钥、Agent 与科研生产。

---

## 研究助手运行时

对话页是科研服务，不是默认首页。阶段角色走各自 Skill 白名单；通用研究助手走 DeepAgents harness。

```
科研工作台 / 阶段角色 / 研究助手
        │ IPC (Zod schema)
        ▼
Research plugin + Agent plugin
        ▼
DeepAgent Executor
        ▼
Context Harness + createDeepAgent
        ▼
Middleware + CompositeBackend + Tools
        ▼
Workspace FS / Shell / MCP / Skills / Memory / 科研生产工具
```

主入口：`src/main/services/deep-agent/agent-builder.ts`

每次 run 会注册 harness profile、按 mode 选择 tools / subagents / memory、组装护栏，再调用 DeepAgents `createDeepAgent(...)`。

Harness profile（`harness-profiles.ts`）：

- 对 `anthropic` / `openai` 生效
- 排除内置 `SummarizationMiddleware`（Roc 自研分层压缩）
- 排除内置 `execute`；只暴露受控 `run_shell_command`

文件工具只认 `/workspace/**`、`/memory/**`、`/skills/**`。不要把 `/workspace/...` 当 shell cwd。shell 使用真实 macOS 工作目录。RTK 见 [docs/rtk-integration.md](docs/rtk-integration.md)。

未手动填写的模型上下文预算运行时回落到 `500_000`。单次最大输出（`maxTokens`）未填时不发送，由上游默认。

改 agent 行为优先读：

| 区域 | 路径 |
| --- | --- |
| Agent 构建 | `src/main/services/deep-agent/agent-builder.ts` |
| 执行器 | `src/main/plugins/agent/deep-agent-executor.ts` |
| Harness profile | `src/main/services/deep-agent/harness-profiles.ts` |
| Context 组装 | `src/main/services/deep-agent/context/` |
| 文件路由 | `src/main/services/deep-agent/filesystem-tool-contract.ts` |
| 护栏 | `src/main/services/forge-guardrails/` |
| 科研插件 | `src/main/plugins/research/` |
| 科研壳 | `src/renderer/views/research/` |

---

## 插件化 Kernel

`src/main/plugins/`，由 `src/main/main-kernel-bootstrap.ts` 注册：

| 插件 | 职责 |
| --- | --- |
| `research` | 研究项目、阶段、文献、证据、实验、图稿、导出 |
| `agent` | DeepAgents 执行器、会话、run 生命周期 |
| `workspace` | 工作区、文件、Git、终端 |
| `mcp` | MCP server 与工具/资源 |
| `skills` | 技能发现与启用 |
| `task` | 任务看板 / 后台任务 |
| `memory` | memory 存储与预览 |
| `app` | 应用设置与主题 |
| `diagnostics` | 诊断与指标 |
| `runtime-tools` | RTK 等运行时小工具 |

科研插件为 `critical`。renderer 不直接碰 Node/Electron 内部 API。

IPC 合同：`src/shared/ipc-registry.ts`。生成与漂移检查：

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc generate:ipc
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
```

---

## 快速开始

环境：macOS + zsh、兼容当前 Electron/Vite 的 Node.js、`pnpm`。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc install
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc dev
```

`dev` 先验证原生模块，再启动 Electron + Vite。默认打开科研工作台。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc typecheck
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:dir
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:mac
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:mac
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc verify:native-packaging
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc verify:paths
```

---

## 安全与隐私

- 配置 / 日志 / memory / skills / 科研库与导出：`~/.roc`
- Provider secrets：SQLite + `safeStorage`
- 本地缓存：`.runtime/`、`.artifacts/`（gitignore）
- 仓库不保存真实密钥。测试只允许明显假数据

推送前确认：不要提交 `.env`、真实 API Key、`~/.roc`、导出的 chat 数据库。二进制只保留 macOS arm64/x64 RTK。

---

## 测试

端到端是唯一测试机制。不写单元测试。每次结束都留下可复核、可重复的工件。

- `pnpm test`：应用端到端，工件 `.artifacts/wave1/electron-smoke.json`
- `pnpm smoke:performance`：长会话端到端，工件 `.artifacts/wave1/performance-smoke.json`
- `pnpm smoke:mac`：已打包应用端到端，工件 `.artifacts/mac-package/result.json` 与截图
- 科研工具链：`node scripts/research/smoke.ts`，工件为输出目录中的 `result.json`

---

## 打包

仅 darwin。以下命令在当前项目路径执行。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc install --frozen-lockfile
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/prepare.ts --arch arm64 --output /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:mac
```

`package:mac`：校验 live 科研工具链 → `pnpm build`（含 typecheck）→ 首屏体积检查 → `electron-builder --mac --dir` → `smoke-mac`。输出当前架构的 `.app`。不会再打 zip/dmg。构建缓存在 `.runtime/`，验证截图在 `.artifacts/mac-package/`。

- Apple Silicon：`release/mac-arm64/Roc.app`
- Intel：在 x64 Mac 上安装匹配依赖，输出 `release/mac/Roc.app`
- 包内只留当前架构的 SQLite、PTY、RTK 和科研工具链
- 随包分发 Python / Tectonic / TeX 子集；Docling 模型不进安装包，打开后下载到 `~/.roc/research-models`
- 打包前用当前 `worker.py` / `figure.py` 覆盖 live 副本；排除 `bibliography.py`、`PyObjCTest`、pip/debugpy/jedi/IPython、RapidOCR、faker/polyfactory、torch 头文件和未使用的 pdfjs 目录。文献交换已在主进程 TypeScript（`bibliography.ts`）
- ad-hoc 本地签名（`identity: "-"`），未做 Developer ID / 公证
- 关窗口保留后台任务；菜单或 `Cmd+Q` 退出
- 终端走用户登录 Shell 与 zsh；Finder/Dock 启动用 `shell-env` 恢复 PATH
- Hook 仅 `command`，由 `/bin/zsh -f -c` 执行

单独验证已有应用包：

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:mac
```

目录包：

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:dir
```

---

## 状态

当前版本：`0.1.0`（积极开发中）

- 产品口径：科研工作台
- 仓库目标：对齐项目/阶段/闸门/产物合同，而不是只改提示词
- 密钥与本机运行态默认不进 Git

## License

未单独声明许可证前，默认保留所有权利。
