# Roc

Roc 是面向个人研究者的 **macOS 科研工作台**。默认入口是研究项目，而不是通用对话页。项目下组织文献、证据、想法、实验、图稿和论文；研究助手、文件、任务、连接器、技能和诊断作为科研服务挂在当前项目上。

底层仍是 Electron + React 本地桌面运行时：LangGraph / DeepAgents、插件化 Kernel、类型安全 IPC、SQLite，以及受控工具调用。路径边界清晰，密钥不进仓库。

- 平台：仅 macOS，Apple Silicon 与 Intel（按架构打包 RTK 与科研工具链）
- 默认界面：项目门户（`page=research`，未选项目）→ 三栏工作台（选中项目后）
- Agent：研究助手与阶段角色，不是产品主页
- 数据面：SQLite + Electron `safeStorage`，默认落 `~/.roc`
- 包管理：`pnpm@12.5.1`

术语见 [CONTEXT.md](CONTEXT.md)。壳层与阶段界面见 [docs/research-workbench.md](docs/research-workbench.md)。视觉、版式与动效的对齐标准见 [docs/adr/0025-alignment-audit-and-cleanup.md](docs/adr/0025-alignment-audit-and-cleanup.md)；设计参照目录是 [research-studio/](research-studio/README.md)（只读，不是第二套前端）。

---

## 科研工作台

打开应用先落**项目门户**：卡片网格列出研究项目，没有项目时是空态，点「新建研究项目」才出表单。
进入某个项目后是**三栏工作台**：左栏（文件 / 文献 / 会话）、助手列、画布（栏序与设计参照一致）；窗口 ≤1099px 时左栏与助手变抽屉。

| 区域 | 作用 |
| --- | --- |
| 顶栏 | 所有项目 / 项目名 / 分支、⌘K 搜索、助手、管理、Git、设置 |
| 左栏 | 文件树、文献、会话；主题与管理入口 |
| 画布 | 一次一个视图：总览、阶段工作区、活动、溯源、改动、文献、文稿、终端、文件、任务、诊断、MCP、技能、记忆 |
| 助手 | DeepAgent run 的执行面；富块渲染；⌘J 开关，窄窗为抽屉 |
| 抽屉与浮层 | Git 抽屉、管理面板、⌘K 搜索、设置浮层 |

科研服务不再有独立导轨：活动/文件/连接器/技能/记忆/诊断都是画布视图（或管理抽屉），
研究助手是推进阶段的主入口。壳层与视图合同见 [docs/research-workbench.md](docs/research-workbench.md)。

11 个研究阶段：发现、检索、阅读、构思、方案、实验/数据、绘图、写作、审稿、修订、导出。证据集、提纲、正文改写、图稿和最终导出走人工闸门。

阶段工作区已接入：

- 文献库 / 知识库 / Idea Canvas
- Python、R、Julia 实验运行
- Matplotlib 图稿渲染与发布
- LaTeX 文稿、模板编译
- 批准正文与图稿的最终 ZIP 导出
- MCP 授权、技能、项目记忆、后台任务、运行诊断（管理面板与画布视图）

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
  renderer/       # React 19 UI：顶栏 + 左栏 + 画布 + 助手；门户与设置浮层
  shared/         # schema / types / IPC 合同
  rtk-integration/# shell 输出压缩
tests/
scripts/
resources/        # 图标、RTK binaries、科研工具链源、阶段 Skill
design-system/    # 全局视觉与交互规范
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
| 壳层 | `src/renderer/app/`、`src/renderer/shell/` |

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

出厂前只有一条硬标准：**真应用 + 真 IPC + 真后端**。静态阅读与单测都不能替代它。

