export type SettingsSectionId =
  | 'providers'
  | 'default-model'
  | 'app-basics'
  | 'auth-security'
  | 'memory'
  | 'browser'
  | 'capabilities';

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
};

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'providers', label: '模型提供商' },
  { id: 'default-model', label: '默认模型' },
  { id: 'app-basics', label: '应用基础' },
  { id: 'auth-security', label: '授权与安全' },
  { id: 'memory', label: '记忆策略' },
  { id: 'browser', label: '网页与浏览器' },
  { id: 'capabilities', label: '能力入口' }
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
