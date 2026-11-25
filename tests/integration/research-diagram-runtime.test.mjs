import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {build as buildRenderer} from 'vite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {rm, access, mkdir, mkdtemp} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import electron from 'electron';
const exec=promisify(execFile);
test('real sandboxed Electron diagram worker preserves reference PNG output, exports SVG/PDF and closes failed windows', {timeout:120000}, async()=>{
 await access('dist/renderer/diagram-worker.html');
 await mkdir('.runtime/tmp',{recursive:true});
 const referenceRoot=await mkdtemp(resolve('.runtime/tmp/diagram-reference-'));
 const output=resolve('dist/main/scientific-writing-test.mjs');
 try {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  const runFixture=async(outfile)=>{
   await build({entryPoints:['tests/integration/fixtures/scientific-writing-electron.ts'],outfile,platform:'node',format:'esm',bundle:true,packages:'external',logLevel:'silent'});
   const result=await exec(electron,[outfile],{env,timeout:80000,maxBuffer:1024*1024});
   return JSON.parse(result.stdout.trim());
  };
  // Build the same installed Mermaid without pruning or the ELK transport
  // adapter. Compare on the same OS/fonts instead of storing platform PNG hashes.
  await buildRenderer({configFile:false,root:process.cwd(),base:'./',logLevel:'silent',
   build:{outDir:join(referenceRoot,'renderer'),minify:'oxc',
    rolldownOptions:{input:{'diagram-worker':resolve('diagram-worker.html')}}}});
  const reference=await runFixture(join(referenceRoot,'main/test.mjs'));
  const actual=await runFixture(output);
  const pixels=result=>result.rendered.map(({name,pngSha256})=>({name,pngSha256}));
  assert.deepEqual(pixels(actual),pixels(reference),'optimized diagrams must preserve reference pixels and geometry');
  console.log(JSON.stringify(actual));
 } finally {
  await rm(output,{force:true});
  await rm(referenceRoot,{recursive:true,force:true});
 }
});
