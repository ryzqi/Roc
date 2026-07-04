import type { AppSettings, ApprovalMode, McpServersConfig, PermissionsConfig, ProvidersConfig, RocSettingsDocument, ShortcutsConfig } from '../../../shared/types';
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

function upgradeTaskSettings(raw: unknown): AppSettings['tasks'] {
  if (raw === null || typeof raw !== 'object') {
    return defaultSettings.tasks;
  }

  const value = raw as Record<string, unknown>;
  const longRunningThresholds =
    value.longRunningThresholds !== null && typeof value.longRunningThresholds === 'object'
      ? (value.longRunningThresholds as Record<string, unknown>)
      : {};
  const scheduler =
    value.scheduler !== null && typeof value.scheduler === 'object'
      ? (value.scheduler as Record<string, unknown>)
      : {};

  return {
    longRunningThresholds: {
      runningSeconds:
        typeof longRunningThresholds.runningSeconds === 'number' &&
        Number.isInteger(longRunningThresholds.runningSeconds) &&
        longRunningThresholds.runningSeconds >= 0
          ? longRunningThresholds.runningSeconds
          : defaultSettings.tasks.longRunningThresholds.runningSeconds,
      toolCallCount:
        typeof longRunningThresholds.toolCallCount === 'number' &&
        Number.isInteger(longRunningThresholds.toolCallCount) &&
        longRunningThresholds.toolCallCount >= 0
          ? longRunningThresholds.toolCallCount
          : defaultSettings.tasks.longRunningThresholds.toolCallCount,
      subagentCount:
        typeof longRunningThresholds.subagentCount === 'number' &&
        Number.isInteger(longRunningThresholds.subagentCount) &&
        longRunningThresholds.subagentCount >= 0
          ? longRunningThresholds.subagentCount
          : defaultSettings.tasks.longRunningThresholds.subagentCount
    },
    scheduler: {
      catchUpOnStartup:
        typeof scheduler.catchUpOnStartup === 'boolean'
          ? scheduler.catchUpOnStartup
          : defaultSettings.tasks.scheduler.catchUpOnStartup,
      maxRegisteredTasks:
        typeof scheduler.maxRegisteredTasks === 'number' &&
        Number.isInteger(scheduler.maxRegisteredTasks) &&
        scheduler.maxRegisteredTasks > 0
          ? scheduler.maxRegisteredTasks
          : defaultSettings.tasks.scheduler.maxRegisteredTasks
    }
  };
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function upgradeMemorySettings(raw: unknown): AppSettings['memory'] {
  if (raw === null || typeof raw !== 'object') {
    return defaultSettings.memory;
  }

  const value = raw as Record<string, unknown>;
  const charLimits =
    value.charLimits !== null && typeof value.charLimits === 'object'
      ? (value.charLimits as Record<string, unknown>)
      : {};
  const securityScan =
    value.securityScan !== null && typeof value.securityScan === 'object'
      ? (value.securityScan as Record<string, unknown>)
      : {};
  const autoMemory =
    value.autoMemory !== null && typeof value.autoMemory === 'object'
      ? (value.autoMemory as Record<string, unknown>)
      : {};

  return {
    charLimits: {
      user: readPositiveInteger(charLimits.user, defaultSettings.memory.charLimits.user),
      agents: readPositiveInteger(charLimits.agents, defaultSettings.memory.charLimits.agents),
      memory: readPositiveInteger(charLimits.memory, defaultSettings.memory.charLimits.memory)
    },
    sessionRetentionDays: readPositiveInteger(value.sessionRetentionDays, defaultSettings.memory.sessionRetentionDays),
    securityScan: {
      promptInjection: readBoolean(securityScan.promptInjection, defaultSettings.memory.securityScan.promptInjection),
      credential: readBoolean(securityScan.credential, defaultSettings.memory.securityScan.credential),
      sshBackdoor: readBoolean(securityScan.sshBackdoor, defaultSettings.memory.securityScan.sshBackdoor),
      invisibleUnicode: readBoolean(securityScan.invisibleUnicode, defaultSettings.memory.securityScan.invisibleUnicode)
    },
    autoMemory: {
      enabled: readBoolean(autoMemory.enabled, defaultSettings.memory.autoMemory.enabled),
      lowConfidenceTtlDays: readPositiveInteger(
        autoMemory.lowConfidenceTtlDays,
        defaultSettings.memory.autoMemory.lowConfidenceTtlDays
      ),
      auditRetentionDays: readPositiveInteger(
        autoMemory.auditRetentionDays,
        defaultSettings.memory.autoMemory.auditRetentionDays
      ),
      maxCandidatesPerRun: readPositiveInteger(
        autoMemory.maxCandidatesPerRun,
        defaultSettings.memory.autoMemory.maxCandidatesPerRun
      )
    }
  };
}

function upgradeLegacySettings(raw: unknown): AppSettings {
  if (raw === null || typeof raw !== 'object') {
    return defaultSettings;
  }
  const value = raw as Record<string, unknown>;
  const startup = (value.startup ?? {}) as Record<string, unknown>;

  return SettingsSchema.parse({
    schemaVersion: 2,
    defaultWorkspace: typeof value.defaultWorkspace === 'string' ? value.defaultWorkspace : null,
    startup: {
      openAtLogin: typeof startup.openAtLogin === 'boolean' ? startup.openAtLogin : false,
      minimizeToTray: typeof startup.minimizeToTray === 'boolean' ? startup.minimizeToTray : true
    },
    globalHotkey: typeof value.globalHotkey === 'string' && value.globalHotkey.length > 0 ? value.globalHotkey : null,
    memory: upgradeMemorySettings(value.memory),
    tasks: upgradeTaskSettings(value.tasks)
  });
}

function normalizeProviderModel(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if ('supportsImages' in record) {
    return record;
  }
  return {
    ...record,
    supportsImages: false
  };
}

function upgradeLegacyProviders(raw: unknown): ProvidersConfig {
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
              : null,
          models: Array.isArray(provider.models) ? provider.models.map(normalizeProviderModel) : []
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
  const approvalMode = readApprovalMode(value.approvalMode);
  const servers = Array.isArray(value.servers) ? value.servers : [];
  return McpServersConfigSchema.parse({
    schemaVersion: 1,
    approvalMode,
    servers: servers.map((entry) => {
      const server = entry as Record<string, unknown>;
      const { approvalMode: _approvalMode, ...rest } = server;
      return rest;
    })
  });
}

function readApprovalMode(value: unknown): ApprovalMode {
  if (value === 'fully_automatic' || value === 'default') {
    return value;
  }
  return defaultMcpConfig.approvalMode;
}

function upgradeLegacyPermissions(_raw: unknown): PermissionsConfig {
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

export function normalizeCurrentSettingsDocument(raw: Record<string, unknown>): RocSettingsDocument {
  return SettingsDocumentSchema.parse({
    ...raw,
    settings: upgradeLegacySettings(raw.settings),
    providers: upgradeLegacyProviders(raw.providers ?? defaultProviders),
    mcp: normalizeLegacyMcpConfig(raw.mcp),
    shortcuts: ShortcutsConfigSchema.parse((raw.shortcuts ?? defaultShortcuts) as ShortcutsConfig)
  });
}
