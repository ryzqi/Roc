import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, HostIntegrationStatus } from '../../src/shared/types';
import { AppBasicsSection } from '../../src/renderer/settings/sections/app-basics-section';

function createSettings(): AppSettings {
  return {
    schemaVersion: 2,
    defaultWorkspace: null,
    startup: {
      openAtLogin: false,
      minimizeToTray: true
    },
    globalHotkey: null,
    memory: {
      charLimits: { user: 1375, agents: 800, memory: 2200 },
      sessionRetentionDays: 90,
      securityScan: {
        promptInjection: true,
        credential: true,
        sshBackdoor: true,
        invisibleUnicode: true
      }
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
}

function createHostIntegration(): HostIntegrationStatus {
  return {
    startup: {
      configuredOpenAtLogin: false,
      effectiveOpenAtLogin: false,
      syncError: null
    },
    globalHotkey: {
      accelerator: null,
      registered: false,
      registrationError: null
    }
  };
}

describe('AppBasicsSection', () => {
  it('renders workspace, window behavior, and global entry settings without notification controls', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppBasicsSection, {
        draft: createSettings(),
        hostIntegration: createHostIntegration(),
        onChange: vi.fn()
      })
    );

    expect(html).toContain('工作区');
    expect(html).toContain('窗口行为');
    expect(html).toContain('全局入口');
    expect(html).toContain('data-testid="settings-default-workspace"');
    expect(html).toContain('data-testid="settings-startup-open-at-login"');
    expect(html).toContain('data-testid="settings-startup-minimize-to-tray"');
    expect(html).toContain('data-testid="settings-global-hotkey"');
    expect(html).not.toContain('低打扰通知');
  });
});
