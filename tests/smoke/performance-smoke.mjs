import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { prepareArtifactDir } from './lib/artifacts.mjs';
import { waitForAppReady } from './lib/assertions.mjs';
import { buildNativeFeelSoftWarnings, buildNativeFeelSummary, nativeFeelScorecard } from './lib/native-feel.mjs';
import { resolveSmokeTarget } from './lib/smoke-target.mjs';

const artifactDir = prepareArtifactDir();
const artifactPath = join(artifactDir, 'performance-smoke.json');
const packagedExe = resolve('release/win-unpacked/Roc.exe');
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

function assertPerformanceSample(sample, budgetMb) {
  if (sample.memoryMeasurement !== 'complete' || typeof sample.totalPrivateBytesMb !== 'number') {
    throw new Error('performance_private_bytes_unavailable');
  }
  if (sample.totalPrivateBytesMb > budgetMb || sample.exceedsBudget) {
    throw new Error(`performance_private_bytes_budget_exceeded:${sample.totalPrivateBytesMb}:${budgetMb}`);
  }
  if (!Array.isArray(sample.electron?.processMetrics) || !Array.isArray(sample.timing?.samples)) {
    throw new Error('performance_sample_contract_invalid');
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
  assertPerformanceSample(sample, budgetMb);
  return sample;
}

async function runProfile(input) {
  const launchStartedAt = performance.now();
  const app = await electron.launch({
    executablePath: smokeTarget.executablePath,
    args: smokeTarget.launchArgs,
    env: { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: input.dataRoot }
  });
  try {
    const page = await app.firstWindow();
    await waitForAppReady(page, `performance-${input.name}`, artifactDir);
    const rendererReadyMs = performance.now() - launchStartedAt;
    const mainInputStartedAt = performance.now();
    await page.waitForSelector('[data-testid="chat-input"]', { timeout: 500 });
    const mainInputReadyMs = performance.now() - mainInputStartedAt;
    let interactiveMs = 0;
    if (input.eventCount > 0) {
      const interactiveStartedAt = performance.now();
      await page.getByTestId(`history-thread-${input.threadId}`).click();
      try {
        await page.getByText(`profile-marker-${input.eventCount}-${input.eventCount}`, { exact: true }).waitFor({ timeout: 10_000 });
      } catch (error) {
        const diagnostics = await page.evaluate(async (threadId) => {
          const history = await window.roc.tasks.getThreadMessages({ threadId, limit: 100, cursor: null });
          return {
            history,
            transcript: document.querySelector('[data-testid="chat-transcript"]')?.textContent?.slice(-1000) ?? null
          };
        }, input.threadId);
        throw new Error(
          `performance_profile_marker_missing:${input.name}:${JSON.stringify(diagnostics)}:${error instanceof Error ? error.message : String(error)}`
        );
      }
      interactiveMs = performance.now() - interactiveStartedAt;
    }
    const sample = await samplePerformance(page, input.memoryBudgetMb);
    const domMessageRows = await page.locator('[data-testid^="chat-message-"]').count();
    const prependDurationsMs = input.eventCount === 10_000 ? await measurePrepends(page, 20) : [];
    return { ...input, rendererReadyMs, mainInputReadyMs, interactiveMs, sample, domMessageRows, prependDurationsMs };
  } finally {
    await app.close();
  }
}

async function measurePrepends(page, count) {
  const durations = [];
  const scrollSurface = page.locator('.chat-empty-plane');
  const transcript = page.getByTestId('chat-transcript');
  await scrollSurface.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 100);
    element.dispatchEvent(new Event('scroll'));
  });
  await page.getByTestId('chat-scroll-bottom').waitFor({ timeout: 5_000 });
  for (let index = 0; index < count; index += 1) {
    const messageCountBefore = Number(await transcript.getAttribute('data-message-count'));
    if (!Number.isInteger(messageCountBefore)) {
      throw new Error('performance_prepend_message_count_invalid');
    }
    const startedAt = performance.now();
    await scrollSurface.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    try {
      await page.waitForFunction(
        (previous) => {
          const element = document.querySelector('[data-testid="chat-transcript"]');
          const value = Number(element?.getAttribute('data-message-count'));
          return Number.isInteger(value) && value > previous;
        },
        messageCountBefore,
        { timeout: 5_000 }
      );
    } catch (error) {
      const diagnostics = await scrollSurface.evaluate((element) => {
        const rows = [...document.querySelectorAll('[data-testid^="chat-message-"]')];
        const virtualRows = [...document.querySelectorAll('[data-index]')];
        return {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          firstText: rows[0]?.textContent ?? null,
          lastText: rows.at(-1)?.textContent ?? null,
          firstVirtualIndex: virtualRows[0]?.getAttribute('data-index') ?? null,
          lastVirtualIndex: virtualRows.at(-1)?.getAttribute('data-index') ?? null,
          historyError: document.querySelector('[data-testid="chat-history-error"]')?.textContent ?? null
        };
      });
      throw new Error(
        `performance_prepend_missing:${index}:${messageCountBefore}:${JSON.stringify(diagnostics)}:${error instanceof Error ? error.message : String(error)}`
      );
    }
    durations.push(performance.now() - startedAt);
  }
  return durations;
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
  const prependP95 = percentile95(profile10000.prependDurationsMs);
  if (prependP95 > 250) {
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
