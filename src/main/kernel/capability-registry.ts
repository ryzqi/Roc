import {
  bindCapabilityOperationContext,
  getCapabilityOperationContext,
  recordCapabilityOperationReceipt,
  runWithCapabilityOperationContext
} from './capability-operation-context';
import type { CapabilityDescriptor, CapabilityHandler, RocCapabilityRegistry } from './types';
import { mainResourceActivity, type ResourceActivity } from '../services/resource-activity';
import { runWithCapabilityCancellation } from './capability-cancellation';

type CapabilityRecord = {
  pluginId: string;
  descriptor: CapabilityDescriptor;
  handler: CapabilityHandler | null;
};

export class CapabilityRegistry implements RocCapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityRecord>();

  constructor(private readonly activity: ResourceActivity = mainResourceActivity) {}

  declare(pluginId: string, descriptor: CapabilityDescriptor): void {
    if (this.capabilities.has(descriptor.name)) {
      throw new Error('capability_already_declared');
    }
    this.capabilities.set(descriptor.name, {
      pluginId,
      descriptor,
      handler: null
    });
  }

  register<TInput, TOutput>(
    pluginId: string,
    descriptor: CapabilityDescriptor<TInput, TOutput>,
    handler: CapabilityHandler<TInput, TOutput>
  ): void {
    const record = this.capabilities.get(descriptor.name);
    if (record === undefined) {
      throw new Error('capability_not_declared');
    }
    if (record.pluginId !== pluginId || !descriptorsMatch(record.descriptor, descriptor)) {
      throw new Error('capability_descriptor_mismatch');
    }
    if (record.handler !== null) {
      throw new Error('capability_already_registered');
    }
    // Heterogeneous storage erases types only after exact schema identity checks.
    record.handler = handler as CapabilityHandler;
  }

  unregister(pluginId: string): void {
    for (const record of this.capabilities.values()) if (record.pluginId === pluginId) record.handler = null;
  }

  async invoke<TInput, TOutput>(name: string, input: TInput, signal?: AbortSignal): Promise<TOutput> {
    const record = this.capabilities.get(name);
    if (record === undefined) {
      throw new Error('capability_not_found');
    }
    if (record.handler === null) {
      throw new Error('capability_not_ready');
    }
    const parsedInput = record.descriptor.inputSchema.parse(input);
    const operationContext = bindCapabilityOperationContext(
      getCapabilityOperationContext(),
      name,
      record.descriptor.version
    );
    if (operationContext !== undefined && record.descriptor.effectReceipt !== 'handler') {
      recordCapabilityOperationReceipt(operationContext);
    }
    const release = this.activity.begin('capability');
    try {
      const handler = record.handler;
      const output = await runWithCapabilityCancellation(signal, () => operationContext === undefined ? handler(parsedInput) :
        runWithCapabilityOperationContext(operationContext, () => handler(parsedInput, operationContext)));
      if (operationContext !== undefined && !operationContext.hasPublishedSideEffect()) {
        throw new Error('capability_effect_receipt_required');
      }
      return record.descriptor.outputSchema.parse(output) as TOutput;
    } finally {
      release();
    }
  }

  list(): readonly CapabilityDescriptor[] {
    return Array.from(this.capabilities.values(), (record) => record.descriptor);
  }
}

function descriptorsMatch(left: CapabilityDescriptor, right: CapabilityDescriptor): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    left.effectReceipt === right.effectReceipt &&
    left.inputSchema === right.inputSchema &&
    left.outputSchema === right.outputSchema
  );
}
