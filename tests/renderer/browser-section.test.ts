import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrowserSection } from '../../src/renderer/settings/sections/browser-section';

describe('browser section', () => {
  it('renders real Exa and Jina status copy instead of unimplemented placeholders', () => {
    const html = renderToStaticMarkup(
      React.createElement(BrowserSection, {
        exaServer: {
          id: 'exa-hosted',
          name: 'Exa Hosted MCP',
          enabled: false,
          transport: 'http',
          status: 'not_connected',
          tools: 2,
          preset: true,
          riskLevel: 'medium',
          url: 'https://mcp.exa.ai/mcp',
          allowedTools: ['web_search_exa', 'web_search_advanced_exa'],
          lastError: null
        },
        onTestExa: async () => {},
        testStatusLabel: '未测试'
      })
    );

    expect(html).toContain('Exa Hosted MCP');
    expect(html).toContain('Jina Reader');
    expect(html).toContain('data-testid="settings-browser-exa-test"');
    expect(html).not.toContain('尚未实现');
    expect(html).not.toContain('未实现');
    expect(html).not.toContain('状态占位');
  });
});
