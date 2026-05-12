import type {
  MemoryCandidate,
  MemoryEntry,
  MemoryLayer,
  MemoryPriority,
  MemoryType
} from '../../../shared/types';

export type MemoryIndexRow = {
  id: string;
  layer: MemoryLayer;
  type: MemoryType;
  scope: string;
  status: MemoryEntry['status'];
  confidence: number;
  priority: MemoryPriority;
  source: string;
  source_ref: string;
  markdown_path: string;
  created_at: string;
  updated_at: string;
};

export type CandidateRow = MemoryIndexRow & {
  candidate_state: MemoryCandidate['state'];
  suggested_action: MemoryCandidate['suggestedAction'];
};

export type SessionRecallRow = {
  id: string;
  scope: string;
  title: string;
  summary: string;
  source_ref: string;
  markdown_path: string;
  created_at: string;
};

export const WARM_FILES = ['preferences.md', 'feedback.md', 'project_context.md', 'process_skills.md', 'knowledge_notes.md'];
