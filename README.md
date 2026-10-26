# Roc

Roc 是面向个人研究者的 **macOS 科研工作台**。默认入口是研究项目，而不是通用对话页。项目下组织文献、证据、想法、实验、图稿和论文；研究助手、文件、后台任务、MCP 连接器、技能和记忆挂在当前项目上。

底层是 Electron + React 本地桌面运行时：LangGraph / DeepAgents、插件化 Kernel、类型安全 IPC、SQLite，以及受控工具调用。路径边界清晰，密钥不进仓库。

- 平台：仅 macOS，仅 Apple Silicon（arm64）。本地文档解析使用 PaddleOCR.js 与 ONNX Runtime；Intel Mac 不受支持
- 默认界面：项目门户（`page=research`，未选项目）→ 三栏工作台（选中项目后）
- Agent：研究助手与阶段角色，不是产品主页
- 数据面：SQLite + Electron `safeStorage`，默认落 `~/.roc`
- 包管理：`pnpm@12.5.1`

术语见 [CONTEXT.md](CONTEXT.md)。壳层与科研服务见 [docs/research-workbench.md](docs/research-workbench.md)。视觉、版式与动效的口径在 [`src/renderer/styles/tokens.css`](src/renderer/styles/tokens.css) 与 [`src/renderer/shared/motion.ts`](src/renderer/shared/motion.ts)，取舍理由见 [ADR 0023](docs/adr/0023-visual-and-motion-spec.md)。

---

## 科研工作台

打开应用先落**项目门户**：卡片网格列出研究项目，没有项目时是空态，点「新建研究项目」才出表单。
进入某个项目后是**三栏工作台**：左栏（文件 / 文献 / 会话）、助手列、画布；窗口 ≤1099px 时左栏与助手变抽屉。

| 区域 | 作用 |
| --- | --- |
| 顶栏 | 所有项目 / 项目名 / 分支、⌘K 搜索、助手、管理、Git、设置 |
| 左栏 | 文件树、文献、会话；主题与管理入口 |
| 画布 | 一次一个视图（`?view=`）。一级 tab 只有三个：文献、LaTeX、终端；管理三节（记忆 / 技能 / MCP）也走画布视图 |
| 助手 | DeepAgent run 的执行面；富块渲染；⌘J 开关，窄窗为抽屉 |
| 抽屉与浮层 | Git 抽屉、管理抽屉（记忆 / 技能 / MCP / 任务）、⌘K 搜索、设置浮层 |

「有哪些面、每个面落在哪里」由 [`src/shared/surfaces.ts`](src/shared/surfaces.ts) 一张表声明，是唯一真理源；逐面清单与落点见 [docs/research-workbench.md](docs/research-workbench.md)。缺省画布视图是 `latex`：文件由左栏文件树 + 预览浮层承载，Git 改动由顶栏抽屉承载——两者都没有画布落点。

**研究助手是唯一执行入口**（ADR 0020）：推进阶段、检索取证、过人工闸门、改论文都在对话里做。11 个研究阶段（发现、检索、阅读、构思、方案、实验/数据、绘图、写作、审稿、修订、导出）由阶段角色 Agent 执行，一次运行绑定当前项目与阶段，由对话代理的科研工具（`research_run_stage` / `research_approve_gate` / `research_lint_manuscript` 等）启动。

下列七个域**今天有契约、有数据库、没有界面**（[ADR 0024](docs/adr/0024-stage-surface-removed.md) 有意保留，登记在 `PARKED_CAPABILITIES` 里，深链会明确失败）：构思、实验、图稿、正文、导出、模板包、阶段策略。

合同细节（记的是契约，不是当前界面）：

- [Idea Canvas](docs/research-ideas.md)
- [实验运行](docs/research-experiments.md)
- [图稿](docs/research-figures.md)
- [最终导出](docs/research-exports.md)

---

## 架构分层

