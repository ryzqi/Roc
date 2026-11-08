import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { contained, directory, fail, fileInventory, writeJson } from './common.mjs';
import { loadPython, runPython } from './local-python.mjs';

export function scienceInput(task) {
  return { kind: 'scienceagentbench', files: {}, prompt: `${task.visible.prompt}\n\nDomain context: ${task.visible.domainKnowledge}\n\nUse Roc file tools under /workspace. Write /workspace/solution.py and run exactly "python solution.py" with run_shell_command. The Python process cwd is the actual local workspace; use relative filesystem paths in Python (not /workspace absolute paths). Generate the requested output files. No network, subprocesses or package installation is available. Finish with a short JSON status.` };
}
export async function sciencePreflight(dataset, tasks, runDirectory, signal) {
  const identities = {}, calibration = [];
  for (const task of tasks) {
    for (const [pathKey, identityKey] of [['pythonEnvironment', 'pythonIdentity'], ['verifierEnvironment', 'verifierIdentity']]) {
      const env = loadPython(task.environment[pathKey]);
      if (env.lock.identity !== task.environment[identityKey]) fail('environment', 'science_python_identity_changed');
      identities[env.lock.identity] = { runtime: env.lock.runtime, executableSha256: env.lock.executableSha256 };
    }
    const cases = ['oracle', 'alternative', 'incorrect-output', 'corrupt-output', 'shortcut'];
    for (const kind of cases) {
      const trial = directory(runDirectory, `calibration-${task.id}-${kind}`);
      const workspace = contained(dataset.root, `${task.environment.calibrationDir}/${kind}`);
      const grade = await gradeScience(dataset, task, workspace, trial, signal);
      const expected = ['oracle', 'alternative'].includes(kind);
      const entry = { task: task.id, kind, expected, observed: grade.metrics.successRate === 1, grade };
      calibration.push(entry); writeJson(join(trial, 'calibration.json'), entry);
      if (entry.observed !== expected) fail('verifier', 'science_calibration_failed');
    }
  }
  return { backend: 'macos-local-python-v2', identities, calibration };
}
export function stageScience(dataset, task, workspace) {
  const source = contained(dataset.root, task.environment.publicDir);
  fileInventory(source);
  cpSync(source, workspace, { recursive: true });
}
export async function executeScience(task, workspace, signal, limits) {
  fileInventory(workspace);
  if (!limits || limits.timeoutMs <= 0 || limits.timeoutMs > 120000 || limits.maxBytes <= 0 || limits.maxBytes > 1048576) fail('policy', 'science_execution_limits_required');
  const environment = loadPython(task.environment.pythonEnvironment);
  if (environment.lock.identity !== task.environment.pythonIdentity) fail('environment', 'science_python_identity_changed');
  const evidenceDir = directory(dirname(dirname(workspace)), 'python-execution');
  let result;
  try { result = await runPython(environment, join(workspace, 'solution.py'), [], { readRoots: [], writeRoot: workspace, directory: evidenceDir, signal, ...limits }); }
  catch (error) {
    if (['process_timeout', 'process_evidence_limit'].includes(error.message)) fail('agent', 'scientific_execution_limit');
    throw error;
  }
  fileInventory(workspace); // Reject links or special output artifacts after execution too.
  return { ...result, exitCode: result.exitCode ?? 137, command: 'python solution.py', normalizedCommand: 'python solution.py', cwd: workspace, usedRtk: false, truncated: false };
}
export function parseScienceGrade(text) {
  let result;
  try { result = JSON.parse(text); } catch { fail('verifier', 'science_grade_not_json'); }
  if (!result || typeof result.success !== 'boolean' || typeof result.evidence !== 'string' || !result.evidence.trim()) fail('verifier', 'science_grade_schema_invalid');
  return { status: result.success ? 'scored' : 'failed', failureClass: result.success ? null : 'agent', reason: result.success ? null : 'scientific_result_incorrect',
    metrics: { successRate: result.success ? 1 : 0 }, evidence: result.evidence };
}
export async function gradeScience(dataset, task, workspace, trialDirectory, signal) {
  const inventory = fileInventory(workspace), outputs = join(trialDirectory, 'verifier-input'); mkdirSync(outputs);
  for (const name of task.environment.outputFiles) {
    if (!inventory.some(f => f.path === name)) return { status: 'failed', failureClass: 'agent', reason: 'required_output_missing', metrics: { successRate: 0 } };
    const target = contained(outputs, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(contained(workspace, name), target);
  }
  const environment = loadPython(task.environment.verifierEnvironment);
  if (environment.lock.identity !== task.environment.verifierIdentity) fail('environment', 'science_verifier_identity_changed');
  const verifier = contained(dataset.root, task.environment.verifierDir), truth = contained(dataset.root, task.environment.hiddenDir);
  const scratch = directory(trialDirectory, 'verifier-work');
  const result = await runPython(environment, join(verifier, 'grade.py'), [outputs, truth], {
    readRoots: [verifier, truth, outputs], writeRoot: scratch, directory: scratch, signal
  });
  if (result.exitCode !== 0) fail('verifier', 'science_verifier_failed');
  return parseScienceGrade(result.stdout);
}
