import {
  createFixedLlamaCppProviderConfig,
  createFixedNvidiaProviderConfig
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
  notifications: {
    lowDistraction: true
  },
  globalHotkey: null,
  memory: {
    frozenSnapshotEnabled: true,
    userProfileEnabled: true,
    agentsRulesEnabled: true,
    charLimits: { user: 1375, agents: 800, memory: 2200 },
    sessionRetentionDays: 90,
    consolidatorEnabled: true,
    consolidatorDebounceMinutes: 10,
    consolidatorTargetRatio: 0.85,
    consolidatorDailyQuota: 50,
    preCompactionFlushEnabled: true,
    preCompactionTokenThreshold: 0.85,
    preCompactionContextWindowTokens: 200000,
    securityScan: {
      promptInjection: true,
      credential: true,
      sshBackdoor: true,
      invisibleUnicode: true
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
  providers: [createFixedNvidiaProviderConfig(), createFixedLlamaCppProviderConfig()]
};

export const defaultMcpConfig: McpServersConfig = {
  schemaVersion: 1,
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
