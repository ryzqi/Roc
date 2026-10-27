import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const { resolveCheckpointResume } = await importTypeScriptModule(
  'src/main/plugins/agent/checkpoint-resume.ts',
  {
    platform: 'node',
    tempDir: join(repositoryRoot, '.runtime/tmp')
  }
);

const threadId = 'thread-recovery';
const validApprovalRequest = {
  actionRequests: [{ name: 'write_file', args: { path: 'workspace/output.txt', content: 'side effect must not run' } }],
  reviewConfigs: []
};

function checkpointer({
  exists = true,
  interrupts = null,
  integrity = { valid: true, issues: [] },
  readError = null,
  integrityError = null
} = {}) {
  return {
    hasCheckpoint: () => exists,
    validateCheckpointIntegrity: () => {
      if (integrityError !== null) throw integrityError;
      return integrity;
    },
    readPendingInterrupts: () => {
      if (readError !== null) throw readError;
      return interrupts;
    }
  };
}

function resolve(checkpointerValue, resumePayload) {
  return resolveCheckpointResume({
    checkpointer: checkpointerValue,
    threadId,
    ...(resumePayload === undefined ? {} : { resumePayload })
  });
}

test('missing checkpoint fails closed instead of restarting the operation', async () => {
  assert.deepEqual(await resolve(checkpointer({ exists: false })), {
    action: 'fail',
    code: 'agent_checkpoint_missing',
    reason: 'Checkpoint 缺失，无法安全恢复运行。'
  });
});

test('clean checkpoint selects checkpoint resume', async () => {
  assert.deepEqual(await resolve(checkpointer()), { action: 'resume_from_checkpoint' });
});

test('pending checkpoint interrupts wait for the user with every approval preserved', async () => {
  const pending = [
    { interruptId: 'approval-1', payload: validApprovalRequest },
    { interruptId: 'approval-2', payload: validApprovalRequest }
  ];
  assert.deepEqual(await resolve(checkpointer({ interrupts: pending })), {
    action: 'resume_with_interrupt',
    interrupts: pending
  });
});

test('an explicit user resume payload can continue the checkpoint', async () => {
  const pending = [{ interruptId: 'approval-1', payload: validApprovalRequest }];
  const resumePayload = { 'approval-1': { type: 'approve' } };
  assert.deepEqual(await resolve(checkpointer({ interrupts: pending }), resumePayload), {
    action: 'resume_from_checkpoint'
  });
});

test('corrupt checkpoint fails closed before selecting any execution path', async () => {
  assert.deepEqual(
    await resolve(checkpointer({ integrity: { valid: false, issues: ['broken parent link'] } })),
    {
      action: 'fail',
      code: 'agent_checkpoint_integrity_invalid',
      reason: 'Checkpoint 完整性检查失败: broken parent link'
    }
  );
});

test('unreadable pending interrupt data is treated as checkpoint corruption', async () => {
  assert.deepEqual(
    await resolve(checkpointer({ readError: new Error('agent_checkpoint_interrupt_invalid') })),
    {
      action: 'fail',
      code: 'agent_checkpoint_interrupt_invalid',
      reason: 'agent_checkpoint_interrupt_invalid'
    }
  );
});

test('checkpoint validation errors retain their checkpoint classification', async () => {
  assert.deepEqual(await resolve(checkpointer({ integrityError: new Error('database read failed') })), {
    action: 'fail',
    code: 'agent_checkpoint_integrity_unavailable',
    reason: 'database read failed'
  });
});
test('checkpoint recovery methods must be available before a resume is allowed', async () => {
  for (const incomplete of [
    { hasCheckpoint: () => true },
    { readPendingInterrupts: () => null },
    { hasCheckpoint: () => true, validateCheckpointIntegrity: () => ({ valid: true, issues: [] }) }
  ]) {
    assert.deepEqual(await resolve(incomplete), {
      action: 'fail',
      code: 'agent_checkpoint_validation_unavailable',
      reason: 'Checkpoint 恢复验证不可用。'
    });
  }
});
