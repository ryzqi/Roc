export type RocRunMode = 'development' | 'packaged' | 'smoke' | 'test';

export type RocErrorCategory =
  | 'validation'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'external'
  | 'degraded'
  | 'internal';

export type RocError = {
  code: string;
  message: string;
  category: RocErrorCategory;
  retryable: boolean;
  userAction?: string;
  auditEventId?: string;
};

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: RocError };

export type ServiceStatus = 'ready' | 'blocked' | 'degraded';

export type RocPathsSnapshot = {
  root: string;
  configDir: string;
  databasePath: string;
  memoryDir: string;
  logsDir: string;
  diagnosticsDir: string;
  skillsDir: string;
  artifactsDir: string;
};
