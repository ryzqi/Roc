import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, McpServerConfig, PermissionsConfig, ProviderConfig } from '../../src/shared/types';
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
import { ConfigService } from '../../src/main/services/config-service';
import { McpService } from '../../src/main/services/mcp-service';
import { RocPaths } from '../../src/main/services/paths';

let root: string;
let paths: RocPaths;

function readSettingsDocument(): unknown {
  return JSON.parse(readFileSync(join(root, 'config', 'settings.json'), 'utf8')) as unknown;
}

function expectedPermissions(): PermissionsConfig {
  return {
    schemaVersion: 3,
    mode: 'fully_automatic',
    grants: []
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-config-test-'));
  paths = new RocPaths(root);
  paths.ensureTree();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});


describe('ConfigService unified settings document', () => {
  it('returns default task thresholds when settings.json omits task settings', () => {
    writeFileSync(
      join(root, 'config', 'settings.json'),
      `${JSON.stringify(
        {
          schemaVersion: 4,
          settings: {
            schemaVersion: 2,
            defaultWorkspace: null,
            startup: { openAtLogin: false, minimizeToTray: true },
            notifications: { lowDistraction: true },
            globalHotkey: null,
            memory: {
              candidateReviewMode: 'manual',
              warmRecallEnabled: true,
              sessionRetentionDays: 90,
              crossScopeRecall: 'explicit_only',
              coldAutoForgetDays: 90
            }
          },
          providers: defaultProviders,
          mcp: defaultMcpConfig,
          permissions: defaultPermissions,
          shortcuts: {
            schemaVersion: 1,
            shortcuts: []
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const configService = new ConfigService(paths);
    expect(
      () =>
        (
          configService as ConfigService & {
            getTaskSettings: () => {
              longRunningThresholds: { runningSeconds: number; toolCallCount: number; subagentCount: number };
              scheduler: { catchUpOnStartup: boolean; maxRegisteredTasks: number };
            };
          }
        ).initialize()
    ).not.toThrow();

    expect(
      (
        configService as ConfigService & {
          getTaskSettings: () => {
            longRunningThresholds: { runningSeconds: number; toolCallCount: number; subagentCount: number };
            scheduler: { catchUpOnStartup: boolean; maxRegisteredTasks: number };
          };
        }
      ).getTaskSettings()
    ).toEqual({
      longRunningThresholds: {
        runningSeconds: 90,
        toolCallCount: 8,
        subagentCount: 1
      },
      scheduler: {
        catchUpOnStartup: true,
        maxRegisteredTasks: 256
      }
    });

    expect(readSettingsDocument()).toMatchObject({
      settings: {
        tasks: defaultSettings.tasks
      }
    });
  });

  it('normalizes current settings documents by dropping obsolete disk-memory fields', () => {
    writeFileSync(
      join(root, 'config', 'settings.json'),
      `${JSON.stringify(
        {
          schemaVersion: 4,
          settings: {
            ...defaultSettings,
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
          providers: defaultProviders,
          mcp: defaultMcpConfig,
          permissions: defaultPermissions,
          shortcuts: {
            schemaVersion: 1,
            shortcuts: []
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const configService = new ConfigService(paths);
    configService.initialize();

    expect(configService.getSettings().memory).toEqual({
      charLimits: { user: 2048, agents: 1024, memory: 4096 },
      sessionRetentionDays: 30,
      securityScan: {
        promptInjection: false,
        credential: true,
        sshBackdoor: false,
        invisibleUnicode: true
      }
    });
    const persisted = readSettingsDocument() as { settings: { memory: unknown } };
    expect(persisted.settings.memory).toEqual({
      charLimits: { user: 2048, agents: 1024, memory: 4096 },
      sessionRetentionDays: 30,
      securityScan: {
        promptInjection: false,
        credential: true,
        sshBackdoor: false,
        invisibleUnicode: true
      }
    });
  });


  it('moves legacy server approval fields to default MCP approval mode during migration', () => {
    writeFileSync(
      join(root, 'config', 'settings.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        settings: {
          schemaVersion: 2,
          defaultWorkspace: null,
          startup: { openAtLogin: false, minimizeToTray: true },
          notifications: { lowDistraction: true },
          globalHotkey: null,
          memory: {
            candidateReviewMode: 'manual',
            warmRecallEnabled: true,
            sessionRetentionDays: 90,
            crossScopeRecall: 'explicit_only',
            coldAutoForgetDays: 90
          }
        },
        providers: {
          schemaVersion: 1,
          defaultModelId: null,
          providers: []
        },
        mcp: {
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
        },
        permissions: {
          schemaVersion: 2,
          defaultConfirmations: {
            workspaceOutsideWrite: 'never_confirm',
            gitPush: 'always_confirm',
            memoryDelete: 'never_confirm',
            workspaceOutsideShell: 'always_confirm'
          },
          grants: ['legacy-grant']
        },
        shortcuts: {
          schemaVersion: 1,
          shortcuts: []
        }
      }, null, 2)}\n`,
      'utf8'
    );

    const configService = new ConfigService(paths);
    configService.initialize();

    expect(configService.getMcpConfig()).toEqual({
      schemaVersion: 1,
      approvalMode: 'fully_automatic',
      servers: [
        expect.objectContaining({
          id: 'legacy-mcp'
        })
      ]
    });
    expect(configService.getMcpConfig().servers[0]).not.toHaveProperty('approvalMode');
    expect(configService.getPermissions()).toEqual({
      schemaVersion: 3,
      mode: 'fully_automatic',
      grants: []
    });
  });

  it('normalizes current MCP config without approvalMode to fully_automatic', () => {
    writeFileSync(
      join(root, 'config', 'settings.json'),
      `${JSON.stringify(
        {
          schemaVersion: 4,
          settings: defaultSettings,
          providers: defaultProviders,
          mcp: {
            schemaVersion: 1,
            servers: []
          },
          permissions: defaultPermissions,
          shortcuts: {
            schemaVersion: 1,
            shortcuts: []
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const configService = new ConfigService(paths);
    configService.initialize();

    expect(configService.getMcpConfig()).toEqual({
      schemaVersion: 1,
      approvalMode: 'fully_automatic',
      servers: []
    });
    expect(readSettingsDocument()).toMatchObject({
      mcp: {
        approvalMode: 'fully_automatic'
      }
    });
  });


  it('clears defaultModelId when saveSettingsSnapshot disables the provider that owns it', () => {
    const configService = new ConfigService(paths);
    configService.initialize();

    const provider: ProviderConfig = {
      id: 'provider-openai',
      name: 'Provider OpenAI',
      type: 'openai_compatible',
      endpoint: 'https://openai.example.test/v1',
      credentialRef: 'secret:provider-openai',
      enabled: false,
      models: [
        {
          id: 'provider-openai-model',
          displayName: 'Provider OpenAI Model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    };

    configService.saveSettingsSnapshot({
      settings: configService.getSettings(),
      providers: [provider],
      defaultModelId: 'provider-openai-model',
      permissions: configService.getPermissions()
    });

    expect(configService.getProviders()).toEqual({
      schemaVersion: 1,
      defaultModelId: null,
      providers: [
        expect.objectContaining({
          id: 'nvidia',
          type: 'nvidia',
          endpoint: 'https://integrate.api.nvidia.com/v1'
        }),
        expect.objectContaining({
          id: 'openrouter',
          type: 'openrouter',
          endpoint: 'https://openrouter.ai/api/v1',
          credentialRef: 'secret:openrouter'
        }),
        expect.objectContaining({
          id: 'llama_cpp',
          type: 'llama_cpp',
          endpoint: 'http://127.0.0.1:8081/v1',
          credentialRef: null
        }),
        provider
      ]
    });
    expect(readSettingsDocument()).toMatchObject({
      providers: {
        schemaVersion: 1,
        defaultModelId: null,
        providers: [
          expect.objectContaining({
            id: 'nvidia',
            type: 'nvidia',
            endpoint: 'https://integrate.api.nvidia.com/v1'
          }),
          expect.objectContaining({
            id: 'openrouter',
            type: 'openrouter',
            endpoint: 'https://openrouter.ai/api/v1',
            credentialRef: 'secret:openrouter'
          }),
          expect.objectContaining({
            id: 'llama_cpp',
            type: 'llama_cpp',
            endpoint: 'http://127.0.0.1:8081/v1',
            credentialRef: null
          }),
          provider
        ]
      }
    });
  });


  it('keeps the fixed llama.cpp provider normalized and restores its default config when deleted', () => {
    const configService = new ConfigService(paths);
    configService.initialize();

    configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'qwen3.5-4b',
      providers: [
        {
          id: 'llama_cpp',
          name: 'Custom llama.cpp',
          type: 'llama_cpp',
          endpoint: 'http://127.0.0.1:9090/v1',
          credentialRef: null,
          enabled: false,
          models: [
            {
              id: 'qwen3.5-4b',
              displayName: 'Qwen 3.5 4B',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    expect(configService.getProviders().providers).toEqual([
      expect.objectContaining({
        id: 'nvidia',
        type: 'nvidia',
        endpoint: 'https://integrate.api.nvidia.com/v1',
        credentialRef: 'secret:nvidia'
      }),
      expect.objectContaining({
        id: 'openrouter',
        type: 'openrouter',
        endpoint: 'https://openrouter.ai/api/v1',
        credentialRef: 'secret:openrouter'
      }),
      expect.objectContaining({
        id: 'llama_cpp',
        name: 'llama.cpp',
        type: 'llama_cpp',
        endpoint: 'http://127.0.0.1:9090/v1',
        credentialRef: null,
        enabled: false
      })
    ]);

    configService.deleteProvider('llama_cpp');

    expect(configService.getProviders()).toEqual({
      schemaVersion: 1,
      defaultModelId: null,
      providers: [
        expect.objectContaining({
          id: 'nvidia',
          type: 'nvidia',
          endpoint: 'https://integrate.api.nvidia.com/v1',
          credentialRef: 'secret:nvidia'
        }),
        expect.objectContaining({
          id: 'openrouter',
          type: 'openrouter',
          endpoint: 'https://openrouter.ai/api/v1',
          credentialRef: 'secret:openrouter'
        }),
        {
          id: 'llama_cpp',
          name: 'llama.cpp',
          type: 'llama_cpp',
          endpoint: 'http://127.0.0.1:8081/v1',
          credentialRef: null,
          enabled: true,
          models: []
        }
      ]
    });
  });

});

