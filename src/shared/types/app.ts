import type { RocPathsSnapshot, RocRunMode, ServiceStatus } from './common';
import type { PerformanceSnapshot } from './performance';

export type AppStatus = {
  appName: string;
  version: string;
  mode: RocRunMode;
  startedAt: string;
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
  exceedsBudget: boolean;
  timing: PerformanceSnapshot;
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

export type PerformanceSampleRequest = {
  mode: RocRunMode;
  memoryBudgetMb: number;
};
