import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../../src/main/services/config-service';
import { defaultSettings } from '../../src/main/services/config/defaults';
import { McpService } from '../../src/main/services/mcp-service';
import { RocPaths } from '../../src/main/services/paths';
import type { AppSettings, McpServerConfig, PermissionsConfig, ProviderConfig } from '../../src/shared/types';

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
        sessionRetentionDays: 30
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

});

