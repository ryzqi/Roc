import {
  appSettingsSchema,
  permissionsConfigSchema,
  providerConfigSchema,
  providersConfigSchema,
  settingsDocumentSchema,
  settingsSaveRequestSchema,
  shortcutsConfigSchema
} from '../../../shared/schemas/ipc-memory-settings';
import {
  mcpServerConfigSchema,
  mcpServersConfigSchema
} from '../../../shared/schemas/ipc-mcp-skills';

export const PROVIDER_CREDENTIAL_REF_PATTERN = /^secret:[A-Za-z0-9_-]+$/;

export const SettingsSchema = appSettingsSchema;
export const ProviderSchema = providerConfigSchema;
export const ProvidersSchema = providersConfigSchema;
export const McpServerSchema = mcpServerConfigSchema;
export const McpServersConfigSchema = mcpServersConfigSchema;
export const PermissionsConfigSchema = permissionsConfigSchema;
export const ShortcutsConfigSchema = shortcutsConfigSchema;
export const SettingsSaveRequestSchema = settingsSaveRequestSchema;
export const SettingsDocumentSchema = settingsDocumentSchema;
