export type SettingsSectionId =
  | 'providers'
  | 'default-model'
  | 'app-basics'
  | 'tasks'
  | 'auth-security'
  | 'hooks'
  | 'memory';

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
};

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'providers', label: '模型提供商' },
  { id: 'default-model', label: '默认模型' },
  { id: 'app-basics', label: '应用基础' },
  { id: 'tasks', label: '任务与调度' },
  { id: 'auth-security', label: '授权与安全' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'memory', label: '记忆策略' }
];

export function selectSettingsSection(current: SettingsSectionId, requested: string): SettingsSectionId {
  if (SETTINGS_SECTIONS.some((section) => section.id === requested)) {
    return requested as SettingsSectionId;
  }
  return current;
}

export * from './settings/provider-draft-model';
export * from './settings/settings-save-model';
export * from './settings/impact-model';
