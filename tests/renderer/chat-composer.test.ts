import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LoadedState } from '../../src/renderer/loaded-state';
import { ChatComposer } from '../../src/renderer/chat/chat-composer';

function createLoadedState(partial: Partial<LoadedState>): LoadedState {
  return {
    appStatus: {
      appName: 'Roc',
      version: '0.1.0',
      mode: 'test',
      startedAt: '2026-05-11T00:00:00.000Z',
      workspace: {
        selectedPath: 'F:\\Code\\Roc',
        label: 'Roc'
      },
      paths: {
        root: 'F:\\Code\\Roc',
        configDir: 'F:\\Code\\Roc\\.tmp',
        databasePath: 'F:\\Code\\Roc\\.tmp\\roc.db',
        memoryDir: 'F:\\Code\\Roc\\.tmp\\memory',
        logsDir: 'F:\\Code\\Roc\\.tmp\\logs',
        diagnosticsDir: 'F:\\Code\\Roc\\.tmp\\diagnostics',
        skillsDir: 'F:\\Code\\Roc\\skills',
        artifactsDir: 'F:\\Code\\Roc\\.artifacts'
      },
      services: {},
      defaultModelConfigured: true,
      rendererBoundary: {
        contextIsolation: true,
        nodeIntegration: false
      }
    },
    taskSnapshot: {
      generatedAt: '2026-05-11T00:00:00.000Z',
      recentEvents: [],
      counts: {
        total: 0,
        running: 0,
        failed: 0,
        pendingConfirmation: 0
      },
      threads: []
    },
    memoryStatus: {
      root: 'F:\\Code\\Roc\\.memory',
      truthSource: 'markdown',
      indexSource: 'sqlite',
      vectorIndex: {
        enabled: false,
        healthy: false,
        status: 'not_configured'
      },
      fullTextIndex: {
        enabled: false,
        healthy: false,
        status: 'degraded'
      },
      layers: {
        hot: { entries: 0, characters: 0, path: 'hot' },
        warm: { entries: 0, characters: 0, path: 'warm' },
        cold: { entries: 0, characters: 0, path: 'cold' },
        session: { entries: 0, characters: 0, path: 'session' },
        candidate: { entries: 0, characters: 0, path: 'candidate' }
      }
    },
    memoryCandidates: [],
    memoryConflicts: [],
    memorySearch: null,
    sessionSearch: null,
    memoryRecovery: null,
    settings: {
      schemaVersion: 2,
      defaultWorkspace: null,
      startup: {
        openAtLogin: false,
        minimizeToTray: false
      },
      notifications: {
        lowDistraction: false
      },
      globalHotkey: null,
      memory: {
        candidateReviewMode: 'manual',
        warmRecallEnabled: false,
        sessionRetentionDays: 30,
        crossScopeRecall: 'explicit_only',
        coldAutoForgetDays: 90
      }
    },
    providers: [
      {
        id: 'provider-openai',
        name: 'OpenAI',
        type: 'openai_compatible',
        endpoint: 'https://api.example.test/v1',
        credentialRef: 'secret:provider-openai',
        enabled: true,
        models: [
          {
            id: 'gpt-test',
            displayName: 'GPT Test',
            enabled: true,
            supportsStreaming: true,
            supportsToolCalls: true
          }
        ]
      }
    ],
    defaultModelId: 'gpt-test',
    providerSecretStatus: [],
    permissions: {
      schemaVersion: 3,
      mode: 'fully_automatic',
      grants: []
    },
    providerTestStatus: null,
    mcpServers: [],
    mcpTestStatus: null,
    skills: [],
    selectedMcpServers: [],
    selectedSkills: [],
    backgroundTask: null,
    backgroundTasks: [],
    traySummary: {
      residentEnabled: false,
      backgroundPaused: false,
      nextRunAt: null,
      updatedAt: '2026-05-11T00:00:00.000Z',
      backgroundTasks: {
        total: 0,
        running: 0,
        failed: 0,
        pendingConfirmation: 0,
        nextRunAt: null
      }
    },
    diagnosticPackage: null,
    performanceSample: {
      id: 'perf-sample',
      sampledAt: '2026-05-11T00:00:00.000Z',
      mode: 'test',
      uptimeSeconds: 0,
      rssMb: 0,
      heapUsedMb: 0,
      heapTotalMb: 0,
      memoryBudgetMb: 0,
      exceedsBudget: false
    },
    agent: {
      deepAgentsPackage: 'available',
      deepAgentsApi: {
        createDeepAgent: true
      },
      defaultModelConfigured: true,
      defaultModelState: {
        status: 'ready',
        modelId: 'gpt-test',
        providerId: 'provider-openai',
        reason: ''
      },
      memoryAccess: 'store_backend',
      execution: 'ready'
    },
    agentCapabilityPreview: null,
    workspace: null,
    fileTree: null,
    fileSearch: null,
    filePreview: null,
    gitStatus: null,
    gitBranches: null,
    gitError: null,
    gitSelectedPath: null,
    gitSelectedPreview: null,
    gitLastCommit: null,
    gitLastPush: null,
    rtkStatus: {
      enabledForAgentCommands: false,
      binaryPath: '',
      configPath: '',
      teeDir: '',
      resourceState: 'missing'
    },
    terminalError: null,
    terminalSession: null,
    ...partial
  };
}

describe('chat composer skills popover', () => {
  it('renders skill names and descriptions inside the skill popover choices', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatComposer, {
        chatInput: '规划一下',
        onChatInputChange: () => {},
        selectedAttachments: [],
        onSelectedAttachmentsChange: () => {},
        activeComposerPopover: 'skills',
        onActiveComposerPopoverChange: () => {},
        submitting: false,
        state: createLoadedState({
          skills: [
            {
              id: 'deep-review',
              name: 'Deep Review',
              enabled: true,
              path: 'F:\\Code\\Roc\\skills\\deep-review',
              description: '只保留这一段说明文本。',
              status: 'ready',
              lastError: null
            }
          ]
        }),
        updateLoadedState: () => {},
        onSubmit: async () => {}
      })
    );

    expect(html).toContain('data-testid="chat-skill-popover"');
    expect(html).toContain('data-testid="turn-skill-deep-review"');
    expect(html).toContain('>Deep Review<');
    expect(html).toContain('class="composer-choice-copy">');
    expect(html).toContain('class="composer-choice-description composer-choice-description--clamp-2">只保留这一段说明文本。</small>');
  });
});
