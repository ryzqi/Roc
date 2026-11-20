import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 闸门脚手架的共用部分。
 *
 * ## 为什么抽它
 *
 * 五个 `verify-p*.mjs`（合计 4907 行）各自复刻了同一批记账与导航代码：
 *
 *   - `record` / `fail` / `assertCheck` 三件套 —— 五个文件里逐字相同（每个 14 行）；
 *   - `navigate` —— 函数体逐字相同，但**签名有两种**：p3/p4/p5 收 `(page, search)`，
 *     p8/p9 收 `(search)` 并靠外层同名变量 `page`。同一个函数体从两个不同的变量取值，
 *     是那种只会在改一处时咬人的重复。
 *   - 报告写出 —— 五个文件都是 `{ checkedAt, passed, ...各自的 extras, results, rendererErrors }`，
 *     失败路径再加 `error`。
 *
 * 复制出来的脚手架有个具体代价，而且已经付过一次：**它不知道自己断言的面已经不存在了。**
 * P10 删掉总览面之后，八处 `view=overview` 仍然在被归一成 `latex` 的页面上让断言通过
 *（第九处在 `verify-p4-assistant.mjs:80` 的**参数默认值**里，字面量扫描看不见它）。
 * 那几个 id 现在就由 `tests/unit/surfaces.test.mjs` 全量扫掉；这里只负责让下次改动只改一处。
 *
 * ## 这个文件不 import 面表
 *
 * `navigate` 故意**不做**运行时面校验。理由不是省事：校验的成本是让五个闸门脚本多一个
 * 加载步骤（面表要么走 esbuild 打包、要么依赖 Node ≥23.6 的类型剥离），而收益已经被静态扫描
 * 完全覆盖 —— 扫描读的就是这些脚本本身，所以新写一个坏 id 在单测里就会红。
 * 单一执法点比两个半覆盖的执法点好。
 *
 * ## 不抽的东西
 *
 * 启动（`electron.launch` 的 env / args 各脚本不同）与收尾（关 app、关 provider、清目录）
 * 留在各脚本里：它们的差异是真实的，抽出来只会多一层参数转发。
 */

/**
 * 记账器：断言结果 + 控制台输出。
 *
 * `kind: 'info'` 标记「报告一个观察」而不是断言（P5/P8/P9 的计数口径：说明性记录不计入断言分母）。
 * p3/p4 原本没有这个参数，统一后它们的报告里会多一个 `kind: 'assert'` 字段——这是有意的，
 * 五个报告从此形状一致。
 */
export function createGateRecorder() {
  const results = [];

  function record(gate, name, ok, detail = '', kind = 'assert') {
    // p8 的记账器会把非字符串 detail 规范成 JSON；统一到这里，免得一个对象变成 `[object Object]`
    // （或让 `detail.length` 静默变成 undefined）。
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null);
    results.push({ gate, name, ok, detail: text, kind });
    console.log(`${ok ? '✔' : '✖'} [${gate}] ${name}${text.length === 0 ? '' : ` — ${text}`}`);
  }

  function fail(gate, name, detail) {
    record(gate, name, false, detail);
    throw new Error(`[${gate}] ${name}: ${detail}`);
  }

  function assertCheck(gate, name, condition, detail = '') {
    if (!condition) {
      fail(gate, name, detail === '' ? 'assertion failed' : detail);
    }
    record(gate, name, true, detail);
  }

  /** 记录一个观察：进报告，但不算断言（用于「环境是那样」这类事实）。 */
  function info(gate, name, detail = '') {
    record(gate, name, true, detail, 'info');
  }

  function failed() {
    return results.filter((entry) => entry.ok !== true);
  }

  return { results, record, fail, assertCheck, info, failed };
}

/**
 * 改地址栏并触发一次 `popstate`，让渲染层的路由重新读 URL。
 *
 * 函数体逐字取自五个脚本里那份（它们本来就一字不差）。`page` 一律显式传入：p8/p9 原本靠
 * 外层同名变量，两次调用之间把 `page` 重新赋值就会静默改行为。
 */
