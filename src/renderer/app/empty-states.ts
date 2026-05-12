import type { AppStatus } from '../../shared/types';
import type { LazyLoadState, MemoryData, OperationsData, WorkspaceData } from './types';

export function emptyWorkspaceData(): WorkspaceData {
  return {
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
    terminalError: null,
    terminalSession: null
  };
}

export function emptyMemoryData(): MemoryData {
  return {
    memoryStatus: {
      root: '',
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
        hot: { entries: 0, characters: 0, path: '' },
        warm: { entries: 0, characters: 0, path: '' },
        cold: { entries: 0, characters: 0, path: '' },
        session: { entries: 0, characters: 0, path: '' },
        candidate: { entries: 0, characters: 0, path: '' }
      },
      degradedReason: '记忆页面尚未加载。'
    },
    memoryCandidates: [],
    memoryConflicts: [],
    memorySearch: null,
    sessionSearch: null,
    memoryRecovery: null
  };
}

export function emptyOperationsData(mode: AppStatus['mode']): OperationsData {
  return {
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
      exceedsBudget: false
    },
    doctor: {
      generatedAt: '',
      summary: {
        pass: 0,
        fail: 0,
        degraded: 0,
        skipped: 0
      },
      findings: []
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