```text
src/
  main/           # Kernel、插件、Agent、科研域、DB、IPC
  preload/        # 类型安全 bridge
  renderer/       # React 19 UI：顶栏 + 左栏 + 助手 + 画布；门户与设置浮层
  shared/         # schema / types / IPC 合同
  rtk-integration/# shell 输出压缩
tests/
scripts/
resources/        # 图标、RTK / ripgrep binaries、科研工具链源、阶段 Skill、内置技能快照与 catalog
```

设计口径没有单独的文档目录：真身是 `src/renderer/styles/tokens.css`（颜色与刻度）与 `src/renderer/shared/motion.ts`（动效），组件不得写死颜色。

进程边界：renderer 只做 UI；preload 白名单 IPC；main 负责文件系统、网络、密钥、Agent 与科研生产。

---

## 研究助手运行时

研究助手是当前项目上的执行面，不是默认首页。阶段角色走各自 Skill 白名单；通用研究助手走 DeepAgents harness。

```text
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

`grep` 工具跑在随包的 ripgrep 上（`RipgrepFilesystemBackend` → `RipgrepService`，显式二进制路径，不看 PATH）；
同一个服务也承担 ⌘K 的文件内容搜索。两条调用面在二进制缺失时都退回 deepagents / `FileService` 原有的实现
（前者会再试一次 PATH 上的 `rg`），所以「不看 PATH」只在随包二进制在位时成立。见「外部集成」的 ripgrep 一节。

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

`dev` 先验证原生模块，再启动 Electron + Vite。默认打开项目门户。

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

推送前确认：不要提交 `.env`、真实 API Key、`~/.roc`、导出的 chat 数据库。二进制只保留 macOS arm64 的 RTK 与 ripgrep。

---

## 测试

出厂前只有一条硬标准：**真应用 + 真 IPC + 真后端**。静态阅读与单测都不能替代它。

| 命令 | 覆盖 | 工件 |
| --- | --- | --- |
| `pnpm test` | `test:unit` + smoke：启动、门户建项目并进入、一轮助手 run、设置保存、文件预览 / Git / 终端 | `.artifacts/smoke-electron/result.json` + 截图 |
| `pnpm smoke:electron` | `pnpm test` 的全部用例，外加审批路径（`verify-p4-assistant` 作为子进程） | 同上 + `.artifacts/p4-gates/` |
| `pnpm verify:p3-workspace` / `verify:p4-assistant` / `verify:p5-literature` / `verify:p8-settings` / `verify:p9-management` | 验收闸门：真阶段运行 / 真 PDF 解析 / 真 provider 测速 / 真 MCP stdio 子进程 / 真重启 | `.artifacts/pN-gates/report.json` |
| `pnpm smoke:performance` | 冷启动与 1k / 10k 会话的交互、内存与预取预算 | `.artifacts/wave1/performance-smoke.json` |
| `pnpm smoke:mac` | 已打包 `.app` 的原生行为（签名、托盘、pty、外观通知） | `.artifacts/mac-package/` |
| `pnpm test:unit` | 纯规则与投影的单元测试（无 DOM；等价于 `node --test tests/unit/`） | — |

**验收闸门必须串行跑**：Electron 的进程单例锁（`SingletonSocket`）让并行实例互相拒绝，表现为 `electron.launch: Process failed to launch`。

`tests/smoke/` 除 `performance-smoke.mjs` 外只有 `lib/` 下的夹具与解析（`fixtures.mjs`、`smoke-target.mjs`、`assertions.mjs`、`artifacts.mjs`、`native-feel.mjs`、`electron-smoke-layout-audit.mjs`、`performance-profile-seed.ts` 与 `lib/assets/`）。

## 本机维护

针对本机 `~/.roc` 运行态的维护命令。用于排查和重置本地数据，不进入打包流程。

| 命令 | 作用 | 副作用 |
| --- | --- | --- |
| `pnpm database:backup` / `database:restore` | 备份 / 还原 `~/.roc` 数据库 | 就地覆盖；需先 `pnpm build`，因为跑的是 `dist/` 里的 JS |
| `pnpm database:migrate` | 把 `~/.roc` 各插件库迁到代码里的最新 schema 版本 | 就地升级 schema；已应用的 migration 被改动、或库里有对象却没有迁移记账时仍要求重建 |
| `pnpm database:clear-agent-history` | 清空 agent / task 历史表，保留 schema 与配置 | 破坏性：删除前自动备份到 `~/.roc/plugin-data/backups/manual-clear-history-<时间戳>/` |
| `pnpm logs:query --level error --grep <关键字>` | 查询 `~/.roc/logs/app.jsonl` | 只读；过滤器另有 `--service`、`--traceId`、`--runId`、`--since` |
| `pnpm audit:layout` | 三个视口 × 门户/画布/助手/设置四态的布局审查 | 需先 `pnpm build`；产出 `.artifacts/layout-audit/`；`release/` 里已有打包应用时优先用它 |

`database:clear-agent-history` 在直接 `node` 调用时另需显式传 `--all-thread-kinds`，作为二次确认。

---

## 打包

仅 darwin。以下命令在当前项目路径执行。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc install --frozen-lockfile
rtk proxy node /Users/Apple_501/Desktop/Roc/Roc/scripts/research/prepare.ts --arch arm64 --output /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:mac
```

