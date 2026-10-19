import {
  PaperProject,
  ProjectWorkspaceData,
  VirtualFile,
  ChatSession
} from '../types/research';
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
  INITIAL_GUARDRAILS,
  INITIAL_TELEMETRY,
  INITIAL_BENCHMARKS
} from './mockResearchData';

export const INITIAL_PROJECTS: PaperProject[] = [];

export const STORAGE_KEY_PROJECTS = 'codex_projects_list';
export const STORAGE_PREFIX_PROJECT_DATA = 'codex_project_data_';

export function loadProjectsFromStorage(): PaperProject[] {
  try {
    // Purge legacy demo project keys if still present from previous sessions
    const hasPurged = localStorage.getItem('codex_demo_cleaned_v4');
    if (!hasPurged) {
      localStorage.removeItem(STORAGE_KEY_PROJECTS);
      localStorage.removeItem(`${STORAGE_PREFIX_PROJECT_DATA}proj-reasoning`);
      localStorage.removeItem(`${STORAGE_PREFIX_PROJECT_DATA}proj-embodied`);
      localStorage.removeItem(`${STORAGE_PREFIX_PROJECT_DATA}proj-genomics`);
      localStorage.setItem('codex_demo_cleaned_v4', 'true');
      return [];
    }

    const raw = localStorage.getItem(STORAGE_KEY_PROJECTS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Filter out legacy demo items if present
        return parsed.filter(
          (p) => p.id !== 'proj-reasoning' && p.id !== 'proj-embodied' && p.id !== 'proj-genomics'
        );
      }
    }
  } catch (err) {
    console.warn('Failed to load projects from localStorage:', err);
  }
  return INITIAL_PROJECTS;
}

export function saveProjectsToStorage(projects: PaperProject[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
  } catch (err) {
    console.error('Failed to save projects to localStorage:', err);
  }
}

/**
 * Generate starter files for a newly created project (clean, empty by default)
 */
export function createStarterFiles(_projectName: string, _title: string, _field: string): VirtualFile[] {
  return [];
}

/**
 * Creates or retrieves initial isolated workspace data for a project
 */
export function getInitialProjectData(project: PaperProject): ProjectWorkspaceData {
  const session: ChatSession = {
    id: `session-${project.id}-${Date.now()}`,
    title: `${project.title || '课题'} 研讨`,
    createdAt: '今天',
    updatedAt: '刚刚',
    messages: [
      {
        id: `msg-init-${Date.now()}`,
        sender: 'assistant',
        text: `您好！课题《${project.title}》已准备就绪。您可以导入文献、创建 LaTeX 源码或进行实验推导。`,
        timestamp: '刚刚'
      }
    ]
  };

  return {
    papers: INITIAL_PAPERS,
    activePaperId: '',
    files: INITIAL_FILES,
    activeFilePath: '',
    gitCommits: INITIAL_COMMITS,
    wikiEntries: INITIAL_RAG_WIKI,
    graphNodes: INITIAL_GRAPH_NODES,
    graphLinks: INITIAL_GRAPH_LINKS,
    selectedGraphNodeId: '',
    memories: INITIAL_MEMORIES,
    skills: INITIAL_SKILLS,
    mcpServers: INITIAL_MCP_SERVERS,
    scheduledTasks: INITIAL_SCHEDULED_TASKS,
    guardrails: INITIAL_GUARDRAILS,
    telemetry: INITIAL_TELEMETRY,
    benchmarks: INITIAL_BENCHMARKS,
    sessions: [session],
    activeSessionId: session.id
  };
}

export function loadProjectWorkspaceData(project: PaperProject): ProjectWorkspaceData {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX_PROJECT_DATA}${project.id}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.files) && Array.isArray(parsed.papers)) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn(`Failed to parse saved data for project ${project.id}:`, err);
  }
  return getInitialProjectData(project);
}

export function saveProjectWorkspaceData(projectId: string, data: ProjectWorkspaceData): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX_PROJECT_DATA}${projectId}`, JSON.stringify(data));
  } catch (err) {
    console.error(`Failed to save project data for ${projectId}:`, err);
  }
}
