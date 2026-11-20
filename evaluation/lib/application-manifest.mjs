import { fail, hash } from './common.mjs';

// The evaluator freezes one production manifest per task. Legacy public suites
// continue to use their single suite manifest.
export function applicationManifest(artifact, input) {
  if (artifact.taskManifests) {
    const entry = artifact.taskManifests.find(item => item.taskId === input.taskId);
    if (!entry || hash(entry.toolNames) !== hash(input.toolNames)) fail('state', 'application_task_manifest_mismatch');
    if (entry.runMode !== undefined && entry.runMode !== input.runMode) {
      fail('state', 'application_task_run_mode_mismatch');
    }
    if (hash(entry.mcp ?? null) !== hash(input.mcp ?? null)) fail('state', 'application_task_mcp_mismatch');
    return entry.manifest;
  }
  const manifest = artifact.manifests?.[input.kind];
  if (!manifest) fail('state', 'application_manifest_missing');
  return manifest;
}