`package:mac`：校验 live 科研工具链 → `pnpm build`（含 typecheck）→ 首屏体积检查 → `electron-builder --mac --dir` → `smoke-mac`。输出当前架构的 `.app`（不打 zip/dmg）。构建缓存在 `.runtime/`，验证截图在 `.artifacts/mac-package/`。

- 产物：`release/mac-arm64/Roc.app`（只产出 arm64；构建脚本在非 arm64 宿主上直接失败）
- 包内只留 arm64 的 SQLite、PTY、RTK、ripgrep 和科研工具链
- 随包分发 Tectonic / Vale / Typst / TeX 子集；PaddleOCR.js 解析模型不进安装包，用户选择下载后存入 `~/.roc/research-models`
- 打包前按工具锁构建并校验原生科研工具链，解析模型按独立模型锁校验；文献交换已在主进程 TypeScript（`bibliography.ts`）
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
改对应锁定文件，不要只改 `package.json` 或只改注释——工具链完整性依据 `tools.lock.json`；工具许可证来源与随包文本登记在 `resources/research-runtime/licenses/sources.json`，npm 生产依赖许可证用 `pnpm licenses list --prod` 核对。

已实测核对过的网址会标 ✓。

### 一、科研工具链（随包离线分发）

来源与哈希的单一真理源是 [`resources/research-runtime/tools.lock.json`](resources/research-runtime/tools.lock.json)；
文件级完整性由 `scripts/research/manifest.ts` 生成、由 `src/main/plugins/research/toolchain.ts` 校验。

| 组件 | 版本 | 来源 | 许可证 | 更新方式 |
| --- | --- | --- | --- | --- |
| `tectonic`（Tectonic） | 0.17.0 | `https://github.com/tectonic-typesetting/tectonic/releases/tag/tectonic%400.17.0` ✓ | MIT | 改 `tools.lock.json` 的 `tectonicVersion` + `architectures[*].tectonic` → 重建；文档 `https://tectonic-typesetting.github.io` ✓ |
| TeX 资源（子集） | tlextras-2022.0r0 | `https://data1b.fullyjustified.net/tlextras-2022.0r0.tar`（上游默认 `https://relay.fullyjustified.net/default_bundle_v33.tar`） | 多许可证，随包保留入选文件原有声明 | 改 `tools.lock.json.texBundle` 的 url/sha256/size/zipSha256 + `tex-bundle-files.txt` → 重建 |
| `vale`（Vale） | 3.24.0 | `https://github.com/vale-cli/vale/releases/tag/v3.24.0` ✓ | MIT | 改 `tools.lock.json` 的 `valeVersion` + `architectures[*].vale` → 重建。见 [docs/research-prose.md](docs/research-prose.md) |
| `typst`（Typst） | 0.15.0 | `https://github.com/typst/typst/releases/tag/v0.15.0` ✓ | Apache-2.0 | 改 `tools.lock.json` 的 `typstVersion` + `architectures[*].typst` → 重建。**只服务导出附带的报告**（`src/main/plugins/research/typst-report.ts`），不进 LaTeX 主链；取舍见 [docs/adr/0025-typst-report-engine.md](docs/adr/0025-typst-report-engine.md) |
| CSL 样式（数据） | 提交 `ffd2a7b9` | `https://github.com/citation-style-language/styles` ✓ | CC BY-SA 3.0 | 改 `resources/research-runtime/csl/**` → 重建（样式参与 `lockHashes`）；加样式同时要改 `typst-report.ts` 的样式表。见 `resources/research-runtime/csl/README.md` |

