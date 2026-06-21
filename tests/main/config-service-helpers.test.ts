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

