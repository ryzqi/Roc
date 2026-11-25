import { z } from 'zod';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().min(1).max(4096).startsWith('/').regex(/^[^\u0000-\u001f]+$/u);
export const researchPythonEnvironmentPrepareSchema = z.strictObject({ projectId: id, requestId: id });
export const researchPythonEnvironmentGetSchema = z.strictObject({ projectId: id, environmentId: id, expectedHash: hash });
export const researchPythonEnvironmentListSchema = z.strictObject({ projectId: id });
export const researchPythonEnvironmentCancelSchema = z.strictObject({ projectId: id, operationId: id });
export const researchPythonEnvironmentActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), id: z.string().regex(/^window:[1-9][0-9]*$/u) }),
  z.strictObject({ kind: z.literal('system'), id: z.literal('roc-python-environment') }),
  z.strictObject({ kind: z.literal('run'), id })
]);
const lockFile = z.strictObject({ path: z.enum(['pyproject.toml', 'uv.lock', '.python-version']),
  size: z.number().int().positive().max(4 * 1024 ** 2), sha256: hash });
export const researchPythonEnvironmentSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(2), id, request: researchPythonEnvironmentPrepareSchema, requestHash: hash,
  actor: researchPythonEnvironmentActorSchema,
  workspacePath: path, selectedExecutable: path, executable: path, prefix: path, basePrefix: path,
  version: z.string().regex(/^3\.14\.\d+$/u), platform: z.literal('darwin'), architecture: z.literal('arm64'),
  metadataHash: hash, codeHash: hash,
  lockFiles: lockFile.array().length(3).refine(files => new Set(files.map(file => file.path)).size === 3),
  managedRuntime: z.strictObject({ version: z.string().regex(/^3\.14\.\d+$/u), pythonKey: id, uvHash: hash, receiptHash: hash }),
  recordedAt: z.iso.datetime()
});
export const researchPythonEnvironmentReceiptSchema = z.strictObject({
  snapshot: researchPythonEnvironmentSnapshotSchema, snapshotHash: hash
});
export const researchPythonEnvironmentPhaseSchema = z.enum(['queued', 'validating', 'downloading_runtime', 'creating_venv',
  'resolving', 'syncing', 'verifying', 'ready', 'failed', 'cancelled', 'interrupted']);
export const researchPythonEnvironmentOperationSchema = z.strictObject({
  schemaVersion: z.literal(1), id, request: researchPythonEnvironmentPrepareSchema,
  actor: researchPythonEnvironmentActorSchema, workspacePath: path, ownerRunId: id.nullable(),
  phase: researchPythonEnvironmentPhaseSchema, errorCode: id.nullable(),
  environmentRef: researchPythonEnvironmentGetSchema.nullable(),
  startedAt: z.iso.datetime(), updatedAt: z.iso.datetime()
}).refine(value => value.phase === 'ready' ? value.environmentRef !== null && value.errorCode === null : value.environmentRef === null,
  {message: 'research_python_operation_result_invalid'})
  .refine(value => value.actor.kind === 'run' ? value.ownerRunId === value.actor.id : value.ownerRunId === null,
    {message: 'research_python_operation_owner_invalid'})
  .refine(value => value.environmentRef === null || value.environmentRef.projectId === value.request.projectId,
    {message: 'research_python_operation_project_invalid'});
export const researchPythonEnvironmentStatusSchema = z.strictObject({
  operation: researchPythonEnvironmentOperationSchema.nullable(), environment: researchPythonEnvironmentReceiptSchema.nullable()
});
export const pythonEnvironmentActivePhases: ReadonlySet<string> = new Set(['queued', 'validating', 'downloading_runtime', 'creating_venv', 'resolving', 'syncing', 'verifying']);
export type ResearchPythonEnvironmentPrepare = z.infer<typeof researchPythonEnvironmentPrepareSchema>;
export type ResearchPythonEnvironmentGet = z.infer<typeof researchPythonEnvironmentGetSchema>;
export type ResearchPythonEnvironmentCancel = z.infer<typeof researchPythonEnvironmentCancelSchema>;
export type ResearchPythonEnvironmentSnapshot = z.infer<typeof researchPythonEnvironmentSnapshotSchema>;
export type ResearchPythonEnvironmentReceipt = z.infer<typeof researchPythonEnvironmentReceiptSchema>;
export type ResearchPythonEnvironmentOperation = z.infer<typeof researchPythonEnvironmentOperationSchema>;
export type ResearchPythonEnvironmentStatus = z.infer<typeof researchPythonEnvironmentStatusSchema>;
