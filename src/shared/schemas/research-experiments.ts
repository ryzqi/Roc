import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchExperimentPathSchema = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith('/') && !/[\\\u0000-\u001f]/u.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
{ message: 'research_relative_path_invalid' });
const runtimePath = z.string().min(1).max(4096).refine((value) => value.startsWith('/') && !/[\u0000-\u001f]/u.test(value), { message: 'research_absolute_path_required' });
export const researchExperimentRuntimeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bundled-node') }).strict(),
  z.object({ kind: z.literal('bundled-python') }).strict(),
  z.object({ kind: z.literal('uv') }).strict(),
  z.object({ kind: z.literal('renv'), rootPath: runtimePath, libraryPath: researchExperimentPathSchema }).strict(),
  z.object({ kind: z.literal('julia'), rootPath: runtimePath, depotPath: runtimePath }).strict()
]);
export const researchExperimentStartRuntimeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bundled-node') }).strict(),
  z.object({ kind: z.literal('renv'), rootPath: runtimePath, libraryPath: researchExperimentPathSchema }).strict(),
  z.object({ kind: z.literal('julia'), rootPath: runtimePath, depotPath: runtimePath }).strict()
]);
const nativeRuntimeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('renv'), rootPath: runtimePath, libraryPath: researchExperimentPathSchema }).strict(),
  z.object({ kind: z.literal('julia'), rootPath: runtimePath, depotPath: runtimePath }).strict()
]);
const pythonRuntimeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bundled-python') }).strict(),
  z.object({ kind: z.literal('uv') }).strict()
]);
const historicalRuntimeSchema = z.union([pythonRuntimeSchema, nativeRuntimeSchema]);
export const researchExperimentFileSchema = z.object({
  area: z.enum(['input', 'output', 'log']), path: researchExperimentPathSchema,
  sha256: digest, size: z.number().int().nonnegative()
}).strict();
export const researchExperimentEnvironmentSchema = z.object({
  runtime: researchExperimentRuntimeSchema, executable: z.string().min(1), prefix: z.string().min(1), basePrefix: z.string().min(1),
  version: z.string().min(1), platform: z.string().min(1), architecture: z.string().min(1), toolchainHash: digest, metadataHash: digest,
  packages: z.array(z.object({ name: z.string().min(1), version: z.string().min(1).nullable() }).strict()).max(10000),
  lockFiles: z.array(z.object({ path: researchExperimentPathSchema, sha256: digest, size: z.number().int().nonnegative() }).strict()),
  hash: digest
}).strict();
export const researchExperimentEnvironmentRequestSchema = z.object({
  projectId: z.string().min(1), runtime: researchExperimentStartRuntimeSchema
}).strict();
const experimentStartSharedFields = {
  requestId: z.string().min(1).max(128), label: z.string().trim().min(1).max(256),
  sourcePath: researchExperimentPathSchema, inputPaths: z.array(researchExperimentPathSchema).max(500),
  parameters: z.record(z.string().min(1).max(256), z.string().max(65536))
    .refine((value) => Object.keys(value).length <= 1000 && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1024 * 1024),
  expectedEnvironmentHash: digest.optional(), timeoutMs: z.number().int().min(1000).max(3600000), network: z.enum(['disabled', 'enabled'])
} as const;
const typescriptStartSchema = z.object({
  ...experimentStartSharedFields, engine: z.literal('typescript'), runtime: z.object({ kind: z.literal('bundled-node') }).strict(),
  sourceVersion: z.literal(1)
}).strict().superRefine((value, context) => {
  if (!value.sourcePath.toLowerCase().endsWith('.mts')) context.addIssue({ code: 'custom', message: 'research_experiment_source_type_invalid', path: ['sourcePath'] });
  if (new Set(value.inputPaths).size !== value.inputPaths.length) context.addIssue({ code: 'custom', message: 'research_experiment_duplicate_input', path: ['inputPaths'] });
});
const nativeStartSchema = z.object({
  ...experimentStartSharedFields, engine: z.enum(['r', 'julia']), runtime: nativeRuntimeSchema,
  arguments: z.array(z.string().max(8192).refine((value) => !value.includes(String.fromCharCode(0)))).max(100)
}).strict().superRefine((value, context) => {
  const extension = value.engine === 'r' ? '.r' : '.jl';
  const runtimeKind = value.engine === 'r' ? 'renv' : 'julia';
  if (!value.sourcePath.toLowerCase().endsWith(extension)) context.addIssue({ code: 'custom', message: 'research_experiment_source_type_invalid', path: ['sourcePath'] });
  if (new Set(value.inputPaths).size !== value.inputPaths.length) context.addIssue({ code: 'custom', message: 'research_experiment_duplicate_input', path: ['inputPaths'] });
  if (value.runtime.kind !== runtimeKind) context.addIssue({ code: 'custom', message: 'research_experiment_runtime_mismatch', path: ['runtime'] });
});
export const researchOwnedExperimentStartSchema = z.discriminatedUnion('engine', [typescriptStartSchema, nativeStartSchema]);
const historicalExperimentStartFields = {
  requestId: z.string().min(1).max(128), label: z.string().trim().min(1).max(256),
  sourcePath: researchExperimentPathSchema, inputPaths: z.array(researchExperimentPathSchema).max(1000),
  parameters: z.record(z.string().min(1).max(256), z.string().max(65536)).refine((value) => Object.keys(value).length <= 1000),
  expectedEnvironmentHash: digest.optional(), timeoutMs: z.number().int().min(1000).max(3600000), network: z.enum(['disabled', 'enabled'])
} as const;
const historicalExperimentStartSchema = z.object({
  projectId: z.string().min(1), ownerRunId: z.string().min(1).nullable().optional(), ...historicalExperimentStartFields,
  engine: z.enum(['python', 'r', 'julia']), runtime: historicalRuntimeSchema,
  arguments: z.array(z.string().max(8192).refine((value) => !value.includes(String.fromCharCode(0)))).max(100)
}).strict().superRefine((value, context) => {
  let extension = '.py';
  let expectedRuntime: string | null = null;
  switch (value.engine) {
    case 'python': break;
    case 'r': extension = '.r'; expectedRuntime = 'renv'; break;
    case 'julia': extension = '.jl'; expectedRuntime = 'julia'; break;
  }
  if (!value.sourcePath.toLowerCase().endsWith(extension)) context.addIssue({ code: 'custom', message: 'research_experiment_source_type_invalid', path: ['sourcePath'] });
  if (new Set(value.inputPaths).size !== value.inputPaths.length) context.addIssue({ code: 'custom', message: 'research_experiment_duplicate_input', path: ['inputPaths'] });
  if (expectedRuntime === null ? !['bundled-python', 'uv'].includes(value.runtime.kind) : value.runtime.kind !== expectedRuntime) {
    context.addIssue({ code: 'custom', message: 'research_experiment_runtime_mismatch', path: ['runtime'] });
  }
});
const typescriptProjectStartSchema = typescriptStartSchema.extend({
  projectId: z.string().min(1), ownerRunId: z.string().min(1).nullable().optional()
});
const nativeProjectStartSchema = nativeStartSchema.extend({
  projectId: z.string().min(1), ownerRunId: z.string().min(1).nullable().optional()
});
export const researchExperimentStartSchema = z.discriminatedUnion('engine', [typescriptProjectStartSchema, nativeProjectStartSchema]);
export const researchExperimentHistoryStartSchema = z.union([researchExperimentStartSchema, historicalExperimentStartSchema]);
export const researchExperimentExecutionSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), request: researchExperimentHistoryStartSchema, ownerRunId: z.string().min(1).nullable(),
  workspacePath: z.string().min(1), workspaceRoot: z.string().min(1), status: z.enum(['preparing', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  environment: researchExperimentEnvironmentSchema.nullable(), files: z.array(researchExperimentFileSchema),
  inputHash: digest.nullable(), exitCode: z.number().int().nullable(), error: z.string().nullable(), artifactId: z.string().nullable(),
  createdAt: z.string(), startedAt: z.string().nullable(), endedAt: z.string().nullable()
}).strict();
export const researchExperimentIdRequestSchema = z.object({ projectId: z.string().min(1), runId: z.string().min(1) }).strict();
export const researchExperimentListRequestSchema = z.object({ projectId: z.string().min(1), limit: z.number().int().min(1).max(200) }).strict();
export const researchExperimentFileRequestSchema = researchExperimentIdRequestSchema.extend({
  area: researchExperimentFileSchema.shape.area, path: researchExperimentPathSchema
}).strict();
export const researchExperimentFileContentSchema = z.object({ file: researchExperimentFileSchema, content: z.string(), encoding: z.enum(['utf8', 'base64']) }).strict();
export const researchExperimentSourceRequestSchema = researchExperimentFileRequestSchema.extend({ sha256: digest }).strict();
export const researchExperimentEvidenceRequestSchema = z.object({ projectId: z.string().min(1), evidenceId: z.string().min(1) }).strict();
export const researchWorkspaceFileSchema = z.object({
  projectId: z.string().min(1), path: researchExperimentPathSchema, sha256: digest, size: z.number().int().nonnegative(),
  revision: z.number().int().positive(), ownerRunId: z.string().min(1).nullable(), updatedAt: z.string()
}).strict();
export const researchWorkspaceFileContentSchema = researchWorkspaceFileSchema.extend({ content: z.string() }).strict();
export const researchWorkspaceFileRequestSchema = z.object({ projectId: z.string().min(1), path: researchExperimentPathSchema }).strict();
export const researchWorkspaceFileSaveRequestSchema = researchWorkspaceFileRequestSchema.extend({
  content: z.string().max(1024 * 1024), expectedHash: digest.nullable()
}).strict();

export type ResearchExperimentRuntime = z.infer<typeof researchExperimentRuntimeSchema>;
export type ResearchExperimentStartRuntime = z.infer<typeof researchExperimentStartRuntimeSchema>;
export type ResearchExperimentEnvironment = z.infer<typeof researchExperimentEnvironmentSchema>;
export type ResearchExperimentStart = z.infer<typeof researchExperimentStartSchema>;
export type ResearchExperimentHistoryStart = z.infer<typeof researchExperimentHistoryStartSchema>;
export type ResearchExperimentExecution = z.infer<typeof researchExperimentExecutionSchema>;
export type ResearchExperimentFile = z.infer<typeof researchExperimentFileSchema>;
export type ResearchExperimentFileContent = z.infer<typeof researchExperimentFileContentSchema>;
export type ResearchWorkspaceFile = z.infer<typeof researchWorkspaceFileSchema>;
export type ResearchWorkspaceFileContent = z.infer<typeof researchWorkspaceFileContentSchema>;
export type ResearchWorkspaceFileSaveRequest = z.infer<typeof researchWorkspaceFileSaveRequestSchema>;
