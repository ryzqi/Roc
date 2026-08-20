import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultMcpConfig, defaultPermissions, defaultProviders, defaultSettings } from '../../src/main/services/config/defaults';
import {
  isCurrentSettingsDocument,
  isLegacyUnifiedSettingsDocument,
  migrateLegacySplitConfig,
  normalizeLegacyMcpConfig
} from '../../src/main/services/config/migration';
import {
  defaultModelStateForProviders,
  normalizeProvidersConfig
} from '../../src/main/services/config/provider-rules';
import { SettingsDocumentSchema } from '../../src/main/services/config/schema';
import { RocPaths } from '../../src/main/services/paths';

let root: string;
let paths: RocPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-config-test-'));
  paths = new RocPaths(root);
  paths.ensureTree();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});


describe('config helper modules', () => {
  it('exports defaults and schemas used by ConfigService', () => {
    expect(defaultSettings.memory.sessionRetentionDays).toBe(90);
    expect(defaultPermissions.mode).toBe('fully_automatic');
    expect(defaultProviders.providers.map((provider) => provider.id)).toEqual(['nvidia', 'openrouter', 'llama_cpp']);
    expect(defaultMcpConfig).toEqual({
      schemaVersion: 1,
      approvalMode: 'fully_automatic',
      servers: []
    });

    expect(
      SettingsDocumentSchema.parse({
        schemaVersion: 4,
        settings: defaultSettings,
        providers: defaultProviders,
        mcp: defaultMcpConfig,
        permissions: defaultPermissions,
        shortcuts: {
          schemaVersion: 1,
          shortcuts: []
        }
      })
    ).toMatchObject({
      schemaVersion: 4,
      settings: defaultSettings
    });
  });


  it('normalizes fixed providers and derives default-model state via provider rules helpers', () => {
    const normalized = normalizeProvidersConfig({
      schemaVersion: 1,
      defaultModelId: 'custom-provider:custom-model',
      providers: [
        {
          id: 'custom-provider',
          name: 'Custom Provider',
          type: 'openai_compatible',
          endpoint: 'https://custom.example.test/v1',
          credentialRef: 'secret:custom-provider',
          enabled: false,
          models: [
            {
              id: 'custom-model',
              displayName: 'Custom Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ]
        }
      ]
    });

    expect(normalized.providers.map((provider) => provider.id)).toEqual([
      'nvidia',
      'openrouter',
      'llama_cpp',
      'custom-provider'
    ]);
    expect(normalized.defaultModelId).toBeNull();
    expect(defaultModelStateForProviders(normalized)).toEqual({
      status: 'missing',
      modelId: null,
      providerId: null,
      reason: '未配置默认模型。'
    });
  });


  it('resolves provider-qualified default model keys when model ids overlap', () => {
    const state = defaultModelStateForProviders({
      schemaVersion: 1,
      defaultModelId: 'second-provider:shared-model',
      providers: [
        {
          id: 'first-provider',
          name: 'First Provider',
          type: 'openai_compatible',
          endpoint: 'https://first.example.test/v1',
          credentialRef: 'secret:first-provider',
          enabled: true,
          models: [
            {
              id: 'shared-model',
              displayName: 'Shared Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: true
            }
          ]
        },
        {
          id: 'second-provider',
          name: 'Second Provider',
          type: 'openai_compatible',
          endpoint: 'https://second.example.test/v1',
          credentialRef: 'secret:second-provider',
          enabled: true,
          models: [
            {
              id: 'shared-model',
              displayName: 'Shared Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ]
        }
      ]
    });

    expect(state).toEqual({
      status: 'ready',
      modelId: 'shared-model',
      providerId: 'second-provider',
      reason: '默认模型可用。'
    });
  });

  it('clears stale default model ids for removed models', () => {
    const provider = {
      id: 'custom-provider',
      name: 'Custom Provider',
      type: 'openai_compatible' as const,
      endpoint: 'https://custom.example.test/v1',
      credentialRef: 'secret:custom-provider',
      enabled: true,
      models: [
        {
          id: 'other-model',
          displayName: 'Other Model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true,
          supportsImages: false
        }
      ]
    };

    expect(
      normalizeProvidersConfig({
        schemaVersion: 1,
        defaultModelId: 'custom-provider:removed-model',
        providers: [provider]
      }).defaultModelId
    ).toBeNull();
  });


  it('detects legacy/current settings documents and migrates legacy MCP fields via migration helpers', () => {
    expect(isCurrentSettingsDocument({ schemaVersion: 4 })).toBe(true);
    expect(
      isLegacyUnifiedSettingsDocument({
        schemaVersion: 3,
        settings: {},
        providers: {}
      })
    ).toBe(true);

    expect(
      normalizeLegacyMcpConfig({
        schemaVersion: 1,
        servers: [
          {
            id: 'legacy-mcp',
            name: 'Legacy MCP',
            enabled: true,
            transport: 'http',
            preset: false,
            riskLevel: 'medium',
            url: 'https://legacy.example.test/mcp',
            allowedTools: ['search_docs'],
            approvalMode: 'always_confirm'
          }
        ]
      })
    ).toEqual({
      schemaVersion: 1,
      approvalMode: 'fully_automatic',
      servers: [
        {
          id: 'legacy-mcp',
          name: 'Legacy MCP',
          enabled: true,
          transport: 'http',
          preset: false,
          riskLevel: 'medium',
          url: 'https://legacy.example.test/mcp',
          allowedTools: ['search_docs']
        }
      ]
    });

    expect(
      migrateLegacySplitConfig({
        rawSettings: undefined,
        legacyProviders: undefined,
        legacyMcp: undefined,
        legacyPermissions: undefined,
        legacyShortcuts: undefined
      })
    ).toMatchObject({
      schemaVersion: 4,
      settings: defaultSettings,
      providers: defaultProviders,
      mcp: defaultMcpConfig,
      permissions: defaultPermissions
    });
  });

  it('drops obsolete disk-memory settings during legacy migration', () => {
    const migrated = migrateLegacySplitConfig({
      rawSettings: {
        schemaVersion: 2,
        defaultWorkspace: null,
        startup: { openAtLogin: false, minimizeToTray: true },
        globalHotkey: null,
        memory: {
          frozenSnapshotEnabled: false,
          userProfileEnabled: false,
          agentsRulesEnabled: false,
          charLimits: { user: 2048, agents: 1024, memory: 4096 },
          sessionRetentionDays: 30,
          consolidatorEnabled: false,
          consolidatorDebounceMinutes: 3,
          consolidatorTargetRatio: 0.5,
          consolidatorDailyQuota: 2,
          preCompactionFlushEnabled: false,
          preCompactionTokenThreshold: 0.5,
          preCompactionContextWindowTokens: 64000,
          securityScan: {
            promptInjection: false,
            credential: true,
            sshBackdoor: false,
            invisibleUnicode: true
          }
        }
      },
      legacyProviders: undefined,
      legacyMcp: undefined,
      legacyPermissions: undefined,
      legacyShortcuts: undefined
    });

    expect(migrated.settings.memory).toEqual({
      charLimits: { user: 2048, agents: 1024, memory: 4096 },
      sessionRetentionDays: 30,
      securityScan: {
        promptInjection: false,
        credential: true,
        sshBackdoor: false,
        invisibleUnicode: true
      },
      autoMemory: {
        enabled: true,
        lowConfidenceTtlDays: 30,
        auditRetentionDays: 30,
        maxCandidatesPerRun: 8
      }
    });
  });

  it('backfills model image support during legacy provider migration', () => {
    const migrated = migrateLegacySplitConfig({
      rawSettings: undefined,
      legacyProviders: {
        schemaVersion: 1,
        defaultModelId: 'legacy-model',
        providers: [
          {
            id: 'legacy-provider',
            name: 'Legacy Provider',
            type: 'openai_compatible',
            endpoint: 'https://legacy.example.test/v1',
            credentialRef: 'secret:legacy-provider',
            enabled: true,
            models: [
              {
                id: 'legacy-model',
                displayName: 'Legacy Model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true,
                supportsImages: false
              }
            ]
          }
        ]
      },
      legacyMcp: undefined,
      legacyPermissions: undefined,
      legacyShortcuts: undefined
    });

    expect(migrated.providers.providers.find((provider) => provider.id === 'legacy-provider')?.models[0]).toMatchObject({
      id: 'legacy-model',
      supportsImages: false
    });
  });
});