| 命令 | 覆盖 | 工件 |
| --- | --- | --- |
| `pnpm test` | 新壳 smoke：启动、门户建项目并进入、一轮助手 run、设置保存、文件预览 / Git / 终端 | `.artifacts/smoke-electron/result.json` + 截图 |
| `pnpm smoke:electron` | 上表 + 审批路径与人工闸门（P4 / P6 闸门作为子进程） | 同上 + `.artifacts/p4-gates/`、`.artifacts/p6-gates/` |
| `pnpm verify:p3-workspace` … `verify:p9-management` | 七个阶段的验收闸门（真阶段运行 / 真 PDF 解析 / 真 provider 测速 / 真 MCP stdio 子进程 / 真重启等） | `.artifacts/pN-gates/report.json` |
| `pnpm smoke:performance` | 冷启动与 1k / 10k 会话的交互、内存与预取预算 | `.artifacts/wave1/performance-smoke.json` |
| `pnpm smoke:mac` | 已打包 `.app` 的原生行为（签名、托盘、pty、外观通知） | `.artifacts/mac-package/` |
| `pnpm audit:layout` | 三个视口 × 门户/画布/助手/设置四态的布局审查 | `.artifacts/layout-audit/` |
| `node --test tests/unit/` | 纯规则与投影的单元测试（无 DOM） | — |

**验收闸门必须串行跑**：Electron 的进程单例锁（`SingletonSocket`）让并行实例互相拒绝，
表现为 `electron.launch: Process failed to launch`。

P10 删掉了旧壳的 smoke 套件（`tests/smoke/electron-smoke*.mjs`）：那些断言绑在已删除的旧 DOM 上，
没有可断言的对象，也不做事后别名映射。现在 `tests/smoke/lib/` 只留夹具与目标解析
（`fixtures.mjs` / `smoke-target.mjs` / `assertions.mjs` / `artifacts.mjs` / `native-feel.mjs`）。

## 本机维护

针对本机 `~/.roc` 运行态的维护命令。用于排查和重置本地数据，不进入打包流程。

| 命令 | 作用 | 副作用 |
| --- | --- | --- |
| `pnpm database:backup` / `database:restore` | 备份 / 还原 `~/.roc` 数据库 | 就地覆盖；需先 `pnpm build`，因为跑的是 `dist/` 里的 JS |
| `pnpm database:migrate` | 把 `~/.roc` 各插件库迁到代码里的最新 schema 版本 | 就地升级 schema |
| `pnpm database:clear-agent-history` | 清空 agent / task 历史表，保留 schema 与配置 | 破坏性：删除前自动备份到 `~/.roc/plugin-data/backups/manual-clear-history-<时间戳>/` |
| `pnpm logs:query --level error --grep <关键字>` | 查询 `~/.roc/logs/app.jsonl` | 只读；过滤器另有 `--service`、`--traceId`、`--runId`、`--since` |
| `pnpm audit:layout` | 多视口 UI 布局审查，产出 `.artifacts/layout-audit/` | 需先 `pnpm build`；`release/` 里已有打包应用时优先用它 |

`database:clear-agent-history` 在直接 `node` 调用时另需显式传 `--all-thread-kinds`，作为二次确认。

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
- 随包分发 Python / Tectonic / Vale / TeX 子集；Docling 模型不进安装包，打开后下载到 `~/.roc/research-models`
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

## 外部集成

Roc 依赖的外部组件全部登记在这里：**版本、来源网址、许可证、归口文件**。升级时按下表的「更新方式」
改对应锁定文件，不要只改 `package.json` 或只改注释——工具链的完整性与许可证采集都读锁定文件。

已实测核对过的网址会标 ✓。

### 一、科研工具链（随包离线分发）

来源与哈希的单一真理源是 [`resources/research-runtime/tools.lock.json`](resources/research-runtime/tools.lock.json)；
文件级完整性由 `scripts/research/manifest.ts` 生成、由 `src/main/plugins/research/toolchain.ts` 校验。

