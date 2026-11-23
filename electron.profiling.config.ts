import {defineConfig, mergeConfig} from 'electron-vite';
import {createRequire} from 'node:module';
import {basename, dirname, resolve} from 'node:path';
import base from './electron.vite.config';
// This configuration is used only by the isolated performance build.
import {rendererProfilingPlugin, preloadProfilingPlugin} from './scripts/performance/profiling/build-plugin.mjs';

const root = __dirname;
const directory = process.env.ROC_PROFILE_BUILD_DIR;
if (directory === undefined) throw new Error('ROC_PROFILE_BUILD_DIR is required');
const output = resolve(directory);
if (dirname(output) !== root || !basename(output).startsWith('.roc-profile-')) {
  throw new Error('Profiling output must be a task-owned .roc-profile-* directory at the repository root');
}
const require = createRequire(import.meta.url);

export default defineConfig({
  main: mergeConfig(base.main ?? {}, {build:{outDir:resolve(output,'main')}}),
  preload: mergeConfig(base.preload ?? {}, {plugins:[preloadProfilingPlugin(root)],build:{outDir:resolve(output,'preload')}}),
  renderer: mergeConfig(base.renderer ?? {}, {
    plugins:[rendererProfilingPlugin(root)],
    resolve:{alias:[{find:/^react-dom\/client$/,replacement:require.resolve('react-dom/profiling')}]},
    build:{outDir:resolve(output,'renderer')}
  })
});
