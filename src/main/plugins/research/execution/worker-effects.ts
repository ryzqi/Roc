import {createCapabilityOperationContext, runWithCapabilityOperationContext} from '../../../kernel/capability-operation-context';
import {AgentToolEffectStore, hashToolInput, type ToolEffectOperationInput} from '../../../services/deep-agent/tool-effect-store';
import type {ResearchTaskGraphRepository} from './task-graph';
import {researchWorkerLease} from './worker-context';

/** The model's call ID is an attempt detail. Frozen node + tool + parameters own the effect. */
export class ResearchWorkerEffects {
  constructor(private readonly graph: ResearchTaskGraphRepository, private readonly store: AgentToolEffectStore) {}

  recover(nodeId: string): void { this.store.markRestartedUnknown(nodeId); }

  async execute(toolName: string, args: unknown, effectClass: ToolEffectOperationInput['effectClass'], work: () => Promise<unknown>): Promise<unknown> {
    const worker = researchWorkerLease();
    const node = this.graph.assertLease(worker);
    // These request IDs identify transport attempts, not distinct scientific work.
    const identityArgs = ['start_experiment', 'start_figure', 'prepare_export'].includes(toolName)
      && typeof args === 'object' && args !== null && !Array.isArray(args)
      ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'requestId')) : args;
    const operation = this.store.beginOperation({runId: node.id, threadId: node.taskId,
      executionPath: node.operationKey, checkpointId: node.inputHash, toolCallId: hashToolInput({toolName, args: identityArgs}),
      toolName, canonicalToolIdentity: `research.stage.${toolName}`, toolVersion: '1', args: identityArgs,
      effectClass, reconcileStrategy: 'manual_confirmation'});
    if (operation.kind === 'replay') return operation.result;
    const lease = operation.lease;
    const context = createCapabilityOperationContext({...lease, recordReceipt: receipt => this.store.recordReceipt(lease, receipt)});
    this.store.markStarted(lease);
    try {
      const result = await runWithCapabilityOperationContext(context, work);
      this.graph.commit(worker, () => this.store.finishSuccess(lease, result));
      return result;
    } catch (error) {
      // A late/failed callback cannot prove that an external effect did not occur.
      this.store.finishUnknown(lease, error);
      throw error;
    }
  }
}
