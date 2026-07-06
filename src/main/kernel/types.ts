import type { Database } from 'better-sqlite3';
import type { z } from 'zod';

export type PluginLoadPhase = 'critical' | 'deferred' | 'on_demand';

export type RocPluginHealth =
  | { status: 'healthy' }
  | { status: 'degraded'; reason: string }
  | { status: 'unhealthy'; reason: string };

export type CapabilityDescriptor<TInput = unknown, TOutput = unknown> = {
  readonly name: string;
  readonly version: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
};

export type RocPluginManifest = {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly loadPhase: PluginLoadPhase;
  readonly required: boolean;
  readonly order: number;
  readonly dependencies: readonly string[];
  readonly capabilityDependencies?: readonly string[];
  readonly capabilities: readonly CapabilityDescriptor[];
};

export type RocEventEnvelope<TPayload = unknown> = {
  readonly type: string;
  readonly source: string;
  readonly payload: TPayload;
  readonly createdAt: string;
};

export type EventSubscription = () => void;

export type RocEventBus = {
  publish<TPayload>(event: RocEventEnvelope<TPayload>): Promise<void>;
  subscribe<TPayload>(
    type: string,
    handler: (event: RocEventEnvelope<TPayload>) => void | Promise<void>
  ): EventSubscription;
};

export type RocCapabilityRegistry = {
  declare(pluginId: string, descriptor: CapabilityDescriptor): void;
  register(pluginId: string, descriptor: CapabilityDescriptor, handler: (input: unknown) => Promise<unknown>): void;
  invoke<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
  list(): readonly CapabilityDescriptor[];
};

export type RocPluginContext = {
  readonly pluginId: string;
  readonly eventBus: RocEventBus;
  readonly capabilities: RocCapabilityRegistry;
  readonly database: {
    getConnection(): Database;
    getCoreConnection(): Database;
    getAgentConnection(): Database;
    getMemoryConnection(): Database;
    getTaskConnection(): Database;
  };
  readonly config: { get<T>(key: string): T | null; set<T>(key: string, value: T): void };
  readonly secrets: { get(key: string): string | null; set(key: string, plaintext: string): void; clear(key: string): void };
  readonly logger: {
    info(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
    error(message: string, metadata?: Record<string, unknown>): void;
  };
};

export type RocPlugin = {
  readonly manifest: RocPluginManifest;
  initialize(context: RocPluginContext): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<RocPluginHealth>;
};
