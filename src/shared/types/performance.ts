export type PerformancePhase =
  | 'main_ready'
  | 'services_created'
  | 'services_initialized'
  | 'services_critical_initialized'
  | 'services_deferred_initialized'
  | 'window_created'
  | 'renderer_loaded'
  | 'ready_to_show'
  | 'renderer_first_paint'
  | 'renderer_interactive'
  | 'ipc_call'
  | 'db_query'
  | 'file_io'
  | 'provider_first_token'
  | 'provider_failed'
  | 'provider_completed';

export type PerformanceTimingSample = {
  id: string;
  phase: PerformancePhase;
  label: string;
  startedAtMs: number;
  durationMs: number;
  metadata: Record<string, string | number | boolean | null>;
};

export type PerformanceSnapshot = {
  generatedAt: string;
  samples: PerformanceTimingSample[];
};

export type PerformanceIpcChannelSummary = {
  channel: string;
  count: number;
  totalDurationMs: number;
  averageDurationMs: number;
  maxDurationMs: number;
  lastOk: boolean | null;
};

export type PerformanceIpcSummary = {
  generatedFromSamples: number;
  totalCalls: number;
  topLimit: number;
  topSlowCalls: PerformanceIpcChannelSummary[];
  topFrequentCalls: PerformanceIpcChannelSummary[];
  windowSetBoundsCalls: number;
};
