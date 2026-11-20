import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api, root;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
before(async () => {
  api = await loadResearchTestApi();
  root = await realpath(await mkdtemp('/private/tmp/roc-python-receipt-'));
});
after(async () => { await rm(root, { recursive: true, force: true }); api.dispose(); });

async function fixture() {
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'python3.14'), 'synthetic executable bytes');
  const code = await api.captureNativeCode([bin], new AbortController().signal);
  const executableHash = code.entries.find(entry => entry.type === 'file').sha256;
  const controls = {
    contractVersion: 1, selectedExecutable: join(bin, 'python3.14'), executable: join(bin, 'python3.14'),
    executableHash, prefix: root, basePrefix: root,
    modulePaths: [join(root, 'lib/python314.zip'), join(root, 'lib/python3.14'), join(root, 'lib/python3.14/lib-dynload')],
    packagePath: join(root, 'lib/python3.14/site-packages'), codeRoots: [bin], controls: []
  };
  const report = {
    implementation: 'cpython', version: '3.14.7', platform: 'darwin', architecture: 'arm64',
    executable: controls.selectedExecutable, prefix: root, basePrefix: root, modulePaths: [...controls.modulePaths],
    flags: { isolated: 1, ignoreEnvironment: 1, noSite: 1, noUserSite: 1, safePath: true, dontWriteBytecode: 1, utf8Mode: 1 },
    siteLoaded: false, distributions: []
  };
  const metadataIdentity = {
    inspectionContractVersion: 1, controls,
    lockFile: { path: 'roc-python.lock.json', size: 100, sha256: 'a'.repeat(64) },
    code: code.hash, report, probe: 'b'.repeat(64)
  };
  return { code, metadataIdentity };
}

test('Python receipt connects the complete inventory to original metadata and exact run identity', async () => {
  const receipt = await fixture(), metadataHash = hash(receipt.metadataIdentity);
  assert.deepEqual(api.assertPythonCodeReceipt(receipt, metadataHash), receipt);
  const report = { schemaVersion: 1, runId: 'run-a', projectId: 'project-a', inputHash: 'c'.repeat(64),
    environmentHash: 'd'.repeat(64), python: receipt };
  assert.deepEqual(api.pythonCodeReportSchema.parse(report), report);
  assert.equal(api.pythonCodeReportSchema.safeParse({ ...report, native: receipt }).success, false);
  assert.equal(api.pythonCodeReceiptSchema.safeParse({ ...receipt, oldInventory: true }).success, false);
});

test('changed code, controls, lock, report and probe cannot retain the original environment identity', async () => {
  const receipt = await fixture(), metadataHash = hash(receipt.metadataIdentity);
  for (const mutate of [
    value => { value.code.entries.find(entry => entry.type === 'file').sha256 = 'e'.repeat(64); },
    value => { value.metadataIdentity.controls.controls = [{ path: join(root, 'pyvenv.cfg'), sha256: 'e'.repeat(64) }]; },
    value => { value.metadataIdentity.lockFile.sha256 = 'e'.repeat(64); },
    value => { value.metadataIdentity.report.version = '3.14.8'; },
    value => { value.metadataIdentity.probe = 'e'.repeat(64); }
  ]) {
    const changed = structuredClone(receipt); mutate(changed);
    assert.throws(() => api.assertPythonCodeReceipt(changed, metadataHash), /python_code_report_changed/u);
  }
  const changed = structuredClone(receipt);
  changed.code.entries.find(entry => entry.type === 'file').sha256 = 'e'.repeat(64);
  const { hash: _hash, ...body } = changed.code;
  changed.code.hash = hash(body); changed.metadataIdentity.code = changed.code.hash;
  assert.throws(() => api.assertPythonCodeReceipt(changed, metadataHash), /python_code_report_changed/u);
});

test('self-consistent digests still require real executable and startup path linkage', async () => {
  const receipt = await fixture();
  for (const mutate of [
    value => { value.metadataIdentity.controls.executableHash = 'e'.repeat(64); },
    value => { value.metadataIdentity.controls.executable = join(root, 'missing-python'); },
    value => { value.metadataIdentity.controls.codeRoots = [root]; },
    value => { value.metadataIdentity.report.executable = join(root, 'other-python'); },
    value => { value.metadataIdentity.report.prefix = join(root, 'other-prefix'); },
    value => { value.metadataIdentity.report.basePrefix = join(root, 'other-base'); },
    value => { value.metadataIdentity.report.modulePaths[0] = join(root, 'other.zip'); }
  ]) {
    const changed = structuredClone(receipt); mutate(changed);
    assert.throws(() => api.assertPythonCodeReceipt(changed, hash(changed.metadataIdentity)), /python_code_report_changed/u);
  }
});

test('Python report rejects relative startup paths, site loading and duplicate installed identities', async () => {
  const receipt = await fixture();
  for (const mutate of [
    value => { value.metadataIdentity.report.executable = 'python3'; },
    value => { value.metadataIdentity.report.siteLoaded = true; },
    value => { value.metadataIdentity.report.flags.noSite = 0; },
    value => { value.metadataIdentity.report.distributions = [{ name: 'fixture', version: '1.0' }, { name: 'fixture', version: '1.0' }]; }
  ]) {
    const changed = structuredClone(receipt); mutate(changed);
    assert.equal(api.pythonCodeReceiptSchema.safeParse(changed).success, false);
  }
});
