import { build } from 'esbuild';

/**
 * 把一个 TS 模块打进内存并 import 回来。
 *
 * ## 为什么不是临时文件
 *
 * 十二份 `tests/unit/*.mjs` 各自复制了一遍 `mkdtempSync` + `esbuild.build({outfile})` + `rmSync`，
 * 每个测试文件都要管一个临时目录的生命周期。而仓库里**已经有**更好的写法：
 * `scripts/generate-ipc-schema.mjs` 用 `write: false` 拿到编译结果，再从 `data:` URL import，
 * 没有临时文件、没有清理、没有失败路径下的残留。这个模块就是那个写法的提取。
 *
 * ## 为什么单测必须这样加载源码
 *
 * 单测跑的是 `src/` 里的 TS（不是 `dist/`，也不是打好的包），因为被守的性质是纯逻辑：
 * 面的分类学、路由往返、投影的稳定性。esbuild 是 devDependency，`node --test` 就够，
 * 不引入第二个测试框架。
 *
 * ## 限度（写下来以免被当成更强的保证）
 *
 * `platform: 'neutral'` + `target: 'node22'` 与 Electron 渲染层**不是**同一个目标，
 * 所以 schema/DOM 层面的漂移这里看不见；`data:` URL 里也没有文件系统基址，任何用
 * `import.meta.url` 或动态路径的模块都加载不了。要验证真实运行行为得看 `verify:p*` 闸门
 *（真 Electron、真 IPC）。
 *
 * @param {string} entry 仓库相对或绝对路径，例如 `src/shared/surfaces.ts`
 * @param {{ target?: string, platform?: 'neutral' | 'node' | 'browser' }} [options]
 */
export async function importTypeScriptModule(entry, options = {}) {
  const { target = 'node22', platform = 'neutral' } = options;
  const compiled = await build({
    bundle: true,
    entryPoints: [entry],
    format: 'esm',
    logLevel: 'silent',
    platform,
    target,
    write: false
  });
  const output = compiled.outputFiles?.[0];
  if (output === undefined) {
    throw new Error(`bundle_produced_no_output:${entry}`);
  }
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(output.text).toString('base64')}`;
  return await import(moduleUrl);
}
