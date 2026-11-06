import { z } from 'zod';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

/** A root Task is not a DAG node. S02 deliberately dispatches only `none`. */
export const executionNodeBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('dag'), nodeId: id, graphRevision: z.number().int().positive() }).strict()
]);

export const executionInputVersionSchema = z.object({
  kind: z.enum(['skill', 'source', 'artifact', 'plan', 'context']),
  id,
  hash
}).strict();

/** Hashes describe the bytes captured at dispatch, never a later lookup of "current". */
export const frozenExecutionInputsSchema = z.object({
  schemaVersion: z.literal(1),
  requestHash: hash,
  manifestHash: hash,
  policyHash: hash,
  versions: z.array(executionInputVersionSchema).max(2048)
}).strict();

export const executionOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), runId: id, grantId: id, requestHash: hash }).strict(),
  z.object({ kind: z.literal('main'), action: z.enum(['start', 'retry', 'review', 'owned']), requestId: id }).strict(),
  z.object({ kind: z.literal('historical'), auditId: id, reason: id }).strict()
]);

export type FrozenExecutionInputs = z.infer<typeof frozenExecutionInputsSchema>;
export type ExecutionOrigin = z.infer<typeof executionOriginSchema>;