**Vale 规则集是 Roc 自己写的**（`resources/research-runtime/vale/styles/`，8+8+1 条），不来自上游 style 包，所以改规则只需重建工具链，不涉及第三方许可。拼写那条（`RocAcademic/Spelling.yml`）是 `extends: spelling` 的包装，把上游 `Vale.Spelling` 的 `error` 档降到 `suggestion`。

### 二、Node.js 数据实验运行时

数据实验通过 Electron 内置 Node.js 24.22.0 执行版本化 `.mts` 模块，不需要单独安装或分发 Python/uv。模块使用受限的 `run(context)` 合同和显式输入/输出快照；文件访问、进程环境与产物大小由实验运行器限制，详见 [`docs/research-experiments.md`](docs/research-experiments.md)。

| 组件 | 版本 | 来源 | 用途 |
| --- | --- | --- | --- |
| Electron 内置 Node.js | 24.22.0（Electron 45.0.0） | Electron runtime | 执行 `.mts` 数据实验 |
| `d3-dsv` | 3.0.1 | `https://github.com/d3/d3-dsv` | 有界 CSV/TSV 数据处理 |
| `csv-parse` | 7.0.3 | `https://github.com/adaltas/node-csv` | 流式 CSV/TSV 输入 |
| `simple-statistics` | 7.12.1 | `https://github.com/simple-statistics/simple-statistics` | 描述性统计 |

### 三、解析模型（按需下载）

模型声明在 [`resources/research-models/models.lock.json`](resources/research-models/models.lock.json)，用户主动下载后存入用户数据目录；安装包不包含 ONNX 权重。锁文件固定不可变来源 revision、文件 URL、大小、SHA-256 与许可证。

| 包 | 内容 | 下载量 |
| --- | --- | ---: |
| `compact` | PP-OCRv6-tiny 检测/识别与字典、PP-DocLayout-S、SLANet | 18,967,109 B |
| `complete` | `compact` 加 PP-FormulaNet-S 与 UniMERNet tokenizer；额外启用公式识别 | 329,850,264 B |

PaddleOCR.js 推理运行库为 MIT；模型与 tokenizer 按上游声明使用 Apache-2.0。具体来源、revision 和许可说明见 [`resources/research-models/README.md`](resources/research-models/README.md)，摘要以 `models.lock.json` 为准。默认使用 `compact` 包；需要公式识别时由用户另行下载 `complete` 包。

### 四、ripgrep（随包全文搜索）

文件内容搜索（`files.search`，⌘K 的「文件内容」分组）与 Agent 的 `grep` 工具共用这一个二进制：
`RipgrepService` 用显式路径启动它，所以结果不取决于用户机器 PATH 里有没有 `rg`。
归口文件是 [`src/main/services/ripgrep-service.ts`](src/main/services/ripgrep-service.ts)（二进制解析、参数组装、
`--json` 解析），Agent 侧的子类在
[`src/main/services/deep-agent/ripgrep-filesystem-backend.ts`](src/main/services/deep-agent/ripgrep-filesystem-backend.ts)。

