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

export function recordCapabilityOperationReceipt(context = getCapabilityOperationContext()): void {
  if (context === undefined) return;
  if (context.capabilityName === undefined || context.capabilityVersion === undefined) {
    throw new Error('capability_operation_binding_required');
  }
  context.recordReceipt({schemaVersion: 1, kind: 'capability', phase: 'request_sent',
    capabilityName: context.capabilityName, capabilityVersion: context.capabilityVersion,
    idempotencyKey: context.idempotencyKey, providerReceiptId: null, evidenceHash: null});
  context.markSideEffectPublished();
}

/** Detached work owns its effects; it must not retain the launching tool's lease. */
export function runWithoutCapabilityOperationContext<TResult>(operation: () => TResult): TResult {
  return operationContextStorage.exit(operation);
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
