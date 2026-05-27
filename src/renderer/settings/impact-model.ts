import type { ApprovalMode, AppSettings, PermissionsConfig } from '../../shared/types';
import type { SettingsSectionId } from '../settings-model';

export type ImpactSeverity = 'info' | 'high';

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

const memoryFieldImpactCopy: Record<keyof AppSettings['memory'], string> = {
  candidateReviewMode: '会影响候选记忆是否需要人工确认才能进入有效记忆。',
  warmRecallEnabled: '会影响暖记忆是否在任务中按需召回。',
  sessionRetentionDays: '会影响会话回忆的保留期，过期后会被自动清理。',
  crossScopeRecall: '会影响跨项目、跨任务的记忆召回是否需要显式扩大范围。',
  coldAutoForgetDays: '会影响冷记忆的自动遗忘策略。'
};

const approvalModeCopy: Record<ApprovalMode, string> = {
  fully_automatic: '全自动',
  default: '默认(MCP 与删除文件需审批)'
};

const candidateModeCopy: Record<AppSettings['memory']['candidateReviewMode'], string> = {
  manual: '人工审阅',
  auto_after_approval: '已确认后自动准入'
};

const crossScopeCopy: Record<AppSettings['memory']['crossScopeRecall'], string> = {
  explicit_only: '仅显式扩大范围',
  expanded_with_label: '默认扩大并标注来源'
};

function describeMemoryValue<K extends keyof AppSettings['memory']>(
  field: K,
  value: AppSettings['memory'][K]
): string {
  if (field === 'candidateReviewMode') {
    return candidateModeCopy[value as AppSettings['memory']['candidateReviewMode']];
  }
  if (field === 'crossScopeRecall') {
    return crossScopeCopy[value as AppSettings['memory']['crossScopeRecall']];
  }
  if (field === 'coldAutoForgetDays') {
    const days = value as AppSettings['memory']['coldAutoForgetDays'];
    return days === null ? '不自动遗忘' : `${days} 天`;
  }
  if (field === 'sessionRetentionDays') {
    return `${value as number} 天`;
  }
  if (field === 'warmRecallEnabled') {
    return value === true ? '已启用' : '已关闭';
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
    'notifications.lowDistraction',
    base.settings.notifications.lowDistraction,
    draft.settings.notifications.lowDistraction,
    '会影响 Roc 主动通知的频率与范围。',
    'info',
    (value) => (value ? '低打扰' : '常规')
  );

  pushIfChanged(
    rows,
    'app-basics',
    'globalHotkey',
    base.settings.globalHotkey,
    draft.settings.globalHotkey,
    '会影响全局快捷入口；保存后会同步注册系统级快捷键。',
    'info',
    (value) => (value === null || value.length === 0 ? '未设置' : value)
  );

  for (const field of Object.keys(base.settings.memory) as Array<keyof AppSettings['memory']>) {
    const before = base.settings.memory[field];
    const after = draft.settings.memory[field];
    if (before === after) {
      continue;
    }
    rows.push({
      sectionId: 'memory',
      field: `memory.${field}`,
      before: describeMemoryValue(field, before),
      after: describeMemoryValue(field, after),
      impact: memoryFieldImpactCopy[field],
      severity: 'high'
    });
  }

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
