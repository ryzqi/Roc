import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRtkService } from '../../../../src/main/plugins/runtime-tools/rtk-adapter';
import { RTKBinaryManager } from '../../../../src/rtk-integration';

let root: string;
let resourcesPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-runtime-tools-rtk-'));
  resourcesPath = join(root, 'resources');
  mkdirSync(join(resourcesPath, 'rtk-binaries', 'win32-x64'), { recursive: true });
  writeFileSync(join(resourcesPath, 'rtk-binaries', 'win32-x64', 'rtk.exe'), 'fake rtk');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runtime tools RTK adapter', () => {
  it('uses RTKBinaryManager resource resolution without hardcoding a plugin path', () => {
    const service = createRtkService({
      rootDir: root,
      binaryManager: new RTKBinaryManager({
        platform: 'win32',
        arch: 'x64',
        resourcesPath
      })
    });

    expect(service.getStatus()).toMatchObject({
      enabledForAgentCommands: true,
      binaryPath: join(resourcesPath, 'rtk-binaries', 'win32-x64', 'rtk.exe'),
      configPath: join(root, 'rtk', 'config.toml'),
      teeDir: join(root, 'rtk', 'tee'),
      resourceState: 'ready'
    });
  });
});
