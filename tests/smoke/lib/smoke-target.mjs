import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveSmokeTarget({
  env = process.env,
  packagedExe = resolve('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Roc.app/Contents/MacOS/Roc'),
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
