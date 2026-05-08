#!/usr/bin/env node

import { resolve } from 'node:path';
import { verifyBetterSqlite3WithElectron } from './lib/native-packaging.mjs';

function readOption(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

const requireBase = readOption('--require-base');
const label = readOption('--label') ?? 'workspace-better-sqlite3';

verifyBetterSqlite3WithElectron({
  label,
  requireBase: requireBase === undefined ? undefined : resolve(requireBase)
});
