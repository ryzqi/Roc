import assert from 'node:assert/strict';

/** Optional bridge for ordinary measurements; profiling must be explicitly required by its runner. */
export async function beginRendererProfile(page, label = 'workload', {required = false} = {}) {
  const available = await page.evaluate(name => {
    const react = window.__rocReactProfile, ipc = window.__rocIpcProfile;
    if (!react && !ipc) return false;
    if (!react || !ipc) throw new Error('incomplete_renderer_profiling_build');
    react.begin(name); ipc.begin(name); return true;
  },label);
  assert.ok(!required || available, 'renderer_profiling_build_required');
  return available;
}

export async function endRendererProfile(page) {
  return await page.evaluate(() => {
    const react = window.__rocReactProfile, ipc = window.__rocIpcProfile;
    if (!react && !ipc) return null;
    if (!react || !ipc) throw new Error('incomplete_renderer_profiling_build');
    return {reactProfile:react.end(),ipcProfile:ipc.end(),buildMode:'react-production-profiling'};
  });
}
