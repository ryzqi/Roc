import { join } from 'node:path';
import type { MemoryEntry, MemoryLayer, MemoryType } from '../../../shared/types';
import type { RocPaths } from '../paths';
import type { CandidateRow } from './types';

export function targetLayer(row: CandidateRow): MemoryLayer {
  const canEnterHot =
    row.scope === 'global' &&
    (row.priority === 'critical' || row.priority === 'high') &&
    (row.source === 'user_explicit' || row.source === 'consolidation');
  return canEnterHot ? 'hot' : 'warm';
}

export function warmFileForType(type: MemoryType): string {
  if (type === 'preference') {
    return 'preferences.md';
  }
  if (type === 'feedback') {
    return 'feedback.md';
  }
  if (type === 'project_context') {
    return 'project_context.md';
  }
  if (type === 'process_skill') {
    return 'process_skills.md';
  }
  return 'knowledge_notes.md';
}

export function activeMarkdownPath(paths: RocPaths, entry: MemoryEntry): string {
  if (entry.layer === 'hot') {
    return join(paths.memoryDir, 'hot', `${entry.id}.md`);
  }
  if (entry.layer === 'warm') {
    return join(paths.memoryDir, 'warm', warmFileForType(entry.type));
  }
  if (entry.layer === 'cold') {
    return join(paths.memoryDir, 'cold', 'archive', `${entry.id}.md`);
  }
  return join(paths.memoryDir, entry.layer, `${entry.id}.md`);
}
