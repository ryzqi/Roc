import {z} from 'zod';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchNodeOutputSchema = z.object({revision: z.number().int().positive(), hash,
  artifactIds: z.array(id), schemaVersion: z.number().int().positive()}).strict();
export const researchNodeLeaseSchema = z.object({
  nodeId: id, taskId: id, projectId: id, executionId: id, workerId: id,
  generation: z.number().int().positive(), revision: z.number().int().positive(), inputHash: hash,
  expiresAt: z.iso.datetime()
}).strict();
export const researchTaskNodeSchema = z.object({
  schemaVersion: z.literal(1), id, taskId: id, projectId: id, executionId: id,
  stage: id, role: id, graphRevision: z.number().int().positive(), revision: z.number().int().positive(),
  inputHash: hash, operationKey: hash, readonly: z.boolean(),
  status: z.enum(['pending', 'ready', 'running', 'pending_review', 'done', 'failed', 'cancelled', 'interrupted', 'blocked']),
  reason: id.nullable(), attempt: z.number().int().nonnegative(), generation: z.number().int().nonnegative(),
  outputRevision: z.number().int().nonnegative(),
  lease: researchNodeLeaseSchema.nullable(),
  output: researchNodeOutputSchema.nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()
}).strict().superRefine((node, ctx) => {
  if ((node.status === 'running') !== (node.lease !== null)) {
    ctx.addIssue({code: 'custom', message: 'research_node_lease_state_invalid'});
  }
  if (node.lease !== null && (node.lease.nodeId !== node.id || node.lease.taskId !== node.taskId ||
      node.lease.projectId !== node.projectId || node.lease.executionId !== node.executionId ||
      node.lease.generation !== node.generation || node.lease.revision !== node.revision || node.lease.inputHash !== node.inputHash)) {
    ctx.addIssue({code: 'custom', message: 'research_node_lease_identity_invalid'});
  }
  if (node.output !== null && node.output.revision !== node.outputRevision) {
    ctx.addIssue({code: 'custom', message: 'research_node_output_revision_invalid'});
  }
});
export const researchTaskGraphSchema = z.object({
  revision: z.number().int().nonnegative(), nodes: z.array(researchTaskNodeSchema),
  edges: z.array(z.object({prerequisite: id, dependent: id}).strict())
}).strict();
export type ResearchNodeLease = z.infer<typeof researchNodeLeaseSchema>;
export type ResearchTaskNode = z.infer<typeof researchTaskNodeSchema>;
export type ResearchTaskGraph = z.infer<typeof researchTaskGraphSchema>;
