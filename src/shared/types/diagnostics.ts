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
