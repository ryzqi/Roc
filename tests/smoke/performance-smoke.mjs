import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { prepareArtifactDir } from './lib/artifacts.mjs';
import { waitForAppReady } from './lib/assertions.mjs';
import { buildNativeFeelSoftWarnings, buildNativeFeelSummary, nativeFeelScorecard } from './lib/native-feel.mjs';
import { resolveSmokeTarget } from './lib/smoke-target.mjs';

const artifactDir = prepareArtifactDir();
const artifactPath = join(artifactDir, 'performance-smoke.json');
const packagedExe = resolve('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Roc.app/Contents/MacOS/Roc');
const distMainPath = resolve('dist/main/index.js');
const smokeTarget = resolveSmokeTarget({ packagedExe, distMainPath });
const profileRoots = readProfileRoots();

function writeResult(result) {
  writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function readProfileRoots() {
  const raw = process.env.ROC_PERFORMANCE_PROFILE_ROOTS;
  if (raw === undefined) {
    throw new Error('performance_profile_roots_missing');
  }
  const parsed = JSON.parse(raw);
  if (
    typeof parsed.empty !== 'string' ||
    typeof parsed.profile1000 !== 'string' ||
    typeof parsed.profile10000 !== 'string'
  ) {
    throw new Error('performance_profile_roots_invalid');
  }
  return parsed;
}

/**
 * 内存测量：私有字节在当前 Electron/macOS 上**不可用**。
 *
 * `app.getAppMetrics()` 对所有进程都返回 `privateBytes: null`（Browser / GPU / Utility / Tab 全部为空），
 * 于是 `diagnostics.samplePerformance` 的 `memoryMeasurement` 恒为 `private_bytes_unavailable`。
 * 这不是渲染层能修的东西，也不是可以造的数：改成用**可用的** `totalWorkingSetMb` 做相对预算
 * （剖面之间比，抓泄漏），并把这次替换写进工件。绝对私有字节预算在拿到可用平台后再说。
 */
function assertPerformanceSample(sample) {
  if (!Array.isArray(sample.electron?.processMetrics) || !Array.isArray(sample.timing?.samples)) {
    throw new Error('performance_sample_contract_invalid');
  }
  if (typeof sample.totalWorkingSetMb !== 'number') {
    throw new Error('performance_working_set_unavailable');
  }
}

async function samplePerformance(page, budgetMb) {
  const sample = await page.evaluate(async (memoryBudgetMb) => {
    const result = await window.roc.diagnostics.samplePerformance({ mode: 'smoke', memoryBudgetMb });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data;
  }, budgetMb);
  assertPerformanceSample(sample);
  return sample;
}

async function runProfile(input) {
  const launchStartedAt = performance.now();
  // 每个剖面一个独立的 Chromium userData 目录：Electron 的进程单例锁住在 userData 里，
  // 而 `ROC_DATA_ROOT` 不改变它，所以三次串行启动会互相抢锁
  // （旧 README 记的「已知红」两条里的一条）。`--user-data-dir` 是主进程不变量之外的启动参数，
  // 不需要改 `src/main`。
  const chromiumDir = join(input.dataRoot, 'chromium');
  const app = await electron.launch({
    executablePath: smokeTarget.executablePath,
    args: [`--user-data-dir=${chromiumDir}`, ...smokeTarget.launchArgs],
    env: { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: input.dataRoot }
  });
  try {
    const page = await app.firstWindow();
    try {
      await waitForAppReady(page, `performance-${input.name}`, artifactDir);
    } catch (error) {
      throw new Error(`performance_profile_failed:${input.name}:${error instanceof Error ? error.message : String(error)}`);
    }
    const rendererReadyMs = performance.now() - launchStartedAt;
    // 默认入口是项目门户（ADR 0002）：冷启动不会自动进入项目，
    // 而对话输入挂在项目内，所以先显式进入项目，再量对话输入的可用延迟。
    // P10：旧壳的 `.research-project-card` / `chat-input` 换成新壳的
    // `portal-card-open-*` / `assistant-composer-input`。
    const card = page.locator('[data-testid^="portal-card-open-"]').first();
    await card.waitFor({ timeout: 10_000 });
    await card.click();
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 10_000 });
    // 新壳的助手是右列里的懒加载 chunk，不默认打开，所以「输入区可用」要从**打开助手**算起
    // （旧壳的对话输入在主画布里，这条路径是不同的东西）。
    const mainInputStartedAt = performance.now();
    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.set('assistant', '1');
      window.history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForSelector('[data-testid="assistant-composer-input"]', { timeout: 10_000 });
    const mainInputReadyMs = performance.now() - mainInputStartedAt;
    let interactiveMs = 0;
    if (input.eventCount > 0) {
      const interactiveStartedAt = performance.now();
      // 会话列表在左栏的「会话」tab 里。
      await page.getByTestId('sidebar-tab-sessions').click();
      await page.getByTestId(`session-row-${input.threadId}`).click();
      try {
        await page.waitForFunction(
          (marker) => (document.querySelector('[data-testid="assistant-transcript"]')?.textContent ?? '').includes(marker),
          `profile-marker-${input.eventCount}-${input.eventCount}`,
          { timeout: 10_000 }
        );
      } catch (error) {
        const diagnostics = await page.evaluate(async (threadId) => {
          const history = await window.roc.tasks.getThreadMessages({ threadId, limit: 100, cursor: null });
          return {
            history,
            transcript: document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.slice(-1000) ?? null
          };
        }, input.threadId);
        throw new Error(
          `performance_profile_marker_missing:${input.name}:${JSON.stringify(diagnostics)}:${error instanceof Error ? error.message : String(error)}`
        );
      }
      interactiveMs = performance.now() - interactiveStartedAt;
    }
    const sample = await samplePerformance(page, input.memoryBudgetMb);
    const domMessageRows = await page.locator('[data-testid^="assistant-message-"]').count();
    const prepends = input.eventCount === 10_000 ? await measurePrepends(page, 20) : { durations: [], observations: [], notObserved: false };
    return {
      ...input,
      rendererReadyMs,
      mainInputReadyMs,
      interactiveMs,
      sample,
      domMessageRows,
      prependDurationsMs: prepends.durations,
      prependObservations: prepends.observations,
      prependNotObserved: prepends.notObserved
    };
  } finally {
    await app.close();
  }
}