| 组件 | 版本 | 来源 | 许可证 | 更新方式 |
| --- | --- | --- | --- | --- |
| `python`（CPython） | 3.12.14 | astral-sh/python-build-standalone（按架构下载）<br/>`https://github.com/astral-sh/python-build-standalone/releases/tag/20260901` ✓ | PSF | 改 `tools.lock.json` 的 `pythonVersion` + `architectures[*].python` 的 url/sha256 → 重建 |
| `uv` | 0.12.10 | `https://github.com/astral-sh/uv/releases/tag/0.12.10` ✓ | MIT / Apache-2.0 | 同上（`uvVersion` + `uv`） |
| `tectonic`（Tectonic） | 0.17.0 | `https://github.com/tectonic-typesetting/tectonic/releases/tag/tectonic%400.17.0` ✓ | MIT | 同上（`tectonicVersion` + `tectonic`）；文档 `https://tectonic-typesetting.github.io` ✓ |
| TeX 资源（子集） | tlextras-2022.0r0 | `https://data1b.fullyjustified.net/tlextras-2022.0r0.tar`（上游默认 `https://relay.fullyjustified.net/default_bundle_v33.tar`） | 多许可证，随包保留入选文件原有声明 | 改 `tools.lock.json.texBundle` 的 url/sha256/size/zipSha256 + `tex-bundle-files.txt` → 重建 |
| `vale`（Vale） | 3.24.0 | `https://github.com/vale-cli/vale/releases/tag/v3.24.0` ✓ | MIT | 改 `tools.lock.json` 的 `valeVersion` + `architectures[*].vale` → 重建。见 [docs/research-prose.md](docs/research-prose.md) |

**Vale 规则集是 Roc 自己写的**（`resources/research-runtime/vale/styles/`，8+8 条），不来自上游 style 包，所以改规则只需重建工具链，不涉及第三方许可。

### 二、科研 Python 运行时

依赖声明在 [`resources/research-runtime/pyproject.toml`](resources/research-runtime/pyproject.toml) 与 `uv.lock`；许可证在构建时由 `scripts/research/collect-licenses.ts` 从各包 METADATA 采集为 `licenses/python-packages.json`。

| 包 | 版本 | 来源 | 用途 |
| --- | --- | --- | --- |
| docling | 2.126.0 | `https://github.com/docling-project/docling` ✓ | PDF 解析（PDFium 后端、布局/表格/公式） |
| docling-ibm-models | 4.0.2 | `https://github.com/docling-project/docling-ibm-models` ✓ | 布局/表格/公式模型运行时 |
| pypdfium2 | 5.13.0 | `https://github.com/pypdfium2-team/pypdfium2` ✓ | PDF 光栅化 |
| ocrmac | 1.0.1 | `https://github.com/straussmaximilian/ocrmac` ✓（PyPI 首页，注意不是 `ocr` 开头的另一个仓库） | 系统 Vision OCR 绑定 |
| matplotlib | 3.11.1 | `https://github.com/matplotlib/matplotlib` ✓ | 图稿渲染 |
| pandas | >=2.2,<3 | `https://github.com/pandas-dev/pandas` ✓ | 数据分析 |
| scipy | >=1.13,<2 | `https://github.com/scipy/scipy` ✓ | 数值计算 |
| torch | 2.14.0(arm64) / 2.2.2(x64) | `https://github.com/pytorch/pytorch` ✓ | 模型推理 |
| torchvision | 0.17.2(x64) | `https://github.com/pytorch/pytorch` ✓ | 模型推理 |
| transformers | 4.51.3(x64) | `https://github.com/huggingface/transformers` ✓ | 模型推理 |
| numpy | 1.26.4(x64) | `https://github.com/numpy/numpy` ✓ | 数值计算 |
| setuptools（构建约束） | 84.0.0 | `https://github.com/pypa/setuptools` | 构建期固定 |

### 三、解析模型（不进安装包，按需下载）

声明在 `resources/research-runtime/models.lock.json`（每个文件带 sha256 与 revision），下载源是 `https://huggingface.co/<repoId>/resolve/<revision>/<path>`；
运行时 `HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`，所以模型只在用户确认下载时联网。

| 模型 | revision | 许可证 |
| --- | --- | --- |
| `docling-project/docling-layout-heron`（`https://huggingface.co/docling-project/docling-layout-heron`） | `8f39ad3c…` | Apache-2.0 |
| `docling-project/docling-models`（TableFormer） | `fc0f2d45…` | CDLA-Permissive-2.0 |
| `docling-project/CodeFormulaV2`（公式识别） | `ecedbe11…` | CDLA-Permissive-2.0 |

