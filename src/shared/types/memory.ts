export type MemoryCandidateReviewMode = 'manual' | 'auto_after_approval';
export type MemorySessionRetentionDays = 30 | 90 | 180;
export type MemoryCrossScopeRecall = 'explicit_only' | 'expanded_with_label';
export type MemoryColdAutoForgetDays = 90 | 180 | 365 | null;

export type MemoryStatus = {
  root: string;
  workspaceHash: string | null;
  workspaceLabel: string | null;
  files: Array<unknown>;
  snapshot: { enabled: boolean; totalChars: number; totalLimit: number };
  sessionMessages: { totalRows: number; retentionDays: number; oldestAt: string | null };
  fullTextIndex: { healthy: boolean; status: 'ready' };
};
