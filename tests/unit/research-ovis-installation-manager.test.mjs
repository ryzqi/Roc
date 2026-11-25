import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {basename, join, relative} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let Manager, inspect;
before(async () => {
  ({OvisInstallationManager: Manager} = await importTypeScriptModule('src/main/plugins/research/ovis-installation-manager.ts', {platform: 'node'}));
  ({inspectOvisInstallation: inspect} = await importTypeScriptModule('src/main/plugins/research/ovis-model-store.ts', {platform: 'node'}));
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const signal = new AbortController().signal;
const revision = '5b252386ba615bd464a5a26597560eaba87dae5c';

// Tiny real inventory exercises the production verifier. It never starts Python or MLX.
async function fixture(operation) {
  const area = await realpath(await mkdtemp('/private/tmp/roc-ovis-manager-test-'));
  const root = join(area, 'installations'), pythonBase = join(area, 'python'), specification = await realpath('resources/ovis-ocr');
  await mkdir(pythonBase);
  const executable = join(pythonBase, 'python'), sharedLibrary = join(pythonBase, 'libpython.dylib');
  await writeFile(executable, 'python'); await writeFile(sharedLibrary, 'library');
  const input = {runtime: {prefix: pythonBase}, projectId: 'ovis-manager-test', signal};
  const prepare = async request => {
    request.onProgress?.({phase: 'verifying'});
    const generation = await mkdtemp(join(request.parent, 'ovis-install-'));
    for (const name of ['model-8bit', 'runtime', 'source', 'spec', 'tools']) await mkdir(join(generation, name));
    await symlink(executable, join(generation, 'runtime/python'));
    await writeFile(join(generation, 'model-8bit/weights'), 'weights');
    const inferenceScript = join(generation, 'spec/infer.py'); await writeFile(inferenceScript, '# inference');
    await writeFile(join(generation, 'spec/manifest.json'), JSON.stringify({model: {revision}}));
    const files = {};
    const visit = async directory => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name), info = await lstat(path), key = relative(generation, path), mode = info.mode & 0o7777;
        if (info.isSymbolicLink()) files[key] = {type: 'symlink', mode, target: executable};
        else if (info.isDirectory()) {files[key] = {type: 'directory', mode}; await visit(path);}
        else files[key] = {type: 'file', mode, size: info.size, sha256: hash(await readFile(path))};
      }
    };
    await visit(generation);
    const bytes = JSON.stringify({schemaVersion: 1, status: 'converted-unvalidated', files,
      python: {basePrefix: pythonBase, executable, executableSha256: hash('python'), sharedLibrary,
        sharedLibrarySha256: hash('library'), pythonVersion: '3.14.10', implementation: 'cpython', machine: 'arm64', freeThreaded: false},
      dependencies: {mlx: '0.32.5', 'mlx-vlm': '0.8.1'}, conversion: {quantization: {bits: 8, group_size: 64, mode: 'affine'},
        visionDtype: 'bfloat16', visionTensors: 153, quantizedLanguageModules: 187}});
    await writeFile(join(generation, 'receipt.json'), bytes);
    return inspect({root: generation, pythonBase, inferenceScript, identity: {engine: 'ovisocr3-mlx', revision,
      quantization: '8bit', groupSize: 64, visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: hash(bytes),
      inferenceSha256: hash('# inference'), promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'}}, signal);
  };
  const manager = dependencies => new Manager(root, specification, {prepare, inspect, ...dependencies});
  try {await operation({area, root, input, prepare, manager, specification});}
  finally {await rm(area, {recursive: true, force: true});}
}

test('missing and pre-cancelled acquisitions never create a model directory or retain a lease', async () => {
  await fixture(async ({root, input, manager}) => {
    const store = manager(); assert.equal(await store.installed(), false);
    await assert.rejects(store.acquire(signal), /installation_missing/);
    await assert.rejects(store.acquire(AbortSignal.abort()), {name: 'AbortError'});
    await assert.rejects(store.install({...input, signal: AbortSignal.abort()}), {name: 'AbortError'});
    assert.equal(store.busy, false); assert.equal(store.progress, null);
    await store.remove(); await assert.rejects(lstat(root), {code: 'ENOENT'});
  });
});

test('verified publication survives process restart, preserves model identity and excludes mutation until every lease releases', async () => {
  await fixture(async ({root, input, manager, specification}) => {
    const store = manager(), phases = [];
    const result = await store.install({...input, onProgress: progress => phases.push(progress.phase)});
    assert.deepEqual(phases, ['verifying']); assert.equal(store.busy, false); assert.equal(store.progress, null);
    assert.equal(result.qualityQualified, false); assert.equal(await store.installed(), true);
    assert.deepEqual((await readdir(root)).sort(), ['active.json', basename(result.installation.root)].sort());
    const active = JSON.parse(await readFile(join(root, 'active.json'), 'utf8'));
    assert.deepEqual(active.identity, result.installation.identity);
    const other = manager(), pending = other.acquire(signal);
    assert.equal(store.busy, true); await assert.rejects(store.remove(), /installation_busy/);
    const first = await pending, second = await store.acquire(signal);
    await assert.rejects(other.install(input), /installation_busy/);
    first.release(); first.release(); assert.equal(store.busy, true);
    second.release(); assert.equal(store.busy, false);
    await assert.rejects(store.install(input), /already_selected/);
    // A separate Node process has no shared in-memory owner or lease state.
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {importTypeScriptModule} from './scripts/lib/bundle-ts.mjs';
      const {OvisInstallationManager} = await importTypeScriptModule('src/main/plugins/research/ovis-installation-manager.ts', {platform: 'node'});
      const store = new OvisInstallationManager(process.argv[1], process.argv[2]);
      assert.equal(await store.installed(), true);
      const lease = await store.acquire(new AbortController().signal);
      assert.equal(lease.qualityQualified, false); lease.release();
      console.log(lease.installation.identity.installationReceiptSha256);
    `, root, specification]);
    assert.equal(child.stdout.trim(), result.installation.identity.installationReceiptSha256);
    await store.remove(); assert.equal(await other.installed(), false); assert.deepEqual(await readdir(root), []);
    await lstat(input.runtime.prefix); // Shared interpreter is never owned by model removal.
  });
});

test('reservations span async preparation and cancellation cleans only the unpublished generation', async () => {
  await fixture(async ({root, input, manager, prepare}) => {
    await mkdir(root); await writeFile(join(root, 'existing-user-file'), 'keep');
    const entered = Promise.withResolvers(), resume = Promise.withResolvers(), controller = new AbortController();
    const store = manager({prepare: async request => {
      request.onProgress({phase: 'verifying'}); entered.resolve(); await resume.promise;
      return prepare(request);
    }}), other = manager();
    const pending = store.install({...input, signal: controller.signal, onProgress: value => {value.phase = 'converting';}});
    await entered.promise;
    assert.deepEqual(store.progress, {phase: 'verifying'});
    const view = store.progress; view.phase = 'converting'; assert.equal(other.progress.phase, 'verifying');
    for (const operation of [() => other.install(input), () => other.remove(), () => other.acquire(signal), () => other.installed()]) {
      await assert.rejects(operation(), /installation_busy/);
    }
    controller.abort(); resume.resolve(); await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(store.busy, false); assert.equal(store.progress, null);
    assert.deepEqual(await readdir(root), ['existing-user-file']);
    await other.install(input); await other.remove();
    assert.equal(await readFile(join(root, 'existing-user-file'), 'utf8'), 'keep');
  });
});

test('exclusive publication refuses a competing selection and cleans its own completed generation', async () => {
  await fixture(async ({root, input, manager, prepare}) => {
    const store = manager({prepare: async request => {
      const result = await prepare(request); await writeFile(join(root, 'active.json'), 'other-owner', {flag: 'wx'}); return result;
    }});
    await assert.rejects(store.install(input), {code: 'EEXIST'});
    assert.equal(store.busy, false); assert.deepEqual(await readdir(root), ['active.json']);
    assert.equal(await readFile(join(root, 'active.json'), 'utf8'), 'other-owner');
  });
});

test('failed preparations retain unproven worker state without being adopted or deleted', async () => {
  await fixture(async ({root, input, manager}) => {
    const failure = new AggregateError([new Error('wrapped', {cause:
      Object.assign(new Error('supervision failed'), {code: 'research_process_supervision_failed'})})], 'unproven');
    const store = manager({prepare: async () => {
      await mkdir(join(root, 'ovis-install-ABC123')); await writeFile(join(root, 'ovis-install-ABC123/worker'), 'retain');
      throw failure;
    }});
    await assert.rejects(store.install(input), error => error === failure);
    assert.equal(store.busy, true);
    for (const operation of [() => store.installed(), () => store.install(input), () => store.acquire(signal), () => store.remove()]) {
      await assert.rejects(operation(), /installation_busy/);
    }
    assert.equal(await readFile(join(root, 'ovis-install-ABC123/worker'), 'utf8'), 'retain');
    assert.equal((await readdir(root)).filter(name => name.startsWith('.ovis-in-use-')).length, 1);
  });
});

test('another host and a restarted host cannot mutate or acquire a model after its owner is killed', {timeout: 30000}, async () => {
  await fixture(async ({root, input, manager, specification}) => {
    const store = manager(), installed = await store.install(input);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {importTypeScriptModule} from './scripts/lib/bundle-ts.mjs';
      const {OvisInstallationManager} = await importTypeScriptModule('src/main/plugins/research/ovis-installation-manager.ts', {platform: 'node'});
      const store = new OvisInstallationManager(process.argv[1], process.argv[2]);
      const lease = await store.acquire(new AbortController().signal);
      process.send('acquired');
      setInterval(() => {}, 1000);
    `, root, specification], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let stderr = ''; child.stderr.on('data', data => {stderr += data;});
    const closed = once(child, 'close');
    try {
      assert.deepEqual(await Promise.race([once(child, 'message'), closed.then(() => {throw new Error(stderr);})]), ['acquired', undefined]);
      for (const operation of [() => store.acquire(signal), () => store.install(input), () => store.remove()]) {
        await assert.rejects(operation(), /previous_operation_unresolved/);
      }
      child.kill('SIGKILL'); await closed;
      // This manager has no in-memory lease from the dead child. The on-disk
      // marker still forbids assuming the child Worker has also exited.
      for (const operation of [() => store.acquire(signal), () => store.install(input), () => store.remove()]) {
        await assert.rejects(operation(), /previous_operation_unresolved/);
      }
      assert.equal(await readFile(join(installed.installation.root, 'model-8bit/weights'), 'utf8'), 'weights');
    } finally {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed;}
  });
});

test('damaged installed bytes refuse acquisition and explicit removal can finish after an interrupted deletion', async () => {
  await fixture(async ({root, input, manager}) => {
    const store = manager(), result = await store.install(input);
    await writeFile(join(result.installation.root, 'model-8bit/weights'), 'damaged');
    await assert.rejects(store.acquire(signal), /installation_/); assert.equal(store.busy, false);
    assert.equal(await store.installed(), true); await store.remove();
    const retry = await store.install(input); await rm(retry.installation.root, {recursive: true});
    await assert.rejects(store.acquire(signal), {code: 'ENOENT'}); assert.equal(store.busy, false);
    await store.remove(); assert.deepEqual(await readdir(root), []);
  });
});

test('replacement generations, aliases and changed model roots are never deleted', async () => {
  await fixture(async ({area, root, input, manager, specification}) => {
    const store = manager(), result = await store.install(input), original = result.installation.root;
    const saved = join(root, 'original'); await rename(original, saved); await mkdir(original);
    await writeFile(join(original, 'unrelated'), 'keep');
    for (const operation of [() => store.acquire(signal), () => store.remove()]) {
      await assert.rejects(operation(), /generation_changed/);
    }
    assert.equal(await readFile(join(original, 'unrelated'), 'utf8'), 'keep');
    await rm(original, {recursive: true}); await symlink(saved, original);
    await assert.rejects(store.remove(), /generation_changed/);
    await rm(original); await rename(saved, original);
    const alias = join(area, 'alias'); await symlink(root, alias);
    await assert.rejects(new Manager(alias, specification).remove(), /directory_invalid/);
    const moved = join(area, 'saved'); await rename(root, moved); await mkdir(root);
    await writeFile(join(root, 'unrelated'), 'keep');
    for (const operation of [() => store.installed(), () => store.install(input), () => store.remove()]) {
      await assert.rejects(operation(), /directory_changed/);
    }
    assert.equal(await readFile(join(root, 'unrelated'), 'utf8'), 'keep');
    await rm(root, {recursive: true}); await rename(moved, root); await store.remove();
  });
});

test('untrusted preparation handles cannot authorize deleting external paths', async () => {
  await fixture(async ({area, root, input, manager, prepare}) => {
    const external = join(area, 'external'); await mkdir(external);
    await writeFile(join(external, 'keep'), 'keep');
    const store = manager({prepare: async request => {
      const result = await prepare(request);
      return {...result, installation: {...result.installation, root: external, inferenceScript: join(external, 'spec/infer.py')}};
    }});
    await assert.rejects(store.install(input), /preparation_invalid/);
    assert.equal(store.busy, false); assert.equal(await store.installed(), false);
    assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'keep');
    assert.ok((await readdir(root)).every(name => name.startsWith('ovis-install-')));
  });
});

test('replacement or in-place mutation of selection during verification rejects the lease', async () => {
  for (const mutate of ['replace', 'write']) await fixture(async ({root, input, manager}) => {
    const store = manager(); await store.install(input);
    const active = join(root, 'active.json'), original = await readFile(active);
    const inspecting = manager({inspect: async (installation, signal) => {
      const result = await inspect(installation, signal);
      if (mutate === 'replace') {await rename(active, `${active}.saved`); await writeFile(active, original);}
      else await writeFile(active, Buffer.concat([original, Buffer.from(' ')]));
      return result;
    }});
    await assert.rejects(inspecting.acquire(signal), /selection_changed/);
    assert.equal(store.busy, false); await store.remove();
  });
});
