import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve('.');
const schemaPath = resolve(repoRoot, 'src/main/services/deep-agent/background-task-tools.ts');
const baselineCommand = ['pnpm', ['vitest', 'run', 'tests/main/background-task-schema.test.ts']];
const original = readFileSync(schemaPath, 'utf8');
const tempDir = mkdtempSync(join(tmpdir(), 'roc-harness-bite-'));
const backupPath = join(tempDir, 'background-task-tools.ts');

copyFileSync(schemaPath, backupPath);

let exitCode = 1;
try {
  const baseline = runCommand(...baselineCommand);
  if (baseline.status !== 0) {
    console.error('Baseline schema harness must pass before negative control.');
    process.exitCode = baseline.status ?? 1;
    exitCode = process.exitCode;
  } else {
    const mutated = original.replace(
      "export const triggerSchema = z\n  .discriminatedUnion('type', [manualTriggerSchema, onceTriggerSchema, cronTriggerSchema])\n  .describe('触发类型：manual / once / cron。');",
      "export const triggerSchema = z\n  .object({})\n  .passthrough()\n  .describe('触发类型：manual / once / cron。');"
    );
    if (mutated === original) {
      throw new Error('Could not apply negative-control mutation to triggerSchema.');
    }

    writeFileSync(schemaPath, mutated, 'utf8');
    const negative = runCommand(...baselineCommand);
    if (negative.status === 0) {
      console.error('Negative control failed: schema harness still passed after relaxing triggerSchema.');
      process.exitCode = 1;
      exitCode = 1;
    } else {
      console.log('Negative control passed: schema harness failed after relaxing triggerSchema.');
      process.exitCode = 0;
      exitCode = 0;
    }
  }
} finally {
  writeFileSync(schemaPath, original, 'utf8');
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(exitCode);

function runCommand(command, args) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
}
