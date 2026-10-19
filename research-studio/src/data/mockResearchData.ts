import {
  ResearchPaper,
  GraphNode,
  GraphLink,
  RagWikiEntry,
  LlmWikiConcept,
  VirtualFile,
  GitCommit,
  MemoryRecord,
  AgentSkill,
  MCPServer,
  ScheduledTask,
  ChatMessage,
  ChatSession,
  ModelSettings,
  GuardrailRule,
  TelemetryMetric,
  EvalBenchmarkResult,
  AgentHarnessSubsystemMeta
} from '../types/research';

export const INITIAL_PAPERS: ResearchPaper[] = [];

export const INITIAL_GRAPH_NODES: GraphNode[] = [];

export const INITIAL_GRAPH_LINKS: GraphLink[] = [];

export const INITIAL_RAG_WIKI: LlmWikiConcept[] = [];

export const INITIAL_FILES: VirtualFile[] = [];

export const INITIAL_COMMITS: GitCommit[] = [];

export const INITIAL_MEMORIES: MemoryRecord[] = [];

export const INITIAL_USER_MEMORY_MD = `# 用户偏好 (USER.md)

## 1. 身份与研究领域
- **研究员**: Dr. Researcher
- **主要领域**: 大语言模型推理能力、强化学习 (RLHF/GRPO)、小模型知识蒸馏
- **目标会议**: NeurIPS 2026, ICML 2026

## 2. LaTeX 写作与排版习惯
- **公式符号**:
  - 目标函数统一采用 \\mathcal{J}_{\\text{name}}(\\theta) 格式。
  - 数据集与分布统一采用 \\mathcal{D}_{\\text{train}}, \\mathcal{P}_{\\text{ref}}。
  - 连续推导统一使用 align 环境。
- **写作风格**:
  - 严谨克制，遵守双盲评审规范。
  - 实验表格统一采用三线表结构（\\toprule, \\midrule, \\bottomrule）。

## 3. 开发环境
- 本地设备: Apple Silicon (128GB Unified Memory)
- 集群环境: 8 × NVIDIA A100 (80GB)
- 框架工具: PyTorch 2.5, Transformers, vLLM`;

export const INITIAL_AGENTS_MD = `# AI 行为准则 (AGENTS.md)

## 1. 角色定位
- 学术科研助理，协助推导数学公式、审查实验代码、检索文献并编写 LaTeX。

## 2. 批判性反思
- **客观严谨**: 当理论假设存在漏洞时主动提出质疑与反例，避免盲目迎合。
- **双向验算**: 输出数学公式前进行边界检查与代数验证。
- **安全规范**: 实验制图与脚本固定随机种子，小规模数据先行验证。

## 3. 工具使用
- 优先通过标准 MCP 工具调度 arXiv 与终端环境。
- 严禁执行高危破坏性系统指令。
- 文件修改自动保留 Git 版本记录。`;

export const INITIAL_MEMORY_GLOBAL_MD = `# 全局知识库 (MEMORY.md - Global)

## 1. 核心理论与方法论
- 在学术研讨与写作中，注重严谨的形式化数学定义与符号守恒。
- 实验对比与评测基准需注明样本集、指标定义与复现参数。

## 2. 文献与数据管理
- 导入前沿论文并基于 MinerU 提取高保真 Markdown 与核心公式。
- 支持知识图谱拓扑演进与多层级向量切片关联。`;

export const INITIAL_MEMORY_PROJECT_MD = `# 项目记忆 (MEMORY.md - Project)

## 1. 核心研究课题
- 记录当前课题的研究假设、理论推导进展与验证基准。

## 2. 实验参数与日志
- 统一记录模型超参数、训练步数与验证集指标。

## 3. 文档状态
- 追踪 LaTeX 论文草稿撰写、方法章节与实验图表汇总进度。`;

