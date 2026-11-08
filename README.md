# Roc

Roc 是一款面向个人研究者的 macOS 桌面工作台，支持 Apple Silicon（arm64）。每个研究项目都有自己的文件、文献、会话和研究助手；进入项目后可在三栏工作区中使用文献、LaTeX 与终端视图。

## 功能

- 管理研究项目、项目文件、文献和助手会话。
- 搜索并导入学术文献，阅读 PDF；需要 OCR 时可按需下载本地模型。
- 在项目内使用研究助手处理文献、文件和研究任务，并连接用户配置的 MCP 工具。
- 在 LaTeX 画布和终端中工作。
- 执行受限的 TypeScript、R、Julia、Python 实验，查看冻结 Notebook 与实验结果。
- 在工件检查器中核查来源、方法计划、图稿、写作检查和综述审核，准备经过人工批准的科研交付包。

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

应用还包含本机工具：Tectonic、Vale、Typst、TeX bundle、ripgrep 和 RTK OSS。版本、校验和及许可来源分别由 [`resources/research-runtime/`](resources/research-runtime/README.md)、[`resources/ripgrep-binaries/ripgrep.lock.json`](resources/ripgrep-binaries/ripgrep.lock.json) 和 [`docs/rtk-integration.md`](docs/rtk-integration.md) 维护。npm 依赖由 [`package.json`](package.json) 与 [`pnpm-lock.yaml`](pnpm-lock.yaml) 固定。

## 技术栈与第三方依赖

Roc 是单一 Electron 桌面应用：主进程管理数据库、原生能力和服务，preload 通过受限 API 连接主进程与界面，React renderer 提供项目工作区。项目只面向 Apple Silicon macOS。

| 层 | 技术与用途 |
| --- | --- |
| 桌面运行时 | Electron；主进程与受限 preload 提供原生能力。 |
| 界面 | React、TypeScript、系统字体与项目语义 token。 |
| 开发与构建 | pnpm、electron-vite、Vite、Tailwind CSS、electron-builder。 |
| 平台与产物 | `package.json` 限定 `darwin` / `arm64`；electron-builder 生成 macOS 应用。 |

### 依赖清单

直接依赖及其固定版本以 [`package.json`](package.json) 为准，完整解析结果见 [`pnpm-lock.yaml`](pnpm-lock.yaml)。主要依赖涵盖 Agent 与模型、数据库与向量索引、OCR 和 PDF、文献检索、编辑器与终端，以及构建和测试工具。OCR 模型权重不随安装包分发，其来源、revision 和 SHA-256 见 [`resources/research-models/models.lock.json`](resources/research-models/models.lock.json)。

### 依赖升级

- npm 包的直接版本以 [`package.json`](package.json) 为准，解析结果以 [`pnpm-lock.yaml`](pnpm-lock.yaml) 为准；先用 `pnpm outdated` 查看可升级项；运行依赖使用 `pnpm add --save-exact package@version`，开发依赖使用 `pnpm add -D --save-exact package@version`，由 pnpm 更新 manifest 和 lockfile，不手改 lockfile。
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

- [完整文档索引](docs/README.md)
- [领域术语](CONTEXT.md)
- [工作台与界面说明](docs/research-workbench.md)
- [内置技能来源与许可](docs/builtin-skills.md)
- [OCR 模型来源与许可](resources/research-models/README.md)
- [本地科研工具链](resources/research-runtime/README.md)
- [RTK 集成](docs/rtk-integration.md)

## License

仓库尚未单独声明许可证，默认保留所有权利。
