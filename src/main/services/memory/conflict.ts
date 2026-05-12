import type { MemoryEntry } from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { readMemoryBody } from './markdown';

export function detectConflicts(
  database: DatabaseService,
  entry: MemoryEntry
): Array<{ activeMemoryId: string; reason: string }> {
  const rows = database.db
    .prepare(
      `SELECT id, markdown_path
       FROM memory_entries_index
       WHERE status = 'active' AND type = ? AND scope = ?`
    )
    .all(entry.type, entry.scope) as Array<{ id: string; markdown_path: string }>;
  const conflicts: Array<{ activeMemoryId: string; reason: string }> = [];
  for (const row of rows) {
    const activeContent = readMemoryBody(row.markdown_path);
    if (isConflicting(activeContent, entry.content)) {
      conflicts.push({
        activeMemoryId: row.id,
        reason: 'same_type_scope_contradiction_or_duplicate'
      });
    }
  }
  return conflicts;
}

function isConflicting(activeContent: string, candidateContent: string): boolean {
  const activeNormalized = normalizeForConflict(activeContent);
  const candidateNormalized = normalizeForConflict(candidateContent);
  if (activeNormalized.length === 0 || candidateNormalized.length === 0) {
    return false;
  }
  if (activeNormalized === candidateNormalized) {
    return true;
  }
  const activeNegation = hasNegation(activeContent);
  const candidateNegation = hasNegation(candidateContent);
  return activeNegation !== candidateNegation && tokenOverlap(activeContent, candidateContent) >= 0.6;
}

function normalizeForConflict(content: string): string {
  return content
    .replace(/^---[\s\S]*?---/m, '')
    .replaceAll('不', '')
    .replaceAll('不要', '')
    .replaceAll('不能', '')
    .replace(/\bnot\b/g, '')
    .replace(/\bdoes\s+not\b/g, '')
    .replace(/[，。！？、；：,.!?:;\s]/g, '')
    .toLocaleLowerCase();
}

function hasNegation(content: string): boolean {
  return content.includes('不') || content.toLocaleLowerCase().includes('not ');
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }
  const rightSet = new Set(rightTokens);
  const overlapCount = leftTokens.filter((token) => rightSet.has(token)).length;
  return overlapCount / Math.max(leftTokens.length, rightTokens.length);
}

function significantTokens(content: string): string[] {
  return content
    .toLocaleLowerCase()
    .replace(/[，。！？、；：,.!?:;()\[\]{}]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && token !== 'not' && token !== 'does');
}
