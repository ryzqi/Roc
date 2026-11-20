import { SETTINGS_SECTIONS, type SettingsSectionId } from './settings-rules';

export type SettingsDomainId = 'general' | 'models' | 'research' | 'security' | 'advanced';
export type SettingsDomain = {
  id: SettingsDomainId;
  label: string;
  description: string;
  sectionIds: readonly SettingsSectionId[];
  keywords: readonly string[];
};

export const SETTINGS_DOMAINS: readonly SettingsDomain[] = [
  { id: 'general', label: '通用与外观', description: '主题、密度和应用行为', sectionIds: ['app'], keywords: ['应用', '外观', '主题', '快捷键', 'density', 'paper'] },
  { id: 'models', label: '模型与路由', description: '供应商和默认模型', sectionIds: ['models', 'default-model'], keywords: ['模型', '供应商', '路由', 'provider', 'default'] },
  { id: 'research', label: '科研与知识库', description: '文献、检索、记忆和任务', sectionIds: ['literature', 'rag', 'memory', 'tasks'], keywords: ['科研', '文献', 'RAG', '记忆', '任务', '知识'] },
  { id: 'security', label: '安全与沙箱', description: '授权、智能体和运行隔离', sectionIds: ['guardrail', 'sandbox', 'authorization'], keywords: ['安全', '权限', '授权', '沙箱', 'guardrail'] },
  { id: 'advanced', label: '高级与扩展', description: 'Hooks、试点和备份', sectionIds: ['backup', 'pilot', 'hooks'], keywords: ['高级', '扩展', 'Hooks', '试点', '备份'] }
];

export const SETTINGS_DOMAIN_BY_ID = new Map(SETTINGS_DOMAINS.map(domain => [domain.id, domain]));
export const SETTINGS_SECTION_BY_ID = new Map(SETTINGS_SECTIONS.map(section => [section.id, section]));

export function domainForSection(id: SettingsSectionId): SettingsDomain {
  return SETTINGS_DOMAINS.find(domain => domain.sectionIds.includes(id)) ?? SETTINGS_DOMAINS[0]!;
}

export function settingsSearchText(id: SettingsSectionId): string {
  const section = SETTINGS_SECTION_BY_ID.get(id);
  const domain = domainForSection(id);
  return [section?.label ?? id, domain.label, domain.description, ...domain.keywords].join(' ').toLocaleLowerCase();
}
