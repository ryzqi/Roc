export type MemoryScope = 'global' | 'workspace';
export type MemoryKind = 'user' | 'agents' | 'memory';
export type SessionMessagePhase = 'visible' | 'pre_compaction_flush';

export type AutoMemoryCandidateType =
  | 'user_preference'
  | 'workspace_fact'
  | 'decision'
  | 'pitfall'
  | 'verification'
  | 'transient_task_result';

export type AutoMemoryConfidence = 'high' | 'medium' | 'low';

export type AutoMemoryAuditAction =
  | 'accepted'
  | 'rejected'
  | 'duplicate_skipped'
  | 'conflict_rejected'
  | 'maintenance_merged'
  | 'maintenance_deleted'
  | 'write_failed';

export type AutoMemoryAuditRecord = {
  id: string;
  createdAt: string;
  action: AutoMemoryAuditAction;
  type: AutoMemoryCandidateType;
  scope: MemoryScope;
  confidence: AutoMemoryConfidence;
  key: string;
  summary: string;
  sourceRunId: string;
  reason: string;
  workspacePath: string | null;
  targetPath: string | null;
};

export type SecurityScanIssue = {
  category: 'prompt_injection' | 'credential' | 'ssh_backdoor' | 'invisible_unicode';
  pattern: string;
  matchExcerpt: string;
};

export type MemoryFileMeta = {
  scope: MemoryScope;
  kind: MemoryKind;
  exists: boolean;
  charCount: number;
  charLimit: number;
  absolutePath: string;
  effective: boolean;
  updatedAt: string | null;
};

export type MemoryStatus = {
  root: string;
  workspaceHash: string | null;
  workspaceLabel: string | null;
  files: MemoryFileMeta[];
  snapshot: { enabled: boolean; totalChars: number; totalLimit: number };
  sessionMessages: { totalRows: number; retentionDays: number; oldestAt: string | null };
  fullTextIndex: { healthy: boolean; status: 'ready' };
  autoMemory: {
    enabled: boolean;
    auditRetentionDays: number;
    recent: AutoMemoryAuditRecord[];
  };
};

export type MemoryFileWriteRequest = {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
};

export type MemoryFileWriteOutcome =
  | { ok: true; meta: MemoryFileMeta }
  | {
      ok: false;
      reason: 'security_scan' | 'capacity_exceeded' | 'invalid_path' | 'workspace_required';
      detail: string;
      chars?: number;
      limit?: number;
      issues?: SecurityScanIssue[];
    };

export type SessionMessageEntry = {
  id: string;
  threadId: string;
  threadTitle: string | null;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  phase: SessionMessagePhase;
  tokenCount: number | null;
  workspaceHash: string | null;
  createdAt: string;
};

export type SessionMessageSearchRequest = {
  query: string;
  workspaceScope: 'current' | 'all';
  workspaceHash?: string | null;
  threadId?: string;
  sinceDays?: number;
  limit?: number;
};

export type SessionMessageSearchResult = {
  query: string;
  total: number;
  items: Array<SessionMessageEntry & { snippet: string }>;
};