### 四、RTK

| 组件 | 版本 | 来源 | 许可证 | 更新方式 |
| --- | --- | --- | --- | --- |
| RTK | v0.48.0 | `https://github.com/rtk-ai/rtk/releases/tag/v0.48.0` ✓ | Apache-2.0 | 双架构二进制放 `resources/rtk-binaries/darwin-*/rtk`；见 [docs/rtk-integration.md](docs/rtk-integration.md) |

### 五、npm 依赖（含版本、来源与许可证）

许可证由 `pnpm licenses list --prod` 实测得到。更新一律走 `pnpm add/upgrade` + `pnpm-lock.yaml`；
**改依赖后要重跑 `pnpm check:renderer-chunks`**（首屏预算）与打包验证。

**运行时（`dependencies` / `optionalDependencies`）**

| 包 | 版本 | 来源 | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `langchain` | 1.5.16 | `https://github.com/langchain-ai/langchainjs` ✓ | MIT | agent 与工具框架 |
| `@langchain/core` | 1.2.17 | 同上 | MIT | 核心抽象 |
| `@langchain/langgraph` | 1.5.0 | 同上 | MIT | 运行状态机、`interrupt` 闸门 |
| `@langchain/anthropic` / `@langchain/openai` | 1.5.12 / 1.6.2 | 同上 | MIT | provider 适配 |
| `@langchain/mcp-adapters` | 2.0.1 | 同上 | MIT | MCP 工具接入 |
| `deepagents` | 1.14.2 | `https://github.com/langchain-ai/deepagentsjs` ✓ | MIT | 研究助手的 harness |
| `better-sqlite3` | 13.0.3 | `https://github.com/WiseLibs/better-sqlite3` ✓ | MIT | SQLite（原生模块） |
| `sqlite-vec`<br/>`sqlite-vec-darwin-arm64`、`sqlite-vec-darwin-x64` | 0.1.9 | `https://github.com/asg017/sqlite-vec` ✓ | MIT / Apache-2.0 | 向量检索 |
| `@napi-rs/canvas` | 1.0.11 | `https://github.com/Brooooooklyn/canvas` ✓ | MIT | PDF 页渲染、图像处理（原生，需 `asarUnpack`） |
| `pdfjs-dist` | 6.4.299 | `https://github.com/mozilla/pdf.js` ✓ | Apache-2.0 | PDF 解析预览 |
| `node-pty` | 1.1.0 | `https://github.com/microsoft/node-pty` ✓ | MIT | 终端（原生，需 `asarUnpack`） |
| `shell-env` | 4.0.3 | `https://github.com/sindresorhus/shell-env` ✓ | MIT | Finder/Dock 启动时恢复登录 shell 的 PATH |
| `fast-xml-parser` | 5.11.2 | `https://github.com/NaturalIntelligence/fast-xml-parser` ✓ | MIT | arXiv Atom 解析 |
| `zod` | 4.6.7 | `https://github.com/colinhacks/zod` ✓ | MIT | 全部 IPC 与领域合同的 schema |

**开发期与构建（`devDependencies`）**

