import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionsConfig } from '../../src/shared/types';
import { AuthSecuritySection } from '../../src/renderer/settings/sections/auth-security-section';

function createPermissions(mode: PermissionsConfig['mode'] = 'fully_automatic'): PermissionsConfig {
  return {
    schemaVersion: 3,
    mode,
    grants: []
  };
}

describe('AuthSecuritySection', () => {
  it('renders global approval mode radios and grant state copy', () => {
    const html = renderToStaticMarkup(
      React.createElement(AuthSecuritySection, {
        draft: createPermissions('default'),
        onChange: vi.fn()
      })
    );

    expect(html).toContain('data-testid="settings-panel-auth-security"');
    expect(html).toContain('data-testid="settings-approval-mode-fully-automatic"');
    expect(html).toContain('data-testid="settings-approval-mode-default"');
    expect(html).toContain('全自动');
    expect(html).toContain('默认');
    expect(html).toContain('仅在 delete_file 与 MCP 工具调用前弹出审批卡');
    expect(html).toContain('目前没有长期授权记录');
    expect(html).not.toContain('settings-confirmation-');
  });
});
