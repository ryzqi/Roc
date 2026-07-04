import type { AppStatus } from '../../shared/types';
import type { LazyLoadState, MemoryData, OperationsData, TaskSurfaceData, WorkspaceData } from './types';

export function emptyWorkspaceData(): WorkspaceData {
  return {
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
    terminalError: null,
    terminalSession: null
  };
}

export function emptyMemoryData(): MemoryData {
  return {
    memoryStatus: {
      root: '',
      workspaceHash: null,
      workspaceLabel: null,
      files: [],
      snapshot: { enabled: false, totalChars: 0, totalLimit: 0 },
      sessionMessages: { totalRows: 0, retentionDays: 90, oldestAt: null },
      fullTextIndex: { healthy: true, status: 'ready' },
      autoMemory: { enabled: true, auditRetentionDays: 30, recent: [] }
    },
    memoryRecovery: null
  };
}

export function emptyOperationsData(mode: AppStatus['mode']): OperationsData {
  return {
    diagnosticChecks: [],
    diagnosticPackage: null,
    performanceSample: {
      id: '',
      sampledAt: '',
      mode,
      uptimeSeconds: 0,
      rssMb: 0,
      heapUsedMb: 0,
      heapTotalMb: 0,
      memoryBudgetMb: 300,
      exceedsBudget: false,
      timing: {
        generatedAt: '',
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
    }
  };
}

export function emptyTaskSurfaceData(): TaskSurfaceData {
  return {
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
      residentEnabled: true,
      backgroundPaused: false,
      backgroundTasks: {
        total: 0,
        running: 0,
        failed: 0,
        pendingConfirmation: 0,
        nextRunAt: null
      },
      nextRunAt: null,
      updatedAt: ''
    }
  };
}

export function idleLazyLoadState(key: string | null = null): LazyLoadState {
  return {
    status: 'idle',
    error: null,
    key
  };
}
