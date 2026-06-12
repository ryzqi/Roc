import { describe, expect, it } from 'vitest';

import { createAgentPlugin } from '../../../../src/main/plugins/agent';
import { RocPaths } from '../../../../src/main/services/paths';

const agentCapabilities = [
  'agent.status.get',
  'agent.config.preview',
  'agent.run.start',
  'agent.run.cancel',
  'agent.run.resume',
  'agent.sessions.list',
  'agent.sessions.search'
];

const agentCapabilitiesWithPreview = [...agentCapabilities, 'agent.capability.preview'];

describe('agent plugin manifest', () => {
  it('declares the Phase 2 critical agent plugin contract', () => {
    const plugin = createAgentPlugin();

    expect(plugin.manifest.id).toBe('@roc/plugin-agent');
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.required).toBe(true);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(agentCapabilities);
  });

  it('declares plugin dependencies when the capability preview API is enabled', () => {
    const plugin = createAgentPlugin({
      capabilityPreview: {
        approvalModeProvider: () => 'fully_automatic'
      }
    });

    expect(plugin.manifest.dependencies).toEqual(['@roc/plugin-mcp', '@roc/plugin-skills']);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(agentCapabilitiesWithPreview);
  });

  it('declares plugin dependencies when the DeepAgent executor is enabled', () => {
    const plugin = createAgentPlugin({
      deepAgentExecutor: {
        paths: new RocPaths('F:\\Code\\Roc')
      }
    });

    expect(plugin.manifest.dependencies).toEqual([
      '@roc/plugin-mcp',
      '@roc/plugin-skills',
      '@roc/plugin-workspace',
      '@roc/plugin-runtime-tools'
    ]);
    expect(Reflect.get(plugin.manifest, 'capabilityDependencies')).toEqual(['@roc/plugin-task']);
  });
});
