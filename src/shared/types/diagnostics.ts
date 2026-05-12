export type DoctorFinding = {
  id: string;
  checkId: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  status: 'pass' | 'fail' | 'degraded' | 'skipped';
  title: string;
  detail: string;
  repairAction?: DoctorRepairAction;
  createdAt: string;
};

export type DoctorRepairAction = {
  label: string;
  action: string;
};

export type DoctorSnapshot = {
  generatedAt: string;
  summary: {
    pass: number;
    fail: number;
    degraded: number;
    skipped: number;
  };
  findings: DoctorFinding[];
};

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
