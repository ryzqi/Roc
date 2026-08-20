import type { ActiveChatRun, ChatStartRunRequest } from '../../../shared/types';
import type { PendingInterrupt } from './interrupt-projection';

type ActiveRunMetadata = {
  request: ChatStartRunRequest;
  threadId: string | null;
};

type ActiveRunRegistration = ActiveRunMetadata & {
  abortController: AbortController;
  runId: string;
};

export type ActiveRunCancellation = {
  abortController: AbortController;
  metadata: ActiveRunMetadata;
};

export class AgentActiveRunLifecycle {
  private readonly activeRuns = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly metadata = new Map<string, ActiveRunMetadata>();
  private readonly pendingInterrupts = new Map<string, PendingInterrupt[]>();
  private readonly pendingRuns = new Map<string, Promise<void>>();
  private readonly scheduledRuns = new Set<NodeJS.Timeout>();

  constructor(private readonly onPendingRunRejected: (error: unknown) => void) {}

  activate(input: ActiveRunRegistration): void {
    this.activeRuns.add(input.runId);
    this.abortControllers.set(input.runId, input.abortController);
    this.metadata.set(input.runId, {
      request: input.request,
      threadId: input.threadId
    });
  }

  isActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  async cancel(runId: string): Promise<ActiveRunCancellation | null> {
    if (!this.activeRuns.has(runId)) {
      return null;
    }
    const abortController = this.abortControllers.get(runId);
    if (abortController === undefined) {
      throw new Error('agent_run_abort_controller_missing');
    }
    const metadata = this.metadata.get(runId);
    if (metadata === undefined) {
      throw new Error('agent_run_metadata_missing');
    }
    this.activeRuns.delete(runId);
    abortController.abort();
    const pendingRun = this.pendingRuns.get(runId);
    if (pendingRun !== undefined) {
      await pendingRun;
    }
    return {
      abortController,
      metadata
    };
  }

  finish(runId: string): void {
    this.activeRuns.delete(runId);
    this.metadata.delete(runId);
    this.abortControllers.delete(runId);
    this.pendingInterrupts.delete(runId);
  }

  findActiveRun(threadId: string): ActiveChatRun | null {
    for (const runId of this.activeRuns) {
      const metadata = this.metadata.get(runId);
      if (metadata?.threadId !== threadId) {
        continue;
      }
      return {
        runId,
        threadId,
        status: this.pendingInterrupts.has(runId) ? 'waiting_user' : 'running'
      };
    }
    return null;
  }

  readPendingInterrupts(runId: string): PendingInterrupt[] | undefined {
    return this.pendingInterrupts.get(runId);
  }

  replacePendingInterrupts(runId: string, interrupts: readonly PendingInterrupt[]): void {
    if (interrupts.length === 0) {
      this.pendingInterrupts.delete(runId);
      return;
    }
    this.pendingInterrupts.set(runId, [...interrupts]);
  }

  trackPendingRun(runId: string, pendingRun: Promise<void>): void {
    if (this.pendingRuns.has(runId)) {
      throw new Error('agent_pending_run_already_tracked');
    }
    this.pendingRuns.set(runId, pendingRun);
    void pendingRun.then(
      () => this.removePendingRun(runId, pendingRun),
      (error: unknown) => {
        this.removePendingRun(runId, pendingRun);
        this.onPendingRunRejected(error);
      }
    );
  }

  schedule(run: () => void): void {
    const timer = setTimeout(() => {
      this.scheduledRuns.delete(timer);
      run();
    }, 0);
    this.scheduledRuns.add(timer);
  }

  async shutdown(): Promise<void> {
    for (const timer of this.scheduledRuns) {
      clearTimeout(timer);
    }
    this.scheduledRuns.clear();
    if (this.pendingRuns.size > 0) {
      await Promise.allSettled([...this.pendingRuns.values()]);
    }
  }

  private removePendingRun(runId: string, pendingRun: Promise<void>): void {
    if (this.pendingRuns.get(runId) === pendingRun) {
      this.pendingRuns.delete(runId);
    }
  }
}
