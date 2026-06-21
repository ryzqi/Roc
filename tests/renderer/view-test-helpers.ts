import type { LoadedState } from '../../src/renderer/loaded-state';

export function createLoadedState(partial: Partial<LoadedState>): LoadedState {
  return {
    appStatus: {
      appName: 'Roc',
      version: '0.1.0',
      mode: 'test',
      startedAt: '2026-05-13T00:00:00.000Z',
      appearance: {
        accentColor: '#2d477a',
        inForcedColorsMode: false,
        prefersReducedTransparency: false,
        resolvedTheme: 'light',
        shouldUseHighContrastColors: false,
        shouldUseInvertedColorScheme: false,
        themeSource: 'system'
      },
      workspace: {
        selectedPath: 'F:\\Code\\Roc',
        label: 'Roc'
      },
      paths: {
        root: 'F:\\Code\\Roc',
        configDir: 'F:\\Code\\Roc\\.tmp',
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
        nodeIntegration: false,
        sandbox: {
          enabled: false,
          evaluated: true,
          reason: 'test fixture',
          compensatingControls: ['contextIsolation', 'nodeIntegration=false']
        }
      }
    },
    taskSnapshot: {
      generatedAt: '2026-05-13T00:00:00.000Z',
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
      workspaceHash: null,
      workspaceLabel: null,
      files: [],
      snapshot: { enabled: false, totalChars: 0, totalLimit: 0 },
      sessionMessages: { totalRows: 0, retentionDays: 90, oldestAt: null },
      fullTextIndex: { healthy: true, status: 'ready' }
    },
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
        frozenSnapshotEnabled: true,
        userProfileEnabled: true,
        agentsRulesEnabled: true,
        charLimits: { user: 1375, agents: 800, memory: 2200 },
        sessionRetentionDays: 30,
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
    },
    providers: [],
    defaultModelId: null,
    providerSecretStatus: [],
    permissions: {
      schemaVersion: 3,
      mode: 'fully_automatic',
      grants: []
    },
    hostIntegration: {
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
    },
    providerTestStatus: null,
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    mcpTestStatus: null,
    skills: [],
    selectedMcpServers: [],
    selectedSkills: [],
    activeTasks: [],
    taskDetail: null,
    scheduledRuns: [],
    schedulerStatus: {
      running: false,
      registeredTaskCount: 0,
      nextFireAt: null,
      recentSkippedCount: 0,
      lastError: null
    },
    traySummary: {
      residentEnabled: false,
      backgroundPaused: false,
      nextRunAt: null,
      updatedAt: '2026-05-13T00:00:00.000Z',
      backgroundTasks: {
        total: 0,
        running: 0,
        failed: 0,
        pendingConfirmation: 0,
        nextRunAt: null
      }
    },
    diagnosticPackage: null,
    diagnosticChecks: [],
    performanceSample: {
      id: 'perf-sample',
      sampledAt: '2026-05-13T00:00:00.000Z',
      mode: 'test',
      uptimeSeconds: 0,
      rssMb: 0,
      heapUsedMb: 0,
      heapTotalMb: 0,
      memoryBudgetMb: 0,
      exceedsBudget: false,
      timing: {
        generatedAt: '2026-05-13T00:00:00.000Z',
        samples: []
      },
      ipc: {
        generatedFromSamples: 0,
        totalCalls: 0,
        topLimit: 5,
        topSlowCalls: [],
        topFrequentCalls: [],
        windowSetBoundsCalls: 0
      },
      electron: {
        browserWindowCount: 0,
        processCount: 0,
        processMetrics: []
      }
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
    fileWorkbenchPdfPreview: null,
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
