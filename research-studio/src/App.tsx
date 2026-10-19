import React, { useState, useEffect, useRef } from 'react';
import {
  WorkspaceTab,
  ResearchPaper,
  GraphNode,
  GraphLink,
  RagWikiEntry,
  VirtualFile,
  GitCommit,
  MemoryRecord,
  AgentSkill,
  MCPServer,
  ScheduledTask,
  ChatMessage,
  ChatSession,
  ModelSettings,
  AgentToolCall,
  ManagementTab,
  GuardrailRule,
  TelemetryMetric,
  EvalBenchmarkResult,
  MessageBlock
} from './types/research';
import {
  INITIAL_PAPERS,
  INITIAL_GRAPH_NODES,
  INITIAL_GRAPH_LINKS,
  INITIAL_RAG_WIKI,
  INITIAL_FILES,
  INITIAL_COMMITS,
  INITIAL_MEMORIES,
  INITIAL_SKILLS,
  INITIAL_MCP_SERVERS,
  INITIAL_SCHEDULED_TASKS,
  INITIAL_SESSIONS,
  DEFAULT_SETTINGS,
  INITIAL_GUARDRAILS,
  INITIAL_TELEMETRY,
  INITIAL_BENCHMARKS
} from './data/mockResearchData';
import { MacWindowChrome } from './components/MacWindowChrome';
import { LeftSidebar } from './components/LeftSidebar';
import { AgentChat } from './components/AgentChat';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
import { SystemDrawer } from './components/SystemDrawer';
import { SettingsModal } from './components/SettingsModal';
import { SearchPaletteModal } from './components/SearchPaletteModal';
import { ManagementPanel } from './components/ManagementPanel';
import { ResizableDivider } from './components/ResizableDivider';
import { FilePreviewModal } from './components/FilePreviewModal';
import { ProjectPortalView } from './components/ProjectPortalView';
import { PaperProject } from './types/research';
import {
  loadProjectsFromStorage,
  saveProjectsToStorage,
  loadProjectWorkspaceData,
  saveProjectWorkspaceData,
  getInitialProjectData,
  STORAGE_PREFIX_PROJECT_DATA
} from './data/mockProjects';

