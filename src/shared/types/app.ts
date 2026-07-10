import type { RocPathsSnapshot, RocRunMode, ServiceStatus } from './common';
import type { PerformanceIpcSummary, PerformanceSnapshot } from './performance';

export type AppStatus = {
  appName: string;
  version: string;
  mode: RocRunMode;
  startedAt: string;
  appearance: SystemAppearanceSnapshot;
  workspace: {
    selectedPath: string | null;
    label: string;
  };
  paths: RocPathsSnapshot;
  services: Record<string, ServiceStatus>;
  defaultModelConfigured: boolean;
  rendererBoundary: {
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: {
      enabled: boolean;
      evaluated: boolean;
      reason: string | null;
      compensatingControls: string[];
    };
  };
};

export type WindowStateSnapshot = {
  maximized: boolean;
  minimized: boolean;
  fullscreen: boolean;
};

export type WindowBoundsSnapshot = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PerformanceSample = {
  id: string;
  sampledAt: string;
  mode: RocRunMode;
  uptimeSeconds: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  memoryBudgetMb: number;
  totalPrivateBytesMb: number | null;
  totalWorkingSetMb: number;
  memoryMeasurement: 'complete' | 'private_bytes_unavailable';
  exceedsBudget: boolean;
  timing: PerformanceSnapshot;
  ipc: PerformanceIpcSummary;
  electron: PerformanceElectronMetrics;
};

export type PerformanceElectronMetrics = {
  browserWindowCount: number;
  processCount: number;
  processMetrics: PerformanceProcessMetric[];
};

export type PerformanceProcessMetric = {
  pid: number;
  type: string;
  name: string | null;
  serviceName: string | null;
  cpuPercent: number;
  sandboxed: boolean | null;
  integrityLevel: string | null;
  memory: {
    workingSetSizeMb: number;
    peakWorkingSetSizeMb: number;
    privateBytesMb: number | null;
    sharedBytesMb: number | null;
  };
};

export type SystemAppearanceSnapshot = {
  accentColor: string;
  inForcedColorsMode: boolean;
  prefersReducedTransparency: boolean;
  resolvedTheme: 'light' | 'dark';
  shouldUseHighContrastColors: boolean;
  shouldUseInvertedColorScheme: boolean;
  themeSource: 'system' | 'light' | 'dark';
};

export type PerformanceSampleRequest = {
  mode: RocRunMode;
  memoryBudgetMb: number;
};
