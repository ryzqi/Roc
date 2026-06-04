import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const rendererChunkRules = [
  {
    chunk: 'renderer-terminal',
    packages: ['@xterm/addon-fit', '@xterm/xterm']
  },
  {
    chunk: 'renderer-diff',
    packages: ['react-diff-view']
  },
  {
    chunk: 'renderer-markdown',
    packages: ['react-markdown', 'rehype-highlight', 'remark-gfm', 'highlight.js']
  }
] as const;

export function resolveRendererManualChunk(id: string): string | undefined {
  const normalizedId = id.replace(/\\/g, '/');
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
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        },
        external: ['better-sqlite3', 'node-pty']
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
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
