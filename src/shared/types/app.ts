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
};

export type PerformanceSampleRequest = {
  mode: RocRunMode;
  memoryBudgetMb: number;
};
