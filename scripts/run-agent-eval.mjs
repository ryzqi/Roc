#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  requireDeterministicMode(process.argv.slice(2));
  process.exitCode = runDeterministicEval();
} catch (error) {
  console.error(readErrorMessage(error));
  process.exitCode = 1;
}

function requireDeterministicMode(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.length === 0) {
    throw new Error('agent_eval_mode_missing');
  }
  const flag = args[0];
  if (flag !== '--mode') {
    throw new Error(`agent_eval_unknown_arg:${flag}`);
  }
  const mode = args[1];
  if (mode === undefined || mode.trim().length === 0) {
    throw new Error('agent_eval_mode_missing');
  }
  if (args.length > 2) {
    throw new Error(`agent_eval_unknown_arg:${args[2]}`);
  }
  if (mode !== 'deterministic') {
    throw new Error(`agent_eval_mode_unsupported:${mode}`);
  }
}

function runDeterministicEval() {
  const vitestPackagePath = fileURLToPath(import.meta.resolve('vitest/package.json'));
  const vitestCliPath = resolve(dirname(vitestPackagePath), 'vitest.mjs');
  const result = spawnSync(
    process.execPath,
    [vitestCliPath, 'run', '--config', 'vitest.agent-eval.config.ts'],
    {
      env: process.env,
      stdio: 'inherit'
    }
  );
  if (result.error !== undefined) {
    throw new Error('agent_eval_runner_start_failed', { cause: result.error });
  }
  if (result.status === null) {
    throw new Error(`agent_eval_runner_terminated:${String(result.signal)}`);
  }
  return result.status;
}

function readErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