export default function App() {
  // Navigation & Elastic Layout States
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isAgentOpen, setIsAgentOpen] = useState(true);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<WorkspaceTab>('latex');

  // Elastic Resizable Panel Widths (persisted to localStorage)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('codex_sidebar_width');
      return saved ? Number(saved) : 256;
    } catch {
      return 256;
    }
  });

  const [agentWidth, setAgentWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('codex_agent_width');
      return saved ? Number(saved) : 440;
    } catch {
      return 440;
    }
  });

  const [isDraggingResizer, setIsDraggingResizer] = useState<'agent' | 'sidebar' | null>(null);

  // Sync widths to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('codex_sidebar_width', String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      localStorage.setItem('codex_agent_width', String(agentWidth));
    } catch {}
  }, [agentWidth]);

  // Responsive auto-collapse & min-width safety for zoom in/out
  useEffect(() => {
    const handleResize = () => {
      const w = window.innerWidth;
      if (w < 860) {
        setIsSidebarOpen(false);
      }
      if (w < 640) {
        setIsAgentOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Modals & Drawers
  const [isSystemDrawerOpen, setIsSystemDrawerOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isManagementPanelOpen, setIsManagementPanelOpen] = useState(false);
  const [managementActiveTab, setManagementActiveTab] = useState<ManagementTab>('memory');
  const [previewFile, setPreviewFile] = useState<VirtualFile | null>(null);

  const handleOpenManagementPanel = (tab: ManagementTab) => {
    setManagementActiveTab(tab);
    setIsManagementPanelOpen(true);
  };

  // Top-Level App Navigation & Multi-Project State (Default: 'portal' landing page)
  const [currentView, setCurrentView] = useState<'portal' | 'workspace'>('portal');
  const [projects, setProjects] = useState<PaperProject[]>(() => loadProjectsFromStorage());
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId) || projects[0];

  // Core Data Stores (Isolated per project)
  const [papers, setPapers] = useState<ResearchPaper[]>(INITIAL_PAPERS);
  const [activePaperId, setActivePaperId] = useState<string>(INITIAL_PAPERS[0]?.id || '');
  const [files, setFiles] = useState<VirtualFile[]>(INITIAL_FILES);
  const [activeFilePath, setActiveFilePath] = useState<string>('');
  const [gitCommits, setGitCommits] = useState<GitCommit[]>(INITIAL_COMMITS);
  const [wikiEntries, setWikiEntries] = useState<RagWikiEntry[]>(INITIAL_RAG_WIKI);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>(INITIAL_GRAPH_NODES);
  const [graphLinks, setGraphLinks] = useState<GraphLink[]>(INITIAL_GRAPH_LINKS);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string>('');
  const [memories, setMemories] = useState<MemoryRecord[]>(INITIAL_MEMORIES);
  const [skills, setSkills] = useState<AgentSkill[]>(INITIAL_SKILLS);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>(INITIAL_MCP_SERVERS);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>(INITIAL_SCHEDULED_TASKS);
  const [guardrails, setGuardrails] = useState<GuardrailRule[]>(INITIAL_GUARDRAILS);
  const [telemetry, setTelemetry] = useState<TelemetryMetric>(INITIAL_TELEMETRY);
  const [benchmarks, setBenchmarks] = useState<EvalBenchmarkResult[]>(INITIAL_BENCHMARKS);
  const [sessions, setSessions] = useState<ChatSession[]>(INITIAL_SESSIONS);
  const [activeSessionId, setActiveSessionId] = useState<string>(INITIAL_SESSIONS[0]?.id || '');

  // Helper to load isolated project data into workspace states
  const loadProjectDataIntoWorkspace = (proj: PaperProject) => {
    const data = loadProjectWorkspaceData(proj);
    setPapers(data.papers || []);
    setActivePaperId(data.activePaperId || (data.papers[0] ? data.papers[0].id : ''));
    setFiles(data.files || []);
    setActiveFilePath(data.activeFilePath || (data.files[0] ? data.files[0].path : ''));
    setGitCommits(data.gitCommits || []);
    setWikiEntries(data.wikiEntries || []);
    setGraphNodes(data.graphNodes || []);
    setGraphLinks(data.graphLinks || []);
    setSelectedGraphNodeId(data.selectedGraphNodeId || (data.graphNodes[0] ? data.graphNodes[0].id : ''));
    setMemories(data.memories || []);
    setSkills(data.skills || []);
    setMcpServers(data.mcpServers || []);
    setScheduledTasks(data.scheduledTasks || []);
    setGuardrails(data.guardrails || []);
    setTelemetry(data.telemetry || INITIAL_TELEMETRY);
    setMemories(data.memories || []);
    setSkills(data.skills || []);
    setMcpServers(data.mcpServers || []);
    setScheduledTasks(data.scheduledTasks || []);
    setGuardrails(data.guardrails || []);
    setTelemetry(data.telemetry || INITIAL_TELEMETRY);
    setBenchmarks(data.benchmarks || []);
    setSessions(data.sessions || []);
    setActiveSessionId(data.activeSessionId || (data.sessions[0] ? data.sessions[0].id : ''));
  };

  // Helper to persist current workspace data
  const persistCurrentWorkspaceData = (projId: string) => {
    saveProjectWorkspaceData(projId, {
      papers,
      activePaperId,
      files,
      activeFilePath,
      gitCommits,
      wikiEntries,
      graphNodes,
      graphLinks,
      selectedGraphNodeId,
      memories,
      skills,
      mcpServers,
      scheduledTasks,
      guardrails,
      telemetry,
      benchmarks,
      sessions,
      activeSessionId
    });
  };

  const handleSelectProject = (projectId: string) => {
    if (activeProjectId && activeProjectId !== projectId) {
      persistCurrentWorkspaceData(activeProjectId);
    }
    const proj = projects.find((p) => p.id === projectId);
    if (proj) {
      loadProjectDataIntoWorkspace(proj);
      setActiveProjectId(projectId);
      setCurrentView('workspace');
    }
  };

  const handleBackToProjects = () => {
    if (activeProjectId) {
      persistCurrentWorkspaceData(activeProjectId);
      setProjects((prev) => {
        const updated = prev.map((p) => {
          if (p.id === activeProjectId) {
            return {
              ...p,
              paperCount: papers.length,
              fileCount: files.length,
              updatedAt: '刚刚'
            };
          }
          return p;
        });
        saveProjectsToStorage(updated);
        return updated;
      });
    }
    setCurrentView('portal');
  };

  const handleCreateProject = (
    newProjData: Omit<PaperProject, 'id' | 'createdAt' | 'updatedAt' | 'paperCount' | 'fileCount' | 'wordCount'>,
    template: string
  ) => {
    const newId = `proj-${Date.now()}`;
    const now = new Date();
    const newProj: PaperProject = {
      ...newProjData,
      id: newId,
      createdAt: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      updatedAt: '刚刚',
      paperCount: 0,
      fileCount: 0,
      wordCount: 0
    };

    const initialData = getInitialProjectData(newProj);
    saveProjectWorkspaceData(newId, initialData);

    const updatedProjects = [newProj, ...projects];
    setProjects(updatedProjects);
    saveProjectsToStorage(updatedProjects);

    loadProjectDataIntoWorkspace(newProj);
    setActiveProjectId(newId);
    setCurrentView('workspace');
  };

  const handleCloneProject = (projectId: string) => {
    const source = projects.find((p) => p.id === projectId);
    if (!source) return;

    const newId = `proj-${Date.now()}`;
    const sourceData = loadProjectWorkspaceData(source);

    const clonedProj: PaperProject = {
      ...source,
      id: newId,
      slug: `${source.slug}-copy`,
      title: `${source.title} (副本)`,
      updatedAt: '刚刚',
      createdAt: new Date().toLocaleDateString(),
      isStarred: false
    };

    saveProjectWorkspaceData(newId, sourceData);

    const updatedProjects = [clonedProj, ...projects];
    setProjects(updatedProjects);
    saveProjectsToStorage(updatedProjects);
  };

  const handleDeleteProject = (projectId: string) => {
    try {
      localStorage.removeItem(`${STORAGE_PREFIX_PROJECT_DATA}${projectId}`);
    } catch {}

    const updated = projects.filter((p) => p.id !== projectId);
    setProjects(updated);
    saveProjectsToStorage(updated);

    if (activeProjectId === projectId) {
      setActiveProjectId(null);
      setCurrentView('portal');
    }
  };

  const handleToggleStar = (projectId: string) => {
    const updated = projects.map((p) =>
      p.id === projectId ? { ...p, isStarred: !p.isStarred } : p
    );
    setProjects(updated);
    saveProjectsToStorage(updated);
  };

  const handleUpdateProject = (updatedProj: PaperProject) => {
    const updated = projects.map((p) => (p.id === updatedProj.id ? updatedProj : p));
    setProjects(updated);
    saveProjectsToStorage(updated);
  };
  const [isProcessing, setIsProcessing] = useState(false);
  const [settings, setSettings] = useState<ModelSettings>(() => {
    try {
      const saved = localStorage.getItem('codex_model_settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        const cleanedProviders = (parsed.customProviders || []).filter(
          (p: any) => p.id !== 'cp-deepseek-official' && p.id !== 'cp-ollama-local' && p.id !== 'cp-bge-embedding'
        );
        const hasLegacyDefault = parsed.provider === 'gemini' && cleanedProviders.length === 0;

        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          provider: hasLegacyDefault ? '' : (parsed.provider || ''),
          modelId: hasLegacyDefault ? '' : (parsed.modelId || ''),
          ragProvider: hasLegacyDefault ? '' : (parsed.ragProvider || ''),
          ragEmbeddingModel: hasLegacyDefault ? '' : (parsed.ragEmbeddingModel || ''),
          customProviders: cleanedProviders,
          academicConfig: { ...DEFAULT_SETTINGS.academicConfig, ...(parsed.academicConfig || {}) },
          sandboxConfig: { ...DEFAULT_SETTINGS.sandboxConfig, ...(parsed.sandboxConfig || {}) },
          guardrailSettings: { ...DEFAULT_SETTINGS.guardrailSettings, ...(parsed.guardrailSettings || {}) },
          mineruConfig: { ...DEFAULT_SETTINGS.mineruConfig, ...(parsed.mineruConfig || {}) }
        };
      }
    } catch {}
    return DEFAULT_SETTINGS;
  });
  const [settingsInitialTab, setSettingsInitialTab] = useState<any>('providers');

  const handleOpenSettingsWithTab = (tab?: string) => {
    setSettingsInitialTab(tab || 'providers');
    setIsSettingsOpen(true);
  };

  // Theme State & Persistence (light / dark / system)
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => {
    try {
      const saved = localStorage.getItem('codex_theme');
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    } catch {}
    return 'dark';
  });

  // Theme synchronizer with DOM & system preferences
  useEffect(() => {
    const applyTheme = () => {
      let isDark = true;
      if (theme === 'system') {
        isDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : true;
      } else {
        isDark = theme === 'dark';
      }

      const root = document.documentElement;
      if (isDark) {
        root.classList.add('dark');
        root.classList.remove('light');
        root.setAttribute('data-theme', 'dark');
        root.style.colorScheme = 'dark';
      } else {
        root.classList.add('light');
        root.classList.remove('dark');
        root.setAttribute('data-theme', 'light');
        root.style.colorScheme = 'light';
      }

      try {
        localStorage.setItem('codex_theme', theme);
      } catch {}
    };

    applyTheme();

    if (theme === 'system' && window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => applyTheme();
      mql.addEventListener('change', listener);
      return () => mql.removeEventListener('change', listener);
    }
  }, [theme]);

  const handleToggleTheme = () => {
    setTheme((prev) => {
      const isCurrentlyDark = document.documentElement.classList.contains('dark') || !document.documentElement.classList.contains('light');
      const nextTheme = isCurrentlyDark ? 'light' : 'dark';
      setSettings((s) => ({ ...s, theme: nextTheme }));
      return nextTheme;
    });
  };

  const handleSetTheme = (newTheme: 'light' | 'dark' | 'system') => {
    setTheme(newTheme);
    setSettings((s) => ({ ...s, theme: newTheme }));
  };

  const [terminalCommand, setTerminalCommand] = useState<string | undefined>(undefined);
  const streamTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Clean up stream timer on unmount
  useEffect(() => {
    return () => {
      if (streamTimerRef.current) {
        clearInterval(streamTimerRef.current);
        streamTimerRef.current = null;
      }
    };
  }, []);

  // Active Session & Derived Messages
  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];
  const messages = activeSession?.messages || [];

  // Derived Active File Content
  const activeFile = files.find((f) => f.path === activeFilePath) || files[0];
  const latexFile = files.find((f) => f.path === activeFilePath && f.type === 'tex') || files.find((f) => f.type === 'tex') || files[0];
  const plotFile = files.find((f) => f.type === 'py') || files[0];

  // Global Keyboard Shortcuts (⌘B for sidebar, ⌘J for Agent copilot, ⌘K for search, ⌘, for settings, ⌘D for theme)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setIsSidebarOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setIsAgentOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setIsSettingsOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && !e.shiftKey) {
        e.preventDefault();
        handleToggleTheme();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Agent Dispatcher Simulation
  const handleSendMessage = (userText: string) => {
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      sender: 'user',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      text: userText
    };

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSessionId) return s;
        const isFirstUserMsg = s.messages.filter((m) => m.sender === 'user').length === 0;
        const updatedTitle =
          isFirstUserMsg && s.title.startsWith('新建')
            ? userText.length > 20
              ? userText.slice(0, 20) + '...'
              : userText
            : s.title;
        return {
          ...s,
          title: updatedTitle,
          updatedAt: '刚刚',
          messages: [...s.messages, userMsg]
        };
      })
    );
    setIsProcessing(true);

    // If agent is closed, automatically reveal it when a message is sent
    if (!isAgentOpen) {
      setIsAgentOpen(true);
    }

    // Simulate autonomous agent tool execution cycle
    setTimeout(() => {
      const lower = userText.toLowerCase();
      let responseText = '';
      const toolCalls: AgentToolCall[] = [];
      let targetTab: WorkspaceTab = activeWorkspaceTab;

      if (lower.includes('技能') || lower.includes('skill') || userText.includes('【启用专业技能】') || userText.includes('【启用技能】')) {
        const matchedSkill =
          skills.find((s) => s.enabled && (userText.includes(s.name) || s.triggers.some((t) => userText.includes(t)))) ||
          skills.find((s) => s.enabled) ||
          skills[0];

        toolCalls.push({
          id: `tc-${Date.now()}-1`,
          name: 'read',
          displayName: 'read',
          status: 'completed',
          durationMs: 260,
          input: {
            skillId: matchedSkill.id,
            category: matchedSkill.category,
            version: matchedSkill.version,
            systemDirective: matchedSkill.systemPromptSnippet
          },
          output: {
            status: 'injected',
            toolsHandshake: matchedSkill.requiredTools,
            complianceCheck: 'passed'
          },
          targetWorkspaceTab: matchedSkill.category === 'math_latex' ? 'latex' : matchedSkill.category === 'literature' ? 'paper' : 'file'
        });

        if (matchedSkill.requiredTools.includes('pdflatex_compile') || matchedSkill.category === 'math_latex' || matchedSkill.category === 'academic_writing') {
          const currentTexFile = latexFile?.name || 'paper.tex';
          toolCalls.push({
            id: `tc-${Date.now()}-2`,
            name: 'compile',
            displayName: 'compile',
            status: 'completed',
            durationMs: 420,
            input: { target: currentTexFile, format: 'article' },
            output: { status: 'success', pages: 1 },
            targetWorkspaceTab: 'latex'
          });
          targetTab = 'latex';
        }

        responseText = `已激活技能 **${matchedSkill.name}** (${matchedSkill.version})：\n\n- **指令**：${matchedSkill.systemPromptSnippet}\n- **工具**：\`${matchedSkill.requiredTools.join('`, `')}\`\n\n规范已对齐，工作区已同步生效！`;
      } else if (lower.includes('arxiv') || lower.includes('文献') || lower.includes('查新') || lower.includes('paper') || lower.includes('检索')) {
        toolCalls.push({
          id: `tc-${Date.now()}-1`,
          name: 'search',
          displayName: 'search',
          status: 'completed',
          durationMs: 380,
          input: { query: userText, max_results: 5 },
          output: { found: papers.length, status: 'ready' },
          targetWorkspaceTab: 'paper'
        });

        responseText = papers.length > 0
          ? `已检索学术文献库，共检索到 ${papers.length} 篇相关论文。已在右侧打开文献视窗供查阅。`
          : `已解析文献检索意图：“${userText}”。您可以在右侧文献视窗点击「导入文献」添加相关 PDF、BibTeX 或 arXiv 论文进行深度解析。`;
        targetTab = 'paper';
      } else if (lower.includes('latex') || lower.includes('公式') || lower.includes('推导') || lower.includes('论文') || lower.includes('写作') || lower.includes('润色') || lower.includes('三线表')) {
        const targetTex = latexFile?.name || 'paper.tex';
        toolCalls.push({
          id: `tc-${Date.now()}-1`,
          name: 'edit',
          displayName: 'edit',
          status: 'completed',
          durationMs: 290,
          input: { path: targetTex, targetSection: 'Methodology' },
          output: { linesModified: 12 },
          targetWorkspaceTab: 'latex'
        });
        toolCalls.push({
          id: `tc-${Date.now()}-2`,
          name: 'compile',
          displayName: 'compile',
          status: 'completed',
          durationMs: 520,
          input: { file: targetTex, flags: '-interaction=nonstopmode' },
          output: { pages: 1, status: 'success', warnings: 0 },
          targetWorkspaceTab: 'latex'
        });

        responseText = `已为您整理学术表达与公式排版，右侧 **LaTeX** 编辑器与预览视窗已就绪。您可直接实时编辑与编译源码！`;
        targetTab = 'latex';
      } else if (lower.includes('plot') || lower.includes('绘图') || lower.includes('图表') || lower.includes('柱状图') || lower.includes('曲线') || lower.includes('可视化')) {
        toolCalls.push({
          id: `tc-${Date.now()}-1`,
          name: 'bash',
          displayName: 'bash',
          status: 'completed',
          durationMs: 450,
          input: { script: 'python script.py' },
          output: { status: 'completed' },
          targetWorkspaceTab: 'terminal'
        });

        responseText = `已在终端准备好执行绘图与实验分析命令。您可直接在终端中运行 Python 脚本生成可视化结果。`;
        targetTab = 'terminal';
      } else if (lower.includes('graph') || lower.includes('图谱') || lower.includes('知识') || lower.includes('拓扑') || lower.includes('实体')) {
        toolCalls.push({
          id: `tc-${Date.now()}-1`,
          name: 'graph',
          displayName: 'graph',
          status: 'completed',
          durationMs: 220,
          input: { concept: userText.slice(0, 30) },
          output: { status: 'synced' },
          targetWorkspaceTab: 'graph'
        });

        responseText = `已同步学术知识图谱与概念实体视窗。导入学术文献后，系统将自动抽取关键实体与拓扑关联。`;
        targetTab = 'graph';
      } else if (lower.includes('git') || lower.includes('commit') || lower.includes('版本')) {
        const newCommit: GitCommit = {
          hash: Math.random().toString(16).substring(2, 9),
          message: 'docs: update research notes and workspace files',
          author: 'Researcher <me@mac.local>',
          date: '刚刚',
          changedFiles: files.length || 1
        };
        setGitCommits((prev) => [newCommit, ...prev]);

        toolCalls.push({
          id: `tc-${Date.now()}-1`,
          name: 'git',
          displayName: 'git',
          status: 'completed',
          durationMs: 190,
          input: { message: newCommit.message },
          output: { commitHash: newCommit.hash },
          targetWorkspaceTab: 'file'
        });

        responseText = `已在 Git 仓库创建提交 \`${newCommit.hash}\`，工作区当前状态已妥善归档。`;
      } else {
        toolCalls.push({
          id: `tc-${Date.now()}-1`,
          name: 'read',
          displayName: 'read',
          status: 'completed',
          durationMs: 310,
          input: { target: 'workspace' },
          output: { status: 'success' },
          targetWorkspaceTab: targetTab
        });

        responseText = `已收到指令！工作区文档、学术推导与代码状态均已就绪。`;
      }

      const assistantMsgId = `msg-${Date.now()}`;
      const assistantTimestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const thoughtId = `th-${assistantMsgId}`;
      const textId = `txt-${assistantMsgId}`;

      // 1. Synthesize contextual thinking reflections
      let thoughtText = '';
      if (lower.includes('技能') || lower.includes('skill') || userText.includes('【启用专业技能】') || userText.includes('【启用技能】')) {
        thoughtText = `正在解析科研技能编排意图：\n1. 检索技能注册表，比对触发条件与当前会话领域需求。\n2. 调度 read 工具读取 System Directive 与依赖规范。\n3. 调度 compile 工具执行环境握手与排版校验。\n4. 检验工作区视窗兼容性并准备反馈。`;
      } else if (lower.includes('arxiv') || lower.includes('文献') || lower.includes('查新') || lower.includes('paper') || lower.includes('检索')) {
        thoughtText = `正在解析文献检索需求：\n1. 结构化抽取学术关键词与检索意图。\n2. 调度 search 工具检索学术文献及引用元数据。\n3. 分析文献摘要与全文结构。\n4. 构建多层级 RAG 向量索引切片并同步工作区展示。`;
      } else if (lower.includes('latex') || lower.includes('公式') || lower.includes('推导') || lower.includes('论文') || lower.includes('写作') || lower.includes('润色') || lower.includes('三线表')) {
        thoughtText = `正在解析学术论文 LaTeX 排版与数学推导需求：\n1. 检查目标文档宏包配置 (amsmath, booktabs, graphicx 等)。\n2. 校验数学推导严谨性与符号一致性。\n3. 调度 edit 工具修改对应章节，调用 compile 工具进行沙箱编译。\n4. 验证编译生成的 PDF 规范性与排版效果。\n5. 格式化输出带有学术说明的最终回答。`;
      } else if (lower.includes('plot') || lower.includes('绘图') || lower.includes('图表') || lower.includes('柱状图') || lower.includes('曲线') || lower.includes('可视化')) {
        thoughtText = `正在分析科学实验绘图与可视化需求：\n1. 评估实验对比维度与指标曲线配置。\n2. 检查制图脚本，配置顶级学术出版配色与 DPI 规格。\n3. 调度 bash 工具在独立沙箱环境中执行脚本渲染图表。\n4. 验证生成结果并联动终端展示。`;
      } else if (lower.includes('graph') || lower.includes('图谱') || lower.includes('拓扑') || lower.includes('实体')) {
        thoughtText = `正在解析知识拓扑演进与实体关系需求：\n1. 抽取核心学术实体与概念演进链条。\n2. 调度 graph 工具动态构建拓扑节点与有向拓扑边。\n3. 联动右侧知识图谱视窗，触发力导向布局重聚类。\n4. 输出拓扑更新摘要与概念演进说明。`;
      } else if (lower.includes('git') || lower.includes('commit') || lower.includes('版本')) {
        thoughtText = `正在评估版本控制与研究资产快照指令：\n1. 检查工作区文件状态与阶段性改动差异。\n2. 组织规范的 Conventional Commits 提交消息。\n3. 调度 git 工具固化当前工作区状态。\n4. 生成提交哈希并反馈给用户。`;
      } else {
        thoughtText = `正在理解用户指令并评估上下文关联：\n1. 分析学术研讨上下文、项目工程结构与当前激活的工作区视窗。\n2. 调度 read 工具检查系统工程配置与状态。\n3. 整合相关数据源，输出清晰精准的学术推理与可执行建议。`;
      }

      const shouldThink = settings.enableThinking;
      const isStream = settings.streamResponse !== false;

      // Initial thought block if thinking is enabled
      const initialBlocks: MessageBlock[] = [];
      if (shouldThink) {
        initialBlocks.push({
          id: thoughtId,
          type: 'thought',
          content: '',
          isStreaming: true,
          durationSeconds: 0.1
        });
      }

      const initialAssistantMsg: ChatMessage = {
        id: assistantMsgId,
        sender: 'assistant',
        timestamp: assistantTimestamp,
        text: '',
        toolCalls: [],
        blocks: initialBlocks,
        targetTabSwitch: targetTab
      };

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeSessionId) return s;
          return {
            ...s,
            updatedAt: '刚刚',
            messages: [...s.messages, initialAssistantMsg]
          };
        })
      );

      // Fast non-stream fallback if stream is disabled
      if (!isStream) {
        const completedTools = toolCalls.map((t) => ({ ...t, status: 'completed' as const }));
        const finalBlocks: MessageBlock[] = [];
        if (shouldThink) {
          finalBlocks.push({
            id: thoughtId,
            type: 'thought',
            content: thoughtText,
            isStreaming: false,
            durationSeconds: 2.1
          });
        }
        completedTools.forEach((tc) => {
          finalBlocks.push({
            id: `blk-${tc.id}`,
            type: 'tool_call',
            toolCall: tc
          });
        });
        finalBlocks.push({
          id: textId,
          type: 'text',
          content: responseText,
          isStreaming: false
        });

        if (settings.autoSwitchWorkspace && targetTab) {
          setActiveWorkspaceTab(targetTab);
        }

        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeSessionId) return s;
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      text: responseText,
                      toolCalls: completedTools,
                      blocks: finalBlocks
                    }
                  : m
              )
            };
          })
        );
        setIsProcessing(false);
        return;
      }

      // ==========================================
      // Stage 1: Stream Thinking Content (Live stream)
      // ==========================================
      const runThinkingPhase = (onThoughtDone: () => void) => {
        if (!shouldThink) {
          onThoughtDone();
          return;
        }

        let charIndex = 0;
        const totalChars = thoughtText.length;
        const startTime = Date.now();
        const chunkSize = 3;
        const intervalMs = 22;

        const thinkTimer = setInterval(() => {
          charIndex = Math.min(charIndex + chunkSize, totalChars);
          const currentThought = thoughtText.slice(0, charIndex);
          const elapsedSec = Math.max(0.1, Number(((Date.now() - startTime) / 1000).toFixed(1)));
          const isDone = charIndex >= totalChars;

          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== activeSessionId) return s;
              return {
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  return {
                    ...m,
                    blocks: (m.blocks || []).map((b) => {
                      if (b.type === 'thought') {
                        return {
                          ...b,
                          content: currentThought,
                          durationSeconds: elapsedSec,
                          isStreaming: !isDone
                        };
                      }
                      return b;
                    })
                  };
                })
              };
            })
          );

          if (isDone) {
            clearInterval(thinkTimer);
            streamTimerRef.current = null;
            setTimeout(onThoughtDone, 180);
          }
        }, intervalMs);

        streamTimerRef.current = thinkTimer;
      };

      // ==========================================
      // Stage 2: Sequential Tool Execution (if any)
      // ==========================================
      const runToolsPhase = (onToolsDone: () => void) => {
        if (toolCalls.length === 0) {
          onToolsDone();
          return;
        }

        let toolIndex = 0;

        const executeNextTool = () => {
          if (toolIndex >= toolCalls.length) {
            onToolsDone();
            return;
          }

          const currentTool = toolCalls[toolIndex];
          const runningTool: AgentToolCall = { ...currentTool, status: 'running' };

          // Append running tool block
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== activeSessionId) return s;
              return {
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  const existingBlocks = m.blocks || [];
                  return {
                    ...m,
                    toolCalls: [...(m.toolCalls || []), runningTool],
                    blocks: [
                      ...existingBlocks,
                      {
                        id: `blk-${currentTool.id}`,
                        type: 'tool_call',
                        toolCall: runningTool
                      }
                    ]
                  };
                })
              };
            })
          );

          // Simulate realistic async tool latency
          const toolLatency = 380 + Math.random() * 150;
          setTimeout(() => {
            const completedTool: AgentToolCall = { ...currentTool, status: 'completed' };

            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== activeSessionId) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) => {
                    if (m.id !== assistantMsgId) return m;
                    return {
                      ...m,
                      toolCalls: (m.toolCalls || []).map((tc) => (tc.id === currentTool.id ? completedTool : tc)),
                      blocks: (m.blocks || []).map((b) =>
                        b.type === 'tool_call' && b.toolCall.id === currentTool.id ? { ...b, toolCall: completedTool } : b
                      )
                    };
                  })
                };
              })
            );

            if (settings.autoSwitchWorkspace && currentTool.targetWorkspaceTab) {
              setActiveWorkspaceTab(currentTool.targetWorkspaceTab);
            }

            toolIndex++;
            setTimeout(executeNextTool, 160);
          }, toolLatency);
        };

        executeNextTool();
      };

      // ==========================================
      // Stage 3: Stream Final Synthesized Answer
      // ==========================================
      const runFinalAnswerPhase = () => {
        // Append initial empty text block
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeSessionId) return s;
            return {
              ...s,
              messages: s.messages.map((m) => {
                if (m.id !== assistantMsgId) return m;
                const existingBlocks = m.blocks || [];
                return {
                  ...m,
                  blocks: [
                    ...existingBlocks,
                    {
                      id: textId,
                      type: 'text',
                      content: '',
                      isStreaming: true
                    }
                  ]
                };
              })
            };
          })
        );

        let charIndex = 0;
        const totalChars = responseText.length;
        const chunkSize = 3;
        const intervalMs = 20;

        const answerTimer = setInterval(() => {
          charIndex = Math.min(charIndex + chunkSize, totalChars);
          const currentText = responseText.slice(0, charIndex);
          const isDone = charIndex >= totalChars;

          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== activeSessionId) return s;
              return {
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  return {
                    ...m,
                    text: currentText,
                    blocks: (m.blocks || []).map((b) => {
                      if (b.type === 'text') {
                        return {
                          ...b,
                          content: currentText,
                          isStreaming: !isDone
                        };
                      }
                      return b;
                    })
                  };
                })
              };
            })
          );

          if (isDone) {
            clearInterval(answerTimer);
            streamTimerRef.current = null;
            setIsProcessing(false);
          }
        }, intervalMs);

        streamTimerRef.current = answerTimer;
      };

      // Execute sequential lifecycle: Stream Thoughts -> Run Tools -> Stream Answer
      runThinkingPhase(() => {
        runToolsPhase(() => {
          runFinalAnswerPhase();
        });
      });
    }, 150);
  };

  // File Operations
  const handleSelectFile = (file: VirtualFile) => {
    setActiveFilePath(file.path);
    if (file.type === 'tex') {
      setActiveWorkspaceTab('latex');
    } else if (file.type === 'py') {
      setActiveWorkspaceTab('terminal');
    } else {
      setActiveWorkspaceTab('latex');
    }
  };

  const handleCreateNewFile = (name: string, type: VirtualFile['type']) => {
    const newF: VirtualFile = {
      path: name,
      name,
      type,
      content: type === 'tex' ? '\\documentclass{article}\n\\begin{document}\nNew File\n\\end{document}' : '# New research document\n'
    };
    setFiles((prev) => [...prev, newF]);
    setActiveFilePath(newF.path);
    setActiveWorkspaceTab(type === 'py' ? 'terminal' : 'latex');
  };

  const handleSaveFileContent = (path: string, content: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, content, isModified: false } : f))
    );
  };

  const handleLatexCodeChange = (code: string) => {
    const targetPath = latexFile?.path || activeFilePath || 'paper.tex';
    setFiles((prev) => {
      const exists = prev.some((f) => f.path === targetPath);
      if (exists) {
        return prev.map((f) => (f.path === targetPath ? { ...f, content: code } : f));
      } else {
        const newFile: VirtualFile = {
          path: targetPath,
          name: targetPath.split('/').pop() || targetPath,
          type: 'tex',
          content: code
        };
        return [...prev, newFile];
      }
    });
    if (!activeFilePath) {
      setActiveFilePath(targetPath);
    }
  };

  // Git Commit
  const handleCommitGit = (message: string) => {
    const newCommit: GitCommit = {
      hash: Math.random().toString(16).substring(2, 9),
      message,
      author: 'Researcher <me@mac.local>',
      date: '刚刚',
      changedFiles: 2
    };
    setGitCommits((prev) => [newCommit, ...prev]);
  };

  // Chat Session Management
  const handleNewSession = () => {
    const newSession: ChatSession = {
      id: `session-${Date.now()}`,
      title: '新建学术研讨对话',
      createdAt: '刚刚',
      updatedAt: '刚刚',
      messages: [
        {
          id: `msg-${Date.now()}`,
          sender: 'assistant',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: '您好！请告诉我您当前想要探讨的研究问题、需要推导的公式，或希望检索的最新文献。'
        }
      ]
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    if (!isAgentOpen) setIsAgentOpen(true);
  };

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
  };

  const handleRenameSession = (id: string, newTitle: string) => {
    if (!newTitle.trim()) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title: newTitle.trim(), updatedAt: '刚刚' } : s))
    );
  };

  const handleDeleteSession = (id: string) => {
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      if (remaining.length === 0) {
        const fallback: ChatSession = {
          id: `session-${Date.now()}`,
          title: '新建学术对话',
          createdAt: '刚刚',
          updatedAt: '刚刚',
          messages: []
        };
        setActiveSessionId(fallback.id);
        return [fallback];
      }
      if (activeSessionId === id) {
        setActiveSessionId(remaining[0].id);
      }
      return remaining;
    });
  };

  const handleDeleteMemory = (id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
  };

  const handleAddMemory = (
    title: string,
    content: string,
    type: MemoryRecord['type'],
    tags?: string[]
  ) => {
    const newMem: MemoryRecord = {
      id: `mem-${Date.now()}`,
      title,
      content,
      type,
      createdAt: new Date().toISOString().split('T')[0],
      confidence: 0.95,
      organizedByAgent: false,
      tags: tags || []
    };
    setMemories((prev) => [newMem, ...prev]);
  };

  const handleUpdateMemory = (updated: MemoryRecord) => {
    setMemories((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  };

  const handleOrganizeMemoriesWithAgent = () => {
    const newAgentMem: MemoryRecord = {
      id: `mem-${Date.now()}`,
      type: 'insight',
      title: '蒸馏采样超参策略',
      content: '在将模型长推理轨迹微调至 7B 紧凑模型时，采样温度设定为 0.6 配合 top_p=0.95 可保持推理自纠错特性，避免无意义词汇震荡。',
      createdAt: new Date().toISOString().split('T')[0],
      confidence: 0.96,
      organizedByAgent: true,
      sourceSessionTitle: activeSession?.title || '学术研讨',
      agentReasoning: '自动分析对话中的模型超参探讨并提炼保存。',
      tags: ['采样温度', '蒸馏策略', '模型调优'],
      pinned: true
    };
    setMemories((prev) => [newAgentMem, ...prev]);
    handleSendMessage(`【记忆已整理】已更新配置：“${newAgentMem.title}”。`);
  };

  // Skill Operations
  const handleToggleSkill = (id: string) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s))
    );
  };

  const handleAddSkill = (skill: AgentSkill) => {
    setSkills((prev) => [skill, ...prev]);
  };

  const handleUpdateSkill = (updated: AgentSkill) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === updated.id ? updated : s))
    );
  };

  const handleDeleteSkill = (id: string) => {
    setSkills((prev) => prev.filter((s) => s.id !== id));
  };

  // MCP Operations
  const handleToggleMCP = (id: string) => {
    setMcpServers((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, status: s.status === 'connected' ? 'disabled' : 'connected' } : s
      )
    );
  };

  const handleAddMCPServer = (server: MCPServer) => {
    setMcpServers((prev) => [...prev, server]);
  };

  const handleDeleteMCPServer = (id: string) => {
    setMcpServers((prev) => prev.filter((s) => s.id !== id));
  };

  // Trigger Scheduled Task
  const handleTriggerScheduledTask = (task: ScheduledTask) => {
    setScheduledTasks((prev) =>
      prev.map((t) => {
        if (t.id !== task.id) return t;
        const newLog = {
          id: `log-${Date.now()}`,
          timestamp: '刚刚',
          status: 'success' as const,
          durationMs: 460,
          summary: `手动触发成功：${task.actionPrompt.slice(0, 36)}...`
        };
        return {
          ...t,
          lastRun: `刚刚 (手动触发成功)`,
          executionHistory: [newLog, ...(t.executionHistory || [])]
        };
      })
    );
    handleSendMessage(`【执行任务】${task.name}：${task.actionPrompt}`);
  };

  const handleToggleTaskStatus = (id: string) => {
    setScheduledTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status: t.status === 'active' ? 'paused' : 'active' } : t))
    );
  };

  const handleAddScheduledTask = (task: ScheduledTask) => {
    setScheduledTasks((prev) => [...prev, task]);
  };

  const handleDeleteScheduledTask = (id: string) => {
    setScheduledTasks((prev) => prev.filter((t) => t.id !== id));
  };

  // Guardrail Operations
  const handleToggleGuardrail = (id: string) => {
    setGuardrails((prev) =>
      prev.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g))
    );
  };

  const handleAddGuardrail = (rule: GuardrailRule) => {
    setGuardrails((prev) => [rule, ...prev]);
  };

  const handleDeleteGuardrail = (id: string) => {
    setGuardrails((prev) => prev.filter((g) => g.id !== id));
  };

  // Benchmark Operations
  const handleRunBenchmark = (benchId: string) => {
    setBenchmarks((prev) =>
      prev.map((b) => {
        if (b.id !== benchId) return b;
        const delta = Math.round((Math.random() * 1.6 - 0.4) * 10) / 10;
        const newScore = Math.min(100, Math.max(70, Math.round((b.score + delta) * 10) / 10));
        return {
          ...b,
          score: newScore,
          lastRun: '刚刚',
          status: 'passed'
        };
      })
    );
    setTelemetry((prev) => ({
      ...prev,
      totalCalls: prev.totalCalls + 1,
      averageLatencyMs: Math.round(prev.averageLatencyMs * 0.98)
    }));
  };

  // Resize event handlers
  const handleAgentResize = (delta: number) => {
    setAgentWidth((prev) => {
      const windowWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const currentSidebar = isSidebarOpen ? sidebarWidth : 0;
      const minAgent = 280;
      const maxAgent = Math.max(minAgent + 60, windowWidth - currentSidebar - 360);
      return Math.max(minAgent, Math.min(maxAgent, Math.round(prev + delta)));
    });
  };

  const handleSidebarResize = (delta: number) => {
    setSidebarWidth((prev) => {
      const minSidebar = 180;
      const maxSidebar = 400;
      return Math.max(minSidebar, Math.min(maxSidebar, Math.round(prev + delta)));
    });
  };

  // 1. Initial Page View: Project Portal (打开应用后为该页面，显示所有的论文项目)
  if (currentView === 'portal' || !activeProjectId) {
    return (
      <>
        <ProjectPortalView
          projects={projects}
          onSelectProject={handleSelectProject}
          onCreateProject={handleCreateProject}
          onCloneProject={handleCloneProject}
          onDeleteProject={handleDeleteProject}
          onToggleStar={handleToggleStar}
          onUpdateProject={handleUpdateProject}
          onOpenSettings={() => handleOpenSettingsWithTab('providers')}
        />
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          initialTab={settingsInitialTab}
          onSaveSettings={(newSettings) => {
            setSettings(newSettings);
            try {
              localStorage.setItem('codex_model_settings', JSON.stringify(newSettings));
            } catch {}
            if (newSettings.theme && newSettings.theme !== theme) {
              handleSetTheme(newSettings.theme);
            }
          }}
          onThemeChange={handleSetTheme}
          mcpServers={mcpServers}
          onAddMCPServer={(newServer) => {
            setMcpServers((prev) => [
              ...prev,
              { ...newServer, id: `mcp-${Date.now()}` }
            ]);
          }}
        />
      </>
    );
  }

  // 2. Main Workbench Workspace (点进某个项目后再进入当前的主页面)
  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-zinc-100 select-none overflow-hidden font-sans">
      {/* 1. macOS Authenticated Window Chrome with Project Breadcrumb & Back Button */}
      <MacWindowChrome
        projectName={activeProject?.slug || 'Transformer-Reasoning-Distillation'}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        isAgentOpen={isAgentOpen}
        onToggleAgent={() => setIsAgentOpen(!isAgentOpen)}
        onOpenSystemDrawer={() => setIsSystemDrawerOpen(true)}
        onOpenSettings={() => handleOpenSettingsWithTab('providers')}
        onOpenSearch={() => setIsSearchOpen(true)}
        onOpenManagementPanel={handleOpenManagementPanel}
        onBackToProjects={handleBackToProjects}
      />

      {/* 2. Main Elastic macOS Workstation Layout with Responsive Safe Overflow */}
      <div className={`flex-1 flex overflow-hidden min-w-0 ${isDraggingResizer ? 'select-none pointer-events-auto' : ''}`}>
        {/* Left Column: Streamlined Sidebar Navigator (Collapsible & Resizable) */}
        {isSidebarOpen && (
          <>
            <LeftSidebar
              projectName={activeProject?.slug}
              onBackToProjects={handleBackToProjects}
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelectSession={handleSelectSession}
              onNewSession={handleNewSession}
              onRenameSession={handleRenameSession}
              onDeleteSession={handleDeleteSession}
              files={files}
              activeFilePath={activeFilePath}
              onSelectFile={handleSelectFile}
              onCreateFile={handleCreateNewFile}
              onDeleteFile={(path) => setFiles((prev) => prev.filter((f) => f.path !== path))}
              onSaveFileContent={handleSaveFileContent}
              onPreviewFile={(f) => setPreviewFile(f)}
              papers={papers}
              activePaperId={activePaperId}
              onSelectPaper={(p) => setActivePaperId(p.id)}
              isLiteratureActive={activeWorkspaceTab === 'literature' || activeWorkspaceTab === 'paper' || activeWorkspaceTab === 'graph'}
              onOpenLiteratureHub={() => setActiveWorkspaceTab('literature')}
              onOpenManagementPanel={handleOpenManagementPanel}
              width={sidebarWidth}
              theme={theme}
              onToggleTheme={handleToggleTheme}
            />
            <ResizableDivider
              onDeltaChange={handleSidebarResize}
              onDoubleClickReset={() => setSidebarWidth(256)}
              isDragging={isDraggingResizer === 'sidebar'}
              onDragStart={() => setIsDraggingResizer('sidebar')}
              onDragEnd={() => setIsDraggingResizer(null)}
            />
          </>
        )}

        {/* Center Column: Conversational Agent & Tool Traces (Collapsible & Resizable) */}
        {isAgentOpen && (
          <>
            <div
              style={{ width: `${agentWidth}px` }}
              className="shrink-0 flex flex-col h-full border-r border-zinc-800 overflow-hidden min-w-[280px] max-w-[calc(100vw-360px)]"
            >
              <AgentChat
                messages={messages}
                onSendMessage={handleSendMessage}
                isProcessing={isProcessing}
                onOpenWorkspaceTab={setActiveWorkspaceTab}
                settings={settings}
                onSwitchModel={(modelId, provider) => {
                  setSettings((prev) => ({
                    ...prev,
                    modelId,
                    provider: provider || prev.provider
                  }));
                }}
                onClose={() => setIsAgentOpen(false)}
                currentWidth={agentWidth}
                onSetWidth={(w) => setAgentWidth(w)}
                onResetWidth={() => setAgentWidth(440)}
                onOpenSettings={handleOpenSettingsWithTab}
              />
            </div>
            <ResizableDivider
              onDeltaChange={handleAgentResize}
              onDoubleClickReset={() => setAgentWidth(440)}
              isDragging={isDraggingResizer === 'agent'}
              onDragStart={() => setIsDraggingResizer('agent')}
              onDragEnd={() => setIsDraggingResizer(null)}
            />
          </>
        )}

        {/* Right Column: Multi-Tab Workspace Canvas (Elastic Flex-1 with min-width safety) */}
        <div className="flex-1 min-w-[340px] flex flex-col h-full overflow-hidden">
          <WorkspaceCanvas
            activeTab={activeWorkspaceTab}
            onChangeTab={setActiveWorkspaceTab}
            papers={papers}
            activePaperId={activePaperId}
            onSelectPaper={(p) => setActivePaperId(p.id)}
            onAddPaper={(p) => setPapers((prev) => [p, ...prev])}
            onAskAboutPaper={(p) => {
              handleSendMessage(`请剖析论文《${p.title}》(arXiv:${p.arxivId}) 的理论与公式推导。`);
            }}
            graphNodes={graphNodes}
            graphLinks={graphLinks}
            selectedGraphNodeId={selectedGraphNodeId}
            onSelectGraphNode={(node) => setSelectedGraphNodeId(node.id)}
            onExpandGraphWithNode={(node) => {
              handleSendMessage(`请围绕实体 “${node.label}” 扩展相关数学原理、算法演进与代表论文。`);
            }}
            wikiEntries={wikiEntries}
            onAddWikiEntry={(entry) => setWikiEntries((prev) => [entry, ...prev])}
            latexCode={latexFile?.content || ''}
            onLatexCodeChange={handleLatexCodeChange}
            onAskAgentToEditLatex={(prompt) => {
              handleSendMessage(`【LaTeX】${prompt}`);
            }}
            plotCode={plotFile?.content || ''}
            onRunScriptInTerminal={(code) => {
              setTerminalCommand('python src/plot_benchmarks.py');
              setActiveWorkspaceTab('terminal');
            }}
            terminalCommand={terminalCommand}
            activeFile={activeFile}
            files={files}
            onSelectFile={handleSelectFile}
            onSaveFileContent={handleSaveFileContent}
            settings={settings}
            onOpenSettings={handleOpenSettingsWithTab}
          />
        </div>
      </div>

      {/* Git Version & Snapshots Drawer */}
      <SystemDrawer
        isOpen={isSystemDrawerOpen}
        onClose={() => setIsSystemDrawerOpen(false)}
        gitCommits={gitCommits}
        onCommitGit={handleCommitGit}
      />

      {/* Preferences Modal (⌘,) */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        initialTab={settingsInitialTab}
        onSaveSettings={(newSettings) => {
          setSettings(newSettings);
          try {
            localStorage.setItem('codex_model_settings', JSON.stringify(newSettings));
          } catch {}
          if (newSettings.theme && newSettings.theme !== theme) {
            handleSetTheme(newSettings.theme);
          }
        }}
        onThemeChange={handleSetTheme}
        mcpServers={mcpServers}
        onAddMCPServer={(newServer) => {
          setMcpServers((prev) => [
            ...prev,
            { ...newServer, id: `mcp-${Date.now()}` }
          ]);
        }}
      />


      {/* Spotlight Command Search Palette Modal (⌘K) */}
      <SearchPaletteModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        papers={papers}
        wikiEntries={wikiEntries}
        files={files}
        skills={skills}
        onSelectPaper={(p) => {
          setActivePaperId(p.id);
          setActiveWorkspaceTab('paper');
        }}
        onSelectWiki={(w) => {
          handleSendMessage(`请在对话中分析 Wiki 概念：${w.title}`);
        }}
        onSelectFile={handleSelectFile}
        onOpenWorkspaceTab={setActiveWorkspaceTab}
        onOpenManagementPanel={handleOpenManagementPanel}
      />

      {/* Complete Right-side Management Panel (Memory, MCP, Scheduled Tasks) */}
      <ManagementPanel
        isOpen={isManagementPanelOpen}
        onClose={() => setIsManagementPanelOpen(false)}
        activeTab={managementActiveTab}
        onChangeTab={setManagementActiveTab}
        memories={memories}
        onAddMemory={handleAddMemory}
        onUpdateMemory={handleUpdateMemory}
        onDeleteMemory={handleDeleteMemory}
        onOrganizeMemoriesWithAgent={handleOrganizeMemoriesWithAgent}
        skills={skills}
        onToggleSkill={handleToggleSkill}
        onAddSkill={handleAddSkill}
        onUpdateSkill={handleUpdateSkill}
        onDeleteSkill={handleDeleteSkill}
        mcpServers={mcpServers}
        onToggleMCP={handleToggleMCP}
        onAddMCPServer={handleAddMCPServer}
        onDeleteMCPServer={handleDeleteMCPServer}
        scheduledTasks={scheduledTasks}
        onTriggerTask={handleTriggerScheduledTask}
        onToggleTaskStatus={handleToggleTaskStatus}
        onAddScheduledTask={handleAddScheduledTask}
        onDeleteScheduledTask={handleDeleteScheduledTask}
        guardrails={guardrails}
        onToggleGuardrail={handleToggleGuardrail}
        onAddGuardrail={handleAddGuardrail}
        onDeleteGuardrail={handleDeleteGuardrail}
        telemetry={telemetry}
        benchmarks={benchmarks}
        onRunBenchmark={handleRunBenchmark}
        onSendToChat={handleSendMessage}
      />

      {/* Fullscreen File Preview Modal (Mounted at root & Portaled to body to prevent stacking context bleed) */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          files={files}
          isOpen={true}
          onClose={() => setPreviewFile(null)}
          onOpenInEditor={(f) => {
            handleSelectFile(f);
            setPreviewFile(null);
          }}
          onSaveContent={handleSaveFileContent}
          onSelectFile={(f) => setPreviewFile(f)}
        />
      )}
    </div>
  );
}
