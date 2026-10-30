import { AsyncLocalStorage } from 'node:async_hooks';

export type CapabilityOperationReceipt =
  | Readonly<{
      schemaVersion: 1;
      kind: 'workspace_write';
      phase: 'prepared' | 'published' | 'durable';
      path: string;
      expectedVersion: string | null;
      resultHash: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: 'capability';
      phase: 'request_sent' | 'provider_confirmed';
      capabilityName: string;
      capabilityVersion: string;
      idempotencyKey: string;
      providerReceiptId: string | null;
      evidenceHash: string | null;
    }>;

export type CapabilityOperationContext = Readonly<{
  operationId: string;
  idempotencyKey: string;
  toolCallId: string;
  toolName: string;
  canonicalToolIdentity: string;
  toolVersion: string;
  attemptId: string;
  leaseGeneration: number;
  capabilityName?: string;
  capabilityVersion?: string;
  recordReceipt(receipt: CapabilityOperationReceipt): void;
  markSideEffectPublished(): void;
  hasPublishedSideEffect(): boolean;
}>;

type CapabilityOperationContextInput = Omit<
  CapabilityOperationContext,
  'capabilityName' | 'capabilityVersion' | 'markSideEffectPublished' | 'hasPublishedSideEffect'
>;

const operationContextStorage = new AsyncLocalStorage<CapabilityOperationContext>();

export function createCapabilityOperationContext(input: CapabilityOperationContextInput): CapabilityOperationContext {
  let publishedSideEffect = false;
  return Object.freeze({
    ...input,
    markSideEffectPublished: () => {
      publishedSideEffect = true;
    },
    hasPublishedSideEffect: () => publishedSideEffect
  });
}

export function runWithCapabilityOperationContext<TResult>(
  context: CapabilityOperationContext,
  operation: () => TResult
): TResult {
  return operationContextStorage.run(context, operation);
}

export function getCapabilityOperationContext(): CapabilityOperationContext | undefined {
  return operationContextStorage.getStore();
}

export function bindCapabilityOperationContext(
  context: CapabilityOperationContext | undefined,
  capabilityName: string,
  capabilityVersion: string
): CapabilityOperationContext | undefined {
  if (context === undefined) {
    return undefined;
  }
  return Object.freeze({ ...context, capabilityName, capabilityVersion });
}
