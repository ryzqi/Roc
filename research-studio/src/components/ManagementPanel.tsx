import React, { useState, useEffect } from 'react';
import {
  AgentSkill,
  MCPServer,
  ScheduledTask,
  ManagementTab,
  GuardrailRule,
  TelemetryMetric,
  EvalBenchmarkResult
} from '../types/research';
import {
  INITIAL_USER_MEMORY_MD,
  INITIAL_AGENTS_MD,
  INITIAL_MEMORY_GLOBAL_MD,
  INITIAL_MEMORY_PROJECT_MD
} from '../data/mockResearchData';
import {
  X,
  Brain,
  Cpu,
  Clock,
  Sparkles,
  Search,
  Plus,
  RotateCw,
  CheckCircle2,
  Trash2,
  Edit3,
  ChevronDown,
  ChevronUp,
  Sliders,
  Check,
  Zap,
  Terminal,
  Code2,
  CheckCheck,
  Copy,
  FileText,
  Save,
  FileCode,
  Globe,
  FolderGit2,
  Wand2,
  AlertCircle
} from 'lucide-react';

interface ManagementPanelProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: ManagementTab;
  onChangeTab: (tab: ManagementTab) => void;
  // Memory
  memories?: any[];
  onAddMemory?: (...args: any[]) => void;
  onUpdateMemory?: (...args: any[]) => void;
  onDeleteMemory?: (id: string) => void;
  onOrganizeMemoriesWithAgent?: () => void;
  // Skills
  skills?: AgentSkill[];
  onToggleSkill?: (id: string) => void;
  onAddSkill?: (skill: AgentSkill) => void;
  onUpdateSkill?: (skill: AgentSkill) => void;
  onDeleteSkill?: (id: string) => void;
  onSynthesizeSkillWithAgent?: () => void;
  // MCP
  mcpServers: MCPServer[];
  onToggleMCP: (id: string) => void;
  onAddMCPServer?: (server: MCPServer) => void;
  onDeleteMCPServer?: (id: string) => void;
  // Scheduled Tasks
  scheduledTasks: ScheduledTask[];
  onTriggerTask: (task: ScheduledTask) => void;
  onToggleTaskStatus?: (id: string) => void;
  onAddScheduledTask?: (task: ScheduledTask) => void;
  onDeleteScheduledTask?: (id: string) => void;
  // Guardrails & Telemetry
  guardrails?: GuardrailRule[];
  onToggleGuardrail?: (id: string) => void;
  onAddGuardrail?: (rule: GuardrailRule) => void;
  onDeleteGuardrail?: (id: string) => void;
  telemetry?: TelemetryMetric;
  benchmarks?: EvalBenchmarkResult[];
  onRunBenchmark?: (id: string) => void;
  onSendToChat?: (text: string) => void;
}

