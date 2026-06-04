import type { CapabilityDescriptor, RocCapabilityRegistry } from './types';

type CapabilityHandler = (input: unknown) => Promise<unknown>;

type CapabilityRecord = {
  pluginId: string;
  descriptor: CapabilityDescriptor;
  handler: CapabilityHandler | null;
};

export class CapabilityRegistry implements RocCapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityRecord>();

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

  register(pluginId: string, descriptor: CapabilityDescriptor, handler: CapabilityHandler): void {
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
    record.handler = handler;
  }

  async invoke<TInput, TOutput>(name: string, input: TInput): Promise<TOutput> {
    const record = this.capabilities.get(name);
    if (record === undefined) {
      throw new Error('capability_not_found');
    }
    if (record.handler === null) {
      throw new Error('capability_not_ready');
    }
    const parsedInput = record.descriptor.inputSchema.parse(input);
    const output = await record.handler(parsedInput);
    return record.descriptor.outputSchema.parse(output) as TOutput;
  }

  list(): readonly CapabilityDescriptor[] {
    return Array.from(this.capabilities.values(), (record) => record.descriptor);
  }
}

function descriptorsMatch(left: CapabilityDescriptor, right: CapabilityDescriptor): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    left.inputSchema === right.inputSchema &&
    left.outputSchema === right.outputSchema
  );
}