版本、网址与 archive / binary SHA-256 的单一真理源是
[`resources/ripgrep-binaries/ripgrep.lock.json`](resources/ripgrep-binaries/ripgrep.lock.json)；
它只声明 `darwin-arm64` 一份。`electron-builder.yml` 按 `darwin-arm64` 取二进制，打包前由
`assertRipgrepBinaryForPackaging`（`scripts/lib/native-packaging.mjs`）核对哈希；`before-pack` 拒绝
arm64 以外的目标架构（含 universal），所以不存在“交叉打包出一个没有 rg 的包”。

搜索口径（两条调用面**有意不同**）：

- `files.search` 传 `--hidden --no-ignore --no-ignore-parent --no-ignore-global`：点文件要能搜到，结果也不受
  仓库或全局 gitignore 影响——它替换的那次逐文件扫描本来就不看这些文件。目录过滤只认
  `ignoredDirectoryNames`（`node_modules`、`.git`、`dist` 等）。
- Agent `grep` 保持 ripgrep 默认的 ignore 语义（与 deepagents 自带调用一致），只把二进制换成随包的那一颗。

`binarySha256` 钉的是**发布资产**（打包前）。打包时 electron-builder 会对 `Roc.app` 里的嵌套可执行文件做
ad-hoc 签名，签完字节就变了，所以包内 `rg` 的 sha256 与 lock 不同是正常的：`codesign --verify` 通过、
`rg --version` 能跑就够了。不要拿包内二进制去比对 lock。

| 组件 | 版本 | 来源 | 许可证 | 更新方式 |
| --- | --- | --- | --- | --- |
| `ripgrep`（`rg`） | 15.2.0 | `https://github.com/BurntSushi/ripgrep` ✓<br/>`https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0` ✓ | MIT OR Unlicense | `pnpm sync:ripgrep` 按 lock 下载、核对 SHA-256、解出 `resources/ripgrep-binaries/darwin-*/rg`；许可证文本在 `resources/ripgrep-binaries/licenses/` |

二进制缺失时的行为是**降级而不是报错**：`files.search` 退回逐文件 JS 扫描，Agent `grep` 退回 deepagents 的实现
（先试 PATH 上的 `rg`，没有才落到字面量扫描）。所以漏打包不会让搜索挂掉，只会变慢——打包校验就是为了
不让这件事悄悄发生。

### 五、RTK

| 组件 | 版本 | 来源 | 许可证 | 更新方式 |
| --- | --- | --- | --- | --- |
| RTK | v0.48.0 | `https://github.com/rtk-ai/rtk/releases/tag/v0.48.0` ✓ | Apache-2.0 | 双架构二进制放 `resources/rtk-binaries/darwin-*/rtk`；见 [docs/rtk-integration.md](docs/rtk-integration.md) |

### 六、npm 依赖（含版本、来源与许可证）

许可证由 `pnpm licenses list --prod` 实测得到。更新一律走 `pnpm add/upgrade` + `pnpm-lock.yaml`；
**改依赖后要重跑 `pnpm check:renderer-chunks`**（首屏预算）与打包验证。

**运行时（`dependencies` / `optionalDependencies`）**