export const INITIAL_SKILLS: AgentSkill[] = [
  {
    id: 'skill-latex-formula-audit',
    name: 'LaTeX 公式检查',
    category: 'math_latex',
    description: '检查论文中的公式符号规范、维度守恒与 align 排版。',
    version: 'v2.1.0',
    enabled: true,
    systemPromptSnippet: '处理数学公式时：遵循符号体系，用 \\mathcal{} 标识集合，检查上下限，确保公式变量清晰定义。',
    skillContent: `---
name: "LaTeX 公式检查"
description: "检查论文中的公式符号规范、维度守恒与 align 排版。"
---

# LaTeX 公式检查 (SKILL.md)

本技能核验 LaTeX 论文的数学推导与公式排版。

## 适用场景
- 检查 LaTeX 源码中的行内与行间公式。
- 核验目标函数与求和符号排版。

## 规范准则
1. **符号规范**：集合与算子使用 \\mathcal{}（如 \\mathcal{D}）。
2. **多行对齐**：多步推导统一采用 align 环境。
3. **变量说明**：新符号出现时给出明确定义。`,
    requiredTools: ['pdflatex_compile', 'file_edit'],
    triggers: ['公式推导', 'LaTeX审计', '\\mathcal', '对齐公式', '公式检查'],
    parameters: [
      { name: 'style', type: 'string', description: '期刊或会议样式', value: 'IEEEtran' },
      { name: 'strictMathCheck', type: 'boolean', description: '开启维度检查', value: 'true' }
    ],
    author: '系统预置',
    executionCount: 142,
    successRate: 99,
    lastTriggered: '10 分钟前',
    tags: ['LaTeX', '公式排版']
  },
  {
    id: 'skill-arxiv-deep-dive',
    name: 'arXiv 文献检索',
    category: 'literature',
    description: '检索目标学科最新预印本，提取核心算法与实验对比。',
    version: 'v1.4.0',
    enabled: true,
    systemPromptSnippet: '文献综述模式：调用 arXiv 工具提取最新论文，梳理 Baseline 核心实验指标，生成三线表对比。',
    skillContent: `---
name: "arXiv 文献检索"
description: "检索目标学科最新预印本，提取核心算法与实验对比。"
---

# arXiv 文献检索 (SKILL.md)

本技能用于跟踪前沿论文并提炼核心成果。

## 适用场景
- 调研最新文献与寻找 Baseline。
- 检索 cs.AI / cs.LG 预印本。

## 规范准则
1. **真实引用**：严格核验预印本编号（如 2501.12948）。
2. **核心机制**：提取损失函数与关键超参数。
3. **结构化呈现**：生成简洁三线表对比。`,
    requiredTools: ['arxiv_search', 'rag_vector_upsert', 'arxiv_get_metadata'],
    triggers: ['文献检索', 'arXiv查新', '对比实验', '前沿追溯', 'Baseline'],
    parameters: [
      { name: 'maxPapers', type: 'number', description: '最大检索篇数', value: '5' },
      { name: 'primaryCategory', type: 'string', description: '学科分类', value: 'cs.AI' }
    ],
    author: '系统预置',
    executionCount: 89,
    successRate: 97,
    lastTriggered: '35 分钟前',
    tags: ['arXiv', '文献综述']
  },
  {
    id: 'skill-code-repro-checker',
    name: '代码复现检查',
    category: 'code_experiment',
    description: '排查训练脚本中的随机种子、学习率调度与显存设置，生成复现性报告。',
    version: 'v1.1.0',
    enabled: true,
    systemPromptSnippet: '复现性检查：排查 torch.manual_seed、梯度聚合逻辑及保存机制。',
    skillContent: `---
name: "代码复现检查"
description: "排查训练脚本中的随机种子、学习率调度与显存设置，生成复现性报告。"
---

# 代码复现检查 (SKILL.md)

本技能对深度学习训练代码进行可复现性审计。

## 规范准则
1. **种子锁定**：核验 manual_seed 是否显式声明。
2. **确定性算子**：检查 cudnn.deterministic 配置。
3. **显存防护**：评估推理包与内存泄漏隐患。`,
    requiredTools: ['python_exec', 'file_edit'],
    triggers: ['可复现性', '训练脚本', '超参检查', '显存瓶颈', 'PyTorch'],
    parameters: [
      { name: 'checkSeed', type: 'boolean', description: '严格种子检验', value: 'true' },
      { name: 'gpuArchitecture', type: 'string', description: '目标显卡', value: 'A100-80G' }
    ],
    author: '系统预置',
    executionCount: 63,
    successRate: 95,
    lastTriggered: '2 小时前',
    tags: ['代码分析', 'PyTorch']
  },
  {
    id: 'skill-table-tikz-generator',
    name: 'LaTeX 表格与制图',
    category: 'academic_writing',
    description: '将实验评估数据转化为三线表，或生成 TikZ 架构流程代码。',
    version: 'v2.0.1',
    enabled: true,
    systemPromptSnippet: '制表与制图：使用 \\toprule、\\midrule、\\bottomrule，最优数值加粗；生成 TikZ 时统一色彩。',
    skillContent: `---
name: "LaTeX 表格与制图"
description: "将实验评估数据转化为三线表，或生成 TikZ 架构流程代码。"
---

# LaTeX 表格与制图 (SKILL.md)

本技能自动生成学术标准的 LaTeX 表格与矢量图。

## 规范准则
1. **三线表规范**：使用 \\toprule, \\midrule, \\bottomrule，禁止竖线。
2. **数值对齐**：最优指标加粗标注。
3. **TikZ 规范**：使用标准节点样式，双栏宽度下文字无重叠。`,
    requiredTools: ['file_edit', 'pdflatex_compile'],
    triggers: ['三线表', '表格排版', 'TikZ', '架构图', 'booktabs'],
    parameters: [
      { name: 'highlightBest', type: 'boolean', description: '加粗最优项', value: 'true' },
      { name: 'tableWidth', type: 'string', description: '栏宽模式', value: 'single_col' }
    ],
    author: '系统预置',
    executionCount: 118,
    successRate: 98,
    lastTriggered: '4 小时前',
    tags: ['LaTeX表格', 'TikZ']
  },
  {
    id: 'skill-counterfactual-debate',
    name: '审稿意见模拟',
    category: 'reasoning',
    description: '模拟严格审稿人视角，对论文贡献声明、基准完备性与假设前提发起质疑。',
    version: 'v1.3.2',
    enabled: true,
    systemPromptSnippet: '审稿人模拟：以批判视角寻找逻辑漏洞，列出可能被质疑的缺陷并给出回应建议。',
    skillContent: `---
name: "审稿意见模拟"
description: "模拟严格审稿人视角，对论文贡献声明、基准完备性与假设前提发起质疑。"
---

# 审稿意见模拟 (SKILL.md)

本技能帮助研究者在投稿前发现潜在漏洞并完善论证。

## 规范准则
1. **针对性**：针对理论证明边界与消融实验充分性提出质疑。
2. **反思设计**：伴随具体验证方案。
3. **回应策略**：给出推演、实验补充与措辞调整建议。`,
    requiredTools: ['rag_vector_upsert'],
    triggers: ['审稿人质疑', '对抗推演', 'Rebuttal', '反事实假说', '论文缺陷'],
    parameters: [
      { name: 'toughness', type: 'string', description: '严苛等级', value: 'harsh' },
      { name: 'focusArea', type: 'string', description: '审查侧重', value: 'theoretical_novelty' }
    ],
    author: '系统预置',
    executionCount: 47,
    successRate: 94,
    lastTriggered: '昨天',
    tags: ['同行评审', 'Rebuttal']
  },
  {
    id: 'skill-neurips-compliance',
    name: '双盲格式检查',
    category: 'academic_writing',
    description: '检查论文匿名性、正文页数、可复现性问卷与引用规范。',
    version: 'v1.0.0',
    enabled: false,
    systemPromptSnippet: '双盲检查：扫描作者名、单位致谢、非匿名链接，校验 9 页正文上限。',
    skillContent: `---
name: "双盲格式检查"
description: "检查论文匿名性、正文页数、可复现性问卷与引用规范。"
---

# 双盲格式检查 (SKILL.md)

本技能审查顶会投稿双盲要求与排版规范。

## 规范准则
1. **匿名性**：排查作者姓名、实验室致谢与个人链接。
2. **页数限制**：核算正文页数上限。
3. **清单核验**：检查代码开源与算力说明。`,
    requiredTools: ['file_edit'],
    triggers: ['双盲自检', '匿名审查', '投稿合规', 'NeurIPS', '页数检查'],
    parameters: [
      { name: 'targetVenue', type: 'string', description: '目标会议', value: 'NeurIPS 2026' }
    ],
    author: '自定义',
    executionCount: 19,
    successRate: 100,
    lastTriggered: '3 天前',
    tags: ['双盲匿名', '学术合规']
  }
];

