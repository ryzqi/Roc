export type SidebarView = 'files' | 'git' | 'rag_wiki' | 'graph' | 'memory' | 'mcp_cron';

export type WorkspaceTab = 'latex' | 'plot' | 'terminal' | 'literature' | 'paper' | 'graph' | 'file';

export type LiteratureSubView = 'reader' | 'rag' | 'wiki' | 'papers' | 'graph' | 'knowledge';

export interface FileTreeNode {
  path: string;
  name: string;
  type: 'dir' | 'tex' | 'bib' | 'py' | 'json' | 'md' | 'txt' | 'pdf';
  children?: FileTreeNode[];
  content?: string;
  isExpanded?: boolean;
}

export interface RagSearchConfig {
  rrfK: number;                 // e.g. 60
  vectorWeight: number;         // e.g. 0.5
  keywordWeight: number;        // e.g. 0.5
  paperWeight: number;          // e.g. 0.3
  denseTopK: number;            // e.g. 6
  sparseTopK: number;           // e.g. 6
  paperTopK: number;            // e.g. 4
  enableReranker: boolean;      // true / false
  rerankerTopN: number;         // e.g. 4
  similarityThreshold: number;  // e.g. 0.15
  rerankerModel?: string;       // e.g. 'bge-reranker-large'
  enableContextualPrefix: boolean; // Contextual Retrieval enrichment
  enableParentExpansion: boolean;  // Expand child to parent section
}

export type ChunkGranularity = 'paper' | 'parent' | 'child';
export type ChunkContentType = 'abstract' | 'paragraph' | 'table' | 'formula' | 'figure_caption' | 'section_summary';

export interface MultiTierChunk {
  id: string;
  paperId: string;
  paperTitle: string;
  granularity: ChunkGranularity;
  contentType: ChunkContentType;
  section: string;
  parentId?: string;
  childIds?: string[];
  content: string;
  contextualPrefix: string;
  keywords: string[];
  provenance: {
    page?: number;
    paragraphIndex?: number;
    formulaName?: string;
    tableCaption?: string;
  };
}

export type RagChunk = MultiTierChunk;

export interface RetrievalItem {
  chunk: MultiTierChunk;
  parentChunk?: MultiTierChunk;
  vectorRank?: number;
  vectorScore?: number;
  keywordRank?: number;
  keywordScore?: number;
  paperRank?: number;
  paperScore?: number;
  rrfScore: number;
  rrfRank: number;
  rerankScore?: number;
  finalRank: number;
}

export interface PaperSection {
  id: string;
  title: string;
  level: number;
  content: string;
  paragraphs?: string[];
  formulas?: { name: string; latex: string; explanation: string }[];
  tables?: { caption: string; headers: string[]; rows: string[][] }[];
  figures?: { caption: string; description: string }[];
}

export interface ResearchPaper {
  id: string;
  arxivId: string;
  title: string;
  authors: string[];
  year: number;
  conference?: string;
  citations: number;
  abstract: string;
  tldr: string;
  tags: string[];
  pdfUrl?: string;
  bibtex: string;
  version?: string;
  fileType?: 'pdf' | 'html' | 'latex';
  keyFormulas?: { name: string; latex: string; explanation: string }[];
  notes?: string;
  sections?: PaperSection[];
  chunks?: MultiTierChunk[];
  mineruMetadata?: MinerUMetadata;
}

export interface MinerUExtractionStep {
  id: string;
  step: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  durationMs?: number;
  outputSummary?: string;
}

export interface MinerUMetadata {
  parsedAt: string;
  engine: string;          // e.g. 'MinerU v0.9 (magic-pdf + UniMERNet)'
  mode: 'pipeline' | 'hybrid' | 'ocr';
  pageCount: number;
  formulaCount: number;
  tableCount: number;
  headingsCount: number;
  layoutScore: number;     // e.g. 99.4%
  rawMarkdown?: string;
  contentListJson?: string;
  steps?: MinerUExtractionStep[];
  pdfFileName?: string;
  pdfFileSize?: string;
}

export interface MinerUConfig {
  serviceType: 'builtin' | 'cloud' | 'local';
  apiUrl: string;
  apiKey: string;
  modelMode: 'pipeline' | 'hybrid' | 'ocr';
  enableFormula: boolean;
  enableTable: boolean;
  language: 'auto' | 'en' | 'zh';
}

export interface GraphNode {
  id: string;
  label: string;
  category: 'method' | 'model' | 'metric' | 'theory' | 'dataset';
  val: number;
  x: number;
  y: number;
  description: string;
  papers: string[];
}

export interface GraphLink {
  source: string;
  target: string;
  relationship: string;
}

export interface IngestionPipelineStats {
  totalDocuments: number;
  deduplicatedCount: number;
  parsedSections: number;
  parsedFormulas: number;
  parsedTables: number;
  paperTierChunks: number;
  parentTierChunks: number;
  childTierChunks: number;
  contextualizedChunks: number;
  lastIngestedAt: string;
}

