import { z } from 'zod';

export const executionEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1).max(256),
  streamId: z.string().min(1).max(512),
  projectId: z.string().min(1).max(256).nullable(),
  taskId: z.string().min(1).max(256).nullable(),
  runId: z.string().min(1).max(256).nullable(),
  sequence: z.number().int().positive(),
  eventType: z.string().min(1).max(128),
  actor: z.object({kind: z.literal('main'), id: z.string().min(1).max(128)}).strict(),
  correlationId: z.string().min(1).max(256),
  causationId: z.string().min(1).max(256).nullable(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  payloadRef: z.null(),
  payload: z.unknown(),
  createdAt: z.iso.datetime()
}).strict();
export type ExecutionEventEnvelope = z.infer<typeof executionEventEnvelopeSchema>;
