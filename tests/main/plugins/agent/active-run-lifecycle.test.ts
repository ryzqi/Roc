import { describe, expect, it, vi } from 'vitest';

import { AgentActiveRunLifecycle } from '../../../../src/main/plugins/agent/active-run-lifecycle';

describe('AgentActiveRunLifecycle', () => {
  it('keeps active identity, interrupts, cancellation, and finish cleanup behind one interface', async () => {
    const lifecycle = new AgentActiveRunLifecycle(vi.fn());
    const abortController = new AbortController();
    lifecycle.activate({
      abortController,
      runId: 'run-1',
      request: startRequest(),
      threadId: 'thread-1'
    });
    lifecycle.replacePendingInterrupts('run-1', [pendingInterrupt()]);

    expect(lifecycle.findActiveRun('thread-1')).toEqual({
      runId: 'run-1',
      threadId: 'thread-1',
      status: 'waiting_user'
    });

    const cancellation = await lifecycle.cancel('run-1');
    expect(cancellation?.abortController.signal.aborted).toBe(true);
    expect(cancellation?.metadata).toEqual({ request: startRequest(), threadId: 'thread-1' });
    expect(lifecycle.findActiveRun('thread-1')).toBeNull();

    lifecycle.finish('run-1');
    expect(lifecycle.isActive('run-1')).toBe(false);
    expect(lifecycle.readPendingInterrupts('run-1')).toBeUndefined();
  });

  it('tracks one pending execution per run and reports detached rejection once', async () => {
    const onRejected = vi.fn();
    const lifecycle = new AgentActiveRunLifecycle(onRejected);
    const rejected = Promise.reject(new Error('execution_failed'));

    lifecycle.trackPendingRun('run-1', rejected);
    expect(() => lifecycle.trackPendingRun('run-1', Promise.resolve())).toThrow('agent_pending_run_already_tracked');
    await lifecycle.shutdown();

    expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ message: 'execution_failed' }));
    expect(() => lifecycle.trackPendingRun('run-1', Promise.resolve())).not.toThrow();
  });
});

function startRequest() {
  return {
    input: 'Run task',
    mode: 'task' as const,
    enabledCapabilities: { mcpServers: [], skills: [] }
  };
}

function pendingInterrupt() {
  return {
    interruptId: 'interrupt-1',
    payload: {
      kind: 'question' as const,
      question: 'Continue?'
    }
  };
}
