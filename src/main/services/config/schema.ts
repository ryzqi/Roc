import {
  appSettingsSchema,
  permissionsConfigSchema,
  providerConfigSchema,
  providersConfigSchema,
  settingsDocumentSchema,
  settingsSaveRequestSchema
} from '../../../shared/schemas/ipc-memory-settings';
import { mcpServersConfigSchema } from '../../../shared/schemas/ipc-mcp-skills';

export const SettingsSchema = appSettingsSchema;
export const ProviderSchema = providerConfigSchema;
export const ProvidersSchema = providersConfigSchema;
export const McpServersConfigSchema = mcpServersConfigSchema;
export const PermissionsConfigSchema = permissionsConfigSchema;
export const SettingsSaveRequestSchema = settingsSaveRequestSchema;
export const SettingsDocumentSchema = settingsDocumentSchema;
