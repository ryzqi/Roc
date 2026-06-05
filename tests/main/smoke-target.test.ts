import { describe, expect, it } from 'vitest';
import { resolveSmokeTarget } from '../smoke/lib/smoke-target.mjs';

describe('smoke target selection', () => {
  it('uses the packaged executable by default when package:dir has produced Roc.exe', () => {
    expect(
      resolveSmokeTarget({
        env: {},
        packagedExe: 'F:/Code/Roc/release/win-unpacked/Roc.exe',
        distMainPath: 'F:/Code/Roc/dist/main/index.js',
        exists: (path) => path.endsWith('Roc.exe')
      })
    ).toEqual({
      kind: 'packaged-exe',
      path: 'F:/Code/Roc/release/win-unpacked/Roc.exe',
      executablePath: 'F:/Code/Roc/release/win-unpacked/Roc.exe',
      launchArgs: []
    });
  });

  it('allows dist smoke to be requested explicitly', () => {
    expect(
      resolveSmokeTarget({
        env: { ROC_SMOKE_TARGET: 'dist' },
        packagedExe: 'F:/Code/Roc/release/win-unpacked/Roc.exe',
        distMainPath: 'F:/Code/Roc/dist/main/index.js',
        exists: () => true
      })
    ).toEqual({
      kind: 'dist-main-fallback',
      path: 'F:/Code/Roc/dist/main/index.js',
      executablePath: undefined,
      launchArgs: ['F:/Code/Roc/dist/main/index.js']
    });
  });

  it('fails when packaged smoke is requested without Roc.exe', () => {
    expect(() =>
      resolveSmokeTarget({
        env: { ROC_SMOKE_TARGET: 'packaged' },
        packagedExe: 'F:/Code/Roc/release/win-unpacked/Roc.exe',
        distMainPath: 'F:/Code/Roc/dist/main/index.js',
        exists: () => false
      })
    ).toThrow('Packaged smoke target is unavailable: F:/Code/Roc/release/win-unpacked/Roc.exe');
  });
});
