import type { ReactNode } from 'react';
import type {
  AutoMemoryAuditAction,
  AutoMemoryAuditRecord,
  AutoMemoryCandidateType,
  AutoMemoryConfidence,
  MemoryFileMeta,
  MemoryScope
} from '../../../shared/types';

export function formatKind(kind: MemoryFileMeta['kind']): string {
  if (kind === 'user') {
    return 'USER.md';
  }
  if (kind === 'agents') {
    return 'AGENTS.md';
  }
  return 'MEMORY.md';
}

export function formatAction(action: AutoMemoryAuditAction): { text: string; className: string } {
  switch (action) {
    case 'accepted':
      return { text: '✓ 已接受', className: 'action-accepted' };
    case 'rejected':
      return { text: '✗ 已拒绝', className: 'action-rejected' };
    case 'duplicate_skipped':
      return { text: '⊘ 重复跳过', className: 'action-skipped' };
    case 'conflict_rejected':
      return { text: '⚠ 冲突拒绝', className: 'action-conflict' };
    case 'maintenance_merged':
      return { text: '⇄ 维护合并', className: 'action-merged' };
    case 'maintenance_deleted':
      return { text: '🗑 维护删除', className: 'action-deleted' };
    case 'write_failed':
      return { text: '✗ 写入失败', className: 'action-failed' };
    default:
      return { text: action, className: '' };
  }
}

export function formatType(type: AutoMemoryCandidateType): string {
  switch (type) {
    case 'user_preference':
      return '用户偏好';
    case 'workspace_fact':
      return '工作区事实';
    case 'decision':
      return '决策记录';
    case 'pitfall':
      return '避坑提示';
    case 'verification':
      return '验证结果';
    case 'transient_task_result':
      return '临时任务结果';
    default:
      return type;
  }
}

export function formatConfidence(confidence: AutoMemoryConfidence): string {
  switch (confidence) {
    case 'high':
      return '高置信度';
    case 'medium':
      return '中等置信度';
    case 'low':
      return '低置信度';
    default:
      return confidence;
  }
}

export function formatScope(scope: MemoryScope): string {
  return scope === 'global' ? '全局' : '工作区';
}

export function truncatePath(path: string, maxLength = 60): string {
  if (path.length <= maxLength) {
    return path;
  }
  const start = path.slice(0, 20);
  const end = path.slice(-37);
  return `${start}...${end}`;
}

export function highlightMatch(text: string, query: string): ReactNode {
  if (query.trim().length === 0) {
    return text;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: ReactNode[] = [];
  let lastIndex = 0;

  let index = lowerText.indexOf(lowerQuery, lastIndex);
  while (index !== -1) {
    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index));
    }
    parts.push(
      <mark key={index} className="search-highlight">
        {text.slice(index, index + query.length)}
      </mark>
    );
    lastIndex = index + query.length;
    index = lowerText.indexOf(lowerQuery, lastIndex);
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}
