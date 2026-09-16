import { z } from 'zod';
import { researchFigureOptionsSchema } from './research-plotting';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchExperimentPathSchema = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith('/') && !/[\\\u0000-\u001f]/u.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
{ message: 'research_relative_path_invalid' });
const runtimePath = z.string().min(1).max(4096).refine((value) => value.startsWith('/') && !/[\u0000-\u001f]/u.test(value), { message: 'research_absolute_path_required' });
export const researchExperimentRuntimeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bundled-python') }).strict(),
  z.object({ kind: z.literal('uv') }).strict(),
  z.object({ kind: z.literal('renv'), rootPath: runtimePath, libraryPath: researchExperimentPathSchema }).strict(),
  z.object({ kind: z.literal('julia'), rootPath: runtimePath, depotPath: runtimePath }).strict()
]);
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
  projectId: z.string().min(1), runtime: researchExperimentRuntimeSchema
}).strict();
const researchExperimentStartFields = {
  requestId: z.string().min(1).max(128), label: z.string().trim().min(1).max(256), engine: z.enum(['python', 'r', 'julia', 'matplotlib']),
  runtime: researchExperimentRuntimeSchema, sourcePath: researchExperimentPathSchema,
  inputPaths: z.array(researchExperimentPathSchema).max(1000),
  arguments: z.array(z.string().max(8192).refine((value) => !value.includes('\u0000'))).max(100),
  parameters: z.record(z.string().min(1).max(256), z.string().max(65536)).refine((value) => Object.keys(value).length <= 1000),
  expectedEnvironmentHash: digest, timeoutMs: z.number().int().min(1000).max(3600000), network: z.enum(['disabled', 'enabled']),
  figure: researchFigureOptionsSchema.optional()
} as const;
function refineExperimentStart(value: { engine: 'python' | 'r' | 'julia' | 'matplotlib'; sourcePath: string; inputPaths: string[]; arguments: string[]; runtime: { kind: string }; figure?: unknown; network: string }, context: z.RefinementCtx): void {
  const extensions = { python: '.py', r: '.r', julia: '.jl', matplotlib: '.py' };
  if (!value.sourcePath.toLowerCase().endsWith(extensions[value.engine])) {
    context.addIssue({ code: 'custom', message: 'research_experiment_source_type_invalid', path: ['sourcePath'] });
  }
  if (new Set(value.inputPaths).size !== value.inputPaths.length) context.addIssue({ code: 'custom', message: 'research_experiment_duplicate_input', path: ['inputPaths'] });
  const expectedRuntime = value.engine === 'r' ? 'renv' : value.engine === 'julia' ? 'julia' : null;
  if (expectedRuntime === null ? !['bundled-python', 'uv'].includes(value.runtime.kind) : value.runtime.kind !== expectedRuntime) {
    context.addIssue({ code: 'custom', message: 'research_experiment_runtime_mismatch', path: ['runtime'] });
  }
  if (value.engine === 'matplotlib' ? value.figure === undefined : value.figure !== undefined) {
    context.addIssue({ code: 'custom', message: 'research_figure_options_invalid', path: ['figure'] });
  }
  if (value.engine === 'matplotlib' && value.network !== 'disabled') context.addIssue({ code: 'custom', message: 'research_figure_offline_required', path: ['network'] });
}
export const researchOwnedExperimentStartSchema = z.object(researchExperimentStartFields).strict().superRefine(refineExperimentStart);
export const researchExperimentStartSchema = z.object({
  projectId: z.string().min(1), ownerRunId: z.string().min(1).nullable().optional(), ...researchExperimentStartFields
}).strict().superRefine(refineExperimentStart);
export const researchExperimentExecutionSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), request: researchExperimentStartSchema, ownerRunId: z.string().min(1).nullable(),
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
export type ResearchExperimentEnvironment = z.infer<typeof researchExperimentEnvironmentSchema>;
export type ResearchExperimentStart = z.infer<typeof researchExperimentStartSchema>;
export type ResearchExperimentExecution = z.infer<typeof researchExperimentExecutionSchema>;
export type ResearchExperimentFile = z.infer<typeof researchExperimentFileSchema>;
export type ResearchExperimentFileContent = z.infer<typeof researchExperimentFileContentSchema>;
export type ResearchWorkspaceFile = z.infer<typeof researchWorkspaceFileSchema>;
export type ResearchWorkspaceFileContent = z.infer<typeof researchWorkspaceFileContentSchema>;
export type ResearchWorkspaceFileSaveRequest = z.infer<typeof researchWorkspaceFileSaveRequestSchema>;
