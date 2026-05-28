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
    notifications: {
      lowDistraction: true
    },
    globalHotkey: null,
    memory: {
      frozenSnapshotEnabled: true,
      userProfileEnabled: true,
      agentsRulesEnabled: true,
      charLimits: { user: 1375, agents: 800, memory: 2200 },
      sessionRetentionDays: 90,
      consolidatorEnabled: true,
      consolidatorDebounceMinutes: 10,
      consolidatorTargetRatio: 0.85,
      consolidatorDailyQuota: 50,
      preCompactionFlushEnabled: true,
      preCompactionTokenThreshold: 0.85,
      preCompactionContextWindowTokens: 200000,
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

describe('AppBasicsSection release honesty', () => {
  it('does not imply low-distraction notifications are Windows toast notifications', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppBasicsSection, {
        draft: createSettings(),
        hostIntegration: createHostIntegration(),
        onChange: vi.fn()
      })
    );

    expect(html).toContain('低打扰通知');
    expect(html).toContain('仅调整 Roc 内部任务提醒频率；尚未启用 Windows toast。');
  });
});
