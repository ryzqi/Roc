import type { z } from 'zod';

import {
  sessionMessageSchema,
  sessionMessageSearchRequestSchema,
  sessionMessageSearchResultSchema
} from '../schemas/agent';
import {
  memoryFileWriteOutcomeSchema,
  memoryFileWriteRequestSchema,
  memoryKindSchema,
  memoryScopeSchema,
  memoryStatusSchema
} from '../schemas/ipc-memory-settings';

export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemoryFileMeta = MemoryStatus['files'][number];
export type AutoMemoryAuditRecord = MemoryStatus['autoMemory']['recent'][number];
export type AutoMemoryCandidateType = AutoMemoryAuditRecord['type'];
export type AutoMemoryConfidence = AutoMemoryAuditRecord['confidence'];
export type AutoMemoryAuditAction = AutoMemoryAuditRecord['action'];
export type MemoryFileWriteRequest = z.infer<typeof memoryFileWriteRequestSchema>;
export type MemoryFileWriteOutcome = z.infer<typeof memoryFileWriteOutcomeSchema>;
type FailedMemoryFileWrite = Extract<MemoryFileWriteOutcome, { ok: false }>;
export type SecurityScanIssue = NonNullable<FailedMemoryFileWrite['issues']>[number];

export type SessionMessageEntry = z.infer<typeof sessionMessageSchema>;
export type SessionMessagePhase = SessionMessageEntry['phase'];
export type SessionMessageSearchRequest = z.infer<typeof sessionMessageSearchRequestSchema>;
export type SessionMessageSearchResult = z.infer<typeof sessionMessageSearchResultSchema>;
