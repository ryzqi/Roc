import { describe, expect, it } from 'vitest';
import { resolveSmokeTarget } from '../smoke/lib/smoke-target.mjs';

describe('smoke target selection', () => {
  it('uses the packaged executable by default when package:dir has produced Roc.app', () => {
    expect(
      resolveSmokeTarget({
        env: {},
        packagedExe: '/Users/test/Roc/release/mac-arm64/Roc.app/Contents/MacOS/Roc',
        distMainPath: '/Users/test/Roc/dist/main/index.js',
        exists: (path) => path.endsWith('/Contents/MacOS/Roc')
      })
    ).toEqual({
      kind: 'packaged-exe',
      path: '/Users/test/Roc/release/mac-arm64/Roc.app/Contents/MacOS/Roc',
      executablePath: '/Users/test/Roc/release/mac-arm64/Roc.app/Contents/MacOS/Roc',
      launchArgs: []
    });
  });

  it('allows dist smoke to be requested explicitly', () => {
    expect(
      resolveSmokeTarget({
        env: { ROC_SMOKE_TARGET: 'dist' },
        packagedExe: '/Users/test/Roc/release/mac-arm64/Roc.app/Contents/MacOS/Roc',
        distMainPath: '/Users/test/Roc/dist/main/index.js',
        exists: () => true
      })
    ).toEqual({
      kind: 'dist-main-fallback',
      path: '/Users/test/Roc/dist/main/index.js',
      executablePath: undefined,
      launchArgs: ['/Users/test/Roc/dist/main/index.js']
    });
  });

  it('fails when packaged smoke is requested without Roc.app', () => {
    expect(() =>
      resolveSmokeTarget({
        env: { ROC_SMOKE_TARGET: 'packaged' },
        packagedExe: '/Users/test/Roc/release/mac-arm64/Roc.app/Contents/MacOS/Roc',
        distMainPath: '/Users/test/Roc/dist/main/index.js',
        exists: () => false
      })
    ).toThrow('Packaged smoke target is unavailable: /Users/test/Roc/release/mac-arm64/Roc.app/Contents/MacOS/Roc');
  });
});
