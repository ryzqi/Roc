import type { ApprovalMode, AppSettings, PermissionsConfig } from '../../shared/types';
import type { SettingsSectionId } from '../settings-model';

type ImpactSeverity = 'info' | 'high';

export type ImpactRow = {
  sectionId: SettingsSectionId;
  field: string;
  before: string;
  after: string;
  impact: string;
  severity: ImpactSeverity;
};

export type ImpactSourceState = {
  settings: AppSettings;
  permissions: PermissionsConfig;
  defaultModelId: string | null;
};

const memoryFieldImpactCopy: Record<string, string> = {
  'charLimits.user': '会影响 DeepAgents native memory 写入 USER.md 的容量上限。',
  'charLimits.agents': '会影响 DeepAgents native memory 写入 AGENTS.md 的容量上限。',
  'charLimits.memory': '会影响 DeepAgents native memory 写入 MEMORY.md 的容量上限。',
  sessionRetentionDays: '会影响会话回忆的保留期，过期后会被自动清理。',
  'securityScan.promptInjection': '会影响 DeepAgents native memory 写入时是否阻断 prompt injection 内容。',
  'securityScan.credential': '会影响 DeepAgents native memory 写入时是否阻断凭据内容。',
  'securityScan.sshBackdoor': '会影响 DeepAgents native memory 写入时是否阻断 SSH 后门内容。',
  'securityScan.invisibleUnicode': '会影响 DeepAgents native memory 写入时是否阻断不可见 Unicode 字符。'
};

const approvalModeCopy: Record<ApprovalMode, string> = {
  fully_automatic: '全自动',
  default: '默认(MCP 与删除文件需审批)'
};

const taskFieldImpactCopy: Record<string, string> = {
  'longRunningThresholds.runningSeconds': '会影响任务运行多久后被识别为长任务候选。',
  'longRunningThresholds.toolCallCount': '会影响工具调用多少次后被识别为长任务候选。',
  'longRunningThresholds.subagentCount': '会影响子代理数量达到多少后被识别为复杂任务候选。',
  'scheduler.catchUpOnStartup': '会影响应用启动时是否补跑错过触发时间的后台任务。',
  'scheduler.maxRegisteredTasks': '会影响后台调度器最多登记多少个任务。'
};

function describeMemoryValue(field: string, value: boolean | number): string {
  if (typeof value === 'boolean') {
    return value === true ? '已启用' : '已关闭';
  }
  if (field === 'sessionRetentionDays') {
    return `${value} 天`;
  }
  return String(value);
}

function pushIfChanged<T>(
  rows: ImpactRow[],
  sectionId: SettingsSectionId,
  field: string,
  before: T,
  after: T,
  impact: string,
  severity: ImpactSeverity,
  format: (value: T) => string = (value) => String(value)
): void {
  if (before === after) {
    return;
  }
  rows.push({
    sectionId,
    field,
    before: format(before),
    after: format(after),
    impact,
    severity
  });
}

