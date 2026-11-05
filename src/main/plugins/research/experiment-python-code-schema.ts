import { z } from 'zod';
import { join } from 'node:path';
import { nativeCodeSnapshotSchema } from './experiment-native-code-schema';
import { researchContentHash } from './research-files';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().min(1).max(4096).startsWith('/').regex(/^[^\u0000-\u001f]+$/u);
const distributions = z.array(z.strictObject({
  name: z.string().max(256).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  version: z.string().min(1).max(256).regex(/^[0-9][A-Za-z0-9.!+_-]*$/u)
})).max(10000).superRefine((items, context) => {
  if (new Set(items.map(item => item.name)).size !== items.length) {
    context.addIssue({ code: 'custom', message: 'research_python_distribution_duplicate' });
  }
});
export const pythonEnvironmentLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  python: z.strictObject({
    implementation: z.literal('cpython'), version: z.string().regex(/^3\.14\.\d+$/u),
    platform: z.literal('darwin'), architecture: z.literal('arm64')
  }),
  distributions
});
export const pythonEnvironmentReportSchema = z.strictObject({
  implementation: z.literal('cpython'), version: z.string().regex(/^3\.14\.\d+$/u),
  platform: z.literal('darwin'), architecture: z.literal('arm64'),
  executable: path, prefix: path, basePrefix: path, modulePaths: z.array(path).length(3),
  flags: z.strictObject({
    isolated: z.literal(1), ignoreEnvironment: z.literal(1), noSite: z.literal(1),
    noUserSite: z.literal(1), safePath: z.literal(true), dontWriteBytecode: z.literal(1), utf8Mode: z.literal(1)
  }),
  siteLoaded: z.literal(false), distributions
});
export const pythonEnvironmentControlsSchema = z.strictObject({
  contractVersion: z.literal(1), selectedExecutable: path, executable: path, executableHash: hash,
  prefix: path, basePrefix: path, modulePaths: z.array(path).length(3), packagePath: path,
  codeRoots: z.array(path).min(1).max(4),
  controls: z.array(z.strictObject({ path, sha256: hash })).max(1)
});
export const pythonEnvironmentLockFileSchema = z.strictObject({
  path: z.literal('roc-python.lock.json'), size: z.number().int().positive().max(4 * 1024 ** 2), sha256: hash
});
export const pythonCodeReceiptSchema = z.strictObject({
  code: nativeCodeSnapshotSchema,
  metadataIdentity: z.strictObject({
    inspectionContractVersion: z.literal(1),
    controls: pythonEnvironmentControlsSchema,
    lockFile: pythonEnvironmentLockFileSchema,
    code: hash,
    report: pythonEnvironmentReportSchema,
    probe: hash
  })
});
export const pythonCodeReportSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: z.string().min(1), projectId: z.string().min(1),
  inputHash: hash, environmentHash: hash, python: pythonCodeReceiptSchema
});
export type PythonCodeReceipt = z.infer<typeof pythonCodeReceiptSchema>;
export type PythonEnvironmentControls = z.infer<typeof pythonEnvironmentControlsSchema>;

/** Validate a stored receipt against the original environment identity without executing Python. */
export function assertPythonCodeReceipt(value: unknown, metadataHash: string): PythonCodeReceipt {
  const receipt = pythonCodeReceiptSchema.parse(value);
  const { hash: codeHash, ...body } = receipt.code;
  const identity = receipt.metadataIdentity, controls = identity.controls, report = identity.report;
  const executable = receipt.code.entries.find(entry => entry.type === 'file'
    && join(entry.root, entry.path) === controls.executable);
  if (researchContentHash(JSON.stringify(body)) !== codeHash || identity.code !== codeHash
    || researchContentHash(JSON.stringify(identity)) !== metadataHash
    || JSON.stringify(receipt.code.roots) !== JSON.stringify(controls.codeRoots)
    || report.executable !== controls.selectedExecutable || report.prefix !== controls.prefix || report.basePrefix !== controls.basePrefix
    || JSON.stringify(report.modulePaths) !== JSON.stringify(controls.modulePaths)
    || executable?.type !== 'file' || executable.sha256 !== controls.executableHash) {
    throw new Error('research_experiment_python_code_report_changed');
  }
  return receipt;
}
