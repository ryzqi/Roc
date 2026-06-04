import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../src/main/kernel/capability-registry';
import type { CapabilityDescriptor } from '../../../src/main/kernel/types';

const echoInputSchema = z.object({ value: z.string().min(1) });
const echoOutputSchema = z.object({ echoed: z.string() });
const countInputSchema = z.object({ items: z.array(z.string()) });
const countOutputSchema = z.object({ count: z.number().int().nonnegative() });

function echoDescriptor(): CapabilityDescriptor<z.infer<typeof echoInputSchema>, z.infer<typeof echoOutputSchema>> {
  return {
    name: 'agent.echo',
    version: '1.0.0',
    inputSchema: echoInputSchema,
    outputSchema: echoOutputSchema
  };
}

function countDescriptor(): CapabilityDescriptor<z.infer<typeof countInputSchema>, z.infer<typeof countOutputSchema>> {
  return {
    name: 'agent.count',
    version: '1.0.0',
    inputSchema: countInputSchema,
    outputSchema: countOutputSchema
  };
}

describe('CapabilityRegistry', () => {
  it('rejects duplicate capability declarations', () => {
    const registry = new CapabilityRegistry();
    const descriptor = echoDescriptor();

    registry.declare('@roc/plugin-agent', descriptor);

    expect(() => registry.declare('@roc/plugin-task', descriptor)).toThrow(/capability_already_declared/u);
  });

  it('rejects handler registration before declaration', () => {
    const registry = new CapabilityRegistry();

    expect(() => registry.register('@roc/plugin-agent', echoDescriptor(), async () => ({ echoed: 'ok' }))).toThrow(
      /capability_not_declared/u
    );
  });

  it('lists declared capabilities before handlers are ready', async () => {
    const registry = new CapabilityRegistry();
    const descriptor = echoDescriptor();

    registry.declare('@roc/plugin-agent', descriptor);

    expect(registry.list()).toEqual([descriptor]);
    await expect(registry.invoke('agent.echo', { value: 'hello' })).rejects.toThrow(/capability_not_ready/u);
  });

  it('validates input before handler invocation and output after handler invocation', async () => {
    const registry = new CapabilityRegistry();
    const descriptor = echoDescriptor();
    const inputs: unknown[] = [];
    registry.declare('@roc/plugin-agent', descriptor);
    registry.register('@roc/plugin-agent', descriptor, async (input) => {
      inputs.push(input);
      return { echoed: (input as { value: string }).value };
    });

    await expect(registry.invoke('agent.echo', {})).rejects.toThrow(z.ZodError);
    expect(inputs).toEqual([]);
    await expect(registry.invoke('agent.echo', { value: 'hello' })).resolves.toEqual({ echoed: 'hello' });

    const invalidOutputDescriptor = countDescriptor();
    registry.declare('@roc/plugin-agent', invalidOutputDescriptor);
    registry.register('@roc/plugin-agent', invalidOutputDescriptor, async () => ({ count: -1 }));

    await expect(registry.invoke('agent.count', { items: ['a'] })).rejects.toThrow(z.ZodError);
  });

  it('rejects unknown capabilities', async () => {
    const registry = new CapabilityRegistry();

    await expect(registry.invoke('agent.missing', { value: 'hello' })).rejects.toThrow(/capability_not_found/u);
  });

  it('requires runtime registration descriptor to match declaration exactly', () => {
    const registry = new CapabilityRegistry();
    const descriptor = echoDescriptor();
    registry.declare('@roc/plugin-agent', descriptor);

    expect(() =>
      registry.register(
        '@roc/plugin-agent',
        {
          ...descriptor,
          version: '2.0.0'
        },
        async () => ({ echoed: 'ok' })
      )
    ).toThrow(/capability_descriptor_mismatch/u);
  });
});
