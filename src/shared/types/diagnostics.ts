export type DiagnosticPackageRequest = {
  taskId: string;
  errorSummary: string;
};

export type DiagnosticPackage = {
  id: string;
  taskId: string;
  path: string;
  createdAt: string;
  includes: string[];
  redacted: boolean;
};

export type DiagnosticCheckId =
  | 'scheduler_running'
  | 'scheduler_tasks_registered'
  | 'scheduler_missed_runs_recent'
  | 'cron_expressions_valid';

export type DiagnosticCheck = {
  id: DiagnosticCheckId;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  severity: 'info' | 'warning' | 'error';
  message: string;
  checkedAt: string;
};

export type HealthCheckName =
  | 'database'
  | 'task_scheduler'
  | 'disk_space'
  | 'memory_usage'
  | 'memory_service'
  | 'provider_connectivity';

export type HealthCheck = {
  name: HealthCheckName;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  lastChecked: string;
};

export type HealthCheckResult = {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: HealthCheck[];
};
