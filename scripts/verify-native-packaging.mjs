#!/usr/bin/env node

import { resolve } from 'node:path';
import { verifyWorkspaceBetterSqlite3 } from './lib/native-packaging.mjs';

function readOption(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

const requireBase = readOption('--require-base');
const label = readOption('--label') ?? 'workspace-better-sqlite3';
let exitCode = 0;

try {
  verifyWorkspaceBetterSqlite3({
    label,
    requireBase: requireBase === undefined ? undefined : resolve(requireBase)
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
}

process.exit(exitCode);
