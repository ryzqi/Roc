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

const memoryFieldImpactCopy: Record<string, string> = {
  frozenSnapshotEnabled: '会影响新会话是否加载冻结记忆快照。',
  userProfileEnabled: '会影响 USER.md 是否进入冻结快照。',
  agentsRulesEnabled: '会影响 AGENTS.md 是否进入冻结快照。',
  'charLimits.user': '会影响 USER.md 的写入容量上限。',
  'charLimits.agents': '会影响 AGENTS.md 的写入容量上限。',
  'charLimits.memory': '会影响 MEMORY.md 的写入容量上限。',
  sessionRetentionDays: '会影响会话回忆的保留期，过期后会被自动清理。',
  consolidatorEnabled: '会影响容量溢出后的自动压缩是否运行。',
  consolidatorDebounceMinutes: '会影响容量溢出后自动压缩的延迟。',
  consolidatorTargetRatio: '会影响自动压缩后的目标容量比例。',
  consolidatorDailyQuota: '会影响每天自动压缩的最大次数。',
  preCompactionFlushEnabled: '会影响上下文接近窗口上限时是否触发静默刷新。',
  preCompactionTokenThreshold: '会影响预压缩刷新的触发阈值。',
  preCompactionContextWindowTokens: '会影响预压缩刷新使用的上下文窗口估算。',
  'securityScan.promptInjection': '会影响 prompt injection 内容是否阻断写入。',
  'securityScan.credential': '会影响凭据内容是否阻断写入。',
  'securityScan.sshBackdoor': '会影响 SSH 后门内容是否阻断写入。',
  'securityScan.invisibleUnicode': '会影响不可见 Unicode 字符是否阻断写入。'
};

const approvalModeCopy: Record<ApprovalMode, string> = {
  fully_automatic: '全自动',
  default: '默认(MCP 与删除文件需审批)'
};

function describeMemoryValue(field: string, value: boolean | number): string {
  if (typeof value === 'boolean') {
    return value === true ? '已启用' : '已关闭';
  }
  if (field === 'sessionRetentionDays' || field === 'consolidatorDebounceMinutes') {
    return field === 'sessionRetentionDays' ? `${value} 天` : `${value} 分钟`;
  }
  if (field === 'consolidatorTargetRatio' || field === 'preCompactionTokenThreshold') {
    return `${Math.round(value * 100)}%`;
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
    '会影响全局快捷键；保存后会同步注册系统级快捷键。',
    'info',
    (value) => (value === null || value.length === 0 ? '未设置' : value)
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

  pushMemoryChange('frozenSnapshotEnabled', base.settings.memory.frozenSnapshotEnabled, draft.settings.memory.frozenSnapshotEnabled);
  pushMemoryChange('userProfileEnabled', base.settings.memory.userProfileEnabled, draft.settings.memory.userProfileEnabled);
  pushMemoryChange('agentsRulesEnabled', base.settings.memory.agentsRulesEnabled, draft.settings.memory.agentsRulesEnabled);
  pushMemoryChange('charLimits.user', base.settings.memory.charLimits.user, draft.settings.memory.charLimits.user);
  pushMemoryChange('charLimits.agents', base.settings.memory.charLimits.agents, draft.settings.memory.charLimits.agents);
  pushMemoryChange('charLimits.memory', base.settings.memory.charLimits.memory, draft.settings.memory.charLimits.memory);
  pushMemoryChange('sessionRetentionDays', base.settings.memory.sessionRetentionDays, draft.settings.memory.sessionRetentionDays);
  pushMemoryChange('consolidatorEnabled', base.settings.memory.consolidatorEnabled, draft.settings.memory.consolidatorEnabled);
  pushMemoryChange(
    'consolidatorDebounceMinutes',
    base.settings.memory.consolidatorDebounceMinutes,
    draft.settings.memory.consolidatorDebounceMinutes
  );
  pushMemoryChange(
    'consolidatorTargetRatio',
    base.settings.memory.consolidatorTargetRatio,
    draft.settings.memory.consolidatorTargetRatio
  );
  pushMemoryChange('consolidatorDailyQuota', base.settings.memory.consolidatorDailyQuota, draft.settings.memory.consolidatorDailyQuota);
  pushMemoryChange(
    'preCompactionFlushEnabled',
    base.settings.memory.preCompactionFlushEnabled,
    draft.settings.memory.preCompactionFlushEnabled
  );
  pushMemoryChange(
    'preCompactionTokenThreshold',
    base.settings.memory.preCompactionTokenThreshold,
    draft.settings.memory.preCompactionTokenThreshold
  );
  pushMemoryChange(
    'preCompactionContextWindowTokens',
    base.settings.memory.preCompactionContextWindowTokens,
    draft.settings.memory.preCompactionContextWindowTokens
  );
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
