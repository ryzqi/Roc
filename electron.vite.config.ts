import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export const rendererChunkRules = [
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
  }
] as const;

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
    const packages: readonly string[] = rule.packages;
    if (packages.includes(packageName)) {
      return rule.chunk;
    }
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