| 包 | 版本 | 来源 | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `langchain` | 1.5.18 | `https://github.com/langchain-ai/langchainjs` ✓ | MIT | agent 与工具框架 |
| `@langchain/core` | 1.2.20 | 同上 | MIT | 核心抽象 |
| `@langchain/langgraph` | 1.5.2 | 同上 | MIT | 运行状态机、`interrupt` 闸门 |
| `@langchain/anthropic` / `@langchain/openai` | 1.5.13 / 1.6.3 | 同上 | MIT | provider 适配 |
| `@langchain/mcp-adapters` | 2.0.1 | 同上 | MIT | MCP 工具接入 |
| `deepagents` | 1.15.1 | `https://github.com/langchain-ai/deepagentsjs` ✓ | MIT | 研究助手的 harness |
| `better-sqlite3` | 13.0.3 | `https://github.com/WiseLibs/better-sqlite3` ✓ | MIT | SQLite（原生模块） |
| `sqlite-vec`<br/>`sqlite-vec-darwin-arm64` | 0.1.9 | `https://github.com/asg017/sqlite-vec` ✓ | MIT / Apache-2.0 | 向量检索 |
| `@napi-rs/canvas` | 1.0.13 | `https://github.com/Brooooooklyn/canvas` ✓ | MIT | PDF 页渲染、图像处理（原生，需 `asarUnpack`） |
| `pdfjs-dist` | 6.4.299 | `https://github.com/mozilla/pdf.js` ✓ | Apache-2.0 | PDF 解析预览 |
| `node-pty` | 1.1.0 | `https://github.com/microsoft/node-pty` ✓ | MIT | 终端（原生，需 `asarUnpack`） |
| `shell-env` | 4.0.3 | `https://github.com/sindresorhus/shell-env` ✓ | MIT | Finder/Dock 启动时恢复登录 shell 的 PATH |
| `fast-xml-parser` | 5.11.2 | `https://github.com/NaturalIntelligence/fast-xml-parser` ✓ | MIT | arXiv Atom 解析 |
| `zod` | 4.6.7 | `https://github.com/colinhacks/zod` ✓ | MIT | 全部 IPC 与领域合同的 schema |

**开发期与构建（`devDependencies`）**

| 包 | 版本 | 来源 | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `electron` | 45.0.0 | `https://github.com/electron/electron` ✓ | MIT | 运行时 |
| `electron-builder` | 26.18.0 | `https://github.com/electron-userland/electron-builder` ✓ | MIT | 打包 |
| `electron-vite` | 6.0.0 | `https://github.com/alex8088/electron-vite` ✓ | MIT | 三进程构建 |
| `vite` | 8.3.5 | `https://github.com/vitejs/vite` ✓ | MIT | 渲染层构建 |
| `esbuild` | 0.28.2 | `https://github.com/evanw/esbuild` ✓ | MIT | 单测加载 TS、打包校验 |
| `typescript` | 7.0.2 | `https://github.com/microsoft/TypeScript` ✓ | Apache-2.0 | 类型检查 |
| `tailwindcss` + `@tailwindcss/vite` | 4.3.3 | `https://github.com/tailwindlabs/tailwindcss` ✓ | MIT | 样式 |
| `react` / `react-dom` | 19.3.1 | `https://github.com/facebook/react` ✓ | MIT | UI |
| `@vitejs/plugin-react` | 6.1.2 | 同上 | MIT | 构建插件 |
| `lucide-react` | 1.61.0 | `https://github.com/lucide-icons/lucide` ✓ | ISC | 图标（**不用 emoji**） |
| `motion` | 14.5.0 | `https://github.com/motiondivision/motion` ✓ | MIT | 动效预设 |
| `react-markdown` + `remark-gfm` | 10.1.0 / 4.0.1 | `https://github.com/remarkjs/react-markdown` ✓ / `https://github.com/remarkjs/remark-gfm` ✓ | MIT | 助手富块 |
| `streamdown` | 2.7.1 | `https://github.com/vercel/streamdown` ✓ | MIT | 流式 markdown |
| `react-virtuoso` | 4.18.19 | `https://github.com/petyosi/react-virtuoso` ✓ | MIT | 长列表虚拟化 |
| `react-diff-view` | 3.3.3 | `https://github.com/otakustay/react-diff-view` ✓ | MIT | 改动画布 |
| `highlight.js` | 11.12.0 | `https://github.com/highlightjs/highlight.js` ✓ | BSD-3-Clause | 代码高亮 |
| `@xterm/xterm` + `@xterm/addon-fit` | 6.0.0 / 0.11.0 | `https://github.com/xtermjs/xterm.js` ✓ | MIT | 终端渲染 |
| `@playwright/test` | 1.64.1 | `https://github.com/microsoft/playwright` ✓ | Apache-2.0 | smoke 与验收闸门 |
| `@types/*` | 见 package.json | 各自上游 | MIT | 类型声明 |

### 七、在线学术 API

