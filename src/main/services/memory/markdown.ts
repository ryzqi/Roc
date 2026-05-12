import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { MemoryEntry } from '../../../shared/types';

export function ensureFile(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content, 'utf8');
  }
}

export function readMemoryBody(markdownPath: string): string {
  if (!existsSync(markdownPath)) {
    return '';
  }
  const content = readFileSync(markdownPath, 'utf8');
  if (!content.startsWith('---')) {
    return content;
  }
  const closingIndex = content.indexOf('\n---', 3);
  if (closingIndex === -1) {
    return content;
  }
  return content.slice(closingIndex + 4).trim();
}

export function summarize(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function renderMemoryMarkdown(entry: MemoryEntry): string {
  return [
    '---',
    `id: ${entry.id}`,
    `type: ${entry.type}`,
    `scope: ${entry.scope}`,
    `layer: ${entry.layer}`,
    `confidence: ${entry.confidence}`,
    `priority: ${entry.priority}`,
    `status: ${entry.status}`,
    `source: ${entry.source}`,
    `source_ref: ${entry.sourceRef}`,
    `created_at: ${entry.createdAt}`,
    `updated_at: ${entry.updatedAt}`,
    '---',
    '',
    entry.content,
    ''
  ].join('\n');
}
