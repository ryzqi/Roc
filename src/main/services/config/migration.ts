import type { AppSettings, McpServersConfig, PermissionsConfig, ProvidersConfig, RocSettingsDocument, ShortcutsConfig } from '../../../shared/types';
import { defaultMcpConfig, defaultPermissions, defaultProviders, defaultSettings, defaultShortcuts } from './defaults';
import {
  McpServersConfigSchema,
  ProvidersSchema,
  SettingsSchema,
  SettingsDocumentSchema,
  ShortcutsConfigSchema,
  PROVIDER_CREDENTIAL_REF_PATTERN
} from './schema';
import { normalizeProvidersConfig } from './provider-rules';

export function isCurrentSettingsDocument(value: unknown): value is RocSettingsDocument {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { schemaVersion?: unknown };
  return record.schemaVersion === 4;
}

export function isLegacyUnifiedSettingsDocument(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { schemaVersion?: unknown; settings?: unknown; providers?: unknown };
  return (record.schemaVersion === 2 || record.schemaVersion === 3) && 'settings' in record && 'providers' in record;
}

export function upgradeColdAutoForget(value: unknown): AppSettings['memory']['coldAutoForgetDays'] {
  if (value === null) {
    return null;
  }
  if (value === 90 || value === 180 || value === 365) {
    return value;
  }
  return 90;
}

export function upgradeLegacySettings(raw: unknown): AppSettings {
  if (raw === null || typeof raw !== 'object') {
    return defaultSettings;
  }
  const value = raw as Record<string, unknown>;
  const startup = (value.startup ?? {}) as Record<string, unknown>;
  const notifications = (value.notifications ?? {}) as Record<string, unknown>;
  const memory = (value.memory ?? {}) as Record<string, unknown>;

  return SettingsSchema.parse({
    schemaVersion: 2,
    defaultWorkspace: typeof value.defaultWorkspace === 'string' ? value.defaultWorkspace : null,
    startup: {
      openAtLogin: typeof startup.openAtLogin === 'boolean' ? startup.openAtLogin : false,
      minimizeToTray: typeof startup.minimizeToTray === 'boolean' ? startup.minimizeToTray : true
    },
    notifications: {
      lowDistraction: typeof notifications.lowDistraction === 'boolean' ? notifications.lowDistraction : true
    },
    globalHotkey: typeof value.globalHotkey === 'string' && value.globalHotkey.length > 0 ? value.globalHotkey : null,
    memory: {
      candidateReviewMode: memory.candidateReviewMode === 'auto_after_approval' ? 'auto_after_approval' : 'manual',
      warmRecallEnabled: typeof memory.warmRecallEnabled === 'boolean' ? memory.warmRecallEnabled : true,
      sessionRetentionDays:
        memory.sessionRetentionDays === 30 || memory.sessionRetentionDays === 180
          ? (memory.sessionRetentionDays as 30 | 180)
          : 90,
      crossScopeRecall:
        memory.crossScopeRecall === 'expanded_with_label' ? 'expanded_with_label' : 'explicit_only',
      coldAutoForgetDays: upgradeColdAutoForget(memory.coldAutoForgetDays)
    },
    tasks: defaultSettings.tasks
  });
}

export function upgradeLegacyProviders(raw: unknown): ProvidersConfig {
  if (raw === null || typeof raw !== 'object') {
    return defaultProviders;
  }
  const value = raw as Record<string, unknown>;
  const providersList = Array.isArray(value.providers) ? value.providers : [];
  return normalizeProvidersConfig(
    ProvidersSchema.parse({
      schemaVersion: 1,
      defaultModelId: typeof value.defaultModelId === 'string' ? value.defaultModelId : null,
      providers: providersList.map((entry) => {
        const provider = entry as ProvidersConfig['providers'][number];
        const credentialRef = provider.credentialRef;
        return {
          ...provider,
          credentialRef:
            typeof credentialRef === 'string' && PROVIDER_CREDENTIAL_REF_PATTERN.test(credentialRef)
              ? credentialRef
              : null
        };
      })
    })
  );
}

export function normalizeLegacyMcpConfig(raw: unknown): McpServersConfig {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return defaultMcpConfig;
  }

  const value = raw as Record<string, unknown>;
  const servers = Array.isArray(value.servers) ? value.servers : [];
  return McpServersConfigSchema.parse({
    schemaVersion: 1,
    servers: servers.map((entry) => {
      const server = entry as Record<string, unknown>;
      const { approvalMode: _approvalMode, ...rest } = server;
      return rest;
    })
  });
}

export function upgradeLegacyPermissions(_raw: unknown): PermissionsConfig {
  return defaultPermissions;
}

export function migrateLegacySplitConfig(input: {
  rawSettings: unknown | undefined;
  legacyProviders: unknown | undefined;
  legacyMcp: unknown | undefined;
  legacyPermissions: unknown | undefined;
  legacyShortcuts: unknown | undefined;
}): RocSettingsDocument {
  const { rawSettings, legacyProviders, legacyMcp, legacyPermissions, legacyShortcuts } = input;
  return SettingsDocumentSchema.parse({
    schemaVersion: 4,
    settings: rawSettings === undefined ? defaultSettings : upgradeLegacySettings(rawSettings),
    providers: upgradeLegacyProviders(legacyProviders ?? defaultProviders),
    mcp: normalizeLegacyMcpConfig(legacyMcp),
    permissions: upgradeLegacyPermissions(legacyPermissions),
    shortcuts:
      legacyShortcuts === undefined ? defaultShortcuts : ShortcutsConfigSchema.parse(legacyShortcuts)
  });
}

export function migrateLegacyUnifiedDocument(raw: Record<string, unknown>): RocSettingsDocument {
  return SettingsDocumentSchema.parse({
    schemaVersion: 4,
    settings: upgradeLegacySettings(raw.settings),
    providers: upgradeLegacyProviders(raw.providers ?? defaultProviders),
    mcp: normalizeLegacyMcpConfig(raw.mcp),
    permissions: upgradeLegacyPermissions(raw.permissions),
    shortcuts: ShortcutsConfigSchema.parse((raw.shortcuts ?? defaultShortcuts) as ShortcutsConfig)
  });
}