export const INITIAL_MCP_SERVERS: MCPServer[] = [
  {
    id: 'mcp-arxiv',
    name: 'ArXiv 检索',
    version: 'v2.1.0',
    status: 'connected',
    endpoint: 'uvx arxiv-mcp-server --max-results 10',
    transport: 'stdio',
    transportType: 'stdio',
    command: 'uvx',
    args: ['arxiv-mcp-server', '--max-results', '10'],
    env: { ARXIV_RATE_LIMIT: '3', CACHE_DIR: '~/.cache/arxiv-mcp' },
    latencyMs: 18,
    lastPing: '刚刚',
    toolsCount: 4,
    tools: ['arxiv_search', 'arxiv_get_metadata', 'arxiv_download_pdf', 'arxiv_citation_tree'],
    description: '通过标准 stdio 运行 arXiv 文献检索与 PDF 解析。'
  },
  {
    id: 'mcp-zotero',
    name: 'Zotero 同步',
    version: 'v1.4.2',
    status: 'connected',
    endpoint: 'http://127.0.0.1:23119/mcp',
    transport: 'http',
    transportType: 'http',
    url: 'http://127.0.0.1:23119/mcp',
    headers: { Authorization: 'Bearer zotero_local_api_key', 'Content-Type': 'application/json' },
    latencyMs: 32,
    lastPing: '1 分钟前',
    toolsCount: 3,
    tools: ['zotero_get_collections', 'zotero_sync_bibtex', 'zotero_attach_notes'],
    description: '通过 HTTP 端点连接本地 Zotero，同步引用与笔记。'
  },
  {
    id: 'mcp-terminal',
    name: '终端与沙箱',
    version: 'v3.0.1',
    status: 'connected',
    endpoint: 'npx -y @modelcontextprotocol/server-filesystem ./',
    transport: 'stdio',
    transportType: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', './'],
    env: { SHELL: '/bin/zsh', LATEX_ENGINE: 'pdflatex' },
    latencyMs: 9,
    lastPing: '刚刚',
    toolsCount: 6,
    tools: ['run_bash_command', 'git_diff', 'git_commit', 'pdflatex_compile', 'python_repl', 'file_write'],
    description: '安全沙箱环境，支持执行 Shell 命令、编译 LaTeX 与运行脚本。'
  },
  {
    id: 'mcp-knowledge',
    name: '知识库检索',
    version: 'v1.8.0',
    status: 'connected',
    endpoint: 'http://localhost:8080/mcp/sse',
    transport: 'http',
    transportType: 'http',
    url: 'http://localhost:8080/mcp/sse',
    headers: { 'X-Project-ID': 'transformer-reasoning', Accept: 'text/event-stream' },
    latencyMs: 24,
    lastPing: '2 分钟前',
    toolsCount: 3,
    tools: ['query_vector_chunks', 'expand_knowledge_graph', 'generate_concept_wiki'],
    description: '提供向量检索与概念图谱查询服务。'
  }
];

