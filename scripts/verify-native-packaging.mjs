#!/usr/bin/env node

import { resolve } from 'node:path';
import { assertRipgrepBinaryForPackaging, verifyWorkspaceBetterSqlite3 } from './lib/native-packaging.mjs';

function readOption(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

const requireBase = readOption('--require-base');
const label = readOption('--label') ?? 'workspace-better-sqlite3';
const architecture = readOption('--arch') ?? process.arch;
let exitCode = 0;

try {
  verifyWorkspaceBetterSqlite3({
    label,
    requireBase: requireBase === undefined ? undefined : resolve(requireBase)
  });
  // 随包 ripgrep 没进包不会让搜索挂掉（会降级），所以它需要一个**显式**的检查点。
  // README 的「升级 ripgrep」一行把这条命令写成验收步骤，这里就得真的校验。
  assertRipgrepBinaryForPackaging({ architecture });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
}

process.exit(exitCode);
