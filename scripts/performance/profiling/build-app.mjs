import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
function ordinaryBuild() {
  const visit = directory => readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const file = join(directory,entry.name);
    return entry.isDirectory() ? visit(file) : entry.isFile() ? [file] : [];
  });
  return visit('dist').sort().map(file => {
    const data = readFileSync(file);
    assert.ok(!data.includes('__rocReactProfile') && !data.includes('__rocIpcProfile'), `ordinary_build_contains_profiler:${file}`);
    return [file,hash(data)];
  });
}

/** The temporary root is a sibling of dist: existing ../../resources paths remain valid. */
export function buildProfilingApp() {
  const before = ordinaryBuild();
  const directory = mkdtempSync(join(process.cwd(),'.roc-profile-'));
  try {
    const built = spawnSync('pnpm',['exec','electron-vite','build','--config','electron.profiling.config.ts'],
      {stdio:'inherit',env:{...process.env,ROC_PROFILE_BUILD_DIR:directory}});
    assert.equal(built.status,0,'profiling_build_failed');
    assert.deepEqual(ordinaryBuild(),before,'ordinary_dist_changed_during_profiling_build');
    const assets = readdirSync(join(directory,'renderer/assets')).filter(name=>name.endsWith('.js'))
      .map(name=>readFileSync(join(directory,'renderer/assets',name),'utf8')).join('\n');
    assert.ok(assets.includes('__rocReactProfile'),'profiling_renderer_instrumentation_missing');
    assert.ok(readFileSync(join(directory,'preload/index.cjs'),'utf8').includes('__rocIpcProfile'),'profiling_preload_instrumentation_missing');
    const metadata = JSON.parse(readFileSync(join(directory,'renderer/.vite/profiling-build.json'),'utf8'));
    assert.equal(metadata.reconciler,'react-dom-profiling.profiling.js','react_profiling_reconciler_missing');
    assert.equal(metadata.boundaries.length,10,'profiling_boundaries_missing');
    return {directory:resolve(directory),dispose:()=>rmSync(directory,{recursive:true,force:true})};
  } catch (error) {rmSync(directory,{recursive:true,force:true});throw error;}
}
