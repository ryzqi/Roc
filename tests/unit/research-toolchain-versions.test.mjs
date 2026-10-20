import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * The manifest's `versions` record is the toolchain's audit trail.
 *
 * `tools.lock.json` declares tools per architecture (`python`, `uv`, `tectonic`, and later `vale`)
 * and the manifest records each one's version. Two properties make that record trustworthy, and
 * both are pinned here:
 *
 *   1. the **key set comes from the lock**, not from a hand-written triple. That is what lets a new
 *      tool be added by editing the lock and `prepare.ts` alone; the reader follows. Before this,
 *      adding a fourth tool required four synchronised edits, and missing the compare step meant the
 *      new binary shipped with no version recorded anywhere — silently unauditable;
 *   2. the two sets must match **exactly**. An extra recorded key is also a mismatch: a manifest
 *      carrying a tool the lock does not declare was not produced by these sources.
 *
 * Why an archive is not enough on its own: a tool registered in `architectures[arch]` without a
 * matching `<name>Version` would be distributed unversioned, so the lock is rejected instead of
 * silently recording an empty string.
 *
 * The compare deliberately returns booleans/`null` rather than throwing domain errors: `toolchain.ts`
 * is the only layer that knows this is a `research_toolchain_version_mismatch`, and it is the only
 * layer that can load `tools.lock.json`, inline `worker.py`, and reach the native canvas bindings —
 * none of which `tests/unit` can bundle (`bundle-ts.mjs` is `platform:'neutral'`).
 */

const { lockedToolVersions, toolVersionsMatch } = await importTypeScriptModule(
  'src/main/plugins/research/toolchain-versions.ts'
);

const archive = { url: 'https://example.invalid/tool.tar.gz', sha256: 'a'.repeat(64) };

function lock(architectures, versions = {}) {
  return { schemaVersion: 1, ...versions, architectures };
}

const threeTools = { python: archive, uv: archive, tectonic: archive };

test('the version keys are the tools the lock declares for that architecture', () => {
  const value = lock({ arm64: threeTools }, { pythonVersion: '3.12.14', uvVersion: '0.12.10', tectonicVersion: '0.17.0' });
  assert.deepEqual(lockedToolVersions(value, 'arm64'), {
    python: '3.12.14',
    uv: '0.12.10',
    tectonic: '0.17.0'
  });
});

test('adding a tool only needs the lock entry and its version key — the reader follows', () => {
  const value = lock({ arm64: { ...threeTools, vale: archive } },
    { pythonVersion: '3.12.14', uvVersion: '0.12.10', tectonicVersion: '0.17.0', valeVersion: '3.24.0' });
  assert.deepEqual(lockedToolVersions(value, 'arm64'), {
    python: '3.12.14',
    uv: '0.12.10',
    tectonic: '0.17.0',
    vale: '3.24.0'
  });
});

test('each architecture is read on its own', () => {
  const value = lock(
    { arm64: threeTools, x64: { ...threeTools, vale: archive } },
    { pythonVersion: '3.12.14', uvVersion: '0.12.10', tectonicVersion: '0.17.0', valeVersion: '3.24.0' }
  );
  assert.equal(Object.hasOwn(lockedToolVersions(value, 'arm64'), 'vale'), false);
  assert.equal(Object.hasOwn(lockedToolVersions(value, 'x64'), 'vale'), true);
});

test('a registered archive without a declared version is a broken lock, not a default', () => {
  const value = lock({ arm64: { ...threeTools, vale: archive } },
    { pythonVersion: '3.12.14', uvVersion: '0.12.10', tectonicVersion: '0.17.0' });
  assert.equal(lockedToolVersions(value, 'arm64'), null);
});