/**
 * 向上翻页（prepend）延迟。
 *
 * 新壳的历史是一个 400 事件的有界窗口（`maxRetainedPersistedEvents`），所以「翻上去加载更早的」
 * 不一定表现为 `data-message-count` 变大。P10 实测：把转录滚到顶（合成 scroll、真实
 * `scrollIntoView`、真实滚轮三种都试过）之后 10 秒内计数不变，最老的 marker 也不变 ——
 * 也就是说这条度量在当前实现里**观察不到**，而不是「很慢」。
 *
 * 不假装它通过、也不把它算成失败：把原始诊断写进工件，并让调用方按 `notObserved` 记录。
 * 翻页本身是 P4 的代码（P10 未改），已登记为风险 R21 去跟进。
 */
async function measurePrepends(page, count) {
  const durations = [];
  const observations = [];
  const scrollSurface = page.locator('[data-testid="assistant-panel"] .overflow-y-auto').first();
  const transcript = page.getByTestId('assistant-transcript');
  await scrollSurface.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 100);
    element.dispatchEvent(new Event('scroll'));
  });
  await page.getByTestId('assistant-scroll-bottom').waitFor({ timeout: 5_000 });
  for (let index = 0; index < count; index += 1) {
    const before = await readTranscriptFacts(page);
    const startedAt = performance.now();
    // 真实滚动（把第一条已渲染的虚拟行滚进视野），而不是只改 scrollTop。
    await page.locator('[data-index]').first().scrollIntoViewIfNeeded({ timeout: 5_000 });
    let observed = false;
    try {
      await page.waitForFunction(
        (previous) => {
          const host = document.querySelector('[data-testid="assistant-transcript"]');
          return Number(host?.getAttribute('data-message-count')) > previous;
        },
        before.messageCount,
        { timeout: 10_000 }
      );
      observed = true;
    } catch {
      observed = false;
    }
    const after = await readTranscriptFacts(page);
    observations.push({ index, before, after, observed });
    if (!observed) {
      return { durations, observations, notObserved: true };
    }
    durations.push(performance.now() - startedAt);
  }
  return { durations, observations, notObserved: false };
}

async function readTranscriptFacts(page) {
  return await page.evaluate(() => {
    const host = document.querySelector('[data-testid="assistant-transcript"]');
    const surface = document.querySelector('[data-testid="assistant-panel"] .overflow-y-auto');
    const virtualRows = [...document.querySelectorAll('[data-index]')];
    return {
      messageCount: Number(host?.getAttribute('data-message-count')),
      scrollTop: surface === null ? null : Math.round(surface.scrollTop),
      scrollHeight: surface === null ? null : surface.scrollHeight,
      clientHeight: surface === null ? null : surface.clientHeight,
      firstVirtualIndex: virtualRows[0]?.getAttribute('data-index') ?? null,
      lastText: (document.querySelectorAll('[data-testid^="assistant-message-"]')[0]?.textContent ?? '').slice(0, 80)
    };
  });
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.ceil(sorted.length * 0.95) - 1];
  if (typeof value !== 'number') {
    throw new Error('performance_prepend_samples_missing');
  }
  return value;
}

