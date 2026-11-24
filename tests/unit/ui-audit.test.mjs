import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditMotionSource } from '../../scripts/ui-audit/audit-motion-rules.mjs';

const auditDirectory = resolve('scripts/ui-audit');
const auditScript = join(auditDirectory, 'audit-design-rules.py');
const motionAuditScript = join(auditDirectory, 'audit-motion-rules.mjs');

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

test('motion audit follows static classes without scanning prose or shadowed bindings', () => {
  const source = `
    // transition-all duration-[200ms] is documentation, not a class.
    const className = 'transition-all';
    const classes = {
      safe: '[&:hover]:transition-[opacity,transform] ui-motion-fast',
      unused: 'duration-700'
    } as const;
    function Forwarded({ className }: { className: string }) {
      return <span className={className}>duration-[200ms]</span>;
    }
    function Menu({ open }: { open: boolean }) {
      const local = { active: 'transition-opacity', idle: 'transition-transform' } satisfies Record<string, string>;
      return <div title="transition-all" className={
        classes.safe + ' ' + \`ui-motion-base \${open ? local.active : local.idle}\`
      } />;
    }
  `;
  assert.deepEqual(auditMotionSource(source, 'valid.tsx'), []);
});

test('motion audit diagnoses aliases, templates, local maps and expensive properties at the use site', () => {
  const source = `
    const variants = { fast: 'ui-motion-fast', custom: 'motion-safe:duration-[var(--duration-fast)]' } as const;
    function Clean() { const classes = 'transition-opacity'; return <div className={classes} />; }
    function Menu({ variant }: { variant: keyof typeof variants }) {
      const classes = 'transition-' + 'all';
      return <div className={\`\${classes} \${variants[variant]} duration-\${300} hover:transition-[height,opacity,box-shadow] transition-shadow\`} />;
    }
  `;
  const diagnostics = auditMotionSource(source, 'menu.tsx');
  assert.deepEqual(diagnostics.map(({ code, token }) => [code, token]), [
    ['MOTION-001', 'transition-all'],
    ['MOTION-002', 'duration-300'],
    ['MOTION-003', 'hover:transition-[height,opacity,box-shadow]'],
    ['MOTION-003', 'transition-shadow'],
    ['MOTION-002', 'motion-safe:duration-[var(--duration-fast)]']
  ]);
  assert.ok(diagnostics.every(diagnostic => diagnostic.filename === 'menu.tsx' && diagnostic.line === 6));
  assert.deepEqual(auditMotionSource(
    '<div className={["transition-all", "duration-120", "transition-[opacity,_block-size]"].filter(Boolean).join(" ")} />'
  ).map(diagnostic => diagnostic.code), ['MOTION-001', 'MOTION-002', 'MOTION-003']);
});

test('motion audit CLI fails on violations and malformed or missing input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roc-motion-audit-'));
  const run = target => spawnSync(process.execPath, [motionAuditScript, target], {
    cwd: directory, encoding: 'utf8'
  });
  try {
    const clean = join(directory, 'clean.tsx');
    await writeFile(clean, '<button className="transition-opacity ui-motion-fast">保存</button>');
    const passing = run(clean);
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /1 files, 0 violations, 0 input failures/);

    const violation = join(directory, 'violation.tsx');
    await writeFile(violation, '<div className="motion-safe:hover:transition-all" />');
    const failing = run(violation);
    assert.equal(failing.status, 1, failing.stderr);
    assert.match(failing.stdout, /violation\.tsx:1:\d+ MOTION-001/);

    const invalid = join(directory, 'invalid.tsx');
    await writeFile(invalid, '<div className="ui-motion-fast">');
    const malformed = run(invalid);
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /MOTION-INPUT/);
    assert.equal(run(join(directory, 'missing')).status, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
