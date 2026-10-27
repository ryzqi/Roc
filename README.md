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

应用还包含 Tectonic、Vale、Typst、TeX 资源子集、ripgrep 和 RTK。它们在本机运行；版本与来源由 `resources/` 中的锁文件和专题文档维护。npm 依赖由 `pnpm-lock.yaml` 固定。

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
