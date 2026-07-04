import {
  createFixedLlamaCppProviderConfig,
  createFixedNvidiaProviderConfig,
  createFixedOpenRouterProviderConfig
} from '../../../shared/provider-defaults';
import type {
  AppSettings,
  McpServersConfig,
  PermissionsConfig,
  ProvidersConfig,
  ShortcutsConfig
} from '../../../shared/types';

export const defaultSettings: AppSettings = {
  schemaVersion: 2,
  defaultWorkspace: null,
  startup: {
    openAtLogin: false,
    minimizeToTray: true
  },
  globalHotkey: null,
  memory: {
    charLimits: { user: 1375, agents: 800, memory: 2200 },
    sessionRetentionDays: 90,
    securityScan: {
      promptInjection: true,
      credential: true,
      sshBackdoor: true,
      invisibleUnicode: true
    },
    autoMemory: {
      enabled: true,
      lowConfidenceTtlDays: 30,
      auditRetentionDays: 30,
      maxCandidatesPerRun: 8
    }
  },
  tasks: {
    longRunningThresholds: {
      runningSeconds: 90,
      toolCallCount: 8,
      subagentCount: 1
    },
    scheduler: {
      catchUpOnStartup: true,
      maxRegisteredTasks: 256
    }
  }
};

export const defaultProviders: ProvidersConfig = {
  schemaVersion: 1,
  defaultModelId: null,
  providers: [createFixedNvidiaProviderConfig(), createFixedOpenRouterProviderConfig(), createFixedLlamaCppProviderConfig()]
};

export const defaultMcpConfig: McpServersConfig = {
  schemaVersion: 1,
  approvalMode: 'fully_automatic',
  servers: []
};

export const defaultPermissions: PermissionsConfig = {
  schemaVersion: 3,
  mode: 'fully_automatic',
  grants: []
};

export const defaultShortcuts: ShortcutsConfig = {
  schemaVersion: 1,
  shortcuts: []
};