export function buildImpactRows(base: ImpactSourceState, draft: ImpactSourceState): ImpactRow[] {
  const rows: ImpactRow[] = [];

  pushIfChanged(
    rows,
    'default-model',
    'defaultModelId',
    base.defaultModelId,
    draft.defaultModelId,
    '会影响新任务和后台任务的模型选择，未配置时聊天和任务入口会进入阻断状态。',
    'high',
    (value) => (value === null ? '未配置' : value)
  );

  pushIfChanged(
    rows,
    'app-basics',
    'defaultWorkspace',
    base.settings.defaultWorkspace,
    draft.settings.defaultWorkspace,
    '会影响新任务的默认执行边界，工作区外动作仍需显式确认。',
    'info',
    (value) => (value === null ? '未选择' : value)
  );

  pushIfChanged(
    rows,
    'app-basics',
    'startup.openAtLogin',
    base.settings.startup.openAtLogin,
    draft.settings.startup.openAtLogin,
    '会影响 Roc 是否随系统登录启动。',
    'info',
    (value) => (value ? '开机启动' : '不开机启动')
  );

  pushIfChanged(
    rows,
    'app-basics',
    'startup.minimizeToTray',
    base.settings.startup.minimizeToTray,
    draft.settings.startup.minimizeToTray,
    '会影响关闭主窗口后是否驻留托盘。',
    'info',
    (value) => (value ? '最小化到托盘' : '直接退出')
  );

  pushIfChanged(
    rows,
    'app-basics',
    'globalHotkey',
    base.settings.globalHotkey,
    draft.settings.globalHotkey,
    '会影响全局快捷键；保存后会同步注册系统级快捷键。',
    'info',
    (value) => (value === null || value.length === 0 ? '未设置' : value)
  );

  pushIfChanged(
    rows,
    'tasks',
    'tasks.longRunningThresholds.runningSeconds',
    base.settings.tasks.longRunningThresholds.runningSeconds,
    draft.settings.tasks.longRunningThresholds.runningSeconds,
    taskFieldImpactCopy['longRunningThresholds.runningSeconds'],
    'info',
    (value) => `${value} 秒`
  );

  pushIfChanged(
    rows,
    'tasks',
    'tasks.longRunningThresholds.toolCallCount',
    base.settings.tasks.longRunningThresholds.toolCallCount,
    draft.settings.tasks.longRunningThresholds.toolCallCount,
    taskFieldImpactCopy['longRunningThresholds.toolCallCount'],
    'info',
    (value) => `${value} 次`
  );

  pushIfChanged(
    rows,
    'tasks',
    'tasks.longRunningThresholds.subagentCount',
    base.settings.tasks.longRunningThresholds.subagentCount,
    draft.settings.tasks.longRunningThresholds.subagentCount,
    taskFieldImpactCopy['longRunningThresholds.subagentCount'],
    'info',
    (value) => `${value} 个`
  );

  pushIfChanged(
    rows,
    'tasks',
    'tasks.scheduler.catchUpOnStartup',
    base.settings.tasks.scheduler.catchUpOnStartup,
    draft.settings.tasks.scheduler.catchUpOnStartup,
    taskFieldImpactCopy['scheduler.catchUpOnStartup'],
    'info',
    (value) => (value ? '启动时补跑' : '启动时不补跑')
  );

  pushIfChanged(
    rows,
    'tasks',
    'tasks.scheduler.maxRegisteredTasks',
    base.settings.tasks.scheduler.maxRegisteredTasks,
    draft.settings.tasks.scheduler.maxRegisteredTasks,
    taskFieldImpactCopy['scheduler.maxRegisteredTasks'],
    'info',
    (value) => `${value} 个`
  );

  const pushMemoryChange = (field: string, before: boolean | number, after: boolean | number): void => {
    if (before === after) {
      return;
    }
    rows.push({
      sectionId: 'memory',
      field: `memory.${field}`,
      before: describeMemoryValue(field, before),
      after: describeMemoryValue(field, after),
      impact: memoryFieldImpactCopy[field],
      severity: 'high'
    });
  };

  pushMemoryChange('charLimits.user', base.settings.memory.charLimits.user, draft.settings.memory.charLimits.user);
  pushMemoryChange('charLimits.agents', base.settings.memory.charLimits.agents, draft.settings.memory.charLimits.agents);
  pushMemoryChange('charLimits.memory', base.settings.memory.charLimits.memory, draft.settings.memory.charLimits.memory);
  pushMemoryChange('sessionRetentionDays', base.settings.memory.sessionRetentionDays, draft.settings.memory.sessionRetentionDays);
  pushMemoryChange(
    'securityScan.promptInjection',
    base.settings.memory.securityScan.promptInjection,
    draft.settings.memory.securityScan.promptInjection
  );
  pushMemoryChange(
    'securityScan.credential',
    base.settings.memory.securityScan.credential,
    draft.settings.memory.securityScan.credential
  );
  pushMemoryChange(
    'securityScan.sshBackdoor',
    base.settings.memory.securityScan.sshBackdoor,
    draft.settings.memory.securityScan.sshBackdoor
  );
  pushMemoryChange(
    'securityScan.invisibleUnicode',
    base.settings.memory.securityScan.invisibleUnicode,
    draft.settings.memory.securityScan.invisibleUnicode
  );

  pushIfChanged(
    rows,
    'auth-security',
    'permissions.mode',
    base.permissions.mode,
    draft.permissions.mode,
    '会影响 agent 何时弹出审批卡。',
    'high',
    (value) => approvalModeCopy[value]
  );

  return rows;
}

export function dirtySectionIds(rows: readonly ImpactRow[]): SettingsSectionId[] {
  const result = new Set<SettingsSectionId>();
  for (const row of rows) {
    result.add(row.sectionId);
  }
  return Array.from(result);
}
