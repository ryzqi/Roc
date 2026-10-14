import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

type RendererChunkRule = {
  chunk: string;
  packages: readonly string[];
  /**
   * Optional further narrowing applied to the **module id**.
   *
   * Used to pull only a handful of lucide icons out of the default split, rather
   * than all of `lucide-react`: grouping the whole package would drag icons that
   * are only used by lazily loaded panels into the eager graph (measured: +38 KB
   * on the legacy build).
   */
  moduleIdPattern?: RegExp;
};

/**
 * chunk 划分规则。
 *
 * `colliding-icon` 这条是必需的，不是优化：rolldown 为一个被多个 chunk 共享的
 * 模块生成以**模块文件名**命名的共享 chunk，而
 * `scripts/check-renderer-chunks.mjs` 会把 forbidden 模式
 *（`/markdown|streamdown|highlight|settings/iu`）同时拿去匹配 chunk 文件名。
 * lucide 的 `settings.mjs` / `settings-2.mjs` / `markdown.mjs` / `highlight.mjs`
 * 正好撞上这个模式：一旦入口与某个懒加载面板都用到该图标，就会产出一个被入口
 * **静态**引用的 `settings-<hash>.js`，从而让构建因为一个图标而失败。
 * 把这些模块钉到一个安全名字的 chunk 上即可彻底避开；其余图标维持默认拆分，
 * 不会把懒加载专用的图标拖进首屏。
 */
export const rendererChunkRules: readonly RendererChunkRule[] = [
  {
    chunk: 'renderer-terminal',
    packages: ['@xterm/addon-fit', '@xterm/xterm']
  },
  {
    chunk: 'renderer-diff',
    packages: ['react-diff-view']
  },
  {
    chunk: 'renderer-katex',
    packages: ['katex']
  },
  {
    chunk: 'renderer-icons-safe',
    packages: ['lucide-react'],
    moduleIdPattern: /\/(settings|settings-2|markdown|highlight|streamdown)\.mjs$/u
  }
];

/**
 * Temporary entry switch for the parallel migration period (ADR-M01).
 *
 * The renderer keeps exactly one build entry - `index.html` - so
 * `check-renderer-chunks.mjs` stays deterministic (it locates "the" entry by
 * `isEntry === true`). With `ROC_RENDERER=next`, the module the entry imports is
 * aliased to the new shell. P10 deletes this together with the legacy shell.
 */
const useNextRenderer = process.env.ROC_RENDERER === 'next';

export function resolveRendererManualChunk(id: string): string | undefined {
  const normalizedId = id;
  const marker = '/node_modules/';
  const markerIndex = normalizedId.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const packagePath = normalizedId.slice(markerIndex + marker.length);
  const packageParts = packagePath.split('/');
  const packageName =
    packageParts[0] !== undefined && packageParts[0].startsWith('@') && packageParts[1] !== undefined
      ? `${packageParts[0]}/${packageParts[1]}`
      : packageParts[0];
  if (packageName === undefined) {
    return undefined;
  }
  for (const rule of rendererChunkRules) {
    if (!rule.packages.includes(packageName)) {
      continue;
    }
    if (rule.moduleIdPattern !== undefined && !rule.moduleIdPattern.test(normalizedId)) {
      continue;
    }
    return rule.chunk;
  }
  return undefined;
}

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      // Vite 8 已弃用 build.rollupOptions（别名），electron-vite 6 的规范键是 rolldownOptions。
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'database-maintenance-cli': resolve(__dirname, 'src/main/infrastructure/database-maintenance-cli.ts'),
          'research-job-cli': resolve(__dirname, 'src/main/plugins/research/research-job-cli.ts')
        },
        external: ['better-sqlite3', 'electron', 'node-pty', '@napi-rs/canvas', 'pdfjs-dist']
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        external: ['electron'],
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    root: '.',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: useNextRenderer
        ? [{ find: '/src/renderer/main.tsx', replacement: resolve(__dirname, 'src/renderer-next/main.tsx') }]
        : []
    },
    build: {
      outDir: 'dist/renderer',
      manifest: true,
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        },
        output: {
          manualChunks: resolveRendererManualChunk
        }
      }
    }
  }
});