export interface WritingEvidenceItem {
  id: string;
  chunk: MultiTierChunk;
  stance: 'support' | 'refute' | 'boundary';
  claimPoint: string;
  score: number;
  explanation: string;
  citationKey: string;
}

export interface WritingRetrievalResult {
  thesisPrompt: string;
  parsedAspects: string[];
  supportEvidence: WritingEvidenceItem[];
  refuteEvidence: WritingEvidenceItem[];
  boundaryEvidence: WritingEvidenceItem[];
  evidenceMatrix: {
    paperTitle: string;
    paperId: string;
    aspect: string;
    stance: 'support' | 'refute' | 'boundary';
    finding: string;
    confidence: number;
    citationKey: string;
  }[];
  suggestedDrafts: {
    id: string;
    title: string;
    style: 'academic_formal' | 'critical_review' | 'method_justification';
    content: string;
  }[];
  consistencyReport: {
    score: number; // 0 - 100%
    isConsistent: boolean;
    totalClaimsChecked: number;
    verifiedClaims: number;
    contradictionNotes: string[];
  };
}

export interface WikiClaimCard {
  id: string;
  claim: string;
  sourcePaperTitle: string;
  paperId: string;
  arxivId: string;
  excerpt: string;
  stance: 'supported' | 'empirical_verified' | 'theoretical_bound';
  confidence: number;
}

export interface LlmWikiConcept {
  id: string;
  title: string;
  category: 'theory' | 'architecture' | 'algorithm' | 'benchmark' | 'metric';
  summary: string;
  formalDefinition?: {
    latex: string;
    explanation: string;
  };
  content: string; // contains [[Other Concept]] wikilinks
  evolutionTimeline: {
    year: number;
    paperTitle: string;
    milestone: string;
  }[];
  claimCards: WikiClaimCard[];
  comparativeMatrix: {
    aspect: string;
    comparisons: { paper: string; value: string }[];
  }[];
  backlinks: {
    conceptId: string;
    conceptTitle: string;
  }[];
  relatedConcepts: string[];
  paperIds: string[];
}

export type RagWikiEntry = LlmWikiConcept;

export interface VirtualFile {
  path: string;
  name: string;
  type: 'tex' | 'bib' | 'py' | 'json' | 'md' | 'dir';
  content?: string;
  isOpen?: boolean;
  isModified?: boolean;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
  changedFiles: number;
}

export type ManagementTab = 'memory' | 'skills' | 'mcp' | 'tasks';

export interface GuardrailRule {
  id: string;
  name: string;
  category: 'sandbox_security' | 'destructive_action' | 'budget_token' | 'pii_leakage' | 'human_in_loop';
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  action: 'block' | 'ask_user' | 'sanitize' | 'warn';
  enabled: boolean;
  interceptCount: number;
  lastIntercepted?: string;
  patternOrPolicy: string;
}

export interface TelemetryMetric {
  totalCalls: number;
  successRate: number;
  averageLatencyMs: number;
  totalTokensUsed: number;
  activeContextTokens: number;
  costEstimateUsd: number;
}

export interface EvalBenchmarkResult {
  id: string;
  name: string;
  benchmarkSuite: 'SWE-bench-Lite' | 'AIME-2024-Pass@1' | 'DeepEval-ToolCall' | 'Safety-RedTeam';
  score: number;
  passCount: number;
  totalTests: number;
  status: 'passed' | 'warning' | 'failed';
  lastRun: string;
  summary: string;
}

export interface AgentHarnessSubsystemMeta {
  key: ManagementTab;
  title: string;
  subtitle: string;
  industryTermEn: string;
  standardRole: string;
  standardDefinition: string;
  iconName: string;
  themeColor: string;
  badgeText: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  category: 'literature' | 'math_latex' | 'code_experiment' | 'academic_writing' | 'reasoning';
  description: string;
  version: string;
  enabled: boolean;
  systemPromptSnippet: string;
  requiredTools: string[];
  triggers: string[];
  skillContent?: string;
  parameters?: {
    name: string;
    type: string;
    description: string;
    value?: string;
  }[];
  author?: string;
  executionCount?: number;
  successRate?: number;
  lastTriggered?: string;
  tags?: string[];
}

export interface MemoryRecord {
  id: string;
  type: 'preference' | 'hypothesis' | 'methodology' | 'constraint' | 'insight';
  title: string;
  content: string;
  createdAt: string;
  confidence: number;
  organizedByAgent?: boolean;
  sourceSessionTitle?: string;
  agentReasoning?: string;
  tags?: string[];
  pinned?: boolean;
}

export type MemoryFileKey = 'USER.md' | 'AGENTS.md' | 'MEMORY.md';
export type MemoryScope = 'global' | 'project';

export interface MarkdownMemoryStore {
  userMemory: string;
  agentMemory: string;
  globalMemory: string;
  projectMemory: string;
}

export interface MCPServer {
  id: string;
  name: string;
  version: string;
  status: 'connected' | 'connecting' | 'disabled';
  endpoint: string;
  toolsCount: number;
  tools: string[];
  description: string;
  transport?: 'stdio' | 'sse' | 'ipc' | 'websocket' | 'http';
  transportType?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  latencyMs?: number;
  lastPing?: string;
}

