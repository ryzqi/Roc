import {resolve} from 'node:path';

export const profilingBoundaries = [
  ['src/renderer/App.tsx', 'App', 'root'],
  ['src/renderer/app/AppShellContent.tsx', 'AppShellContent', 'shell'],
  ['src/renderer/app/ViewContent.tsx', 'ViewContent', 'canvas'],
  ['src/renderer/shell/ContextDrawer.tsx', 'ContextDrawer', 'sidebar'],
  ['src/renderer/assistant/AssistantPanel.tsx', 'AssistantPanel', 'assistant'],
  ['src/renderer/assistant/transcript-panel.tsx', 'ChatTranscriptPanel', 'transcript'],
  ['src/renderer/assistant/composer.tsx', 'AssistantComposer', 'composer'],
  ['src/renderer/literature/LibraryList.tsx', 'LibraryList', 'library'],
  ['src/renderer/literature/PaperReader.tsx', 'PaperReader', 'reader'],
  ['src/renderer/literature/KnowledgeGraphView.tsx', 'KnowledgeGraphView', 'graph']
];

export function rendererProfilingPlugin(root) {
  const targets = new Map(profilingBoundaries.map(([file, symbol, boundary]) => [resolve(root,file), {symbol,boundary}]));
  const seen = new Set();
  return {
    name:'roc-benchmark-react-profiler', enforce:'pre', apply:'build',
    transform(source,id) {
      const target = targets.get(id);
      if (target === undefined) return null;
      const marker = `export function ${target.symbol}(`;
      if (!source.includes(marker)) throw new Error(`profiling_export_changed:${id}`);
      seen.add(id);
      const original = `RocOriginal_${target.symbol}`;
      return {code:`import {profileComponent as rocProfileComponent} from ${JSON.stringify(resolve(root,'scripts/performance/profiling/renderer-runtime.mjs'))};\n` +
        source.replace(marker, `function ${original}(`) +
        `\nexport const ${target.symbol} = rocProfileComponent(${JSON.stringify(target.boundary)}, ${original});\n`,map:null};
    },
    generateBundle(_options, bundle) {
      for (const file of targets.keys()) if (!seen.has(file)) throw new Error(`profiling_boundary_not_built:${file}`);
      const modules = Object.values(bundle).filter(chunk => chunk.type === 'chunk')
        .flatMap(chunk => Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0).map(([id]) => id));
      const reconciler = modules.find(id => id.replaceAll('\\', '/').endsWith('/react-dom-profiling.profiling.js'));
      if (reconciler === undefined) throw new Error('react_profiling_reconciler_missing');
      if (modules.some(id => id.replaceAll('\\', '/').endsWith('/react-dom-client.production.js'))) {
        throw new Error('ordinary_reconciler_in_profiling_build');
      }
      this.emitFile({type:'asset', fileName:'.vite/profiling-build.json', source:JSON.stringify({
        mode:'react-production-profiling', reconciler:'react-dom-profiling.profiling.js',
        boundaries:profilingBoundaries.map(([, , boundary]) => boundary)
      })});
    }
  };
}

export function preloadProfilingPlugin(root) {
  const target = resolve(root,'src/preload/ipc-api-generated.ts');
  let count = 0;
  return {
    name:'roc-benchmark-ipc-profiler', enforce:'pre', apply:'build',
    transform(source,id) {
      if (id !== target) return null;
      count = source.split('ipcRenderer.invoke(').length - 1;
      if (count < 1) throw new Error('profiling_preload_invokes_missing');
      return {code:`import {profileInvoke} from ${JSON.stringify(resolve(root,'scripts/performance/profiling/preload-runtime.mjs'))};\n` +
        source.replaceAll('ipcRenderer.invoke(', 'profileInvoke('),map:null};
    },
    generateBundle() {if (count < 1) throw new Error('profiling_preload_not_built');}
  };
}
