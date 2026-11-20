import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const {
  resolveToolAdmissionResources,
  ToolResourceCoordinator
} = await importTypeScriptModule('src/main/services/deep-agent/tool-resource-coordinator.ts', {
  platform: 'node'
});

function workspaceClaim(path, access = 'write') {
  return { kind: 'workspace', key: `workspace:${path}`, path, access };
}

function policy(overrides = {}) {
  return {
    canonicalIdentity: 'workspace:read_file',
    effectClass: 'none',
    modelVisibleName: 'read_file',
    resourceScope: 'workspace',
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    policy: policy(),
    runId: 'run-private-id',
    workspaceHash: 'workspace-private-hash',
    workspacePath: null,
    workspaceIdentity: null,
    researchProjectId: null,
    ...overrides
  };
}

test('resource coordinator overlaps reads, blocks ancestor writes, and admits unrelated work', async () => {
  const coordinator = new ToolResourceCoordinator();
  const activeRead = await coordinator.acquire([workspaceClaim('/repo/project', 'read')]);
  const secondRead = await coordinator.acquire([workspaceClaim('/repo/project', 'read')]);
  let writerAdmitted = false;
  const waitingWriter = coordinator.acquire([workspaceClaim('/repo/project/cache', 'write')]).then((release) => {
    writerAdmitted = true;
    return release;
  });

  const otherProject = await coordinator.acquire([workspaceClaim('/repo/other-project', 'write')]);
  const unrelated = await coordinator.acquire([{ kind: 'network', key: 'shared', access: 'write' }]);
  assert.equal(writerAdmitted, false);
  unrelated();
  otherProject();

  secondRead();
  activeRead();
  const releaseWriter = await waitingWriter;
  assert.equal(writerAdmitted, true);
  releaseWriter();
});

test('resource coordinator is FIFO for conflicting sets and grants multi-resource claims atomically', async () => {
  const coordinator = new ToolResourceCoordinator();
  const blocker = await coordinator.acquire([workspaceClaim('/repo/a', 'write')]);
  const earlier = coordinator.acquire([
    workspaceClaim('/repo/a', 'write'),
    { kind: 'network', key: 'shared', access: 'write' }
  ]);
  let laterAdmitted = false;
  const later = coordinator.acquire([{ kind: 'network', key: 'shared', access: 'read' }]).then((release) => {
    laterAdmitted = true;
    return release;
  });

  blocker();
  const releaseEarlier = await earlier;
  assert.equal(laterAdmitted, false);
  releaseEarlier();
  const releaseLater = await later;
  assert.equal(laterAdmitted, true);
  releaseLater();
});

test('cancelled global fallback leaves no queue blockage and observations omit resource identities', async () => {
  const coordinator = new ToolResourceCoordinator();
  const blockerPath = '/private/workspace/root';
  const blocker = await coordinator.acquire([workspaceClaim(blockerPath, 'write')]);
  const controller = new AbortController();
  const observations = [];
  const cancelled = coordinator.acquire(
    [{ kind: 'global_fallback', key: 'all', access: 'write' }],
    controller.signal,
    (observation) => observations.push(observation)
  );
  const networkPending = coordinator.acquire([{ kind: 'network', key: 'shared', access: 'read' }]);

  controller.abort(new Error('cancel admission'));
  await assert.rejects(cancelled, /cancel admission/u);
  const releaseNetwork = await networkPending;
  assert.equal(observations.length, 1);
  assert.equal(observations[0].status, 'cancelled');
  assert.equal(observations[0].holdMs, null);
  assert.ok(observations[0].conflictKinds.includes('workspace'));
  assert.ok(!JSON.stringify(observations).includes(blockerPath));

  releaseNetwork();
  blocker();
});

