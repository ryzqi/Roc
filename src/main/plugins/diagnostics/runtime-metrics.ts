export type RuntimeProcessMetric = {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  cpuPercent: number;
  sandboxed?: boolean;
  integrityLevel?: string;
  memory: {
    workingSetSizeKb: number;
    peakWorkingSetSizeKb: number;
    privateBytesKb?: number;
    sharedBytesKb?: number;
  };
};

export type RuntimeMetricsProvider = {
  getBrowserWindowCount(): number;
  getProcessMetrics(): RuntimeProcessMetric[];
};
