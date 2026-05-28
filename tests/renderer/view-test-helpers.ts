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
