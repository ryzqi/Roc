import type { LoadedState } from '../../loaded-state';
import type { ViewId } from '../../app/types';
import type { ResearchContext } from './research-context';

export type ResearchServiceStatus = 'available' | 'needs_setup' | 'running' | 'blocked' | 'failed' | 'disabled';

export type ResearchServiceId =
  | 'assistant'
  | 'files'
  | 'tasks'
  | 'connectors'
  | 'skills'
  | 'memory'
  | 'diagnostics';

export type ResearchServiceEntry = {
  id: ResearchServiceId;
  label: string;
  description: string;
  view: ViewId;
  status: ResearchServiceStatus;
  statusLabel: string;
  projectId: string | null;
  stage: ResearchContext['currentStage'];
  workspacePath: string | null;
};

export type ResearchServiceContext = {
  projectId: string | null;
  projectTitle: string | null;
  currentStage: ResearchContext['currentStage'];
  workspacePath: string | null;
};

const SERVICE_STATUS_LABELS: Record<ResearchServiceStatus, string> = {
  available: '可用',
  needs_setup: '待配置',
  running: '运行中',
  blocked: '待确认',
  failed: '失败',
  disabled: '未启用'
};

export function researchServiceStatusLabel(status: ResearchServiceStatus): string {
  return SERVICE_STATUS_LABELS[status];
}

export function createResearchServiceContext(
  context: Pick<ResearchContext, 'projectId' | 'project' | 'currentStage'>,
  fallbackWorkspacePath: string | null = null
): ResearchServiceContext {
  return {
    projectId: context.projectId,
    projectTitle: context.project?.title ?? null,
    currentStage: context.currentStage,
    workspacePath: context.project?.workspacePath ?? (context.projectId === null ? fallbackWorkspacePath : null)
  };
}

export function buildResearchServices(
  state: LoadedState,
  context: ResearchServiceContext
): ResearchServiceEntry[] {
  const running = state.taskSnapshot.counts.running;
  const pending = state.taskSnapshot.counts.pendingConfirmation;
  const failed = state.taskSnapshot.counts.failed;
  const mcpEnabled = state.mcpServers.filter((server) => server.enabled).length;
  const skillsReady = state.skills.filter((skill) => skill.enabled && skill.status === 'ready').length;
  return [
    service('assistant', '研究助手', '绑定当前项目与阶段的对话', 'chat', state.agent.execution === 'ready' ? 'available' : 'needs_setup', context),
    service('tasks', '活动与运行', '任务、审批和后台运行', 'tasks-board', pending > 0 ? 'blocked' : running > 0 ? 'running' : 'available', context),
    service('files', '文件与代码', '项目文件、Git 与终端', 'workspace', context.workspacePath === null ? 'needs_setup' : 'available', context),
    service('connectors', '连接器', 'MCP 授权与工具权限', 'mcp', mcpEnabled > 0 ? 'available' : 'needs_setup', context),
    service('skills', '技能', '按阶段可调用的 Skill', 'skills', skillsReady > 0 ? 'available' : 'needs_setup', context),
    service('memory', '项目记忆', '会话历史与自动记忆', 'memory', 'available', context),
    service('diagnostics', '运行诊断', '失败运行与主机状态', 'diagnostics', failed > 0 ? 'failed' : 'available', context)
  ];
}

function service(
  id: ResearchServiceId,
  label: string,
  description: string,
  view: ViewId,
  status: ResearchServiceStatus,
  context: ResearchServiceContext
): ResearchServiceEntry {
  return {
    id,
    label,
    description,
    view,
    status,
    statusLabel: researchServiceStatusLabel(status),
    projectId: context.projectId,
    stage: context.currentStage,
    workspacePath: context.workspacePath
  };
}
