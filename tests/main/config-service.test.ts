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
  it('saves and reads the unified settings document asynchronously', async () => {
    const configService = new ConfigService(paths);
    configService.initialize();
    const nextSettings = {
      ...defaultSettings,
      globalHotkey: 'Ctrl+Alt+R'
    };

    const saved = await configService.saveSettingsSnapshotAsync({
      settings: nextSettings,
      providers: defaultProviders.providers,
      defaultModelId: defaultProviders.defaultModelId,
      permissions: expectedPermissions()
    });

    await expect(configService.getSettingsAsync()).resolves.toMatchObject({
      globalHotkey: 'Ctrl+Alt+R'
    });
    await expect(configService.getProvidersAsync()).resolves.toMatchObject({
      providers: defaultProviders.providers,
      defaultModelId: defaultProviders.defaultModelId
    });
    await expect(configService.getPermissionsAsync()).resolves.toEqual(expectedPermissions());
    expect(saved).toMatchObject({
      settings: {
        globalHotkey: 'Ctrl+Alt+R'
      },
      defaultModelId: defaultProviders.defaultModelId,
      permissions: expectedPermissions()
    });

    await configService.saveSettingsAsync({
      ...nextSettings,
      globalHotkey: 'Ctrl+Shift+R'
    });
    await expect(configService.getSettingsAsync()).resolves.toMatchObject({
      globalHotkey: 'Ctrl+Shift+R'
    });
  });

  it('reuses fresh async settings reads from cache until the cache expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-04T00:00:00.000Z'));
    const configService = new ConfigService(paths);
    configService.initialize();

    const firstSettings = await configService.getSettingsAsync();
    const document = SettingsDocumentSchema.parse(readSettingsDocument());
    const externallyChangedDocument = {
      ...document,
      settings: {
        ...document.settings,
        globalHotkey: 'Ctrl+Alt+External'
      }
    };
    writeFileSync(join(root, 'config', 'settings.json'), `${JSON.stringify(externallyChangedDocument, null, 2)}\n`, 'utf8');

    await expect(configService.getSettingsAsync()).resolves.toMatchObject({
      globalHotkey: firstSettings.globalHotkey
    });

    vi.setSystemTime(new Date('2026-06-04T00:00:06.000Z'));

    await expect(configService.getSettingsAsync()).resolves.toMatchObject({
      globalHotkey: 'Ctrl+Alt+External'
    });
  });

  it('returns defensive copies from the fresh settings cache', async () => {
    const configService = new ConfigService(paths);
    configService.initialize();

    const firstSettings = await configService.getSettingsAsync();
    firstSettings.globalHotkey = 'Ctrl+Alt+Mutated';

    await expect(configService.getSettingsAsync()).resolves.toMatchObject({
      globalHotkey: defaultSettings.globalHotkey
    });
  });

  it('migrates legacy v1 split config files into schemaVersion 4 settings.json with safeStorage credentials', () => {
    const legacyV1Settings = {
      schemaVersion: 1 as const,
      defaultWorkspace: 'F:\\Code\\Roc',
      startup: {
        openAtLogin: true,
        minimizeToTray: false
      },
      notifications: {
        lowDistraction: false
      },
      memory: {
        candidateReviewMode: 'manual' as const,
        warmRecallEnabled: false
      }
    };
    const legacyProviders = {
      schemaVersion: 1 as const,
      defaultModelId: 'provider-openai-model',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI Provider',
          type: 'openai_compatible',
          endpoint: 'https://openai.example.test/v1',
          credentialRef: 'env:OPENAI_KEY',
          enabled: true,
          models: [
            {
              id: 'provider-openai-model',
              displayName: 'Provider OpenAI Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    };
    const legacyMcp = {
      schemaVersion: 1 as const,
      servers: [
        {
          id: 'docs-http',
          name: 'Docs HTTP',
          enabled: true,
          transport: 'http' as const,
          preset: false,
          riskLevel: 'medium' as const,
          url: 'https://docs.example.test/mcp',
          allowedTools: ['search_docs'],
          approvalMode: 'always_confirm' as const
        }
      ]
    };

    writeFileSync(join(root, 'config', 'settings.json'), `${JSON.stringify(legacyV1Settings, null, 2)}\n`, 'utf8');
    writeFileSync(join(root, 'config', 'providers.json'), `${JSON.stringify(legacyProviders, null, 2)}\n`, 'utf8');
    writeFileSync(join(root, 'config', 'mcp.servers.json'), `${JSON.stringify(legacyMcp, null, 2)}\n`, 'utf8');
    writeFileSync(
      join(root, 'config', 'permissions.json'),
      `${JSON.stringify({ schemaVersion: 1, grants: ['shell.execute'] }, null, 2)}\n`,
      'utf8'
    );
    writeFileSync(
      join(root, 'config', 'shortcuts.json'),
      `${JSON.stringify({ schemaVersion: 1, shortcuts: ['Ctrl+Shift+K'] }, null, 2)}\n`,
      'utf8'
    );

    const configService = new ConfigService(paths);
    configService.initialize();

    const document = readSettingsDocument() as Record<string, unknown>;
    expect(document.schemaVersion).toBe(4);
    expect(document.settings).toMatchObject({
      schemaVersion: 2,
      defaultWorkspace: 'F:\\Code\\Roc',
      startup: { openAtLogin: true, minimizeToTray: false },
      notifications: { lowDistraction: false },
      globalHotkey: null,
      memory: defaultSettings.memory
    });
    expect(document.providers).toMatchObject({
      schemaVersion: 1,
      defaultModelId: 'provider-openai-model'
    });
    expect((document.providers as { providers: unknown[] }).providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'nvidia',
          type: 'nvidia',
          endpoint: 'https://integrate.api.nvidia.com/v1',
          credentialRef: 'secret:nvidia'
        }),
        expect.objectContaining({
          id: 'llama_cpp',
          type: 'llama_cpp',
          endpoint: 'http://127.0.0.1:8081/v1',
          credentialRef: null
        }),
        expect.objectContaining({
          id: 'provider-openai',
          name: 'OpenAI Provider',
          credentialRef: null
        })
      ])
    );
    expect(document.permissions).toEqual({
      schemaVersion: 3,
      mode: 'fully_automatic',
      grants: []
    });
    expect(configService.getProviders().providers.find((provider) => provider.id === 'provider-openai')?.credentialRef).toBeNull();
  });

  it('keeps legacy v2 unified document credentials only when they reference safeStorage secrets', () => {
    const legacyV2: Record<string, unknown> = {
      schemaVersion: 2,
      settings: {
        schemaVersion: 1,
        defaultWorkspace: null,
        startup: { openAtLogin: false, minimizeToTray: true },
        notifications: { lowDistraction: true },
        memory: { candidateReviewMode: 'manual', warmRecallEnabled: true }
      },
      providers: {
        schemaVersion: 1,
        defaultModelId: 'kept-model',
        providers: [
          {
            id: 'kept-provider',
            name: 'Kept',
            type: 'openai_compatible',
            endpoint: 'https://kept.example.test/v1',
            credentialRef: 'secret:kept-provider',
            enabled: true,
            models: [
              {
                id: 'kept-model',
                displayName: 'Kept Model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          },
          {
            id: 'legacy-env',
            name: 'Legacy env provider',
            type: 'anthropic_compatible',
            endpoint: 'https://legacy.example.test/v1',
            credentialRef: 'env:LEGACY_KEY',
            enabled: true,
            models: [
              {
                id: 'legacy-model',
                displayName: 'Legacy',
                enabled: true,
                supportsStreaming: false,
                supportsToolCalls: false
              }
            ]
          }
        ]
      },
      mcp: {
        schemaVersion: 1,
        servers: []
      },
      permissions: {
        schemaVersion: 1,
        grants: ['shell.execute']
      },
      shortcuts: {
        schemaVersion: 1,
        shortcuts: []
      }
    };

    writeFileSync(join(root, 'config', 'settings.json'), `${JSON.stringify(legacyV2, null, 2)}\n`, 'utf8');

    const configService = new ConfigService(paths);
    configService.initialize();
    const providers = configService.getProviders().providers;

    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'nvidia',
          credentialRef: 'secret:nvidia',
          endpoint: 'https://integrate.api.nvidia.com/v1'
        }),
        expect.objectContaining({
          id: 'llama_cpp',
          credentialRef: null,
          endpoint: 'http://127.0.0.1:8081/v1'
        }),
        expect.objectContaining({ id: 'kept-provider', credentialRef: 'secret:kept-provider' }),
        expect.objectContaining({ id: 'legacy-env', credentialRef: null })
      ])
    );
    expect(configService.getPermissions()).toEqual(expectedPermissions());
    expect(configService.getSettings().memory).toEqual(defaultSettings.memory);
  });

  it('persists providers and mcp servers into the unified settings document on fresh roots', () => {
    const configService = new ConfigService(paths);
    configService.initialize();
    const mcpService = new McpService(configService);
    const provider: ProviderConfig = {
      id: 'provider-anthropic',
      name: 'Anthropic Provider',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic.example.test/v1',
      credentialRef: 'secret:provider-anthropic',
      enabled: true,
      models: [
        {
          id: 'anthropic-model',
          displayName: 'Anthropic Model',
          enabled: true,
          supportsStreaming: false,
          supportsToolCalls: false
        }
      ]
    };
    const mcpServer: McpServerConfig = {
      id: 'exa-hosted',
      name: 'Exa Hosted MCP',
      enabled: true,
      transport: 'http',
      preset: true,
      riskLevel: 'medium',
      url: 'https://mcp.exa.ai/mcp',
      allowedTools: ['web_search_exa']
    };

    configService.upsertProvider(provider);
    configService.setDefaultModel('anthropic-model');
    mcpService.upsertServer(mcpServer);

    expect(readSettingsDocument()).toMatchObject({
      schemaVersion: 4,
      providers: {
        defaultModelId: 'anthropic-model',
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
      },
      mcp: {
        servers: [mcpServer]
      },
      permissions: expectedPermissions()
    });
    expect(existsSync(join(root, 'config', 'providers.json'))).toBe(false);
    expect(existsSync(join(root, 'config', 'mcp.servers.json'))).toBe(false);
  });

  it('rejects providers with non-secret credential references on save', () => {
    const configService = new ConfigService(paths);
    configService.initialize();
    expect(() =>
      configService.upsertProvider({
        id: 'env-provider',
        name: 'env provider',
        type: 'openai_compatible',
        endpoint: 'https://env.example.test/v1',
        credentialRef: 'env:OPENAI_KEY',
        enabled: true,
        models: [
          {
            id: 'env-model',
            displayName: 'env',
            enabled: true,
            supportsStreaming: true,
            supportsToolCalls: true
          }
        ]
      } as ProviderConfig)
    ).toThrow();
  });

  it('persists approval mode and language preferences via saveSettingsSnapshot', () => {
    const configService = new ConfigService(paths);
    configService.initialize();

    const settings: AppSettings = {
      schemaVersion: 2,
      defaultWorkspace: null,
      startup: { openAtLogin: true, minimizeToTray: true },
      notifications: { lowDistraction: false },
      globalHotkey: 'Ctrl+Alt+R',
      memory: {
        ...defaultSettings.memory,
        frozenSnapshotEnabled: false,
        sessionRetentionDays: 30,
        consolidatorTargetRatio: 0.75
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

    configService.saveSettingsSnapshot({
      settings,
      providers: [],
      defaultModelId: null,
      permissions: {
        schemaVersion: 3,
        mode: 'default',
        grants: []
      } as PermissionsConfig
    });

    const stored = configService.getSettings();
    const permissions = configService.getPermissions();
    expect(stored).toEqual(settings);
    expect(permissions).toEqual({
      schemaVersion: 3,
      mode: 'default',
      grants: []
    });
  });

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

  it('drops legacy MCP approval mode fields and resets permissions to fully_automatic during migration', () => {
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

  it('persists OpenAI-compatible and Anthropic-compatible advanced provider options through the unified settings document', () => {
    const configService = new ConfigService(paths);
    configService.initialize();

    configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'gpt-openai-1',
      providers: [
        {
          id: 'openai-advanced',
          name: 'OpenAI Advanced',
          type: 'openai_compatible',
          endpoint: 'https://openai.example.test/v1',
          credentialRef: 'secret:openai-advanced',
          enabled: true,
          models: [
            {
              id: 'gpt-openai-1',
              displayName: 'GPT OpenAI 1',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            temperature: 0.2,
            maxTokens: 2048,
            topP: 0.8,
            frequencyPenalty: 0.3,
            presencePenalty: 0.1,
            stop: ['DONE'],
            seed: 7,
            organization: 'org-roc-config',
            useResponsesApi: true,
            reasoning: {
              effort: 'high',
              summary: 'concise'
            },
            streamUsage: false,
            parallelToolCalls: true,
            serviceTier: 'priority',
            timeoutMs: 15_000,
            verbosity: 'medium',
            zdrEnabled: true,
            defaultHeaders: {
              'x-client': 'roc'
            },
            modelKwargs: {
              chat_template_kwargs: {
                enable_thinking: true
              }
            }
          } as ProviderConfig['options']
        },
        {
          id: 'anthropic-advanced',
          name: 'Anthropic Advanced',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-advanced',
          enabled: true,
          models: [
            {
              id: 'claude-advanced-1',
              displayName: 'Claude Advanced 1',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            temperature: 0.1,
            maxTokens: 4096,
            topP: 0.85,
            topK: 12,
            stop: ['\n\nHuman:'],
            streamUsage: false,
            timeoutMs: 22_000,
            defaultHeaders: {
              'x-tenant': 'east'
            },
            anthropicThinking: {
              mode: 'adaptive'
            }
          }
        }
      ]
    });

    expect(configService.getProviders().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openai-advanced',
          options: {
            temperature: 0.2,
            maxTokens: 2048,
            topP: 0.8,
            frequencyPenalty: 0.3,
            presencePenalty: 0.1,
            stop: ['DONE'],
            seed: 7,
            organization: 'org-roc-config',
            useResponsesApi: true,
            reasoning: {
              effort: 'high',
              summary: 'concise'
            },
            streamUsage: false,
            parallelToolCalls: true,
            serviceTier: 'priority',
            timeoutMs: 15_000,
            verbosity: 'medium',
            zdrEnabled: true,
            defaultHeaders: {
              'x-client': 'roc'
            },
            modelKwargs: {
              chat_template_kwargs: {
                enable_thinking: true
              }
            }
          }
        }),
        expect.objectContaining({
          id: 'anthropic-advanced',
          options: {
            temperature: 0.1,
            maxTokens: 4096,
            topP: 0.85,
            topK: 12,
            stop: ['\n\nHuman:'],
            streamUsage: false,
            timeoutMs: 22_000,
            defaultHeaders: {
              'x-tenant': 'east'
            },
            anthropicThinking: {
              mode: 'adaptive'
            }
          }
        })
      ])
    );

    expect(readSettingsDocument()).toMatchObject({
      providers: {
        defaultModelId: 'gpt-openai-1',
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'openai-advanced',
            options: expect.objectContaining({
              defaultHeaders: {
                'x-client': 'roc'
              },
              organization: 'org-roc-config',
              useResponsesApi: true,
              reasoning: {
                effort: 'high',
                summary: 'concise'
              },
              serviceTier: 'priority',
              timeoutMs: 15_000,
              verbosity: 'medium',
              zdrEnabled: true,
              modelKwargs: {
                chat_template_kwargs: {
                  enable_thinking: true
                }
              }
            })
          }),
          expect.objectContaining({
            id: 'anthropic-advanced',
            options: expect.objectContaining({
              defaultHeaders: {
                'x-tenant': 'east'
              },
              anthropicThinking: {
                mode: 'adaptive'
              }
            })
          })
        ])
      }
    });
  });

  it('rejects persisted Anthropic thinking configs that violate the official budget contract', () => {
    const configService = new ConfigService(paths);
    configService.initialize();

    let missingBudgetError: unknown;
    try {
      configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'claude-invalid-missing-budget',
        providers: [
          {
            id: 'anthropic-invalid-missing-budget',
            name: 'Anthropic Invalid Missing Budget',
            type: 'anthropic_compatible',
            endpoint: 'https://anthropic.example.test',
            credentialRef: 'secret:anthropic-invalid-missing-budget',
            enabled: true,
            models: [
              {
                id: 'claude-invalid-missing-budget',
                displayName: 'Claude Invalid Missing Budget',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ],
            options: {
              maxTokens: 4096,
              anthropicThinking: {
                mode: 'enabled'
              }
            }
          }
        ]
      } as unknown as Parameters<ConfigService['saveProviders']>[0]);
    } catch (error) {
      missingBudgetError = error;
    }

    expect(missingBudgetError).toBeInstanceOf(ZodError);
    expect((missingBudgetError as ZodError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['providers', 0, 'options', 'anthropicThinking']
        })
      ])
    );

    let tooSmallBudgetError: unknown;
    try {
      configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'claude-invalid-small-budget',
        providers: [
          {
            id: 'anthropic-invalid-small-budget',
            name: 'Anthropic Invalid Small Budget',
            type: 'anthropic_compatible',
            endpoint: 'https://anthropic.example.test',
            credentialRef: 'secret:anthropic-invalid-small-budget',
            enabled: true,
            models: [
              {
                id: 'claude-invalid-small-budget',
                displayName: 'Claude Invalid Small Budget',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ],
            options: {
              maxTokens: 4096,
              anthropicThinking: {
                mode: 'enabled',
                budgetTokens: 1023
              }
            }
          }
        ]
      });
    } catch (error) {
      tooSmallBudgetError = error;
    }

    expect(tooSmallBudgetError).toBeInstanceOf(ZodError);
    expect((tooSmallBudgetError as ZodError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['providers', 0, 'options', 'anthropicThinking', 'budgetTokens']
        })
      ])
    );

    let oversizedBudgetError: unknown;
    try {
      configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'claude-invalid-oversized-budget',
        providers: [
          {
            id: 'anthropic-invalid-oversized-budget',
            name: 'Anthropic Invalid Oversized Budget',
            type: 'anthropic_compatible',
            endpoint: 'https://anthropic.example.test',
            credentialRef: 'secret:anthropic-invalid-oversized-budget',
            enabled: true,
            models: [
              {
                id: 'claude-invalid-oversized-budget',
                displayName: 'Claude Invalid Oversized Budget',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ],
            options: {
              maxTokens: 2048,
              anthropicThinking: {
                mode: 'enabled',
                budgetTokens: 2048
              }
            }
          }
        ]
      });
    } catch (error) {
      oversizedBudgetError = error;
    }

    expect(oversizedBudgetError).toBeInstanceOf(ZodError);
    expect((oversizedBudgetError as ZodError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['providers', 0, 'options', 'anthropicThinking', 'budgetTokens']
        })
      ])
    );
  });

  it('persists explicit Anthropic disabled thinking configs through the unified settings document', () => {
    const configService = new ConfigService(paths);
    configService.initialize();

    configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'claude-disabled-thinking',
      providers: [
        {
          id: 'anthropic-disabled-thinking',
          name: 'Anthropic Disabled Thinking',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-disabled-thinking',
          enabled: true,
          models: [
            {
              id: 'claude-disabled-thinking',
              displayName: 'Claude Disabled Thinking',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            anthropicThinking: {
              mode: 'disabled'
            }
          }
        }
      ]
    });

    expect(configService.getProviders().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'anthropic-disabled-thinking',
          options: {
            anthropicThinking: {
              mode: 'disabled'
            }
          }
        })
      ])
    );

    expect(readSettingsDocument()).toMatchObject({
      providers: {
        defaultModelId: 'claude-disabled-thinking',
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'anthropic-disabled-thinking',
            options: {
              anthropicThinking: {
                mode: 'disabled'
              }
            }
          })
        ])
      }
    });
  });
});

describe('config helper modules', () => {
  it('exports defaults and schemas used by ConfigService', () => {
    expect(defaultSettings.memory.sessionRetentionDays).toBe(90);
    expect(defaultPermissions.mode).toBe('fully_automatic');
    expect(defaultProviders.providers.map((provider) => provider.id)).toEqual(['nvidia', 'openrouter', 'llama_cpp']);
    expect(defaultMcpConfig).toEqual({
      schemaVersion: 1,
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
      defaultModelId: 'custom-model',
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
              supportsToolCalls: true
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
});
