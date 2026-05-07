import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings, McpServerConfig, ProviderConfig } from '../../src/shared/types';
import { ConfigService } from '../../src/main/services/config-service';
import { McpService } from '../../src/main/services/mcp-service';
import { RocPaths } from '../../src/main/services/paths';

let root: string;
let paths: RocPaths;

function readSettingsDocument(): unknown {
  return JSON.parse(readFileSync(join(root, 'config', 'settings.json'), 'utf8')) as unknown;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-config-test-'));
  paths = new RocPaths(root);
  paths.ensureTree();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ConfigService unified settings document', () => {
  it('migrates legacy split config files into schemaVersion 2 settings.json', () => {
    const legacySettings: AppSettings = {
      schemaVersion: 1,
      defaultWorkspace: 'F:\\Code\\Roc',
      startup: {
        openAtLogin: true,
        minimizeToTray: false
      },
      notifications: {
        lowDistraction: false
      },
      appearance: {
        theme: 'light'
      },
      memory: {
        candidateReviewMode: 'manual',
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
          transport: 'http',
          preset: false,
          riskLevel: 'medium',
          url: 'https://docs.example.test/mcp',
          allowedTools: ['search_docs']
        }
      ]
    };

    writeFileSync(join(root, 'config', 'settings.json'), `${JSON.stringify(legacySettings, null, 2)}\n`, 'utf8');
    writeFileSync(join(root, 'config', 'providers.json'), `${JSON.stringify(legacyProviders, null, 2)}\n`, 'utf8');
    writeFileSync(join(root, 'config', 'mcp.servers.json'), `${JSON.stringify(legacyMcp, null, 2)}\n`, 'utf8');
    writeFileSync(join(root, 'config', 'permissions.json'), `${JSON.stringify({ schemaVersion: 1, grants: ['shell.execute'] }, null, 2)}\n`, 'utf8');
    writeFileSync(join(root, 'config', 'shortcuts.json'), `${JSON.stringify({ schemaVersion: 1, shortcuts: ['Ctrl+Shift+K'] }, null, 2)}\n`, 'utf8');

    const configService = new ConfigService(paths);
    configService.initialize();

    expect(readSettingsDocument()).toEqual({
      schemaVersion: 2,
      settings: legacySettings,
      providers: legacyProviders,
      mcp: legacyMcp,
      permissions: {
        schemaVersion: 1,
        grants: ['shell.execute']
      },
      shortcuts: {
        schemaVersion: 1,
        shortcuts: ['Ctrl+Shift+K']
      }
    });
    expect(configService.getSettings()).toEqual(legacySettings);
    expect(configService.getProviders()).toEqual(legacyProviders);
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
      credentialRef: 'env:ANTHROPIC_KEY',
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
      schemaVersion: 2,
      providers: {
        defaultModelId: 'anthropic-model',
        providers: [provider]
      },
      mcp: {
        servers: [mcpServer]
      }
    });
    expect(existsSync(join(root, 'config', 'providers.json'))).toBe(false);
    expect(existsSync(join(root, 'config', 'mcp.servers.json'))).toBe(false);
  });
});