test('already-aborted admission rejects asynchronously and emits a cancellation aggregate', async () => {
  const coordinator = new ToolResourceCoordinator();
  const controller = new AbortController();
  const observations = [];
  controller.abort(new Error('already cancelled'));

  await assert.rejects(
    coordinator.acquire([], controller.signal, (observation) => observations.push(observation)),
    /already cancelled/u
  );
  assert.deepEqual(observations, [{
    status: 'cancelled',
    waitMs: 0,
    holdMs: null,
    resourceKinds: ['global_fallback'],
    conflictKinds: []
  }]);
});

test('resource scopes use trusted global, workspace, app and fallback identities', async () => {
  const memory = await resolveToolAdmissionResources(input({
    policy: policy({ resourceScope: 'memory' })
  }));
  assert.deepEqual(memory.claims.map(({ kind, key }) => [kind, key]), [
    ['memory', 'global'],
    ['memory', 'workspace:workspace-private-hash']
  ]);

  const config = await resolveToolAdmissionResources(input({
    policy: policy({ resourceScope: 'app', modelVisibleName: 'roc_self_config' })
  }));
  assert.deepEqual(config.claims.map(({ kind, key }) => [kind, key]), [['global_config', 'roc']]);

  const backgroundTask = await resolveToolAdmissionResources(input({
    policy: policy({ resourceScope: 'app', modelVisibleName: 'schedule_background_task' })
  }));
  assert.deepEqual(backgroundTask.claims.map(({ kind, key }) => [kind, key]), [['background_tasks', 'scheduler']]);

  const runLocal = await resolveToolAdmissionResources(input({
    policy: policy({ resourceScope: 'app', modelVisibleName: 'write_todos' })
  }));
  assert.equal(runLocal.claims[0].kind, 'app_run');
  assert.notEqual(runLocal.claims[0].key, 'run-private-id');

  const unsupported = await resolveToolAdmissionResources(input({
    policy: policy({ resourceScope: 'app', modelVisibleName: 'unknown_app_tool' })
  }));
  assert.deepEqual(unsupported.claims.map(({ kind, key }) => [kind, key]), [['global_fallback', 'all']]);

  const externalScope = await resolveToolAdmissionResources(input({
    policy: policy({ resourceScope: 'external' })
  }));
  assert.deepEqual(externalScope.claims.map(({ kind, key }) => [kind, key]), [['global_fallback', 'all']]);

  const missingWorkspace = await resolveToolAdmissionResources(input());
  assert.deepEqual(missingWorkspace.claims.map(({ kind, key }) => [kind, key]), [['global_fallback', 'all']]);
});

test('workspace claims canonicalize symlinks, include research identity, and reject replacement roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roc-tool-admission-'));
  const workspacePath = join(directory, 'workspace');
  const aliasPath = join(directory, 'workspace-alias');
  const movedPath = join(directory, 'workspace-moved');
  await mkdir(workspacePath);
  await symlink(workspacePath, aliasPath);
  try {
    const canonicalPath = await realpath(workspacePath);
    const workspaceStat = await stat(canonicalPath);
    const workspaceIdentity = {
      path: canonicalPath,
      dev: String(workspaceStat.dev),
      ino: String(workspaceStat.ino)
    };
    const expectedResearchKey = createHash('sha256').update('project-private-id').digest('hex');
    const resolved = await resolveToolAdmissionResources(input({
      policy: policy({
        canonicalIdentity: 'research:literature_search',
        effectClass: 'network_read',
        modelVisibleName: 'literature_search',
        resourceScope: 'network'
      }),
      workspacePath: aliasPath,
      workspaceIdentity,
      researchProjectId: 'project-private-id'
    }));

    assert.deepEqual(resolved.claims.map((claim) => claim.kind).sort(), ['network', 'research', 'workspace']);
    assert.equal(resolved.claims.find((claim) => claim.kind === 'workspace').path, canonicalPath);
    assert.equal(resolved.claims.find((claim) => claim.kind === 'research').key, expectedResearchKey);
    assert.ok(!JSON.stringify(resolved.claims).includes('project-private-id'));

    await rename(workspacePath, movedPath);
    await mkdir(workspacePath);
    await assert.rejects(resolved.verifyWorkspaceIdentity(), /tool_admission_workspace_identity_changed/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
