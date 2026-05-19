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
    candidateReviewMode: 'manual',
    warmRecallEnabled: true,
    sessionRetentionDays: 90,
    crossScopeRecall: 'explicit_only',
    coldAutoForgetDays: 90
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
