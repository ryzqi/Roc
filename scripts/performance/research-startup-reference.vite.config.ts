import config from '../../electron.vite.config';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

// Run on the PR-10 source revision. Dependencies are intentionally shared;
// only the two production files changed by that phase are frozen to PR-09.
const frozenRevision = 'f1c6d7920719d2a2d7a75bf6cb9a4b099a87ddc0';
const frozenFiles = [
  'src/main/plugins/research/index.ts',
  'src/main/plugins/research/research-plugin-lifecycle.ts'
];
const sources = new Map(frozenFiles.map(path => [
  resolve(path), execFileSync('git', ['show', `${frozenRevision}:${path}`], {encoding: 'utf8'})
]));
// Main resolves development resources two levels above its module directory.
const root = resolve('.runtime');

export default {
  ...config,
  main: {
    ...config.main,
    plugins: [{
      name: 'frozen-pr-09-research',
      enforce: 'pre' as const,
      load(id: string) { return sources.get(id) ?? null; }
    }],
    build: {...config.main?.build, outDir: resolve(root, 'main')}
  },
  preload: {...config.preload, build: {...config.preload?.build, outDir: resolve(root, 'preload')}},
  renderer: {...config.renderer, build: {...config.renderer?.build, outDir: resolve(root, 'renderer')}}
};