export const INITIAL_SCHEDULED_TASKS: ScheduledTask[] = [];

export const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'msg-welcome',
    sender: 'assistant',
    timestamp: '刚刚',
    text: '您好！我是您的学术科研助手。您可以导入论文文献、在工作区编写 LaTeX、执行实验脚本或进行学术推导演进。请问有什么可以协助您？'
  }
];

export const INITIAL_SESSIONS: ChatSession[] = [
  {
    id: 'session-main',
    title: '新建研讨对话',
    createdAt: '今天',
    updatedAt: '刚刚',
    messages: INITIAL_MESSAGES
  }
];

export const DEFAULT_SETTINGS: ModelSettings = {
  provider: '',
  modelId: '',
  apiKey: '',
  baseUrl: '',
  temperature: 0.7,
  maxTokens: 8192,
  topK: 5,
  autoSwitchWorkspace: true,
  enableThinking: false,
  ragProvider: '',
  ragBaseUrl: '',
  ragApiKey: '',
  ragEmbeddingModel: '',
  ragChunkSize: 512,
  ragChunkOverlap: 64,
  ragRrfK: 60,
  ragVectorWeight: 0.5,
  ragKeywordWeight: 0.5,
  ragPaperWeight: 0.3,
  ragEnableReranker: false,
  ragRerankerModel: '',
  ragSimilarityThreshold: 0.55,
  ragEnableContextualPrefix: true,
  ragEnableParentExpansion: true,
  theme: 'dark',
  fontSize: 'medium',
  editorFontSize: 13,
  streamResponse: true,
  customProviders: [],
  mineruConfig: {
    serviceType: 'builtin',
    apiUrl: 'https://mineru.net/api/v4',
    apiKey: 'mineru_demo_token_ak8291',
    modelMode: 'pipeline',
    enableFormula: true,
    enableTable: true,
    language: 'auto'
  },
  academicConfig: {
    arxivMirror: 'cn',
    semanticScholarApiKey: '',
    crossrefEmail: 'researcher@academic.org',
    proxyUrl: '',
    autoFetchCitations: true,
    bibtexCitationStyle: 'IEEEtran'
  },
  sandboxConfig: {
    latexEngine: 'tectonic',
    autoCompileOnSave: true,
    debounceMs: 500,
    enableSynctex: true,
    sandboxRuntime: 'local_pyodide',
    sandboxEndpoint: 'http://localhost:8000/sandbox',
    executionTimeoutSec: 30,
    plotBackend: 'matplotlib'
  },
  guardrailSettings: {
    shellSecurityLevel: 'strict',
    fileOverwriteProtection: true,
    sessionTokenBudget: 65536,
    autoExtractMemory: true,
    memoryScope: 'project',
    mcpTimeoutMs: 15000,
    allowExternalNetwork: true
  }
};


