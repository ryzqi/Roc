import { describe, it, expect } from 'vitest';
import type { McpServerSnapshot, SkillSnapshot } from '../../../../src/shared/types';
import { ManifestBuilder } from '../../../../src/main/plugins/agent/manifest-builder';

describe('ManifestBuilder', () => {
  it('forMode 设置正确的模式', () => {
    const compiled = ManifestBuilder
      .forMode('plan')
      .withRequestedCapabilities({ mcpServers: [], skills: [] })
      .build();

    expect(compiled.manifest).toBeDefined();
  });

  it('链式调用构建 manifest', () => {
    const mcpServers: McpServerSnapshot[] = [
      {
        id: 'test-server',
        name: 'Test Server',
        enabled: true,
        transport: 'stdio',
        status: 'ready',
        tools: 1,
        allowedTools: ['test_tool'],
        riskLevel: 'medium'
      }
    ];

    const skills: SkillSnapshot[] = [
      {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        enabled: true,
        status: 'ready',
        path: '/test/skill.md'
      }
    ];

    const compiled = ManifestBuilder
      .forMode('chat')
      .withMcp(mcpServers, 'default')
      .withSkills(skills)
      .withDeleteFileApproval('default')
      .withShellCommands(['echo'])
      .withSelfConfig(true)
      .withRequestedCapabilities({
        mcpServers: ['test-server'],
        skills: ['test-skill']
      })
      .build();

    expect(compiled.manifest).toBeDefined();
    expect(compiled.toolCards.length).toBeGreaterThan(0);
    expect(compiled.skillCards.length).toBe(1);
    expect(compiled.skillCards[0].name).toBe('Test Skill');
  });

  it('plan mode 过滤工具', () => {
    const compiled = ManifestBuilder
      .forMode('plan')
      .withSelfConfig(true)
      .withRequestedCapabilities({ mcpServers: [], skills: [] })
      .build();

    // plan mode 不应包含 roc_self_config
    expect(compiled.toolCards.some((c) => c.name === 'roc_self_config')).toBe(false);

    // plan mode 应包含 web_read
    expect(compiled.toolCards.some((c) => c.name === 'web_read')).toBe(true);
  });

  it('可以注入自定义策略', () => {
    const mockPolicy = {
      selectToolCards: () => [
        {
          id: 'custom:tool',
          name: 'custom_tool',
          capabilityType: 'terminal_tool' as const,
          description: 'Custom tool',
          requiredInput: 'none',
          scope: 'app' as const,
          dependencies: [],
          sideEffects: [],
          requiresApproval: false,
          supportsLongTermGrant: false,
          revokeGrantHint: '',
          riskLevel: 'low' as const,
          auditCategory: 'test' as const,
          untrustedContext: false
        }
      ]
    };

    const compiled = ManifestBuilder
      .forMode('chat')
      .withToolSelectionPolicy(mockPolicy)
      .withRequestedCapabilities({ mcpServers: [], skills: [] })
      .build();

    expect(compiled.toolCards.length).toBe(1);
    expect(compiled.toolCards[0].name).toBe('custom_tool');
  });

  it('生成正确的 manifest hash', () => {
    const compiled1 = ManifestBuilder
      .forMode('chat')
      .withRequestedCapabilities({ mcpServers: [], skills: [] })
      .build();

    const compiled2 = ManifestBuilder
      .forMode('plan')
      .withRequestedCapabilities({ mcpServers: [], skills: [] })
      .build();

    // 不同配置应该生成不同的 hash
    expect(compiled1.manifest.manifestHash).not.toBe(compiled2.manifest.manifestHash);
  });
});
