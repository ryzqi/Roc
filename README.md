# Roc

Roc 是一款面向个人研究者的 macOS 桌面工作台，支持 Apple Silicon（arm64）。每个研究项目都有自己的文件、文献、会话和研究助手；进入项目后可在三栏工作区中使用文献、LaTeX 与终端视图。

## 功能

- 管理研究项目、项目文件、文献和助手会话。
- 搜索并导入学术文献，阅读 PDF；需要 OCR 时可按需下载本地模型。
- 在项目内使用研究助手处理文献、文件和研究任务，并连接用户配置的 MCP 工具。
- 在 LaTeX 画布和终端中工作。

## 外部集成

Roc 不包含云服务账号或 API 密钥。使用相应功能时，应用会连接已配置的服务或下列公开接口。

### 模型、文献与网页

- **聊天模型**：NVIDIA、OpenRouter、llama.cpp；也可配置 OpenAI-compatible 或 Anthropic-compatible API。语义索引可选用 OpenAI-compatible embedding API。
- **学术文献**：OpenAlex、Crossref、Semantic Scholar、arXiv、PubMed 和 Europe PMC。PubMed 检索通过 Europe PMC；DOI 通过 doi.org 解析；撤稿状态由 OpenAlex 提供。
- **网页阅读**：通过 Jina Reader 获取用户请求阅读的网页内容。
- **OCR 模型**：用户主动下载后在本地运行；模型文件来自 Hugging Face 和 GitHub 上游仓库，不随应用安装包分发。

### MCP 与内置技能

- **MCP**：可配置本地 stdio 或远程 HTTP/SSE 服务。Exa Hosted MCP 是一个默认禁用的可选预设。
- **内置技能**：Nature Skills 和 Academic Research Skills 随应用附带快照，并每日通过 GitHub 检查上游更新。Academic Research Skills 使用 CC BY-NC 4.0，安装前需要用户明确接受许可。

### 随包离线工具

应用还包含本机工具：Tectonic 0.17.0、Vale 3.24.0、Typst 0.15.0、TeX bundle `tlextras-2022.0r0`、ripgrep 15.2.0 和 RTK v1.1.0 OSS。版本、校验和及许可来源分别由 [`resources/research-runtime/`](resources/research-runtime/README.md)、[`resources/ripgrep-binaries/ripgrep.lock.json`](resources/ripgrep-binaries/ripgrep.lock.json) 和 [`docs/rtk-integration.md`](docs/rtk-integration.md) 维护。npm 依赖由 [`package.json`](package.json) 与 [`pnpm-lock.yaml`](pnpm-lock.yaml) 固定。

## 技术栈与第三方依赖

Roc 是单一 Electron 桌面应用：主进程管理数据库、原生能力和服务，preload 通过受限 API 连接主进程与界面，React renderer 提供项目工作区。项目只面向 Apple Silicon macOS。

| 层 | 技术与用途 |
| --- | --- |
| 桌面运行时 | Electron 45.0.0；Electron 内嵌 Node.js 24.22.0。开发环境使用 Node.js 26。 |
| 界面 | React / React DOM 19.3.1；TypeScript 7.0.2。 |
| 开发与构建 | pnpm 12.5.1、electron-vite 6.0.0、Vite 8.3.5、Tailwind CSS 4.3.3、electron-builder 26.18.0。 |
| 平台与产物 | `package.json` 限定 `darwin` / `arm64`；electron-builder 配置生成 macOS `.app`。 |

### 应用运行依赖

下表列出 [`package.json`](package.json) 中的直接运行依赖及当前固定版本。传递依赖完整解析见 [`pnpm-lock.yaml`](pnpm-lock.yaml)。

| 用途 | 包与版本 |
| --- | --- |
| Agent、模型与 MCP | `@langchain/anthropic` 1.5.13；`@langchain/core` 1.2.20；`@langchain/langgraph` 1.5.2；`@langchain/mcp-adapters` 2.0.1；`@langchain/openai` 1.6.3；`deepagents` 1.15.1；`langchain` 1.5.18 |
| Token 计算与数据校验 | `js-tiktoken` 1.0.21；`zod` 4.6.7 |
| 数据库与向量索引 | `better-sqlite3` 13.0.3；`sqlite-vec` 0.1.9 |
| OCR、PDF 与图像 | `@napi-rs/canvas` 1.0.13；`onnxruntime-node` 1.22.0-rev；`paddleocr` 1.2.0；`pdfjs-dist` 6.4.299；`utif` 3.1.0 |
| 文献、网页与归档 | `@retorquere/bibtex-parser` 12.1.13；`fast-xml-parser` 5.11.2；`htmlparser2` 12.0.0；`yauzl` 3.4.0（ZIP 读取）；`yazl` 3.3.1（ZIP 写入） |
| 表格与统计 | `csv-parse` 7.0.3；`csv-stringify` 6.9.0；`d3-dsv` 3.0.1；`simple-statistics` 7.12.1 |
| 图表 | `vega` 6.2.0；`vega-lite` 6.4.1 |
| 终端、日志与运行支持 | `node-pty` 1.1.0；`pino` 10.4.0；`p-retry` 7.1.1；`shell-env` 4.0.3；`lowlight` 3.3.0（代码高亮） |

