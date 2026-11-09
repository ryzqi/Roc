import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { finalizePackagedResearchToolchain } from '../lib/native-packaging.mjs';

// Use the installed builder's signer, including its retries and signing options.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const { sign } = builderRequire('app-builder-lib/out/codeSign/macCodeSign.js');

export default async function signApp(options) {
  const appPath = resolve(options.app);
  let finalized = false;
  await sign({
    ...options,
    optionsForFile(filePath) {
      const fileOptions = options.optionsForFile?.(filePath);
      // osx-sign visits all nested binaries before the outer app. Refresh here:
      // afterPack is too early; afterSign would invalidate the app's resource seal.
      if (resolve(filePath) === appPath) {
        finalizePackagedResearchToolchain({
          resourcesDir: join(appPath, 'Contents', 'Resources'),
          architecture: 'arm64'
        });
        finalized = true;
      }
      return fileOptions;
    }
  });
  if (!finalized) throw new Error('Packaged research toolchain was not finalized before app signing.');
}
