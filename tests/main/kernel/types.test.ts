import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  CapabilityDescriptor,
  RocCapabilityRegistry,
  RocEventBus,
  RocEventEnvelope,
  RocPlugin,
  RocPluginContext,
  RocPluginHealth,
  RocPluginManifest
} from '../../../src/main/kernel/types';

const inputSchema = z.object({ prompt: z.string().min(1) });
const outputSchema = z.object({ answer: z.string() });
const typesPath = fileURLToPath(new URL('../../../src/main/kernel/types.ts', import.meta.url));

describe('kernel canonical type contracts', () => {
  it('exists without legacy plugin aliases', () => {
    expect(existsSync(typesPath)).toBe(true);
    const source = readFileSync(typesPath, 'utf8');
    expect(source).not.toMatch(/type\s+Plugin\b/u);
    expect(source).not.toMatch(/type\s+PluginManifest\b/u);
    expect(source).not.toContain('init(');
    expect(source).not.toContain('cleanup(');
    expect(source).not.toContain(' on(');
    expect(source).not.toContain(' emit(');
  });

  it('defines the exact plugin manifest and lifecycle names', () => {
    const descriptor = {
      name: 'agent.answer',
      version: '1.0.0',
      inputSchema,
      outputSchema
    } satisfies CapabilityDescriptor<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>>;

    const manifest = {
      id: '@roc/plugin-agent',
      version: '1.0.0',
      displayName: 'Agent',
      description: 'Agent runtime plugin.',
      loadPhase: 'critical',
      required: true,
      order: 10,
      dependencies: [],
      capabilities: [descriptor]
    } satisfies RocPluginManifest;

    const plugin = {
      manifest,
      initialize: async () => {},
      shutdown: async () => {},
      healthCheck: async (): Promise<RocPluginHealth> => ({ status: 'healthy' })
    } satisfies RocPlugin;

    expect(Object.keys(plugin).sort()).toEqual(['healthCheck', 'initialize', 'manifest', 'shutdown']);
    expect(Object.keys(manifest).sort()).toEqual([
      'capabilities',
      'dependencies',
      'description',
      'displayName',
      'id',
      'loadPhase',
      'order',
      'required',
      'version'
    ]);
    expect(descriptor.inputSchema.parse({ prompt: 'hello' })).toEqual({ prompt: 'hello' });
    expect(descriptor.outputSchema.parse({ answer: 'world' })).toEqual({ answer: 'world' });
  });

  it('defines async event bus and capability registry method names', () => {
    expectTypeOf<RocEventBus>().toEqualTypeOf<{
      publish<TPayload>(event: RocEventEnvelope<TPayload>): Promise<void>;
      subscribe<TPayload>(
        type: string,
        handler: (event: RocEventEnvelope<TPayload>) => void | Promise<void>
      ): () => void;
    }>();

    expectTypeOf<RocCapabilityRegistry>().toEqualTypeOf<{
      declare(pluginId: string, descriptor: CapabilityDescriptor): void;
      register(pluginId: string, descriptor: CapabilityDescriptor, handler: (input: unknown) => Promise<unknown>): void;
      invoke<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
      list(): readonly CapabilityDescriptor[];
    }>();
  });

  it('scopes plugin context facades to the current plugin', () => {
    expectTypeOf<RocPluginContext['database']>().toEqualTypeOf<{
      getConnection(): Database;
      getCoreConnection(): Database;
    }>();
    expectTypeOf<RocPluginContext['config']>().toEqualTypeOf<{
      get<T>(key: string): T | null;
      set<T>(key: string, value: T): void;
    }>();
    expectTypeOf<RocPluginContext['secrets']>().toEqualTypeOf<{
      get(key: string): string | null;
      set(key: string, plaintext: string): void;
      clear(key: string): void;
    }>();
    expectTypeOf<RocPluginContext['logger']>().toEqualTypeOf<{
      info(message: string, metadata?: Record<string, unknown>): void;
      warn(message: string, metadata?: Record<string, unknown>): void;
      error(message: string, metadata?: Record<string, unknown>): void;
    }>();
  });
});
