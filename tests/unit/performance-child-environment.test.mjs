import assert from 'node:assert/strict';
import {test} from 'node:test';
import {benchmarkChildEnvironment} from '../../scripts/performance/child-environment.mjs';

test('benchmark children cannot inherit a dev renderer, Node-only Electron or another measurement mode', () => {
  const inherited={PATH:'/runtime/bin', LANG:'zh_CN.UTF-8', ELECTRON_RENDERER_URL:'http://localhost:5173',
    ELECTRON_RUN_AS_NODE:'1', ROC_PERF_APP_DIR:'/unrelated-build', ROC_PERF_REQUIRE_PROFILE:'1',
    ROC_PERF_KEEP_ARTIFACTS:'1', ROC_PERF_RAW_TRACE_DIR:'/unrelated-traces', ROC_PERF_STREAM_MINUTES:'120',
    ROC_PERF_PDF_REFERENCE_RENDERER:'/old-renderer', ROC_PERF_PDF_SOURCE_PAIRED:'1', ROC_PERF_UNKNOWN_OPTION:'1'};
  const original={...inherited};
  for (const profile of ['0','1']) {
    const options={ROC_PERF_APP_DIR:profile==='1' ? '/isolated-profile-build' : '/production-dist',
      ROC_PERF_REQUIRE_PROFILE:profile, ROC_PERF_KEEP_ARTIFACTS:'0', ROC_PERF_STREAM_MINUTES:'0'};
    const env=benchmarkChildEnvironment(inherited,options);
    assert.deepEqual(env,{PATH:inherited.PATH,LANG:inherited.LANG,...options});
    assert.deepEqual(inherited,original);
  }
});