export async function navigate(page, search) {
  await page.evaluate((next) => {
    let url;
    try {
      url = new URL(window.location.href);
    } catch {
      return;
    }
    url.search = next;
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, search);
}

/** 建报告目录。每个脚本在开始时就建，好让失败路径也写得进去。 */
export function prepareArtifactDir(artifactDir) {
  mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}

/**
 * 闸门的收尾：**一处**同时决定写哪种报告与打印哪句话。
 *
 * ## 为什么要合并
 *
 * 五个脚本原来各写一份报告，而且 p8/p9 把它写在 `finally` 里 —— 于是失败路径上也会周出一句
 * 「N/N 记录通过」，与报告里的 `passed: false` 直接矛盾。与 p9 一次部分运行（29 条）写的是
 * `passed: true`、打的是「29/29 记录通过」，看起来跟跑完了一样。
 *
 * ## `expectedGates`：把「默默少跑一大截」变成失败
 *
 * p8 声明了十一个闸门段落，而有一次运行只跑到第四个（`3 测速`）就结束了，仍然写 `passed: true`、
 * 报 40/40；下一次同一条命令跑到 67/67。p9 也有同类现象（29 vs 88）。两次都没抛异常。
 *
 * 机制我没查明，不猜。但这不重要 —— 把「脚本声明的段落是否都跑到」当作断言，这类运行就变成
 * **硬失败**，而且失败信息里的第一个缺失标签会把卡住的位置直接指出来。非零退出码也让外层脚本
 * （`pnpm test`）能看见。
 *
 * 只在成功路径上检查缺失：已经抛异常的运行不需要再多一条“段落没跑到”的次要原因。
 *
 * ## 退出码也在这里决定
 *
 * 最初把退出码留给调用方的 `if (failed.length > 0)`，结果守卫自己漏了：段落缺失会让
 * `passed = false`，但不产生任何失败**记录**，于是退出码仍是 0 —— 外层 `pnpm test` 看不见
 * 这次失败。一个“三处各自判断”的收尾就是会产生这种缺口，所以退出码与报告、与打印都归这一处。
 */
export function finishGate({
  label,
  artifactDir,
  results,
  rendererErrors = [],
  extra = {},
  extraNote = '',
  error = null,
  expectedGates = []
}) {
  const failed = results.filter((entry) => entry.ok !== true);
  const reached = [...new Set(results.map((entry) => entry.gate))];
  const missing = error === null ? expectedGates.filter((gate) => !reached.includes(gate)) : [];
  const passed = error === null && failed.length === 0 && missing.length === 0;

  const report = {
    checkedAt: new Date().toISOString(),
    passed,
    ...extra,
    results,
    rendererErrors
  };
  if (error !== null) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  if (missing.length > 0) {
    report.missingGates = missing;
  }
  writeFileSync(join(artifactDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  // 退出码与报告、与打印同一个判决。调用方不要再各自判断一次。
  if (!passed) {
    process.exitCode = 1;
  }

  if (passed) {
    const infoCount = results.filter((entry) => entry.kind === 'info').length;
    const assertionFailures = failed.filter((entry) => entry.kind !== 'info').length;
    const note = extraNote.length === 0 ? '' : ` · ${extraNote}`;
    console.log(
      `\n${label} 验收闸门：${results.length - failed.length}/${results.length} 记录通过 · 断言 ${results.length - infoCount - assertionFailures}/${results.length - infoCount} · 说明性记录 ${infoCount}${note}。报告写入 ${artifactDir}/report.json`
    );
    return failed;
  }

  const reasons = [];
  if (error !== null) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  if (failed.length > 0) {
    reasons.push(
      `${failed.length} 条断言失败：${failed.slice(0, 3).map((entry) => `[${entry.gate}] ${entry.name}`).join(' | ')}`
    );
  }
  if (missing.length > 0) {
    reasons.push(`声明的闸门段落没有跑到：${missing.join(' / ')}（实际只跑到：${reached.join(' / ')}）`);
  }
  console.error(`\n${label} 验收闸门失败：${reasons.join('  ||  ')}`);
  console.error(`报告写入 ${artifactDir}/report.json`);
  return failed;
}