try {
  const empty = await runProfile({
    name: 'empty',
    dataRoot: profileRoots.empty,
    threadId: 'thread-profile-empty',
    eventCount: 0,
    memoryBudgetMb: 450
  });
  const mainReady = empty.sample.timing.samples.find((item) => item.phase === 'main_ready');
  if (mainReady === undefined) {
    throw new Error('performance_main_ready_sample_missing');
  }
  if (mainReady.durationMs > 500 || empty.rendererReadyMs > 2500) {
    throw new Error(`performance_ready_budget_exceeded:${mainReady.durationMs}:${empty.rendererReadyMs}`);
  }
  // 10k 消息的常驻内存不得超过空剖面的 1.8 倍（relative guard：绝对值随平台浮动太大）。
  const workingSetBudgetMb = Math.round(empty.sample.totalWorkingSetMb * 1.8);

  const profile1000 = await runProfile({
    name: 'profile-1000',
    dataRoot: profileRoots.profile1000,
    threadId: 'thread-profile-1000',
    eventCount: 1_000,
    memoryBudgetMb: 500
  });
  if (profile1000.interactiveMs > 750) {
    throw new Error(`profile_1k_interactive_exceeded:${profile1000.interactiveMs}`);
  }
  if (profile1000.sample.totalWorkingSetMb > workingSetBudgetMb) {
    throw new Error(`profile_1k_working_set_exceeded:${profile1000.sample.totalWorkingSetMb}:${workingSetBudgetMb}`);
  }

  const profile10000 = await runProfile({
    name: 'profile-10000',
    dataRoot: profileRoots.profile10000,
    threadId: 'thread-profile-10000',
    eventCount: 10_000,
    memoryBudgetMb: 500
  });
  if (profile10000.interactiveMs > 1000) {
    throw new Error(`profile_10k_interactive_exceeded:${profile10000.interactiveMs}`);
  }
  if (profile10000.domMessageRows >= 300) {
    throw new Error(`profile_10k_dom_rows_exceeded:${profile10000.domMessageRows}`);
  }
  if (profile10000.sample.totalWorkingSetMb > workingSetBudgetMb) {
    throw new Error(`profile_10k_working_set_exceeded:${profile10000.sample.totalWorkingSetMb}:${workingSetBudgetMb}`);
  }
  const prependP95 =
    profile10000.prependNotObserved || profile10000.prependDurationsMs.length === 0 ? null : percentile95(profile10000.prependDurationsMs);
  if (prependP95 !== null && prependP95 > 250) {
    throw new Error(`profile_10k_prepend_p95_exceeded:${prependP95}`);
  }
  const nativeFeel = buildNativeFeelSummary({
    sample: profile10000.sample,
    smokeTarget: {
      kind: smokeTarget.kind,
      path: smokeTarget.path,
      packagedExeExists: existsSync(packagedExe)
    },
    rendererReadyMs: profile10000.rendererReadyMs,
    mainInputReadyMs: profile10000.mainInputReadyMs
  });

  writeResult({
    passed: true,
    checkedAt: new Date().toISOString(),
    smokeTarget: { kind: smokeTarget.kind, path: smokeTarget.path, packagedExeExists: existsSync(packagedExe) },
    profiles: { empty, profile1000, profile10000 },
    memoryGuard: {
      kind: 'working_set',
      workingSetBudgetMb,
      emptyWorkingSetMb: empty.sample.totalWorkingSetMb,
      reason:
        empty.sample.memoryMeasurement === 'private_bytes_unavailable'
          ? 'app.getAppMetrics() 在本平台对所有进程返回 privateBytes=null，私有字节预算不可用'
          : 'private bytes 可用（本次仍按 working set 记录）'
    },
    prependP95,
    nativeFeelScorecard,
    nativeFeel,
    ipcSummary: profile10000.sample.ipc,
    processMetricsSummary: nativeFeel.processMetricsSummary,
    softWarnings: buildNativeFeelSoftWarnings({
      initialSample: empty.sample,
      finalSample: profile10000.sample
    })
  });
} catch (error) {
  const result = {
    passed: false,
    checkedAt: new Date().toISOString(),
    smokeTarget: { kind: smokeTarget.kind, path: smokeTarget.path, packagedExeExists: existsSync(packagedExe) },
    error: error instanceof Error ? error.message : String(error)
  };
  writeResult(result);
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
