import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const auditDirectory = resolve('scripts/ui-audit');
const auditScript = join(auditDirectory, 'audit-design-rules.py');

test('vendored UI audit snapshots retain their source hashes and licenses', async () => {
  const manifest = JSON.parse(await readFile(join(auditDirectory, 'sources.json'), 'utf8'));
  assert.equal(manifest.sources.length, 2);
  for (const source of manifest.sources) {
    const script = await readFile(join(auditDirectory, source.file));
    const license = await readFile(join(auditDirectory, source.licenseFile));
    assert.equal(createHash('sha256').update(script).digest('hex'), source.sha256);
    assert.equal(createHash('sha256').update(license).digest('hex'), source.licenseSha256);
    assert.match(license.toString('utf8'), /Permission is hereby granted/);
  }
});

test('design audit passes valid source and rejects violations and incomplete input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roc-design-audit-'));
  const run = target => spawnSync('python3', ['-B', auditScript, target], {
    cwd: directory, encoding: 'utf8'
  });
  try {
    const clean = join(directory, 'clean.tsx');
    await writeFile(clean, '<button className="focus-visible:ring">保存</button>');
    const passing = run(clean);
    assert.equal(passing.status, 0, passing.stderr);

    const violation = join(directory, 'violation.tsx');
    await writeFile(violation, '<div className="border-black" />');
    const failing = run(violation);
    assert.equal(failing.status, 1, failing.stderr);
    assert.match(failing.stdout, /DS-001/);

    assert.equal(run(join(directory, 'missing')).status, 2);
    const unreadable = join(directory, 'invalid.tsx');
    await writeFile(unreadable, Buffer.from([0xff]));
    const invalid = run(unreadable);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout, /IO-ERR/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