export interface TaskExecutionLog {
  id: string;
  timestamp: string;
  status: 'success' | 'failed';
  durationMs: number;
  summary: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  scheduleDescription: string;
  nextRun: string;
  lastRun: string;
  status: 'active' | 'paused';
  actionPrompt: string;
  executionHistory?: TaskExecutionLog[];
}

export interface AgentToolCall {
  id: string;
  name: string;
  displayName: string;
  status: 'running' | 'completed' | 'failed';
  input: Record<string, any>;
  output?: any;
  durationMs?: number;
  targetWorkspaceTab?: WorkspaceTab;
}

export type MessageBlock =
  | {
      id: string;
      type: 'thought';
      content: string;
      isStreaming?: boolean;
      durationSeconds?: number;
    }
  | {
      id: string;
      type: 'tool_call';
      toolCall: AgentToolCall;
    }
  | {
      id: string;
      type: 'text';
      content: string;
      isStreaming?: boolean;
    };

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  timestamp: string;
  text: string;
  toolCalls?: AgentToolCall[];
  blocks?: MessageBlock[];
  targetTabSwitch?: WorkspaceTab;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  rerankerModels?: string[];
  type: 'llm' | 'embedding' | 'both';
  enabled: boolean;
}

export interface AcademicSourceConfig {
  arxivMirror: 'official' | 'cn' | 'tuna';
  semanticScholarApiKey: string;
  crossrefEmail: string;
  proxyUrl: string;
  autoFetchCitations: boolean;
  bibtexCitationStyle: 'IEEEtran' | 'ACM' | 'APA' | 'Nature';
}

export interface LatexSandboxConfig {
  latexEngine: 'wasm' | 'tectonic' | 'pdflatex' | 'xelatex';
  autoCompileOnSave: boolean;
  debounceMs: number;
  enableSynctex: boolean;
  sandboxRuntime: 'local_pyodide' | 'remote_docker';
  sandboxEndpoint: string;
  executionTimeoutSec: number;
  plotBackend: 'matplotlib' | 'plotly' | 'seaborn';
}

export interface AgentGuardrailSettings {
  shellSecurityLevel: 'strict' | 'prompt' | 'allow';
  fileOverwriteProtection: boolean;
  sessionTokenBudget: number;
  autoExtractMemory: boolean;
  memoryScope: 'global' | 'project';
  mcpTimeoutMs: number;
  allowExternalNetwork: boolean;
}

export interface ModelSettings {
  // 1. LLM Models & Providers
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  streamResponse?: boolean;
  enableThinking: boolean;
  customProviders?: CustomProvider[];
  activeProviderId?: string;

  // 2. Vector & RAG Studio
  ragProvider?: string;
  ragProviderId?: string;
  ragBaseUrl?: string;
  ragApiKey?: string;
  ragEmbeddingModel: string;
  ragChunkSize: number;
  ragChunkOverlap?: number;
  topK: number;
  ragRrfK?: number;
  ragVectorWeight?: number;
  ragKeywordWeight?: number;
  ragPaperWeight?: number;
  ragEnableReranker?: boolean;
  ragRerankerModel?: string;
  ragSimilarityThreshold?: number;
  ragEnableContextualPrefix?: boolean;
  ragEnableParentExpansion?: boolean;

  // 3. Literature & MinerU & Academic Sources
  mineruConfig?: MinerUConfig;
  academicConfig?: AcademicSourceConfig;

  // 4. LaTeX & Code Sandbox
  sandboxConfig?: LatexSandboxConfig;

  // 5. Agent & Guardrails
  guardrailSettings?: AgentGuardrailSettings;

  // 6. General & Backup
  theme?: 'light' | 'dark' | 'system';
  fontSize?: 'small' | 'medium' | 'large';
  editorFontSize?: number;
  autoSwitchWorkspace: boolean;
}

export type ProjectStatus = 'drafting' | 'experiment' | 'reviewing' | 'accepted';

export interface PaperProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  field: string;
  targetVenue: string;
  status: ProjectStatus;
  updatedAt: string;
  createdAt: string;
  tags: string[];
  paperCount: number;
  fileCount: number;
  wordCount: number;
  isStarred?: boolean;
}

export interface ProjectWorkspaceData {
  papers: ResearchPaper[];
  activePaperId?: string;
  files: VirtualFile[];
  activeFilePath?: string;
  gitCommits: GitCommit[];
  wikiEntries: RagWikiEntry[];
  graphNodes: GraphNode[];
  graphLinks: GraphLink[];
  selectedGraphNodeId?: string;
  memories: MemoryRecord[];
  skills: AgentSkill[];
  mcpServers: MCPServer[];
  scheduledTasks: ScheduledTask[];
  guardrails: GuardrailRule[];
  telemetry: TelemetryMetric;
  benchmarks: EvalBenchmarkResult[];
  sessions: ChatSession[];
  activeSessionId: string;
}
