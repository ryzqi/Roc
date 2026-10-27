import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const originalTimezone = process.env.TZ;
process.env.TZ = 'UTC';
after(() => {
  if (originalTimezone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
});

const { computeNextCronRunAt, parseCronExpression } = await importTypeScriptModule(
  'src/main/plugins/task/cron-parser.ts',
  {
    platform: 'node',
    external: ['croner'],
    tempDir: join(repositoryRoot, '.runtime/tmp')
  }
);

function computeInTimezone(timezone, expression, after) {
  const helperUrl = pathToFileURL(join(repositoryRoot, 'scripts/lib/bundle-ts.mjs')).href;
  const worker = `
    import { importTypeScriptModule } from ${JSON.stringify(helperUrl)};
    const { computeNextCronRunAt } = await importTypeScriptModule(
      'src/main/plugins/task/cron-parser.ts',
      { platform: 'node', external: ['croner'], tempDir: ${JSON.stringify(join(repositoryRoot, '.runtime/tmp'))} }
    );
    process.stdout.write(computeNextCronRunAt(${JSON.stringify(expression)}, new Date(${JSON.stringify(after)})));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', worker], {
    cwd: repositoryRoot,
    env: { ...process.env, TZ: timezone },
    encoding: 'utf8',
    timeout: 5_000
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'cron worker did not exit cleanly');
  return result.stdout;
}

test('cron parser keeps the five-field grammar and Sunday alias', () => {
  assert.deepEqual([...parseCronExpression('0 9 13 * 7').daysOfWeek], [0]);
  assert.deepEqual([...parseCronExpression('0 9 5/5 * *').daysOfMonth], [5]);

  for (const expression of [
    '0 9 * * * *',
    '@daily',
    '0 9 ? * *',
    '0 9 1,,2 * *',
    '*/5/2 * * * *'
  ]) {
    assert.throws(
      () => parseCronExpression(expression),
      (error) => error.code === 'background_task_cron_invalid' && error.message === 'Cron 表达式无效。'
    );
  }
});

test('cached cron jobs still validate the exact legacy expression', () => {
  const after = new Date('2026-10-27T14:00:00.000Z');
  assert.equal(computeNextCronRunAt('5 * * * *', after), '2026-10-27T14:05:00.000Z');
  assert.throws(
    () => computeNextCronRunAt('5/2/3 * * * *', after),
    (error) => error.code === 'background_task_cron_invalid' && error.message === 'Cron 表达式无效。'
  );
});

test('next cron run preserves minute, date, day and calendar boundaries', () => {
  const cases = [
    ['0 9 * * *', '2026-10-26T20:00:00.000Z', '2026-10-27T09:00:00.000Z'],
    ['*/15 * * * *', '2026-10-27T14:07:30.000Z', '2026-10-27T14:15:00.000Z'],
    ['7 * * * *', '2026-10-27T14:07:00.000Z', '2026-10-27T15:07:00.000Z'],
    ['0 9 13 * 5', '2026-10-01T00:00:00.000Z', '2026-11-13T09:00:00.000Z'],
    ['0 9 5/5 * *', '2026-10-27T14:00:00.000Z', '2026-11-05T09:00:00.000Z'],
    ['0 0 29 2 *', '2027-03-01T00:00:00.000Z', '2028-02-29T00:00:00.000Z'],
    ['59 23 * * *', '2026-12-31T23:58:30.000Z', '2026-12-31T23:59:00.000Z'],
    ['0 0 1 1 *', '2026-12-31T23:59:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['0 0 * * 7', '2026-10-27T14:00:00.000Z', '2026-11-01T00:00:00.000Z']
  ];

  for (const [expression, after, expected] of cases) {
    assert.equal(computeNextCronRunAt(expression, new Date(after)), expected, `${expression} after ${after}`);
  }
});

test('next cron run keeps the existing 366-day failure boundary', () => {
  for (const [expression, after] of [
    ['0 0 29 2 *', '2024-03-01T00:00:00.000Z'],
    ['0 0 31 2 *', '2026-01-01T00:00:00.000Z']
  ]) {
    assert.throws(
      () => computeNextCronRunAt(expression, new Date(after)),
      (error) => error.code === 'background_task_cron_invalid' && error.message === 'Cron 表达式无效。'
    );
  }
});

test('a cached cron job follows the process local timezone', () => {
  const after = new Date('2026-10-26T20:00:00.000Z');
  try {
    process.env.TZ = 'UTC';
    assert.equal(computeNextCronRunAt('0 9 * * *', after), '2026-10-27T09:00:00.000Z');
    process.env.TZ = 'Asia/Singapore';
    assert.equal(computeNextCronRunAt('0 9 * * *', after), '2026-10-27T01:00:00.000Z');
  } finally {
    process.env.TZ = 'UTC';
  }
});

test('next cron run uses the local timezone and matches existing DST behavior', () => {
  const cases = [
    ['Asia/Singapore', '0 9 * * *', '2026-10-26T20:00:00.000Z', '2026-10-27T01:00:00.000Z'],
    ['America/New_York', '30 2 * * *', '2026-03-08T06:55:00.000Z', '2026-03-09T06:30:00.000Z'],
    ['America/New_York', '30 1 * * *', '2026-11-01T05:45:00.000Z', '2026-11-02T06:30:00.000Z']
  ];

  for (const [timezone, expression, after, expected] of cases) {
    assert.equal(computeInTimezone(timezone, expression, after), expected, `${timezone}: ${expression}`);
  }
});