| 包 | 版本 | 来源 | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `electron` | 44.7.0 | `https://github.com/electron/electron` ✓ | MIT | 运行时 |
| `electron-builder` | 26.17.0 | `https://github.com/electron-userland/electron-builder` ✓ | MIT | 打包 |
| `electron-vite` | 6.0.0-beta.8 | `https://github.com/alex8088/electron-vite` ✓ | MIT | 三进程构建 |
| `vite` | 8.3.4 | `https://github.com/vitejs/vite` ✓ | MIT | 渲染层构建 |
| `esbuild` | 0.28.2 | `https://github.com/evanw/esbuild` ✓ | MIT | 单测加载 TS、打包校验 |
| `typescript` | 7.0.2 | `https://github.com/microsoft/TypeScript` ✓ | Apache-2.0 | 类型检查 |
| `tailwindcss` + `@tailwindcss/vite` | 4.3.3 | `https://github.com/tailwindlabs/tailwindcss` ✓ | MIT | 样式 |
| `react` / `react-dom` | 19.3.0 | `https://github.com/facebook/react` ✓ | MIT | UI |
| `@vitejs/plugin-react` | 6.1.2 | 同上 | MIT | 构建插件 |
| `lucide-react` | 1.56.0 | `https://github.com/lucide-icons/lucide` ✓ | ISC | 图标（**不用 emoji**） |
| `motion` | 14.2.0 | `https://github.com/motiondivision/motion` ✓ | MIT | 动效预设 |
| `katex` | 0.19.0 | `https://github.com/KaTeX/KaTeX` ✓ | MIT | 数学公式渲染 |
| `react-markdown` + `remark-gfm` | 10.1.0 / 4.0.1 | `https://github.com/remarkjs/react-markdown` ✓ / `https://github.com/remarkjs/remark-gfm` ✓ | MIT | 助手富块 |
| `streamdown` | 2.7.0 | `https://github.com/vercel/streamdown` ✓ | MIT | 流式 markdown |
| `react-virtuoso` | 4.18.19 | `https://github.com/petyosi/react-virtuoso` ✓ | MIT | 长列表虚拟化 |
| `react-diff-view` | 3.3.3 | `https://github.com/otakustay/react-diff-view` ✓ | MIT | 改动画布 |
| `highlight.js` | 11.12.0 | `https://github.com/highlightjs/highlight.js` ✓ | BSD-3-Clause | 代码高亮 |
| `@xterm/xterm` + `@xterm/addon-fit` | 6.0.0 / 0.11.0 | `https://github.com/xtermjs/xterm.js` ✓ | MIT | 终端渲染 |
| `@playwright/test` | 1.64.0 | `https://github.com/microsoft/playwright` ✓ | Apache-2.0 | smoke 与验收闸门 |
| `@types/*` | 见 package.json | 各自上游 | MIT | 类型声明 |

### 六、在线学术 API

都是只读 GET，无需密钥；响应经 `no-store` 缓存策略，不落盘。调用点集中在
[`src/main/plugins/research/literature-service.ts`](src/main/plugins/research/literature-service.ts)。

| 数据源 | 端点 | 说明 |
| --- | --- | --- |
| Crossref | `https://api.crossref.org/works` | 元数据检索；DOI 解析走 `https://doi.org/<doi>`（`Accept: application/vnd.citationstyles.csl+json`） |
| OpenAlex | `https://api.openalex.org/works` | 元数据检索 |
| Semantic Scholar | `https://api.semanticscholar.org/graph/v1/paper/search` | 元数据检索 |
| Europe PMC | `https://www.ebi.ac.uk/europepmc/webservices/rest/search` | 生物医学文献 |
| arXiv | `https://export.arxiv.org/api/query` | 预印本（Atom，用 `fast-xml-parser` 解析） |
| Hugging Face | `https://huggingface.co/<repoId>/resolve/<revision>/<path>` | 解析模型下载（唯一会下大文件的联网点） |

### 七、已评估但未集成

记录在这里是为了避免重复讨论；判据是 `AGENTS.md` 的**离线分发**与 `CONTEXT.md` 的**许可**两条约束。

