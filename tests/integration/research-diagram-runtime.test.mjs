import test from 'node:test';
import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {rm, access} from 'node:fs/promises';
import {resolve} from 'node:path';
import electron from 'electron';
const exec=promisify(execFile);
test('real sandboxed Electron diagram worker renders frozen SVG/PNG/PDF and closes failed windows', {timeout:90000}, async()=>{
 await access('dist/renderer/diagram-worker.html');
 const output=resolve('dist/main/scientific-writing-test.mjs');
 try {
  await build({entryPoints:['tests/integration/fixtures/scientific-writing-electron.ts'],outfile:output,platform:'node',format:'esm',bundle:true,packages:'external',logLevel:'silent'});
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  const result=await exec(electron,[output],{env,timeout:80000,maxBuffer:1024*1024});console.log(result.stdout);
 } finally {await rm(output,{force:true});}
});
