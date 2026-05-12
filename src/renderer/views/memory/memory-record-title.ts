import type { MemoryRecordViewModel } from '../../app/types';

export function memoryRecordTitle(record: MemoryRecordViewModel): string {
  if (record.layer === 'candidate') {
    return '候选记忆';
  }
  if (record.layer === 'session_recall') {
    return '会话回忆';
  }
  return `${record.layer}记忆`;
}
