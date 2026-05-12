export type MemoryCandidateReviewMode = 'manual' | 'auto_after_approval';
export type MemorySessionRetentionDays = 30 | 90 | 180;
export type MemoryCrossScopeRecall = 'explicit_only' | 'expanded_with_label';
export type MemoryColdAutoForgetDays = 90 | 180 | 365 | null;

export type MemoryLayer = 'hot' | 'warm' | 'cold' | 'session' | 'candidate';
export type MemoryType = 'preference' | 'feedback' | 'project_context' | 'process_skill' | 'knowledge_note' | 'session_recall';
export type MemoryPriority = 'critical' | 'high' | 'medium' | 'low';
export type MemoryEntryStatus = 'active' | 'candidate' | 'superseded' | 'stale' | 'archived';
export type MemoryCandidateState =
  | 'new'
  | 'needs_review'
  | 'conflict_detected'
  | 'accepted'
  | 'rejected'
  | 'merged'
  | 'expired';

export type MemoryEntry = {
  id: string;
  layer: MemoryLayer;
  type: MemoryType;
  scope: string;
  content: string;
  confidence: number;
  priority: MemoryPriority;
  status: MemoryEntryStatus;
  source: string;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryFullTextIndexStatus = {
  enabled: boolean;
  healthy: boolean;
  status: 'ready' | 'degraded';
};

export type MemoryStatus = {
  root: string;
  truthSource: 'markdown';
  indexSource: 'sqlite';
  vectorIndex: {
    enabled: boolean;
    healthy: boolean;
    status: 'not_configured' | 'ready' | 'degraded';
  };
  fullTextIndex: MemoryFullTextIndexStatus;
  layers: Record<MemoryLayer, { entries: number; characters: number; path: string }>;
  degradedReason?: string;
};

export type MemorySearchRequest = {
  query: string;
  includeCold?: boolean;
  source?: 'curated' | 'session' | 'all';
  scope?: string;
};

export type MemorySearchResult = {
  query: string;
  degraded: boolean;
  degradedReason?: string;
  items: Array<{
    id: string;
    layer: MemoryLayer;
    scope: string;
    confidence: number;
    sourceRef: string;
    reason: string;
    summary: string;
  }>;
};

export type MemoryCandidate = {
  id: string;
  state: MemoryCandidateState;
  type: MemoryType;
  scope: string;
  content: string;
  confidence: number;
  priority: MemoryPriority;
  source: string;
  sourceRef: string;
  suggestedAction: 'accept' | 'review_conflict' | 'none';
  conflictCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MemoryConflict = {
  id: string;
  candidateId: string;
  activeMemoryId: string;
  type: MemoryType;
  scope: string;
  reason: string;
  status: 'open' | 'resolved';
  createdAt: string;
};

export type SessionRecallEntry = {
  id: string;
  title: string;
  summary: string;
  scope: string;
  sourceRef: string;
  markdownPath: string;
  createdAt: string;
};

export type SessionRecallWriteRequest = {
  sessionId: string;
  title: string;
  summary: string;
  scope: string;
  content: string;
  sourceRef: string;
};

export type SessionSearchRequest = {
  query: string;
  scope?: string;
};

export type SessionSearchResult = {
  query: string;
  items: Array<{
    id: string;
    title: string;
    summary: string;
    scope: string;
    sourceRef: string;
    reason: string;
  }>;
};

export type MemoryDeleteResult = {
  id: string;
  status: MemoryEntryStatus;
  recoverable: boolean;
};
