import type { RocCheckpointInterrupt, RocSqliteCheckpointer } from './sqlite-checkpointer';

export type CheckpointRecoveryReader = Pick<
  RocSqliteCheckpointer,
  'hasCheckpoint' | 'readPendingInterrupts' | 'validateCheckpointIntegrity'
>;

export type RecoveryResult =
  | { kind: 'no_checkpoint'; action: 'fail'; code: 'agent_checkpoint_missing'; reason: string }
  | { kind: 'clean_checkpoint'; action: 'resume_from_checkpoint' }
  | { kind: 'interrupted'; action: 'resume_with_interrupt'; interrupts: RocCheckpointInterrupt[] }
  | { kind: 'corrupted'; action: 'fail'; code: string; reason: string };

export async function recoverOrphanedOperation(
  context: { threadId: string },
  checkpointer: CheckpointRecoveryReader
): Promise<RecoveryResult> {
  if (!checkpointer.hasCheckpoint(context.threadId)) {
    return {
      kind: 'no_checkpoint',
      action: 'fail',
      code: 'agent_checkpoint_missing',
      reason: 'Checkpoint 缺失，无法安全恢复运行。'
    };
  }

  let integrity: ReturnType<CheckpointRecoveryReader['validateCheckpointIntegrity']>;
  try {
    integrity = checkpointer.validateCheckpointIntegrity(context.threadId);
  } catch (error) {
    return {
      kind: 'corrupted',
      action: 'fail',
      code: 'agent_checkpoint_integrity_unavailable',
      reason: error instanceof Error ? error.message : 'Checkpoint 完整性检查不可用。'
    };
  }
  if (!integrity.valid) {
    return {
      kind: 'corrupted',
      action: 'fail',
      code: 'agent_checkpoint_integrity_invalid',
      reason: `Checkpoint 完整性检查失败: ${integrity.issues.join('; ')}`
    };
  }

  let interrupts: RocCheckpointInterrupt[] | null;
  try {
    interrupts = checkpointer.readPendingInterrupts(context.threadId);
  } catch (error) {
    return {
      kind: 'corrupted',
      action: 'fail',
      code: 'agent_checkpoint_interrupt_invalid',
      reason: error instanceof Error ? error.message : 'agent_checkpoint_interrupt_invalid'
    };
  }
  if (interrupts !== null && interrupts.length > 0) {
    return {
      kind: 'interrupted',
      action: 'resume_with_interrupt',
      interrupts
    };
  }

  return { kind: 'clean_checkpoint', action: 'resume_from_checkpoint' };
}