`sqlite-vec-darwin-arm64` 0.1.9 是 `optionalDependencies` 中的 Apple Silicon 原生包。OCR 模型权重不随安装包分发，来源、revision 和 SHA-256 见 [`resources/research-models/models.lock.json`](resources/research-models/models.lock.json)。

### 开发、界面与测试依赖

| 用途 | 包与版本 |
| --- | --- |
| Electron / 前端构建 | `electron` 45.0.0；`electron-builder` 26.18.0；`electron-vite` 6.0.0；`esbuild` 0.28.2；`vite` 8.3.5；`@vitejs/plugin-react` 6.1.2；`@tailwindcss/vite` 4.3.3；`tailwindcss` 4.3.3；`typescript` 7.0.2 |
| React 与类型定义 | `react` 19.3.1；`react-dom` 19.3.1；`@types/node` 26.6.5；`@types/react` 19.3.0；`@types/react-dom` 19.3.0 |
| 编辑器与终端 | `@codemirror/commands` 6.11.1；`@codemirror/language` 6.13.1；`@codemirror/legacy-modes` 6.5.5；`@codemirror/search` 6.7.2；`@codemirror/state` 6.7.6；`@codemirror/view` 6.43.15；`@lezer/highlight` 1.2.5；`@xterm/addon-fit` 0.11.0；`@xterm/xterm` 6.0.0 |
| 图标、动效与内容呈现 | `highlight.js` 11.12.0；`lucide-react` 1.61.0；`motion` 14.5.0；`react-diff-view` 3.3.3；`react-markdown` 10.1.0；`react-virtuoso` 4.18.19；`remark-gfm` 4.0.1；`streamdown` 2.7.1 |
| Electron 端到端自动化 | `@playwright/test` 1.64.1；单元和 renderer 测试使用 Node.js 内置 `node:test`。 |
| 原生包类型定义 | `@types/better-sqlite3` 9.6.0；`@types/utif` 3.0.6；`@types/yauzl` 3.4.0；`@types/yazl` 3.3.1 |

### 依赖升级

- npm 包的直接版本以 [`package.json`](package.json) 为准，解析结果以 [`pnpm-lock.yaml`](pnpm-lock.yaml) 为准；提交升级时同步更新 README 中对应版本。先用 `pnpm outdated` 查看可升级项；运行依赖使用 `pnpm add --save-exact package@version`，开发依赖使用 `pnpm add -D --save-exact package@version`，由 pnpm 更新 manifest 和 lockfile，不手改 lockfile。
- LangGraph 版本还受 [`pnpm-workspace.yaml`](pnpm-workspace.yaml) 中的 `@langchain/langgraph` 与 `@langchain/langgraph-checkpoint` overrides 约束。升级 LangGraph 时检查并同步 overrides，避免同一进程加载不兼容的 checkpoint / schema 实例。
- 原生模块、Electron、OCR、ripgrep、RTK 或科研工具升级时，同时检查对应架构过滤、完整性校验、资源锁、许可证和专题文档；不要只改 `package.json`。
- 依赖升级后按改动范围运行 `pnpm typecheck`、`pnpm test`、`pnpm check:renderer-chunks` 和 `pnpm verify:native-packaging`。`pnpm test` 包含 Node 单元测试、renderer 测试和 Electron smoke。

## 快速开始

需要 Apple Silicon Mac、Node.js 26 和 pnpm 12.5.1。

```bash
pnpm install
pnpm dev
```

构建应用：

```bash
pnpm build
```

## 数据与隐私

应用配置、索引、日志和本地运行数据默认保存在 `~/.roc`；研究项目文件保存在创建项目时选择的工作目录。Provider 凭据由 Electron `safeStorage` 加密后保存在 `~/.roc/secrets`。使用模型、文献、网页或 MCP 集成时，请求会发送给相应的已配置服务。

## 文档

- [术语与产品约定](CONTEXT.md)
- [工作台与界面说明](docs/research-workbench.md)
- [内置技能来源与许可](docs/builtin-skills.md)
- [OCR 模型来源与许可](resources/research-models/README.md)
- [本地科研工具链](resources/research-runtime/README.md)
- [RTK 集成](docs/rtk-integration.md)

## License

仓库尚未单独声明许可证，默认保留所有权利。
