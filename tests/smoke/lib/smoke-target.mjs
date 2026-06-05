import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveSmokeTarget({
  env = process.env,
  packagedExe = resolve('release/win-unpacked/Roc.exe'),
  distMainPath = resolve('dist/main/index.js'),
  exists = existsSync
} = {}) {
  if (env.ROC_SMOKE_TARGET === 'dist') {
    return {
      kind: 'dist-main-fallback',
      path: distMainPath,
      executablePath: undefined,
      launchArgs: [distMainPath]
    };
  }

  if (env.ROC_SMOKE_TARGET === 'packaged' || exists(packagedExe)) {
    if (!exists(packagedExe)) {
      throw new Error(`Packaged smoke target is unavailable: ${packagedExe}`);
    }
    return {
      kind: 'packaged-exe',
      path: packagedExe,
      executablePath: packagedExe,
      launchArgs: []
    };
  }

  return {
    kind: 'dist-main-fallback',
    path: distMainPath,
    executablePath: undefined,
    launchArgs: [distMainPath]
  };
}