都是只读 GET，无需密钥；响应经 `no-store` 缓存策略，不落盘。调用点集中在
[`src/main/plugins/research/literature-service.ts`](src/main/plugins/research/literature-service.ts)。

| 数据源 | 端点 | 说明 |
| --- | --- | --- |
| Crossref | `https://api.crossref.org/works` | 元数据检索；DOI 解析走 `https://doi.org/<doi>`（`Accept: application/vnd.citationstyles.csl+json`） |
| OpenAlex | `https://api.openalex.org/works` | 元数据检索；撤稿核查（`research.library.checkRetractions`，读 `is_retracted`）。主进程联网，离线工具链不碰它 |
| Semantic Scholar | `https://api.semanticscholar.org/graph/v1/paper/search` | 元数据检索 |
| Europe PMC | `https://www.ebi.ac.uk/europepmc/webservices/rest/search` | 生物医学文献 |
| arXiv | `https://export.arxiv.org/api/query` | 预印本（Atom，用 `fast-xml-parser` 解析） |
| Hugging Face | `https://huggingface.co/<repoId>/resolve/<revision>/<path>` | 解析模型下载（唯一会下大文件的联网点） |

### 八、内置技能源

两个上游 Skill 仓库随安装包内置（离线可用），运行时每 24 小时比对提交并同步；细节见
[docs/builtin-skills.md](docs/builtin-skills.md)。快照与提交号的单一真理源是
[`resources/builtin-skills/catalog.json`](resources/builtin-skills/catalog.json)。

| 组件 | 版本 | 来源 | 许可证 | 更新方式 |
| --- | --- | --- | --- | --- |
| Nature Skills（23 个技能） | 快照 `2a163b95` | `https://github.com/Yuan1z0825/nature-skills` ✓ | Apache-2.0 | `pnpm sync:builtin-skills` → 提交 `resources/builtin-skills/nature-skills.tar.gz` 与 `catalog.json`；运行时自动同步 |
| Academic Research Skills（5 个技能） | 快照 `cfd081d8` | `https://github.com/Imbad0202/academic-research-skills` ✓ | **CC BY-NC 4.0** | 同上；许可证不允许默认分发，所以内置但不自动安装（管理 → 技能里显式接受后安装） |

### 九、维护动作

| 场景 | 动作 |
| --- | --- |
| 升级 npm 依赖 | `pnpm upgrade` → `pnpm check:ipc` → `pnpm check:renderer-chunks` → `pnpm typecheck` → `pnpm test:unit` → 重跑受影响的验收闸门 |
| 升级工具链组件 | 改 `tools.lock.json` → **重建到新目录**（旧目录会被 `research_toolchain_version_mismatch` 拒） → 切路径 → `pnpm verify:native-packaging` |
| 升级 Vale 规则 | 改 `resources/research-runtime/vale/**` → 重建（规则参与 `lockHashes`） |
| 升级 CSL 样式 | 改 `resources/research-runtime/csl/**` → 重建（样式参与 `lockHashes`） |
| 升级 ripgrep | 改 `ripgrep.lock.json`（版本、url、archive/binary SHA-256）→ `pnpm sync:ripgrep` → `pnpm test:unit`（核对 lock↔二进制 sha256，并真跑一次 `rg`）→ `pnpm verify:native-packaging`（`--arch` 可选，缺省本机架构） |
| 升级解析模型 | 改 `models.lock.json` 的 revision + 各文件 sha256 → 重下模型缓存 |
| 升级随包第三方资源 | 更新 `resources/research-runtime/licenses/sources.json` 的 url 与 sha256，并同步对应许可证文本；`prepare.ts` 复制并纳入完整性清单，打包校验确认文件随包 |
| 新增任何外部组件 | 先在本节登记：版本、网址、许可证、归口文件、更新方式 |

---

## 状态

当前版本：`0.1.0`（积极开发中）。产品口径是科研工作台；密钥与本机运行态默认不进 Git。

## License

未单独声明许可证前，默认保留所有权利。
