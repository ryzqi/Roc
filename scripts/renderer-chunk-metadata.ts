import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

export function packageNameFromModuleId(id: string): string | undefined {
  const normalized = id.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  const parts = normalized.slice(index + marker.length).split('/');
  return parts[0]?.startsWith('@') && parts[1] !== undefined ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Build-time attribution survives minification; excluded from packaged resources with .vite/. */
export function rendererChunkMetadata(): Plugin {
  return {
    name: 'roc-renderer-chunk-metadata',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      // Vite adds preload dependencies during generateBundle, after user plugins.
      order: 'post',
      handler(_options, bundle) {
        const chunks: Record<string, { sha256: string; packages: Record<string, number> }> = {};
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk') continue;
          const packages: Record<string, number> = {};
          for (const [id, module] of Object.entries(chunk.modules)) {
            if (module.renderedLength === 0) continue;
            const name = packageNameFromModuleId(id);
            if (name !== undefined) packages[name] = (packages[name] ?? 0) + 1;
          }
          chunks[chunk.fileName] = { sha256: createHash('sha256').update(chunk.code).digest('hex'), packages };
        }
        this.emitFile({
          type: 'asset',
          fileName: '.vite/chunk-packages.json',
          source: JSON.stringify({ version: 1, chunks })
        });
      }
    }
  };
}
