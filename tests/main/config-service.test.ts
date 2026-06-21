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

});