export const AGENT_HARNESS_SUBSYSTEMS: AgentHarnessSubsystemMeta[] = [
  {
    key: 'memory',
    title: '记忆',
    subtitle: 'Memory & Profile',
    industryTermEn: 'Memory Store',
    standardRole: '跨会话记忆与偏好维护',
    standardDefinition: '保存用户偏好、AI 准则与知识库文档。',
    iconName: 'Brain',
    themeColor: '#8B5CF6',
    badgeText: '5 条记忆'
  },
  {
    key: 'skills',
    title: '技能',
    subtitle: 'Skills & Directives',
    industryTermEn: 'Skills Store',
    standardRole: '专业技能与工作流',
    standardDefinition: '提供针对科研场景的专业规范与指令。',
    iconName: 'Sparkles',
    themeColor: '#6366F1',
    badgeText: '5/6 启用'
  },
  {
    key: 'mcp',
    title: 'MCP',
    subtitle: 'Model Context Protocol',
    industryTermEn: 'Tool Bus',
    standardRole: '外部工具与执行环境',
    standardDefinition: '遵循 MCP 协议连接外部工具与服务。',
    iconName: 'Cpu',
    themeColor: '#3B82F6',
    badgeText: '4 在线 · 16 工具'
  },
  {
    key: 'tasks',
    title: '定时任务',
    subtitle: 'Scheduled Tasks',
    industryTermEn: 'Cron Tasks',
    standardRole: '后台定时与自动任务',
    standardDefinition: '支持定时调度与自动任务后台执行。',
    iconName: 'Clock',
    themeColor: '#F59E0B',
    badgeText: '3 项任务'
  }
];

export const INITIAL_GUARDRAILS: GuardrailRule[] = [
  {
    id: 'guard-1',
    name: '高危命令拦截',
    category: 'destructive_action',
    description: '拦截诸如 rm -rf、格式化磁盘、删除非工作区目录等破坏性命令。',
    severity: 'critical',
    action: 'block',
    enabled: true,
    interceptCount: 2,
    lastIntercepted: '昨天 15:40',
    patternOrPolicy: 'Regex: (rm\\s+-rf|dd\\s+if=|mkfs|chmod\\s+-R\\s+777\\s+/)'
  },
  {
    id: 'guard-2',
    name: '重大改动人工确认',
    category: 'human_in_loop',
    description: '当计划修改核心源码或重要文档超过 50 行时，需用户确认。',
    severity: 'high',
    action: 'ask_user',
    enabled: true,
    interceptCount: 0,
    patternOrPolicy: 'Policy: file_diff_lines > 50 || is_critical_file(target)'
  },
  {
    id: 'guard-3',
    name: '密钥脱敏防泄露',
    category: 'pii_leakage',
    description: '渲染消息与输出前，自动脱敏包含密钥或 Token 的凭证字符串。',
    severity: 'high',
    action: 'sanitize',
    enabled: true,
    interceptCount: 0,
    patternOrPolicy: 'Regex: (sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,})'
  },
  {
    id: 'guard-4',
    name: '执行步数上限限制',
    category: 'sandbox_security',
    description: '单个任务内连续工具调用超过 15 步时暂停并提醒。',
    severity: 'medium',
    action: 'ask_user',
    enabled: true,
    interceptCount: 0,
    patternOrPolicy: 'Policy: consecutive_tool_calls <= 15'
  },
  {
    id: 'guard-5',
    name: '单日 Token 预算预警',
    category: 'budget_token',
    description: '单日消耗达到 500k 触发预警，达到 1M 切换至轻量模型。',
    severity: 'low',
    action: 'warn',
    enabled: true,
    interceptCount: 0,
    patternOrPolicy: 'Threshold: 500k warning, 1M hard fallback'
  }
];

export const INITIAL_TELEMETRY: TelemetryMetric = {
  totalCalls: 0,
  successRate: 100,
  averageLatencyMs: 0,
  totalTokensUsed: 0,
  activeContextTokens: 0,
  costEstimateUsd: 0
};

export const INITIAL_BENCHMARKS: EvalBenchmarkResult[] = [];

