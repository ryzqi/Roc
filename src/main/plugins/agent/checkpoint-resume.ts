import type { BaseCheckpointSaver } from '@langchain/langgraph';

import type { RocCheckpointInterrupt } from '../../services/deep-agent/sqlite-checkpointer';
import { recoverOrphanedOperation, type CheckpointRecoveryReader, type RecoveryResult } from '../../services/deep-agent/operation-recovery';

export type CheckpointResumeResolution =
  | { action: 'fail'; code: string; reason: string }
  | { action: 'resume_from_checkpoint' }
  | { action: 'resume_with_interrupt'; interrupts: RocCheckpointInterrupt[] };

export async function resolveCheckpointResume(input: {
  checkpointer: BaseCheckpointSaver;
  resumePayload?: unknown;
  threadId: string;
}): Promise<CheckpointResumeResolution> {
  if (!hasCheckpointRecoveryReader(input.checkpointer)) {
    return {
      action: 'fail',
      code: 'agent_checkpoint_validation_unavailable',
      reason: 'Checkpoint 恢复验证不可用。'
    };
  }

  let recovery: RecoveryResult;
  try {
    recovery = await recoverOrphanedOperation({ threadId: input.threadId }, input.checkpointer);
  } catch (error) {
    return {
      action: 'fail',
      code: 'agent_checkpoint_validation_failed',
      reason: error instanceof Error ? error.message : 'Checkpoint 恢复验证失败。'
    };
  }
  switch (recovery.action) {
    case 'fail':
      return { action: 'fail', code: recovery.code, reason: recovery.reason };
    case 'resume_from_checkpoint':
      return { action: 'resume_from_checkpoint' };
    case 'resume_with_interrupt':
      if (input.resumePayload !== undefined) {
        return { action: 'resume_from_checkpoint' };
      }
      return { action: 'resume_with_interrupt', interrupts: recovery.interrupts };
  }
}

function hasCheckpointRecoveryReader(
  checkpointer: BaseCheckpointSaver
): checkpointer is BaseCheckpointSaver & CheckpointRecoveryReader {
  return (
    'hasCheckpoint' in checkpointer &&
    typeof checkpointer.hasCheckpoint === 'function' &&
    'readPendingInterrupts' in checkpointer &&
    typeof checkpointer.readPendingInterrupts === 'function' &&
    'validateCheckpointIntegrity' in checkpointer &&
    typeof checkpointer.validateCheckpointIntegrity === 'function'
  );
}
