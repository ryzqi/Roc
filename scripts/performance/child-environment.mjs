/** Keep host/runtime settings while making every benchmark mode explicit. */
export function benchmarkChildEnvironment(environment, options) {
  const env = {...environment};
  for (const name of Object.keys(env)) if (name.startsWith('ROC_PERF_')) delete env[name];
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  return {...env, ...options};
}
