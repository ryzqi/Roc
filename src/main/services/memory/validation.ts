import type { MemoryEntry } from '../../../shared/types';
import { RocDomainError } from '../errors';
import { requireText } from '../validation';

export { requireText } from '../validation';

export function validateCandidateInput(entry: Omit<MemoryEntry, 'id' | 'layer' | 'status' | 'createdAt' | 'updatedAt'>): void {
  requireText(entry.type, 'memory_type_empty', '记忆 type 不能为空。', '请选择记忆类型。');
  requireText(entry.scope, 'memory_scope_empty', '记忆 scope 不能为空。', '请选择记忆作用范围。');
  requireText(entry.content, 'memory_content_empty', '记忆内容不能为空。', '请输入要保存的记忆内容。');
  requireText(entry.priority, 'memory_priority_empty', '记忆 priority 不能为空。', '请选择记忆优先级。');
  requireText(entry.source, 'memory_source_empty', '记忆 source 不能为空。', '请提供记忆来源。');
  requireText(entry.sourceRef, 'memory_source_ref_empty', '记忆 sourceRef 不能为空。', '请提供可追溯来源。');
  if (entry.confidence < 0 || entry.confidence > 1) {
    throw new RocDomainError({
      code: 'memory_confidence_invalid',
      message: '记忆 confidence 必须在 0 到 1 之间。',
      category: 'validation',
      retryable: false,
      userAction: '请使用 0 到 1 之间的置信度。'
    });
  }
}