// Markdown lightweight formatter
const renderMarkdownPreview = (text: string) => {
  const lines = text.split('\n');
  let inCodeBlock = false;
  let codeLines: string[] = [];
  const renderedNodes: React.ReactNode[] = [];

  lines.forEach((line, index) => {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        renderedNodes.push(
          <pre
            key={`code-${index}`}
            className="p-3 bg-slate-900 text-slate-100 font-mono text-[11px] rounded-lg overflow-x-auto my-2 border border-slate-800"
          >
            {codeLines.join('\n')}
          </pre>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      return;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      return;
    }

    if (line.startsWith('# ')) {
      renderedNodes.push(
        <h1
          key={index}
          className="text-sm font-bold text-slate-900 mt-4 mb-2 pb-1 border-b border-slate-200"
        >
          {line.replace('# ', '')}
        </h1>
      );
    } else if (line.startsWith('## ')) {
      renderedNodes.push(
        <h2
          key={index}
          className="text-xs font-semibold text-slate-800 mt-3 mb-1.5 flex items-center gap-1.5"
        >
          {line.replace('## ', '')}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      renderedNodes.push(
        <h3 key={index} className="text-[11px] font-semibold text-slate-700 mt-2 mb-1">
          {line.replace('### ', '')}
        </h3>
      );
    } else if (line.trim().startsWith('- ')) {
      renderedNodes.push(
        <li
          key={index}
          className="text-xs text-slate-600 ml-4 list-disc my-0.5 leading-relaxed"
        >
          {line.trim().replace('- ', '')}
        </li>
      );
    } else if (/^\d+\.\s/.test(line.trim())) {
      const match = line.trim().match(/^\d+\.\s*(.*)$/);
      renderedNodes.push(
        <li
          key={index}
          className="text-xs text-slate-600 ml-4 list-decimal my-0.5 leading-relaxed"
        >
          {match ? match[1] : line}
        </li>
      );
    } else if (line.trim() === '---') {
      renderedNodes.push(<hr key={index} className="my-2.5 border-slate-200" />);
    } else if (line.trim() === '') {
      renderedNodes.push(<div key={index} className="h-1.5" />);
    } else {
      renderedNodes.push(
        <p key={index} className="text-xs text-slate-600 leading-relaxed my-0.5">
          {line}
        </p>
      );
    }
  });

  return renderedNodes;
};

export const ManagementPanel: React.FC<ManagementPanelProps> = ({
  isOpen,
  onClose,
  activeTab,
  onChangeTab,
  skills = [],
  onToggleSkill,
  mcpServers,
  onToggleMCP,
  onAddMCPServer,
  onDeleteMCPServer,
  scheduledTasks,
  onTriggerTask,
  onToggleTaskStatus,
  onAddScheduledTask,
  onDeleteScheduledTask,
  onSendToChat
}) => {
  // ESC key listener to close panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // ==========================================
  // 1. REFACTORED MEMORY STATES (USER.md / AGENTS.md / MEMORY.md)
  // ==========================================
  type MemoryFileTab = 'user' | 'agent' | 'general';
  type GeneralMemoryScope = 'global' | 'project';

  const [activeMemoryFile, setActiveMemoryFile] = useState<MemoryFileTab>('user');
  const [generalScope, setGeneralScope] = useState<GeneralMemoryScope>('global');
  const [memoryViewMode, setMemoryViewMode] = useState<'preview' | 'edit'>('edit');

  // Markdown stores
  const [userMemoryMd, setUserMemoryMd] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('codex_memory_user_md');
      return saved || INITIAL_USER_MEMORY_MD;
    } catch {
      return INITIAL_USER_MEMORY_MD;
    }
  });

  const [agentMemoryMd, setAgentMemoryMd] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('codex_memory_agent_md');
      return saved || INITIAL_AGENTS_MD;
    } catch {
      return INITIAL_AGENTS_MD;
    }
  });

  const [globalMemoryMd, setGlobalMemoryMd] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('codex_memory_global_md');
      return saved || INITIAL_MEMORY_GLOBAL_MD;
    } catch {
      return INITIAL_MEMORY_GLOBAL_MD;
    }
  });

  const [projectMemoryMd, setProjectMemoryMd] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('codex_memory_project_md');
      return saved || INITIAL_MEMORY_PROJECT_MD;
    } catch {
      return INITIAL_MEMORY_PROJECT_MD;
    }
  });

  const [isOrganizingMemory, setIsOrganizingMemory] = useState(false);
  const [organizeStep, setOrganizeStep] = useState<string>('');
  const [saveSuccessNotice, setSaveSuccessNotice] = useState<string | null>(null);

  // Active memory content helper
  const getCurrentMemoryContent = (): string => {
    if (activeMemoryFile === 'user') return userMemoryMd;
    if (activeMemoryFile === 'agent') return agentMemoryMd;
    return generalScope === 'global' ? globalMemoryMd : projectMemoryMd;
  };

  const setCurrentMemoryContent = (val: string) => {
    if (activeMemoryFile === 'user') {
      setUserMemoryMd(val);
      try {
        localStorage.setItem('codex_memory_user_md', val);
      } catch {}
    } else if (activeMemoryFile === 'agent') {
      setAgentMemoryMd(val);
      try {
        localStorage.setItem('codex_memory_agent_md', val);
      } catch {}
    } else if (generalScope === 'global') {
      setGlobalMemoryMd(val);
      try {
        localStorage.setItem('codex_memory_global_md', val);
      } catch {}
    } else {
      setProjectMemoryMd(val);
      try {
        localStorage.setItem('codex_memory_project_md', val);
      } catch {}
    }
  };

  const getMemoryFilePath = (): string => {
    if (activeMemoryFile === 'user') return '~/.roc/memories/USER.md';
    if (activeMemoryFile === 'agent') return '~/.roc/memories/AGENTS.md';
    return generalScope === 'global'
      ? '~/.roc/memories/MEMORY.md'
      : '~/.roc/memories/PROJECT_MEMORY.md';
  };

  // Agent Autonomous Curation: analyzes current context & appends insight
  const handleTriggerAgentOrganize = () => {
    setIsOrganizingMemory(true);
    setOrganizeStep('正在扫描当前研讨会话与 LaTeX 论文源码...');
    setTimeout(() => {
      setOrganizeStep('整理偏好、配置与研究假设...');
      setTimeout(() => {
        setIsOrganizingMemory(false);
        setOrganizeStep('');

        const timestamp = new Date().toISOString().split('T')[0];
        let addition = '';
        if (activeMemoryFile === 'user') {
          addition = `\n\n- **[自动整理 ${timestamp}]**: 行间公式排版时保持整洁规范，关键结论明确标出。`;
          setUserMemoryMd((prev) => prev + addition);
        } else if (activeMemoryFile === 'agent') {
          addition = `\n\n- **[自动整理 ${timestamp}]**: 遇到复杂公式推导时，给出清晰推导步骤与说明。`;
          setAgentMemoryMd((prev) => prev + addition);
        } else if (generalScope === 'global') {
          addition = `\n\n- **[通用知识 ${timestamp}]**: 蒸馏小模型在应对长推理链时，引入格式奖励可显著提升稳定性。`;
          setGlobalMemoryMd((prev) => prev + addition);
        } else {
          addition = `\n\n- **[项目更新 ${timestamp}]**: 采样组 G=8 相比 G=4 能提供更稳定的相对优势估计。`;
          setProjectMemoryMd((prev) => prev + addition);
        }

        setSaveSuccessNotice('已完成整理并保存至记忆文档！');
        setTimeout(() => setSaveSuccessNotice(null), 3500);

        onSendToChat?.('【记忆已整理】已更新偏好与关键结论至记忆文件。');
      }, 700);
    }, 600);
  };

  const handleManualSaveMemory = () => {
    try {
      if (activeMemoryFile === 'user') {
        localStorage.setItem('codex_memory_user_md', userMemoryMd);
      } else if (activeMemoryFile === 'agent') {
        localStorage.setItem('codex_memory_agent_md', agentMemoryMd);
      } else if (generalScope === 'global') {
        localStorage.setItem('codex_memory_global_md', globalMemoryMd);
      } else {
        localStorage.setItem('codex_memory_project_md', projectMemoryMd);
      }
    } catch {}
    setSaveSuccessNotice('记忆文件已保存！');
    setTimeout(() => setSaveSuccessNotice(null), 2500);
  };

  const handleResetCurrentMemory = () => {
    if (activeMemoryFile === 'user') setUserMemoryMd(INITIAL_USER_MEMORY_MD);
    else if (activeMemoryFile === 'agent') setAgentMemoryMd(INITIAL_AGENTS_MD);
    else if (generalScope === 'global') setGlobalMemoryMd(INITIAL_MEMORY_GLOBAL_MD);
    else setProjectMemoryMd(INITIAL_MEMORY_PROJECT_MD);
    setSaveSuccessNotice('已恢复为默认配置！');
    setTimeout(() => setSaveSuccessNotice(null), 2500);
  };

  // ==========================================
  // 2. REFACTORED SKILLS TAB STATES (对齐 SKILL.md 规范)
  // ==========================================
  const [skillSearch, setSkillSearch] = useState('');
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);
  const [copiedSkillId, setCopiedSkillId] = useState<string | null>(null);

  const toggleSkillExpand = (id: string) => {
    setExpandedSkillId((prev) => (prev === id ? null : id));
  };

  const handleCopySkillMarkdown = (skill: AgentSkill) => {
    const fullSpec =
      skill.skillContent ||
      `---\nname: "${skill.name}"\ndescription: "${skill.description}"\n---\n\n# ${skill.name} (SKILL.md)\n\n${skill.systemPromptSnippet}`;
    navigator.clipboard?.writeText(fullSpec);
    setCopiedSkillId(skill.id);
    setTimeout(() => setCopiedSkillId(null), 2000);
  };

  // ==========================================
  // 3. REFACTORED MCP TAB STATES (stdio / http 规范与启用停用)
  // ==========================================
  const [mcpSearch, setMcpSearch] = useState('');
  const [testingTool, setTestingTool] = useState<{ serverName: string; toolName: string; result?: string } | null>(null);
  const [isTestingLoading, setIsTestingLoading] = useState(false);
  const [isAddMcpModalOpen, setIsAddMcpModalOpen] = useState(false);
  const [mcpInputMode, setMcpInputMode] = useState<'form' | 'json'>('form');

  // Form states
  const [mcpType, setMcpType] = useState<'stdio' | 'http'>('stdio');
  const [formMcpName, setFormMcpName] = useState('');
  const [formMcpDesc, setFormMcpDesc] = useState('');
  const [formMcpTools, setFormMcpTools] = useState('');
  // stdio fields
  const [formStdioCommand, setFormStdioCommand] = useState('uvx');
  const [formStdioArgs, setFormStdioArgs] = useState('arxiv-mcp-server, --max-results, 10');
  const [formStdioEnv, setFormStdioEnv] = useState('ARXIV_RATE_LIMIT=3');
  // http fields
  const [formHttpUrl, setFormHttpUrl] = useState('http://localhost:8080/mcp');
  const [formHttpHeaders, setFormHttpHeaders] = useState('Authorization: Bearer sk-local');

  // JSON mode state
  const [jsonConfigStr, setJsonConfigStr] = useState<string>(
    JSON.stringify(
      {
        name: 'ArXiv Scholar MCP',
        type: 'stdio',
        command: 'uvx',
        args: ['arxiv-mcp-server', '--max-results', '10'],
        env: { ARXIV_RATE_LIMIT: '3' },
        description: 'ArXiv 实时文献与元数据解析服务',
        tools: ['arxiv_search', 'arxiv_get_metadata']
      },
      null,
      2
    )
  );
  const [jsonParseError, setJsonParseError] = useState<string | null>(null);

  // Sync Form to JSON when switching to JSON mode
  const syncFormToJson = () => {
    try {
      const toolList = formMcpTools
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean);

      if (mcpType === 'stdio') {
        const argList = formStdioArgs
          .split(/[,，]/)
          .map((a) => a.trim())
          .filter(Boolean);
        const envObj: Record<string, string> = {};
        formStdioEnv.split('\n').forEach((line) => {
          const parts = line.split('=');
          if (parts[0]?.trim()) envObj[parts[0].trim()] = parts.slice(1).join('=').trim();
        });

        const obj = {
          name: formMcpName || 'Custom Stdio MCP',
          type: 'stdio',
          command: formStdioCommand,
          args: argList,
          env: envObj,
          description: formMcpDesc || '标准 stdio 进程服务',
          tools: toolList.length ? toolList : ['run_task']
        };
        setJsonConfigStr(JSON.stringify(obj, null, 2));
      } else {
        const headerObj: Record<string, string> = {};
        formHttpHeaders.split('\n').forEach((line) => {
          const parts = line.split(':');
          if (parts[0]?.trim()) headerObj[parts[0].trim()] = parts.slice(1).join(':').trim();
        });

        const obj = {
          name: formMcpName || 'Custom HTTP MCP',
          type: 'http',
          url: formHttpUrl,
          headers: headerObj,
          description: formMcpDesc || '标准 HTTP/SSE 远程服务',
          tools: toolList.length ? toolList : ['fetch_api']
        };
        setJsonConfigStr(JSON.stringify(obj, null, 2));
      }
      setJsonParseError(null);
    } catch {}
  };

  // Sync JSON to Form when switching to Form mode
  const syncJsonToForm = () => {
    try {
      const parsed = JSON.parse(jsonConfigStr);
      setFormMcpName(parsed.name || '');
      setFormMcpDesc(parsed.description || '');
      setFormMcpTools(Array.isArray(parsed.tools) ? parsed.tools.join(', ') : '');
      if (parsed.type === 'http' || parsed.url) {
        setMcpType('http');
        setFormHttpUrl(parsed.url || '');
        if (parsed.headers && typeof parsed.headers === 'object') {
          setFormHttpHeaders(
            Object.entries(parsed.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')
          );
        }
      } else {
        setMcpType('stdio');
        setFormStdioCommand(parsed.command || 'npx');
        setFormStdioArgs(Array.isArray(parsed.args) ? parsed.args.join(', ') : '');
        if (parsed.env && typeof parsed.env === 'object') {
          setFormStdioEnv(
            Object.entries(parsed.env)
              .map(([k, v]) => `${k}=${v}`)
              .join('\n')
          );
        }
      }
      setJsonParseError(null);
    } catch (e: any) {
      setJsonParseError(`JSON 格式错误: ${e.message}`);
    }
  };

  const handleCreateMcp = () => {
    let finalName = '';
    let finalDesc = '';
    let finalType: 'stdio' | 'http' = 'stdio';
    let finalEndpoint = '';
    let finalCommand = '';
    let finalArgs: string[] = [];
    let finalEnv: Record<string, string> = {};
    let finalUrl = '';
    let finalHeaders: Record<string, string> = {};
    let finalTools: string[] = [];

    if (mcpInputMode === 'json') {
      try {
        const parsed = JSON.parse(jsonConfigStr);
        if (!parsed.name) {
          setJsonParseError('缺少必需字段: name');
          return;
        }
        finalName = parsed.name;
        finalDesc = parsed.description || '标准 MCP 服务';
        finalType = parsed.type === 'http' ? 'http' : 'stdio';
        finalTools = Array.isArray(parsed.tools) && parsed.tools.length ? parsed.tools : ['service_tool'];

        if (finalType === 'stdio') {
          finalCommand = parsed.command || 'uvx';
          finalArgs = Array.isArray(parsed.args) ? parsed.args : [];
          finalEnv = parsed.env || {};
          finalEndpoint = `${finalCommand} ${finalArgs.join(' ')}`.trim();
        } else {
          finalUrl = parsed.url || 'http://localhost:8080/mcp';
          finalHeaders = parsed.headers || {};
          finalEndpoint = finalUrl;
        }
      } catch (err: any) {
        setJsonParseError(`无效的 JSON 格式: ${err.message}`);
        return;
      }
    } else {
      if (!formMcpName.trim()) return;
      finalName = formMcpName.trim();
      finalDesc = formMcpDesc.trim() || '用户自定义 MCP 服务';
      finalType = mcpType;
      finalTools = formMcpTools
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (!finalTools.length) finalTools = ['default_action'];

      if (mcpType === 'stdio') {
        finalCommand = formStdioCommand.trim() || 'uvx';
        finalArgs = formStdioArgs
          .split(/[,，]/)
          .map((a) => a.trim())
          .filter(Boolean);
        finalEnv = {};
        formStdioEnv.split('\n').forEach((l) => {
          const parts = l.split('=');
          if (parts[0]?.trim()) finalEnv[parts[0].trim()] = parts.slice(1).join('=').trim();
        });
        finalEndpoint = `${finalCommand} ${finalArgs.join(' ')}`.trim();
      } else {
        finalUrl = formHttpUrl.trim() || 'http://localhost:8080/mcp';
        finalHeaders = {};
        formHttpHeaders.split('\n').forEach((l) => {
          const parts = l.split(':');
          if (parts[0]?.trim()) finalHeaders[parts[0].trim()] = parts.slice(1).join(':').trim();
        });
        finalEndpoint = finalUrl;
      }
    }

    if (onAddMCPServer) {
      onAddMCPServer({
        id: `mcp-${Date.now()}`,
        name: finalName,
        version: 'v1.0.0',
        status: 'connected',
        endpoint: finalEndpoint,
        description: finalDesc,
        toolsCount: finalTools.length,
        tools: finalTools,
        transport: finalType,
        transportType: finalType,
        command: finalCommand,
        args: finalArgs,
        env: finalEnv,
        url: finalUrl,
        headers: finalHeaders,
        latencyMs: 16,
        lastPing: '刚刚'
      });
    }

    setIsAddMcpModalOpen(false);
    setFormMcpName('');
    setFormMcpDesc('');
    setFormMcpTools('');
    setJsonParseError(null);
  };

  // Test Tool Simulation
  const handleTestTool = (serverName: string, toolName: string) => {
    setTestingTool({ serverName, toolName });
    setIsTestingLoading(true);
    setTimeout(() => {
      const mockOutput = JSON.stringify(
        {
          status: '200 OK',
          protocol: 'mcp/1.0',
          server: serverName,
          tool: toolName,
          result: {
            success: true,
            message: `成功通过 MCP 管道触发执行工具 ${toolName}`,
            timestamp: new Date().toLocaleTimeString()
          }
        },
        null,
        2
      );
      setTestingTool((prev) => (prev ? { ...prev, result: mockOutput } : null));
      setIsTestingLoading(false);
    }, 450);
  };

  // ==========================================
  // 4. REFACTORED SCHEDULED TASKS (自然语言规划 + 人工微调确认)
  // ==========================================
  const [isAddTaskModalOpen, setIsAddTaskModalOpen] = useState(false);
  const [nlTaskPrompt, setNlTaskPrompt] = useState('');
  const [isAgentParsingTask, setIsAgentParsingTask] = useState(false);
  const [parsedTaskDraft, setParsedTaskDraft] = useState<{
    name: string;
    cron: string;
    scheduleDescription: string;
    actionPrompt: string;
  } | null>(null);

  // Natural language schedule parser
  const parseNaturalLanguage = (text: string) => {
    const trimmed = text.trim();
    let name = '科研自动化任务';
    let cron = '0 9 * * *';
    let scheduleDescription = '每天 09:00 AM (自动运行)';
    let actionPrompt = trimmed;

    // Pattern matching
    if (trimmed.includes('8点') || trimmed.includes('早晨8点') || trimmed.includes('08:00')) {
      cron = '0 8 * * *';
      scheduleDescription = '每天 08:00 AM (自动运行)';
    } else if (trimmed.includes('10点') || trimmed.includes('晚上10点') || trimmed.includes('22:00')) {
      cron = '0 22 * * *';
      scheduleDescription = '每天 10:00 PM (自动运行)';
    } else if (trimmed.includes('每2小时') || trimmed.includes('每两小时') || trimmed.includes('每隔2小时')) {
      cron = '0 */2 * * *';
      scheduleDescription = '每 2 小时 (自动运行)';
    } else if (trimmed.includes('每小时') || trimmed.includes('每个小时')) {
      cron = '0 * * * *';
      scheduleDescription = '每小时整点 (自动运行)';
    } else if (trimmed.includes('每周一') || trimmed.includes('星期一')) {
      cron = '0 9 * * 1';
      scheduleDescription = '每周一 09:00 AM (自动运行)';
    }

    // Name inference
    if (trimmed.includes('arxiv') || trimmed.includes('文献') || trimmed.includes('论文')) {
      name = 'ArXiv 论文追踪';
      actionPrompt = trimmed.includes('总结')
        ? trimmed
        : `${trimmed}，并建立索引。`;
    } else if (trimmed.includes('基准') || trimmed.includes('评测') || trimmed.includes('benchmark')) {
      name = '模型基准监控';
    } else if (trimmed.includes('latex') || trimmed.includes('草稿') || trimmed.includes('git')) {
      name = 'LaTeX 进度备份';
    } else if (trimmed.includes('周报') || trimmed.includes('汇报')) {
      name = '实验进展周报';
    } else {
      name = trimmed.length > 18 ? `${trimmed.slice(0, 18)}...` : trimmed;
    }

    return { name, cron, scheduleDescription, actionPrompt };
  };

  const handleAgentParseSchedule = () => {
    if (!nlTaskPrompt.trim()) return;
    setIsAgentParsingTask(true);
    setTimeout(() => {
      const parsed = parseNaturalLanguage(nlTaskPrompt);
      setParsedTaskDraft(parsed);
      setIsAgentParsingTask(false);
    }, 500);
  };

  const handleConfirmCreateTask = () => {
    if (!parsedTaskDraft || !onAddScheduledTask) return;
    onAddScheduledTask({
      id: `task-${Date.now()}`,
      name: parsedTaskDraft.name.trim(),
      cron: parsedTaskDraft.cron.trim(),
      scheduleDescription: parsedTaskDraft.scheduleDescription.trim(),
      nextRun: '明天 08:00 AM',
      lastRun: '刚刚创建 (就绪)',
      status: 'active',
      actionPrompt: parsedTaskDraft.actionPrompt.trim(),
      executionHistory: []
    });

    setIsAddTaskModalOpen(false);
    setNlTaskPrompt('');
    setParsedTaskDraft(null);
  };

  if (!isOpen) return null;

  const onlineMcpCount = mcpServers.filter((s) => s.status === 'connected').length;
  const activeTaskCount = scheduledTasks.filter((t) => t.status === 'active').length;
  const enabledSkillCount = skills.filter((s) => s.enabled).length;

  return (
    /* Requirement 1: 点击左侧空白后管理中枢消失 (onClick={onClose} on backdrop) */
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end animate-in fade-in duration-150 select-none"
    >
      {/* Sliding Sheet Container */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-zinc-900 h-full shadow-2xl border-l border-zinc-800 flex flex-col animate-in slide-in-from-right duration-200 overflow-hidden text-zinc-100 select-text"
      >
        {/* =========================================================================
            HEADER: Brand, Tabs Switcher, Close
            ========================================================================= */}
        <div className="border-b border-zinc-800 bg-zinc-900 px-4 sm:px-5 pt-3 pb-3 shrink-0">
          <div className="flex items-center justify-between mb-2.5 select-none">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 flex items-center justify-center shadow-xs">
                <Sliders size={14} />
              </div>
              <div>
                <h2 className="text-xs font-semibold text-zinc-100">管理</h2>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
              title="关闭 (Esc 或点击空白处)"
            >
              <X size={16} />
            </button>
          </div>

          {/* Nav Tabs */}
          <div className="grid grid-cols-4 gap-1 bg-zinc-950 border border-zinc-850 p-1 rounded-xl select-none">
            {/* 1. 记忆 */}
            <button
              onClick={() => onChangeTab('memory')}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                activeTab === 'memory'
                  ? 'bg-zinc-800 text-zinc-100 border border-zinc-700 shadow-xs font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              <Brain size={12} className={activeTab === 'memory' ? 'text-purple-400' : 'text-zinc-500'} />
              <span>记忆</span>
            </button>

            {/* 2. 技能 */}
            <button
              onClick={() => onChangeTab('skills')}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                activeTab === 'skills'
                  ? 'bg-zinc-800 text-zinc-100 border border-zinc-700 shadow-xs font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              <Sparkles size={12} className={activeTab === 'skills' ? 'text-purple-400' : 'text-zinc-500'} />
              <span>技能</span>
            </button>

            {/* 3. MCP */}
            <button
              onClick={() => onChangeTab('mcp')}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                activeTab === 'mcp'
                  ? 'bg-zinc-800 text-zinc-100 border border-zinc-700 shadow-xs font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              <Cpu size={12} className={activeTab === 'mcp' ? 'text-sky-400' : 'text-zinc-500'} />
              <span>MCP</span>
            </button>

            {/* 4. 定时任务 */}
            <button
              onClick={() => onChangeTab('tasks')}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                activeTab === 'tasks'
                  ? 'bg-zinc-800 text-zinc-100 border border-zinc-700 shadow-xs font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              <Clock size={12} className={activeTab === 'tasks' ? 'text-amber-400' : 'text-zinc-500'} />
              <span>任务</span>
            </button>
          </div>
        </div>

        {/* =========================================================================
            PANEL CONTENT VIEWPORT
            ========================================================================= */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 bg-zinc-900 text-zinc-200">
          {/* =====================================================================
              TAB 1: 记忆系统 (USER.md / AGENTS.md / MEMORY.md)
              ===================================================================== */}
          {activeTab === 'memory' && (
            <div className="space-y-4 animate-in fade-in duration-150">
              {/* Memory File Tabs Switcher */}
              <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setActiveMemoryFile('user')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all cursor-pointer ${
                      activeMemoryFile === 'user'
                        ? 'bg-purple-600 text-white shadow-2xs font-semibold'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200/80'
                    }`}
                  >
                    <FileText size={13} />
                    <span>USER.md</span>
                  </button>

                  <button
                    onClick={() => setActiveMemoryFile('agent')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all cursor-pointer ${
                      activeMemoryFile === 'agent'
                        ? 'bg-purple-600 text-white shadow-2xs font-semibold'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200/80'
                    }`}
                  >
                    <FileCode size={13} />
                    <span>AGENTS.md</span>
                  </button>

                  <button
                    onClick={() => setActiveMemoryFile('general')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all cursor-pointer ${
                      activeMemoryFile === 'general'
                        ? 'bg-purple-600 text-white shadow-2xs font-semibold'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200/80'
                    }`}
                  >
                    <Brain size={13} />
                    <span>MEMORY.md</span>
                  </button>
                </div>

                {/* Agent Organize Button */}
                <button
                  onClick={handleTriggerAgentOrganize}
                  disabled={isOrganizingMemory}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 rounded-lg text-xs font-medium shadow-2xs transition-all cursor-pointer"
                  title="自动整理并提取记忆"
                >
                  <RotateCw size={12} className={isOrganizingMemory ? 'animate-spin' : ''} />
                  <span>{isOrganizingMemory ? '整理中' : '整理'}</span>
                </button>
              </div>

              {/* Scope Segmented Control if General Memory is active */}
              {activeMemoryFile === 'general' && (
                <div className="flex items-center justify-between bg-purple-50/70 border border-purple-200/80 rounded-lg p-2 animate-in fade-in">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-purple-900">作用域:</span>
                    <div className="flex items-center gap-1 bg-white p-0.5 rounded-md border border-purple-200 shadow-2xs">
                      <button
                        onClick={() => setGeneralScope('global')}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all cursor-pointer ${
                          generalScope === 'global'
                            ? 'bg-purple-600 text-white'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        <Globe size={11} />
                        <span>全局</span>
                      </button>
                      <button
                        onClick={() => setGeneralScope('project')}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all cursor-pointer ${
                          generalScope === 'project'
                            ? 'bg-purple-600 text-white'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        <FolderGit2 size={11} />
                        <span>项目</span>
                      </button>
                    </div>
                  </div>

                  <span className="text-[11px] text-purple-700 font-mono">
                    {generalScope === 'global' ? '跨项目共享' : '仅当前项目'}
                  </span>
                </div>
              )}

              {/* Notification banners */}
              {isOrganizingMemory && (
                <div className="p-2.5 bg-purple-50 border border-purple-200 rounded-lg flex items-center gap-2 text-xs text-purple-800">
                  <span className="w-2 h-2 rounded-full bg-purple-600 animate-ping shrink-0" />
                  <span className="font-mono text-[11px]">{organizeStep}</span>
                </div>
              )}

              {saveSuccessNotice && (
                <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center justify-between text-xs text-emerald-800">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={13} className="text-emerald-600 shrink-0" />
                    <span>{saveSuccessNotice}</span>
                  </div>
                  <button onClick={() => setSaveSuccessNotice(null)} className="text-emerald-600 hover:text-emerald-800">
                    <X size={12} />
                  </button>
                </div>
              )}

              {/* Memory Document Toolbar */}
              <div className="flex items-center justify-between bg-slate-50 border border-slate-200/90 rounded-t-lg px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-semibold text-slate-700">
                    {getMemoryFilePath()}
                  </span>
                  <span className="text-slate-300">|</span>
                  <span className="text-[11px] text-slate-500 font-mono">
                    {getCurrentMemoryContent().length} 字符 · {getCurrentMemoryContent().split('\n').length} 行
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {/* View Mode Toggle */}
                  <div className="flex items-center bg-slate-200/80 p-0.5 rounded-md text-[11px]">
                    <button
                      onClick={() => setMemoryViewMode('edit')}
                      className={`px-2 py-0.5 rounded transition-all cursor-pointer ${
                        memoryViewMode === 'edit'
                          ? 'bg-white text-slate-900 font-medium shadow-2xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Markdown 编辑
                    </button>
                    <button
                      onClick={() => setMemoryViewMode('preview')}
                      className={`px-2 py-0.5 rounded transition-all cursor-pointer ${
                        memoryViewMode === 'preview'
                          ? 'bg-white text-slate-900 font-medium shadow-2xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      预览
                    </button>
                  </div>

                  <button
                    onClick={handleManualSaveMemory}
                    className="flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-md text-[11px] font-medium transition-colors cursor-pointer"
                    title="保存"
                  >
                    <Save size={11} className="text-purple-600" />
                    <span>保存</span>
                  </button>

                  <button
                    onClick={handleResetCurrentMemory}
                    className="text-[11px] text-slate-400 hover:text-slate-600 px-1.5 py-1 transition-colors cursor-pointer"
                    title="恢复默认"
                  >
                    重置
                  </button>
                </div>
              </div>

              {/* Editor or Preview Pane */}
              <div className="border border-t-0 border-slate-200 rounded-b-lg bg-white overflow-hidden shadow-2xs">
                {memoryViewMode === 'edit' ? (
                  <textarea
                    value={getCurrentMemoryContent()}
                    onChange={(e) => setCurrentMemoryContent(e.target.value)}
                    rows={18}
                    className="w-full p-4 font-mono text-xs leading-relaxed text-slate-800 bg-white focus:outline-hidden resize-y min-h-[380px]"
                    placeholder="输入 Markdown 格式的记忆正文..."
                    spellCheck={false}
                  />
                ) : (
                  <div className="p-4 bg-white min-h-[380px] max-h-[520px] overflow-y-auto leading-relaxed text-xs">
                    {renderMarkdownPreview(getCurrentMemoryContent())}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* =====================================================================
              TAB 2: 技能列表对齐规范 (Skills - 移除分类/元数据，仅展示名称与描述，点开展示完整正文)
              ===================================================================== */}
          {activeTab === 'skills' && (
            <div className="space-y-3.5 animate-in fade-in duration-150">
              {/* Requirement 2: 搜索框，删除全部及数学公式分类 */}
              <div className="flex items-center justify-between gap-3 bg-slate-50/80 p-2.5 rounded-xl border border-slate-200">
                <div className="relative flex-1">
                  <Search size={13} className="absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="text"
                    placeholder="搜索技能名称或描述..."
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-hidden shadow-2xs"
                  />
                  {skillSearch && (
                    <button
                      onClick={() => setSkillSearch('')}
                      className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                <div className="text-xs text-slate-500 shrink-0 select-none">
                  <span>已启用: </span>
                  <span className="font-semibold text-emerald-600 font-mono">
                    {enabledSkillCount}
                  </span>
                  <span className="text-slate-400"> / {skills.length}</span>
                </div>
              </div>

              {/* Skills List - Requirement 2: 未点开时只展示 name 和 description */}
              <div className="space-y-2.5">
                {skills
                  .filter(
                    (s) =>
                      s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
                      s.description.toLowerCase().includes(skillSearch.toLowerCase())
                  )
                  .map((skill) => {
                    const isExpanded = expandedSkillId === skill.id;
                    const isCopied = copiedSkillId === skill.id;

                    return (
                      <div
                        key={skill.id}
                        className={`bg-white rounded-xl border transition-all shadow-2xs ${
                          skill.enabled ? 'border-slate-200 hover:border-slate-300' : 'border-slate-200/80 bg-slate-50/40 opacity-75'
                        }`}
                      >
                        {/* Collapsed Card Header: name + description + toggle + expand */}
                        <div
                          onClick={() => toggleSkillExpand(skill.id)}
                          className="p-3.5 flex items-start justify-between gap-3 cursor-pointer select-none"
                        >
                          <div className="space-y-1 min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <h4 className="text-xs font-semibold text-slate-900 hover:text-indigo-600 transition-colors">
                                {skill.name}
                              </h4>
                            </div>
                            <p className="text-xs text-slate-600 leading-relaxed">
                              {skill.description}
                            </p>
                          </div>

                          {/* Controls: Enable/Disable Switch & Expand affordance */}
                          <div
                            className="flex items-center gap-2 shrink-0 pt-0.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {/* Enable/Disable Toggle Switch */}
                            {onToggleSkill && (
                              <button
                                onClick={() => onToggleSkill(skill.id)}
                                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer shadow-2xs ${
                                  skill.enabled
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                                    : 'bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200'
                                }`}
                                title={skill.enabled ? '点击停用技能' : '点击启用技能'}
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    skill.enabled ? 'bg-emerald-500' : 'bg-slate-400'
                                  }`}
                                />
                                <span>{skill.enabled ? '已启用' : '已停用'}</span>
                              </button>
                            )}

                            {/* Expand toggle */}
                            <button
                              onClick={() => toggleSkillExpand(skill.id)}
                              className="p-1 text-slate-400 hover:text-slate-700 rounded transition-colors"
                              title={isExpanded ? '收起技能正文' : '展开完整技能正文'}
                            >
                              {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                            </button>
                          </div>
                        </div>

                        {/* Expanded Full Skill Specification conforming to SKILL.md */}
                        {isExpanded && (
                          <div className="border-t border-slate-200 bg-slate-50/50 p-4 space-y-3 animate-in fade-in duration-150">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5 text-xs font-mono font-medium text-slate-700">
                                <Code2 size={13} className="text-indigo-600" />
                                <span>SKILL.md</span>
                              </div>

                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => handleCopySkillMarkdown(skill)}
                                  className="flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-800 transition-colors cursor-pointer"
                                >
                                  {isCopied ? (
                                    <>
                                      <CheckCheck size={12} className="text-emerald-600" />
                                      <span className="text-emerald-600 font-medium">已复制</span>
                                    </>
                                  ) : (
                                    <>
                                      <Copy size={12} />
                                      <span>复制</span>
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>

                            {/* Full Spec Body with Markdown Preview */}
                            <div className="bg-white p-3.5 rounded-lg border border-slate-200 shadow-2xs space-y-2">
                              {renderMarkdownPreview(
                                skill.skillContent ||
                                  `---\nname: "${skill.name}"\ndescription: "${skill.description}"\n---\n\n# ${skill.name} (SKILL.md)\n\n${skill.systemPromptSnippet}\n\n## 说明\n- 运行环境已同步\n- 保持输出严谨规范`
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* =====================================================================
              TAB 3: MCP 服务中枢 (stdio / http 规范，删除快速预设，支持启用/停用)
              ===================================================================== */}
          {activeTab === 'mcp' && (
            <div className="space-y-4 animate-in fade-in duration-150">
              {/* Overview banner */}
              <div className="bg-blue-50/40 border border-blue-200/80 rounded-xl p-3.5 shadow-2xs space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded bg-blue-600 text-white shadow-2xs">
                      <Cpu size={14} />
                    </span>
                    <h3 className="text-xs font-semibold text-blue-950">
                      MCP 服务
                    </h3>
                  </div>

                  <button
                    onClick={() => {
                      setIsAddMcpModalOpen(true);
                      setMcpInputMode('form');
                    }}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium shadow-xs transition-all cursor-pointer"
                  >
                    <Plus size={13} />
                    <span>添加 MCP 服务</span>
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-2.5 border-t border-blue-200/60 text-xs">
                  <div className="bg-white/80 p-2 rounded-lg border border-blue-100">
                    <span className="text-[11px] text-slate-500 block">已连接/已配置</span>
                    <span className="text-sm font-semibold text-emerald-600">
                      {onlineMcpCount} / {mcpServers.length}
                    </span>
                  </div>
                  <div className="bg-white/80 p-2 rounded-lg border border-blue-100">
                    <span className="text-[11px] text-slate-500 block">注册工具总数</span>
                    <span className="text-sm font-semibold text-blue-600">
                      {mcpServers.reduce((acc, cur) => acc + (cur.status === 'connected' ? cur.toolsCount : 0), 0)} 个活跃
                    </span>
                  </div>
                  <div className="bg-white/80 p-2 rounded-lg border border-blue-100">
                    <span className="text-[11px] text-slate-500 block">支持协议规范</span>
                    <span className="text-sm font-semibold text-slate-700 font-mono">
                      stdio · http
                    </span>
                  </div>
                </div>
              </div>

              {/* Search Bar */}
              <div className="relative">
                <Search size={13} className="absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="搜索 MCP 服务名称、命令端点或工具..."
                  value={mcpSearch}
                  onChange={(e) => setMcpSearch(e.target.value)}
                  className="w-full bg-slate-50/80 border border-slate-200 focus:border-blue-500 focus:bg-white rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-hidden transition-all"
                />
              </div>

              {/* MCP Servers List (支持启用/停用) */}
              <div className="space-y-3">
                {mcpServers
                  .filter(
                    (s) =>
                      s.name.toLowerCase().includes(mcpSearch.toLowerCase()) ||
                      s.endpoint.toLowerCase().includes(mcpSearch.toLowerCase()) ||
                      s.tools.some((t) => t.toLowerCase().includes(mcpSearch.toLowerCase()))
                  )
                  .map((server) => {
                    const isConnected = server.status === 'connected';
                    const isStdio = server.transportType === 'stdio' || server.transport === 'stdio' || server.command;

                    return (
                      <div
                        key={server.id}
                        className={`bg-white rounded-xl border p-4 shadow-2xs space-y-3 transition-all ${
                          isConnected
                            ? 'border-slate-200 hover:border-slate-300'
                            : 'border-slate-200/70 bg-slate-50/50 opacity-75'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-semibold ${
                                  isStdio ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                                }`}
                              >
                                {isStdio ? 'stdio' : 'http'}
                              </span>
                              <h4 className="text-xs font-semibold text-slate-900 truncate">
                                {server.name}
                              </h4>
                              <span className="text-[10px] text-slate-400 font-mono">
                                {server.version}
                              </span>
                            </div>

                            <p className="text-xs text-slate-600 leading-relaxed">
                              {server.description}
                            </p>

                            <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono truncate">
                              <span className="text-slate-400">端点:</span>
                              <code className="text-slate-700 bg-slate-100 px-1 py-0.2 rounded text-[10px]">
                                {server.endpoint}
                              </code>
                            </div>
                          </div>

                          {/* Action Switch: 启用 / 停用 */}
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => onToggleMCP(server.id)}
                              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer shadow-2xs ${
                                isConnected
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                                  : 'bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200'
                              }`}
                              title={isConnected ? '点击停用此 MCP 服务' : '点击启用此 MCP 服务'}
                            >
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${
                                  isConnected ? 'bg-emerald-500' : 'bg-slate-400'
                                }`}
                              />
                              <span>{isConnected ? '已连接' : '已停用'}</span>
                            </button>

                            {onDeleteMCPServer && (
                              <button
                                onClick={() => onDeleteMCPServer(server.id)}
                                className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors"
                                title="移除服务"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Tools Exposed */}
                        <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200/80 space-y-1.5">
                          <div className="flex items-center justify-between text-[11px] text-slate-500">
                            <span>注册工具 ({server.tools.length})</span>
                            <span className="text-slate-400 font-mono">
                              {isConnected ? `${server.latencyMs || 15}ms 响应` : '服务已暂停'}
                            </span>
                          </div>

                          <div className="flex flex-wrap gap-1.5">
                            {server.tools.map((tool) => (
                              <button
                                key={tool}
                                disabled={!isConnected}
                                onClick={() => handleTestTool(server.name, tool)}
                                className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-all cursor-pointer ${
                                  isConnected
                                    ? 'bg-white text-slate-700 border-slate-200 hover:border-blue-300 hover:text-blue-700 shadow-2xs'
                                    : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                                }`}
                                title="点击模拟调用此工具"
                              >
                                {tool}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* Tool Execution Test Modal */}
              {testingTool && (
                <div
                  onClick={() => setTestingTool(null)}
                  className="fixed inset-0 z-60 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4"
                >
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg p-5 space-y-3 animate-in zoom-in-95"
                  >
                    <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
                      <div className="flex items-center gap-2">
                        <Terminal size={16} className="text-blue-600" />
                        <div>
                          <h4 className="text-xs font-semibold text-slate-900 font-mono">
                            {testingTool.toolName}
                          </h4>
                          <span className="text-[10px] text-slate-500">
                            所属服务: {testingTool.serverName}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => setTestingTool(null)}
                        className="text-slate-400 hover:text-slate-600 p-1 rounded"
                      >
                        <X size={16} />
                      </button>
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-[11px] font-medium text-slate-700">调用模拟结果:</span>
                      {isTestingLoading ? (
                        <div className="p-6 text-center text-xs text-slate-500 space-y-2">
                          <RotateCw size={16} className="animate-spin mx-auto text-blue-600" />
                          <p>正在向 MCP 协议端点派发 RPC 握手...</p>
                        </div>
                      ) : (
                        <pre className="p-3 bg-slate-900 text-emerald-400 font-mono text-[11px] rounded-lg overflow-x-auto max-h-60 leading-relaxed border border-slate-800">
                          {testingTool.result}
                        </pre>
                      )}
                    </div>

                    <div className="flex justify-end pt-2 border-t border-slate-200">
                      <button
                        onClick={() => setTestingTool(null)}
                        className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-medium cursor-pointer"
                      >
                        关闭
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* =====================================================================
              TAB 4: 定时任务自动化 (Scheduled Tasks)
              ===================================================================== */}
          {activeTab === 'tasks' && (
            <div className="space-y-4 animate-in fade-in duration-150">
              {/* Scheduled Tasks Hero */}
              <div className="bg-amber-50/40 border border-amber-200/80 rounded-xl p-3.5 shadow-2xs space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded bg-amber-600 text-white shadow-2xs">
                      <Clock size={14} />
                    </span>
                    <h3 className="text-xs font-semibold text-amber-950">
                      自动化任务
                    </h3>
                  </div>

                  <button
                    onClick={() => {
                      setIsAddTaskModalOpen(true);
                      setParsedTaskDraft(null);
                      setNlTaskPrompt('');
                    }}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-medium shadow-xs transition-all cursor-pointer"
                  >
                    <Plus size={13} />
                    <span>新建任务</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2.5 border-t border-amber-200/60 text-xs">
                  <div className="bg-white/80 p-2 rounded-lg border border-amber-100">
                    <span className="text-[11px] text-slate-500 block">活跃任务</span>
                    <span className="text-sm font-semibold text-amber-700">
                      {activeTaskCount} 项运行中
                    </span>
                  </div>
                  <div className="bg-white/80 p-2 rounded-lg border border-amber-100">
                    <span className="text-[11px] text-slate-500 block">最近运行</span>
                    <span className="text-sm font-semibold text-slate-700">
                      今天 08:00 AM (已完成)
                    </span>
                  </div>
                </div>
              </div>

              {/* Tasks List */}
              <div className="space-y-3">
                {scheduledTasks.map((task) => {
                  const isActive = task.status === 'active';

                  return (
                    <div
                      key={task.id}
                      className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-3 hover:border-slate-300 transition-all"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-2 h-2 rounded-full shrink-0 ${
                                isActive ? 'bg-amber-500 ring-4 ring-amber-100' : 'bg-slate-300'
                              }`}
                            />
                            <h4 className="text-xs font-semibold text-slate-900 truncate">
                              {task.name}
                            </h4>
                            <span className="text-[10px] text-slate-600 font-mono bg-slate-100 px-1.5 py-0.2 rounded">
                              {task.cron}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 text-[11px] text-slate-500">
                            <span>周期: {task.scheduleDescription}</span>
                            <span>·</span>
                            <span>下次触发: {task.nextRun}</span>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => onTriggerTask(task)}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200/80 transition-all cursor-pointer"
                            title="立即在当前会话触发执行"
                          >
                            <Zap size={12} />
                            <span>触发</span>
                          </button>

                          {onToggleTaskStatus && (
                            <button
                              onClick={() => onToggleTaskStatus(task.id)}
                              className={`px-2 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                                isActive
                                  ? 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                                  : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                              }`}
                            >
                              {isActive ? '暂停' : '启动'}
                            </button>
                          )}

                          {onDeleteScheduledTask && (
                            <button
                              onClick={() => onDeleteScheduledTask(task.id)}
                              className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors cursor-pointer"
                              title="删除此任务"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200/80 text-xs text-slate-700 space-y-1">
                        <span className="text-[10px] text-slate-400 font-medium block">
                          触发的动作或提示词:
                        </span>
                        <p className="text-[11px] leading-relaxed text-slate-700 font-mono">
                          {task.actionPrompt}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* =========================================================================
            MODALS
            ========================================================================= */}

        {/* 1. Requirement 4: 添加 MCP 弹窗 (删除预设模板，stdio/http 规范双模切换) */}
        {isAddMcpModalOpen && (
          <div
            onClick={() => setIsAddMcpModalOpen(false)}
            className="fixed inset-0 z-60 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg p-5 space-y-4 animate-in zoom-in-95 max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div className="flex items-center gap-2">
                  <Cpu size={16} className="text-blue-600" />
                  <h4 className="text-sm font-semibold text-slate-900">添加 MCP 服务</h4>
                </div>
                <button
                  onClick={() => setIsAddMcpModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Mode Toggle: 表单录入 vs JSON 录入 */}
              <div className="flex items-center justify-between bg-slate-100 p-1 rounded-lg text-xs">
                <button
                  onClick={() => {
                    if (mcpInputMode === 'json') syncJsonToForm();
                    setMcpInputMode('form');
                  }}
                  className={`flex-1 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                    mcpInputMode === 'form' ? 'bg-white text-slate-900 shadow-2xs font-semibold' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  表单录入
                </button>
                <button
                  onClick={() => {
                    if (mcpInputMode === 'form') syncFormToJson();
                    setMcpInputMode('json');
                  }}
                  className={`flex-1 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                    mcpInputMode === 'json' ? 'bg-white text-slate-900 shadow-2xs font-semibold' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  JSON 配置
                </button>
              </div>

              {mcpInputMode === 'form' ? (
                <div className="space-y-3">
                  {/* Protocol Selector: stdio vs http */}
                  <div>
                    <label className="text-xs font-medium text-slate-700 block mb-1">
                      协议类型 (Transport)
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setMcpType('stdio')}
                        className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                          mcpType === 'stdio'
                            ? 'bg-amber-50/80 border-amber-300 text-amber-900 font-semibold'
                            : 'bg-slate-50 border-slate-200 text-slate-700'
                        }`}
                      >
                        <div className="text-xs font-mono font-bold">stdio</div>
                        <div className="text-[10px] text-slate-500 font-normal">
                          本地子进程管道 (CLI, Python, npx)
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setMcpType('http')}
                        className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                          mcpType === 'http'
                            ? 'bg-blue-50/80 border-blue-300 text-blue-900 font-semibold'
                            : 'bg-slate-50 border-slate-200 text-slate-700'
                        }`}
                      >
                        <div className="text-xs font-mono font-bold">http</div>
                        <div className="text-[10px] text-slate-500 font-normal">
                          HTTP / SSE 远程端点网络服务
                        </div>
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-700 block mb-1">服务名称</label>
                    <input
                      type="text"
                      value={formMcpName}
                      onChange={(e) => setFormMcpName(e.target.value)}
                      placeholder="如: Local SQLite MCP"
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800"
                    />
                  </div>

                  {mcpType === 'stdio' ? (
                    <>
                      <div className="grid grid-cols-3 gap-2">
                        <div className="col-span-1">
                          <label className="text-xs font-medium text-slate-700 block mb-1">
                            执行命令 (Command)
                          </label>
                          <input
                            type="text"
                            value={formStdioCommand}
                            onChange={(e) => setFormStdioCommand(e.target.value)}
                            placeholder="如: uvx, npx"
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 font-mono"
                          />
                        </div>
                        <div className="col-span-2">
                          <label className="text-xs font-medium text-slate-700 block mb-1">
                            参数列表 (Args, 逗号分隔)
                          </label>
                          <input
                            type="text"
                            value={formStdioArgs}
                            onChange={(e) => setFormStdioArgs(e.target.value)}
                            placeholder="如: arxiv-mcp-server, --max-results, 10"
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 font-mono"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="text-xs font-medium text-slate-700 block mb-1">
                          环境变量 (Env, 换行分隔 KEY=VALUE)
                        </label>
                        <textarea
                          rows={2}
                          value={formStdioEnv}
                          onChange={(e) => setFormStdioEnv(e.target.value)}
                          placeholder="ARXIV_RATE_LIMIT=3"
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 font-mono resize-none"
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <label className="text-xs font-medium text-slate-700 block mb-1">
                          端点 URL (URL)
                        </label>
                        <input
                          type="text"
                          value={formHttpUrl}
                          onChange={(e) => setFormHttpUrl(e.target.value)}
                          placeholder="如: http://localhost:8080/mcp 或 https://.../sse"
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 font-mono"
                        />
                      </div>

                      <div>
                        <label className="text-xs font-medium text-slate-700 block mb-1">
                          请求头 (Headers, 换行分隔 Key: Value)
                        </label>
                        <textarea
                          rows={2}
                          value={formHttpHeaders}
                          onChange={(e) => setFormHttpHeaders(e.target.value)}
                          placeholder="Authorization: Bearer my_token"
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 font-mono resize-none"
                        />
                      </div>
                    </>
                  )}

                  <div>
                    <label className="text-xs font-medium text-slate-700 block mb-1">服务描述</label>
                    <input
                      type="text"
                      value={formMcpDesc}
                      onChange={(e) => setFormMcpDesc(e.target.value)}
                      placeholder="说明该服务提供的上下文与工具能力..."
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-700 block mb-1">
                      暴露的工具列表 (逗号分隔)
                    </label>
                    <input
                      type="text"
                      value={formMcpTools}
                      onChange={(e) => setFormMcpTools(e.target.value)}
                      placeholder="如: query_data, parse_bibtex"
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 font-mono"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>标准 JSON Schema 配置 (stdio 或 http):</span>
                    <button
                      onClick={() => {
                        setJsonConfigStr(
                          JSON.stringify(
                            {
                              name: 'Custom Stdio MCP',
                              type: 'stdio',
                              command: 'uvx',
                              args: ['arxiv-mcp-server'],
                              env: {},
                              description: '学术检索标准工具',
                              tools: ['search_paper']
                            },
                            null,
                            2
                          )
                        );
                      }}
                      className="text-blue-600 hover:text-blue-800 cursor-pointer"
                    >
                      填充范例
                    </button>
                  </div>

                  <textarea
                    rows={12}
                    value={jsonConfigStr}
                    onChange={(e) => {
                      setJsonConfigStr(e.target.value);
                      setJsonParseError(null);
                    }}
                    className="w-full p-3 font-mono text-xs bg-slate-900 text-slate-100 rounded-lg border border-slate-800 focus:outline-hidden resize-none"
                    spellCheck={false}
                  />

                  {jsonParseError && (
                    <div className="text-[11px] text-rose-600 bg-rose-50 p-2 rounded border border-rose-200 flex items-center gap-1.5">
                      <AlertCircle size={13} className="shrink-0" />
                      <span>{jsonParseError}</span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  onClick={() => setIsAddMcpModalOpen(false)}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs cursor-pointer"
                >
                  取消
                </button>
                <button
                  onClick={handleCreateMcp}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium cursor-pointer shadow-xs"
                >
                  确认添加
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 2. Requirement 5: 新建定时任务 (输入自然语言由 Agent 解析生成，最后人工确认) */}
        {isAddTaskModalOpen && (
          <div
            onClick={() => setIsAddTaskModalOpen(false)}
            className="fixed inset-0 z-60 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg p-5 space-y-4 animate-in zoom-in-95 max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div className="flex items-center gap-2">
                  <Wand2 size={16} className="text-amber-600" />
                  <h4 className="text-sm font-semibold text-slate-900">
                    新建定时任务
                  </h4>
                </div>
                <button
                  onClick={() => setIsAddTaskModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  <X size={16} />
                </button>
              </div>

              {!parsedTaskDraft ? (
                /* Step 1: 输入自然语言需求 */
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-slate-700 block mb-1">
                      输入任务需求
                    </label>
                    <textarea
                      rows={4}
                      value={nlTaskPrompt}
                      onChange={(e) => setNlTaskPrompt(e.target.value)}
                      placeholder="输入您的自动化任务需求，例如执行周期、命令或提示词..."
                      className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-amber-500 rounded-lg p-3 text-xs text-slate-800 focus:outline-hidden resize-none leading-relaxed"
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                    <button
                      onClick={() => setIsAddTaskModalOpen(false)}
                      className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs cursor-pointer"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleAgentParseSchedule}
                      disabled={!nlTaskPrompt.trim() || isAgentParsingTask}
                      className="flex items-center gap-1.5 px-4 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium cursor-pointer shadow-xs transition-all"
                    >
                      {isAgentParsingTask ? (
                        <>
                          <RotateCw size={13} className="animate-spin" />
                          <span>正在解析...</span>
                        </>
                      ) : (
                        <>
                          <Wand2 size={13} />
                          <span>智能解析</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                /* Step 2: 任务确认卡片，支持微调 */
                <div className="space-y-3 animate-in fade-in">
                  <div className="p-2.5 bg-amber-50 border border-amber-200/80 rounded-lg flex items-center gap-2 text-xs text-amber-900">
                    <CheckCircle2 size={14} className="text-amber-600 shrink-0" />
                    <span>已生成任务配置，核对后即可创建：</span>
                  </div>

                  <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-3">
                    <div>
                      <label className="text-[11px] font-semibold text-slate-700 block mb-1">
                        任务名称
                      </label>
                      <input
                        type="text"
                        value={parsedTaskDraft.name}
                        onChange={(e) =>
                          setParsedTaskDraft({ ...parsedTaskDraft, name: e.target.value })
                        }
                        className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-lg px-3 py-1.5 text-xs text-slate-900 font-medium"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[11px] font-semibold text-slate-700 block mb-1">
                          Cron 表达式
                        </label>
                        <input
                          type="text"
                          value={parsedTaskDraft.cron}
                          onChange={(e) =>
                            setParsedTaskDraft({ ...parsedTaskDraft, cron: e.target.value })
                          }
                          className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-900"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] font-semibold text-slate-700 block mb-1">
                          运行周期
                        </label>
                        <input
                          type="text"
                          value={parsedTaskDraft.scheduleDescription}
                          onChange={(e) =>
                            setParsedTaskDraft({
                              ...parsedTaskDraft,
                              scheduleDescription: e.target.value
                            })
                          }
                          className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-lg px-3 py-1.5 text-xs text-slate-900"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-slate-700 block mb-1">
                        执行指令
                      </label>
                      <textarea
                        rows={3}
                        value={parsedTaskDraft.actionPrompt}
                        onChange={(e) =>
                          setParsedTaskDraft({
                            ...parsedTaskDraft,
                            actionPrompt: e.target.value
                          })
                        }
                        className="w-full bg-white border border-slate-200 focus:border-amber-500 rounded-lg px-3 py-1.5 text-xs text-slate-800 font-mono resize-none leading-relaxed"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-200">
                    <button
                      onClick={() => setParsedTaskDraft(null)}
                      className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs cursor-pointer flex items-center gap-1"
                    >
                      <RotateCw size={11} />
                      <span>重新输入</span>
                    </button>

                    <button
                      onClick={handleConfirmCreateTask}
                      className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-medium cursor-pointer shadow-xs flex items-center gap-1.5"
                    >
                      <Check size={13} />
                      <span>创建任务</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
