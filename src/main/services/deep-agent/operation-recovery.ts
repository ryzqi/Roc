import type { RocSqliteCheckpointer } from './sqlite-checkpointer';

export type OperationRecoveryContext = {
  runId: string;
  threadId: string;
  lastCheckpointId: string | null;
};

export type RecoveryResult =
  | { kind: 'no_checkpoint'; action: 'restart' }
  | { kind: 'clean_checkpoint'; action: 'resume_from_checkpoint' }
  | { kind: 'interrupted'; action: 'resume_with_interrupt'; payload: unknown }
  | { kind: 'corrupted'; action: 'fail'; reason: string };

export async function recoverOrphanedOperation(
  context: OperationRecoveryContext,
  checkpointer: RocSqliteCheckpointer
): Promise<RecoveryResult> {
  // 1. 检查 checkpoint 是否存在
  const hasCheckpoint = checkpointer.hasCheckpoint(context.threadId);
  if (!hasCheckpoint) {
    return { kind: 'no_checkpoint', action: 'restart' };
  }

  // 2. 读取 pending interrupts
  const interrupts = checkpointer.readPendingInterrupts(context.threadId);
  if (interrupts !== null && interrupts.length > 0) {
    return {
      kind: 'interrupted',
      action: 'resume_with_interrupt',
      payload: interrupts[0].payload
    };
  }

  // 3. 检查 checkpoint 完整性
  const integrity = checkpointer.validateCheckpointIntegrity(context.threadId);
  if (!integrity.valid) {
    return {
      kind: 'corrupted',
      action: 'fail',
      reason: `Checkpoint 完整性检查失败: ${integrity.issues.join('; ')}`
    };
  }

  // 4. 默认返回干净的 checkpoint 恢复
  return { kind: 'clean_checkpoint', action: 'resume_from_checkpoint' };
}

