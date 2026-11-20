/** Run the versioned security catalogue; skipped/missing cases never count as passes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { run } from 'node:test';
import { inspect } from 'node:util';

const cwd = process.cwd();
const cataloguePath = 'tests/fixtures/security-boundary-catalog.json';
const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
const requestedIds = process.argv.slice(2);
assert.ok(requestedIds.every(id => catalogue.scenarios.some(row => row.id === id)), 'unknown scenario ID');
const cases = catalogue.scenarios.filter(row => requestedIds.length === 0 || requestedIds.includes(row.id));
const output = resolve(process.env.ROC_SECURITY_AUDIT_DIR ?? `.artifacts/research-harness/S07/security-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(output, {recursive: true});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = [...new Set([
  ...execFileSync('git', ['ls-files', 'src', 'scripts', 'tests', 'package.json', 'pnpm-lock.yaml'], {encoding: 'utf8'}).trim().split('\n'),
  cataloguePath, relative(cwd, import.meta.filename)
])].sort();
const sourceHashes = () => Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(path))]));
const before = sourceHashes();
const head = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
writeFileSync(join(output, 'working.patch'), execFileSync('git', ['diff', '--binary']));
assert.equal(new Set(cases.map(row => row.id)).size, cases.length, 'duplicate scenario id');
assert.equal(new Set(cases.map(row => `${row.file}:${row.name}`)).size, cases.length, 'duplicate scenario');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const results = [];
const startedAt = new Date().toISOString();
for (const file of [...new Set(cases.map(row => row.file))]) {
  const selected = cases.filter(row => row.file === file);
  const events = [];
  const outcomes = new Map();
  const stream = run({files: [resolve(file)], concurrency: 1, timeout: 180_000,
    testNamePatterns: [new RegExp(`^(?:${selected.map(row => escape(row.name)).join('|')})$`)]});
  let failures = 0;
  for await (const event of stream) {
    events.push(JSON.stringify(event, (_key, value) => value instanceof Error ? inspect(value, {depth: 6}) : value));
    if (event.type === 'test:fail') failures += 1;
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const matches = selected.filter(row => row.name === event.data.name && resolve(event.data.file) === resolve(file));
      for (const row of matches) {
        assert.equal(outcomes.has(row.id), false, `duplicate result: ${row.id}`);
        outcomes.set(row.id, {passed: event.type === 'test:pass' && !event.data.skip && !event.data.todo,
          skip: event.data.skip ?? null, todo: event.data.todo ?? null,
          durationMs: event.data.details?.duration_ms, line: event.data.line});
      }
    }
  }
  const log = `${file.replaceAll('/', '-')}.jsonl`;
  writeFileSync(join(output, log), `${events.join('\n')}\n`);
  for (const row of selected) results.push({...row, result: outcomes.get(row.id) ?? {passed: false, missing: true}, log});
  const passed = selected.filter(row => outcomes.get(row.id)?.passed).length;
  console.log(`${file}: ${passed}/${selected.length}; file failures=${failures}`);
  if (failures > 0) results.push({file, infrastructureFailure: true, result: {passed: false}, log});
}
const after = sourceHashes();
const changedSources = sourcePaths.filter(path => before[path] !== after[path]);
const passed = results.every(row => row.result.passed) && changedSources.length === 0;
const report = {schemaVersion: 1, kind: catalogue.kind, passed, startedAt, endedAt: new Date().toISOString(),
  cwd, command: [process.execPath, ...process.argv.slice(1)], head, node: process.version,
  platform: process.platform, architecture: process.arch, sourceHashes: before, changedSources,
  countingRule: catalogue.countingRule, limits: catalogue.limits,
  outcomeClassification: 'Catalogue labels describe assertions in the linked tests, not model attack-success rates. No aggregate zero-effect claim is inferred from a passing test.',
  selected: cases.length, passedScenarios: results.filter(row => row.id && row.result.passed).length,
  results, logHashes: Object.fromEntries([...new Set(results.map(row => row.log))].map(log => [log, hash(readFileSync(join(output, log)))]))};
writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${passed ? 'PASS' : 'FAIL'} ${report.passedScenarios}/${cases.length}: ${output}`);
process.exitCode = passed ? 0 : 1;
