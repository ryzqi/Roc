import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { prepareArtifactDir } from './lib/artifacts.mjs';
import { waitForAppReady, waitForWindowWithSelector } from './lib/assertions.mjs';

const artifactDir = prepareArtifactDir();
const artifactPath = join(artifactDir, 'performance-smoke.json');
const packagedExe = resolve('release/win-unpacked/Roc.exe');
const preferredSmokeTarget = process.env.ROC_SMOKE_TARGET === 'packaged' ? 'packaged' : 'dist';
const distMainPath = resolve('dist/main/index.js');
const smokeTarget =
  preferredSmokeTarget === 'packaged'
    ? existsSync(packagedExe)
      ? {
          kind: 'packaged-exe',
          path: packagedExe,
          executablePath: packagedExe,
          launchArgs: []
        }
      : (() => {
          throw new Error(`Packaged smoke target is unavailable: ${packagedExe}`);
        })()
    : {
        kind: 'dist-main-fallback',
        path: distMainPath,
        executablePath: undefined,
        launchArgs: [distMainPath]
      };

const dataRoot = await mkdtemp(join(tmpdir(), 'roc-performance-smoke-'));
let app;

function writePerformanceSmokeResult(result) {
  writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function assertPerformanceSample(sample) {
  if (typeof sample.id !== 'string' || sample.id.length === 0) {
    throw new Error('Performance smoke sample is missing id.');
  }
  if (sample.mode !== 'smoke') {
    throw new Error(`Performance smoke sample mode mismatch: ${sample.mode}`);
  }
  if (typeof sample.rssMb !== 'number' || sample.rssMb <= 0) {
    throw new Error(`Performance smoke sample has invalid RSS: ${sample.rssMb}`);
  }
  if (!Array.isArray(sample.timing?.samples)) {
    throw new Error('Performance smoke sample is missing timing.samples.');
  }
}

function buildSoftWarnings({ initialSample, finalSample, quickOpenMs, trayOpenMs }) {
  const warnings = [];
  if (initialSample.exceedsBudget) {
    warnings.push(`initial RSS ${initialSample.rssMb} MB exceeds soft budget ${initialSample.memoryBudgetMb} MB`);
  }
  if (finalSample.exceedsBudget) {
    warnings.push(`final RSS ${finalSample.rssMb} MB exceeds soft budget ${finalSample.memoryBudgetMb} MB`);
  }
  if (quickOpenMs > 1000) {
    warnings.push(`quick entry opened in ${quickOpenMs} ms`);
  }
  if (trayOpenMs > 1000) {
    warnings.push(`tray entry opened in ${trayOpenMs} ms`);
  }
  return warnings;
}

try {
  app = await electron.launch({
    executablePath: smokeTarget.executablePath,
    args: smokeTarget.launchArgs,
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot
    }
  });

  const page = await app.firstWindow();
  await waitForAppReady(page, 'performance-initial', artifactDir);
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 5000 });

  const initialSample = await page.evaluate(async () => {
    const sample = await window.roc.diagnostics.samplePerformance({
      mode: 'smoke',
      memoryBudgetMb: 300
    });
    if (!sample.ok) {
      throw new Error(sample.error.message);
    }
    return sample.data;
  });
  assertPerformanceSample(initialSample);

  const quickStartedAt = Date.now();
  await page.evaluate(async () => {
    const result = await window.roc.app.openQuickEntry();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  });
  const quickWindow = await waitForWindowWithSelector(app, '[data-testid="floating-quick"]');
  await quickWindow.waitForSelector('[data-testid="quick-entry-view"]', { timeout: 5000 });
  const quickOpenMs = Date.now() - quickStartedAt;

  const trayStartedAt = Date.now();
  await page.evaluate(async () => {
    const result = await window.roc.app.openTrayEntry();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  });
  const trayWindow = await waitForWindowWithSelector(app, '[data-testid="floating-tray"]');
  await trayWindow.waitForSelector('[data-testid="tray-entry-view"]', { timeout: 5000 });
  const trayOpenMs = Date.now() - trayStartedAt;

  const finalSample = await page.evaluate(async () => {
    const sample = await window.roc.diagnostics.samplePerformance({
      mode: 'smoke',
      memoryBudgetMb: 300
    });
    if (!sample.ok) {
      throw new Error(sample.error.message);
    }
    return sample.data;
  });
  assertPerformanceSample(finalSample);

  const result = {
    passed: true,
    checkedAt: new Date().toISOString(),
    dataRoot,
    smokeTarget: {
      kind: smokeTarget.kind,
      path: smokeTarget.path,
      packagedExeExists: existsSync(packagedExe)
    },
    windows: {
      quickOpenMs,
      trayOpenMs
    },
    samples: {
      initial: initialSample,
      final: finalSample
    },
    softWarnings: buildSoftWarnings({
      initialSample,
      finalSample,
      quickOpenMs,
      trayOpenMs
    })
  };
  writePerformanceSmokeResult(result);
  if (result.softWarnings.length > 0) {
    console.warn(JSON.stringify({ performanceSmokeWarnings: result.softWarnings }, null, 2));
  }
} catch (error) {
  const result = {
    passed: false,
    checkedAt: new Date().toISOString(),
    dataRoot,
    smokeTarget: {
      kind: smokeTarget.kind,
      path: smokeTarget.path,
      packagedExeExists: existsSync(packagedExe)
    },
    error: error instanceof Error ? error.message : String(error)
  };
  writePerformanceSmokeResult(result);
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  if (app !== undefined) {
    await app.close();
  }
  await rm(dataRoot, { recursive: true, force: true });
}