| 项目 | 网址 | 不集成的原因 |
| --- | --- | --- |
| pandoc | `https://github.com/jgm/pandoc` ✓ | GPL-2.0 传染 + 体积大；现有导出只需 PDF/LaTeX |
| Quarto | `https://github.com/quarto-dev/quarto-cli` ✓ | 需要 Deno 运行时，与随包离线工具链冲突 |
| Typst | `https://github.com/typst/typst` ✓ | 许可证没问题（Apache-2.0），但换掉 Tectonic 等于重写导出域；等「编译太慢」成为真实投诉再评估 |
| Manubot | `https://github.com/manubot/manubot` ✓ | 面向 CI/网络的写作流水线，与本地桌面口径不符 |
| Zotero / Better BibTeX | `https://retorque.re/zotero-better-bibtex/` ✓ | Zotero 本体 AGPL；插件用它的**交换格式与引用键约定**即可，不引依赖 |
| citecheck | `https://github.com/tobiasosDev/citecheck` ✓ | 项目过小（个位数 star），逻辑自研更可控 |
| latex2arxiv | `https://github.com/YuZh98/latex2arxiv` ✓ | 面向 arXiv 投稿的预处理；等真要做投稿打包时再评估 |
| citeproc-rs | `https://github.com/zotero/citeproc-rs` ✓ | MPL-2.0 可用，但不发布 macOS 预编译二进制，需要给 `prepare.ts` 加 Rust 构建 |
| vega-lite / mermaid | `https://github.com/vega/vega-lite` ✓ / `https://github.com/mermaid-js/mermaid` ✓ | 计划内的图稿扩展（见下） |
| graphviz | `https://github.com/graphviz/graphviz` ✓ | 许可证是 EPL-1.0（非宽松）；同类需求优先 Mermaid |

### 八、计划中的集成（尚未落地）

| 组件 | 版本 | 网址 | 许可证 | 义务 |
| --- | --- | --- | --- | --- |
| citeproc-js | 2.4.63 | `https://github.com/Juris-M/citeproc-js` ✓ | **CPAL-1.0** | 这是本仓库第一个非 MIT/Apache/BSD 的运行时依赖。文件级 copyleft：不修改它时只需随包保留许可证与版权声明；若修改其源码文件，被改文件需按同许可回馈 |
| CSL 样式（GB/T 7714-2015） | 随库更新 | `https://github.com/citation-style-language/styles` ✓ | **CC-BY-SA-3.0** | 必须保留样式内作者与贡献者署名，并注明 CSL 项目与 `https://citationstyles.org/` |
| CSL 语言文件 | 随库更新 | `https://github.com/citation-style-language/locales` ✓ | CC-BY-SA-3.0 | 同上 |

落地时以上三条必须同时进 `docs/integrations` 的运行时清单与随包 `licenses/`。

### 九、只作参照、不引入代码

| 项目 | 网址 | 借鉴的是什么 |
| --- | --- | --- |
| research-studio | 本仓库 `research-studio/README.md`（只读设计参照） | 视觉、版式、动效与栏序（ADR 0025） |
| MyST | `https://mystmd.org` ✓ | 交叉引用语义（`{numref}`）与「标签解析 = 纯函数 + 可预检」 |
| Vale 上游规则 | `https://github.com/errata-ai/vale` ✓ | 规则格式与 `existence/substitution` 的写法；**规则内容为本仓库自研** |
| Prose 写作风格规则 | `https://github.com/jdkato/prose` | `write-good` 系规则的思路来源；只借思路，不复制文本 |

### 十、维护动作

| 场景 | 动作 |
| --- | --- |
| 升级 npm 依赖 | `pnpm upgrade` → `pnpm check:ipc` → `pnpm check:renderer-chunks` → `pnpm typecheck` → `pnpm test:unit` → 重跑受影响的验收闸门 |
| 升级工具链组件 | 改 `tools.lock.json` → **重建到新目录**（旧目录会被 `research_toolchain_version_mismatch` 拒） → 切路径 → `pnpm verify:native-packaging` |
| 升级 Vale 规则 | 改 `resources/research-runtime/vale/**` → 重建（规则参与 `lockHashes`） |
| 升级解析模型 | 改 `models.lock.json` 的 revision + 各文件 sha256 → 重下模型缓存 |
| 升级随包第三方资源 | 同步 `resources/research-runtime/licenses/sources.json` 的 url 与 sha256（`collect-licenses.ts` 与打包校验会读它） |
| 新增任何外部组件 | 先在本节登记：版本、网址、许可证、归口文件、更新方式 |

---

## 状态

当前版本：`0.1.0`（积极开发中）

- 产品口径：科研工作台
- 仓库目标：对齐项目/阶段/闸门/产物合同，而不是只改提示词
- 密钥与本机运行态默认不进 Git

## License

未单独声明许可证前，默认保留所有权利。
