import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * The manifest's `versions` record is the toolchain's audit trail.
 *
 * `tools.lock.json` declares tools per architecture (`tectonic`, `vale`, and `typst`), and the
 * manifest records each one's version. Two properties make that record trustworthy, and both are
 * pinned here:
 *
 *   1. the key set comes from the lock, not from a hand-written list; adding a tool means adding
 *      its archive and `<name>Version` to the lock, and the reader follows;
 *   2. the two sets must match exactly. An extra recorded key is also a mismatch: a manifest
 *      carrying a tool the lock does not declare was not produced by these sources.
 *
 * Why an archive is not enough on its own: a tool registered in `architectures[arch]` without a
 * matching `<name>Version` would be distributed unversioned, so the lock is rejected instead of
 * silently recording an empty string.
 *
 * The compare deliberately returns booleans/`null` rather than throwing domain errors: `toolchain.ts`
 * is the only layer that knows this is a `research_toolchain_version_mismatch`, and it is the only
 * layer that can load `tools.lock.json` and reach native canvas bindings — neither of which
 * `tests/unit` can bundle (`bundle-ts.mjs` is `platform:'neutral'`).
 */

const { lockedToolVersions, toolVersionsMatch } = await importTypeScriptModule(
  'src/main/plugins/research/toolchain-versions.ts'
);

const archive = { url: 'https://example.invalid/tool.tar.gz', sha256: 'a'.repeat(64) };

function lock(architectures, versions = {}) {
  return { schemaVersion: 1, ...versions, architectures };
}

const threeTools = { tectonic: archive, vale: archive, typst: archive };
const threeVersions = { tectonicVersion: '0.17.0', valeVersion: '3.24.0', typstVersion: '0.15.0' };

test('the version keys are the tools the lock declares for that architecture', () => {
  const value = lock({ arm64: threeTools }, threeVersions);
  assert.deepEqual(lockedToolVersions(value, 'arm64'), {
    tectonic: '0.17.0',
    vale: '3.24.0',
    typst: '0.15.0'
  });
});

test('adding a tool only needs the lock entry and its version key — the reader follows', () => {
  const value = lock({ arm64: { ...threeTools, proofreader: archive } }, {
    ...threeVersions,
    proofreaderVersion: '1.0.0'
  });
  assert.deepEqual(lockedToolVersions(value, 'arm64'), {
    tectonic: '0.17.0',
    vale: '3.24.0',
    typst: '0.15.0',
    proofreader: '1.0.0'
  });
});

test('each architecture is read on its own', () => {
  const value = lock(
    { arm64: threeTools, x64: { ...threeTools, proofreader: archive } },
    { ...threeVersions, proofreaderVersion: '1.0.0' }
  );
  assert.equal(Object.hasOwn(lockedToolVersions(value, 'arm64'), 'proofreader'), false);
  assert.equal(Object.hasOwn(lockedToolVersions(value, 'x64'), 'proofreader'), true);
});

test('a registered archive without a declared version is a broken lock, not a default', () => {
  const value = lock({ arm64: { ...threeTools, proofreader: archive } }, threeVersions);
  assert.equal(lockedToolVersions(value, 'arm64'), null);
});

test('a malformed lock yields null rather than an empty key set', () => {
  const malformed = [
    null, undefined, 'arm64', 7, [],
    {},
    lock(null, { tectonicVersion: '0.17.0' }),
    lock({}, { tectonicVersion: '0.17.0' }),
    lock({ arm64: [] }, { tectonicVersion: '0.17.0' }),
    lock({ arm64: {} }, { tectonicVersion: '0.17.0' }),
    lock({ arm64: threeTools }, {}),
    lock({ arm64: { ...threeTools, proofreader: archive } }, {
      tectonicVersion: '0.17.0', valeVersion: '3.24.0', typstVersion: '0.15.0'
    }),
    lock({ arm64: { ...threeTools, proofreader: archive } }, {
      ...threeVersions, proofreaderVersion: ''
    })
  ];
  for (const value of malformed) {
    assert.equal(lockedToolVersions(value, 'arm64'), null, JSON.stringify(value));
  }
  // An empty architecture name is never a valid tool set.
  assert.equal(lockedToolVersions(lock({ arm64: threeTools }, threeVersions), ''), null);
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
    for (const name of ['tectonic', 'vale', 'typst']) {
      assert.equal(typeof versions[name], 'string', `${name} lost its version for ${architecture}`);
    }
  }
  assert.deepEqual(Object.keys(shipped.architectures.arm64).sort(), ['tectonic', 'typst', 'vale']);
  assert.equal(typeof shipped.valeVersion, 'string');
  assert.equal(lockedToolVersions(shipped, 'arm64').vale, shipped.valeVersion);
  assert.equal(typeof shipped.typstVersion, 'string');
  assert.equal(lockedToolVersions(shipped, 'arm64').typst, shipped.typstVersion);
  // Roc 只发 Apple Silicon：lock 里除了 arm64 不该再有别的架构。
  assert.deepEqual(architectures, ['arm64']);
});

test('the recorded set must match the expected set key for key', () => {
  const expected = { tectonic: '0.17.0', vale: '3.24.0', typst: '0.15.0' };
  assert.equal(toolVersionsMatch({ tectonic: '0.17.0', vale: '3.24.0', typst: '0.15.0' }, expected), true);
  // Order is irrelevant.
  assert.equal(toolVersionsMatch({ typst: '0.15.0', tectonic: '0.17.0', vale: '3.24.0' }, expected), true);
});

test('a missing, extra or drifted key is a mismatch', () => {
  const expected = { tectonic: '0.17.0', vale: '3.24.0', typst: '0.15.0' };
  const mismatches = {
    'a tool went missing': { tectonic: '0.17.0', typst: '0.15.0' },
    'the manifest carries a tool the lock never declared': {
      tectonic: '0.17.0', vale: '3.24.0', typst: '0.15.0', proofreader: '1.0.0'
    },
    'one version drifted': { tectonic: '0.17.0', vale: '3.24.0', typst: '0.15.1' },
    'a version is not a string': { tectonic: '0.17.0', vale: '3.24.0', typst: 15 },
    'a version is empty': { tectonic: '0.17.0', vale: '', typst: '0.15.0' },
    'the record is not an object': 'toolchain',
    'the record is an array': ['tectonic'],
    'the record is absent': undefined
  };
  for (const [label, recorded] of Object.entries(mismatches)) {
    assert.equal(toolVersionsMatch(recorded, expected), false, label);
  }
});
