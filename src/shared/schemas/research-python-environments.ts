import { z } from 'zod';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().min(1).max(4096).startsWith('/').regex(/^[^\u0000-\u001f]+$/u);

/** Paths and human actors come from main, never from selection arguments. */
export const researchPythonEnvironmentSelectSchema = z.strictObject({ projectId: id, requestId: id });
export const researchPythonEnvironmentGetSchema = z.strictObject({ projectId: id, selectionId: id, expectedHash: hash });
export const researchPythonEnvironmentListSchema = z.strictObject({ projectId: id });
export const researchPythonEnvironmentSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), id, request: researchPythonEnvironmentSelectSchema, requestHash: hash,
  actor: z.strictObject({ kind: z.literal('user'), id: z.string().regex(/^window:[1-9][0-9]*$/u) }),
  workspacePath: path, selectedExecutable: path, executable: path, prefix: path, basePrefix: path,
  version: z.string().regex(/^3\.14\.\d+$/u), platform: z.literal('darwin'), architecture: z.literal('arm64'),
  metadataHash: hash, codeHash: hash,
  lockFile: z.strictObject({ path: z.literal('roc-python.lock.json'), size: z.number().int().positive().max(4 * 1024 ** 2), sha256: hash }),
  recordedAt: z.iso.datetime()
});
export const researchPythonEnvironmentSelectionSchema = z.strictObject({
  snapshot: researchPythonEnvironmentSnapshotSchema, snapshotHash: hash
});
export type ResearchPythonEnvironmentSelect = z.infer<typeof researchPythonEnvironmentSelectSchema>;
export type ResearchPythonEnvironmentGet = z.infer<typeof researchPythonEnvironmentGetSchema>;
export type ResearchPythonEnvironmentSnapshot = z.infer<typeof researchPythonEnvironmentSnapshotSchema>;
export type ResearchPythonEnvironmentSelection = z.infer<typeof researchPythonEnvironmentSelectionSchema>;