test('a malformed lock yields null rather than an empty key set', () => {
  const malformed = [
    null, undefined, 'arm64', 7, [],
    {},
    lock(null, { pythonVersion: '3.12.14' }),
    lock({}, { pythonVersion: '3.12.14' }),
    lock({ arm64: [] }, { pythonVersion: '3.12.14' }),
    lock({ arm64: {} }, { pythonVersion: '3.12.14' }),
    lock({ arm64: threeTools }, {}),
    lock({ arm64: { ...threeTools, vale: archive } }, { pythonVersion: '1', uvVersion: '2', tectonicVersion: '3' }),
    lock({ arm64: { ...threeTools, vale: archive } }, { pythonVersion: '1', uvVersion: '2', tectonicVersion: '3', valeVersion: '' })
  ];
  for (const value of malformed) {
    assert.equal(lockedToolVersions(value, 'arm64'), null, JSON.stringify(value));
  }
  // An empty architecture name is never a valid tool set.
  assert.equal(lockedToolVersions(lock({ arm64: threeTools }, { pythonVersion: '1', uvVersion: '2', tectonicVersion: '3' }), ''), null);
});

/**
 * The tests above build locks by hand. This one reads the lock that actually ships.
 *
 * Without it, `resources/research-runtime/tools.lock.json` could drift into a shape the reader
 * rejects — a renamed key, a missing `<name>Version` — and every unit test would still pass while
 * the app refused to start with `research_toolchain_version_mismatch`. The reader's contract is
 * only worth anything if the real input satisfies it.
 */
test('the shipped lock satisfies the reader contract for every architecture it declares', () => {
  const raw = readFileSync(new URL('../../resources/research-runtime/tools.lock.json', import.meta.url), 'utf8');
  const shipped = JSON.parse(raw);
  const architectures = Object.keys(shipped.architectures);
  assert.ok(architectures.length > 0, 'the lock declares no architectures');
  for (const architecture of architectures) {
    const versions = lockedToolVersions(shipped, architecture);
    assert.notEqual(versions, null, `the shipped lock is unreadable for ${architecture}`);
    // Every declared archive has a version, and vice versa: that is the whole contract.
    assert.deepEqual(Object.keys(versions).sort(), Object.keys(shipped.architectures[architecture]).sort(), architecture);
    for (const name of ['python', 'uv', 'tectonic']) {
      assert.equal(typeof versions[name], 'string', `${name} lost its version for ${architecture}`);
    }
  }
  // Vale is a declared tool like the others, so its version must be auditable too. An archive
  // without a version is what `lockedToolVersions` rejects, and the rebuild would not notice.
  assert.deepEqual(Object.keys(shipped.architectures.arm64).sort(), ['python', 'tectonic', 'uv', 'vale']);
  assert.equal(typeof shipped.valeVersion, 'string');
  assert.equal(lockedToolVersions(shipped, 'arm64').vale, shipped.valeVersion);
});

test('the recorded set must match the expected set key for key', () => {
  const expected = { python: '3.12.14', uv: '0.12.10', tectonic: '0.17.0' };
  assert.equal(toolVersionsMatch({ python: '3.12.14', uv: '0.12.10', tectonic: '0.17.0' }, expected), true);
  // Order is irrelevant.
  assert.equal(toolVersionsMatch({ tectonic: '0.17.0', uv: '0.12.10', python: '3.12.14' }, expected), true);
});

test('a missing, extra or drifted key is a mismatch — including the unaudited tool case', () => {
  const expected = { python: '3.12.14', uv: '0.12.10', tectonic: '0.17.0' };
  const mismatches = {
    'a tool went missing': { python: '3.12.14', uv: '0.12.10' },
    'the manifest carries a tool the lock never declared': { python: '3.12.14', uv: '0.12.10', tectonic: '0.17.0', vale: '3.24.0' },
    'one version drifted': { python: '3.12.14', uv: '0.12.11', tectonic: '0.17.0' },
    'a version is not a string': { python: 3, uv: '0.12.10', tectonic: '0.17.0' },
    'a version is empty': { python: '', uv: '0.12.10', tectonic: '0.17.0' },
    'the record is not an object': 'python',
    'the record is an array': ['python'],
    'the record is absent': undefined
  };
  for (const [label, recorded] of Object.entries(mismatches)) {
    assert.equal(toolVersionsMatch(recorded, expected), false, label);
  }
});
