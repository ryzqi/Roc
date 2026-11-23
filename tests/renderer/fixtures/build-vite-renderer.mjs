import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {build} from 'vite';
import react from '@vitejs/plugin-react';

/** Compile renderer fixtures with real lazy modules and Vite's emitted worker assets. */
export async function buildViteRenderer({directory, script, style, setup = '', csp = '', plugins = []}) {
  const scratch = join(process.cwd(), '.runtime/tmp');
  await mkdir(scratch, {recursive: true});
  const input = await mkdtemp(join(scratch, 'roc-vite-renderer-'));
  try {
    const assets = join(process.cwd(), 'dist/renderer/assets');
    const styles = await Promise.all((await readdir(assets)).filter(file => file.endsWith('.css'))
      .map(file => readFile(join(assets, file), 'utf8')));
    await writeFile(join(input, 'app.tsx'), script);
    await writeFile(join(input, 'app.css'), styles.join('\n'));
    if (csp) await writeFile(join(input, 'setup.js'), setup);
    await writeFile(join(input, 'index.html'), `<!doctype html><html data-theme="light">${csp}<link rel="stylesheet" href="/app.css">
      <style>${style}</style><div id="root"></div>${csp ? '<script type="module" src="/setup.js"></script>' : `<script>${setup}</script>`}
      <script type="module" src="/app.tsx"></script></html>`);
    await build({configFile: false, root: input, base: './', plugins: [...plugins, react()], logLevel: 'silent',
      resolve: {alias: [{find: /^\.\/src\//u, replacement: `${join(process.cwd(), 'src')}/`}]},
      build: {outDir: directory, emptyOutDir: false, manifest: true}});
  } finally {
    await rm(input, {recursive: true, force: true});
  }
}
