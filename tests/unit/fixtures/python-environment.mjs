import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Execution fixtures have real Python and immutable project inputs; installation has its own integration suite. */
export async function writePythonProjectFiles(workspace, version, distributions = []) {
  const dependencies = distributions.map(({name, version}) => `${name}==${version}`);
  await writeFile(join(workspace, '.python-version'), `${version}\n`);
  await writeFile(join(workspace, 'pyproject.toml'), `[project]\nname = "fixture-project"\nversion = "0.0.0"\nrequires-python = ">=3.14,<3.15"\ndependencies = ${JSON.stringify(dependencies)}\n`);
  await writeFile(join(workspace, 'uv.lock'), `version = 1\nrevision = 3\nrequires-python = ">=3.14,<3.15"\n\n[[package]]\nname = "fixture-project"\nversion = "0.0.0"\nsource = { virtual = "." }\n${distributions.map(({name, version}) => `\n[[package]]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\nsource = { registry = "https://pypi.org/simple" }\nwheels = [{ url = "https://files.pythonhosted.org/packages/fixture/${name}-${version}-py3-none-any.whl", hash = "sha256:${'a'.repeat(64)}" }]\n`).join('')}`);
}

export function createPythonFixtureService(api, repository, root, executable, {run = api.runResearchProcess, prepare, inspect, onProbe = () => {}} = {}) {
  const inspectEnvironment = input => api.inspectPythonExperimentEnvironment({...input, run});
  return new api.ResearchPythonEnvironmentService(repository, join(root, 'managed-python'), {
    inspect: inspect ?? inspectEnvironment,
    prepare: prepare ?? (async input => {
      const jobDir = join(root, 'preparation-probes'); await mkdir(jobDir, {recursive: true});
      input.onPhase('verifying');
      const inspected = await inspectEnvironment({workspace: input.workspace, selectedExecutable: executable, jobDir,
        signal: input.signal, admission: {projectId: input.projectId, priority: 'user'}, onProbe});
      if (input.previousCodeHash !== undefined && inspected.code.hash !== input.previousCodeHash) throw new Error('research_python_environment_changed');
      return {inspected, runtime: {version: inspected.report.version, pythonKey: `cpython-${inspected.report.version}-macos-aarch64-none`,
        uvHash: 'c'.repeat(64), receiptHash: 'd'.repeat(64)}};
    })
  });
}

export async function waitPythonPreparation(service, projectId, operationId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = service.status({projectId});
    if (status.operation?.id === operationId && ['ready','failed','cancelled','interrupted'].includes(status.operation.phase)) return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Python preparation terminal state timed out');
}

export async function preparePythonFixture(api, service, projectId, requestId = 'fixture-environment', windowId = 72) {
  const operation = await api.withResearchHumanContext({capability: 'research.pythonEnvironments.prepare', projectId, windowId},
    () => service.prepare({projectId, requestId}));
  const status = await waitPythonPreparation(service, projectId, operation.id);
  assert.equal(status.operation.phase, 'ready', status.operation.errorCode);
  return status.environment;
}
