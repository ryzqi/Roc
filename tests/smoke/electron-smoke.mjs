import { spawnSync } from 'node:child_process';
import { _electron as electron } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareArtifactDir } from './lib/artifacts.mjs';
import { runSmokeBoundaryProbes } from './lib/electron-smoke-boundary-probes.mjs';
import { runSmokeCapabilityViews } from './lib/electron-smoke-capabilities.mjs';
import { runSmokeChatDiagnosticsChecks } from './lib/electron-smoke-chat-diagnostics.mjs';
import { runSmokeInteractionChecks } from './lib/electron-smoke-interactions.mjs';
import { writeElectronSmokeResult } from './lib/electron-smoke-result.mjs';
import { runSmokeSettingsChecks } from './lib/electron-smoke-settings.mjs';
import { runSmokeTaskFlow } from './lib/electron-smoke-task-flow.mjs';
import { createSafeDailySmokeClock, formatSmokeClock, nextDailyRunAtUtc } from './lib/electron-smoke-time.mjs';
import { runSmokeWindowChecks } from './lib/electron-smoke-window.mjs';
import { runSmokeWorkbenchFileChecks } from './lib/electron-smoke-workbench-files.mjs';
import { runSmokeWorkbenchGitTerminalChecks } from './lib/electron-smoke-workbench-git-terminal.mjs';
import { runSmokeWorkspaceMemoryChecks } from './lib/electron-smoke-workspace-memory.mjs';
import { createSmokePaths, seedSmokeSkillSource, seedSmokeWorkspace, startSmokeProvider } from './lib/fixtures.mjs';
import { buildReleaseReadinessSnapshot } from './lib/release-readiness.mjs';
import { resolveSmokeTarget } from './lib/smoke-target.mjs';

const artifactDir = prepareArtifactDir();
const packagedExe = resolve('release/win-unpacked/Roc.exe');
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const electronBuilderConfig = readFileSync(resolve('electron-builder.yml'), 'utf8');
const releaseReadiness = buildReleaseReadinessSnapshot({
  builderConfigText: electronBuilderConfig,
  packageJson,
  sourceTexts: {
    main: readFileSync(resolve('src/main/index.ts'), 'utf8'),
    windowsHost: readFileSync(resolve('src/main/windows-host-service.ts'), 'utf8'),
    nativeContextMenu: readFileSync(resolve('src/main/native-context-menu.ts'), 'utf8'),
    mainKernelBootstrap: readFileSync(resolve('src/main/main-kernel-bootstrap.ts'), 'utf8'),
    kernelRuntime: readFileSync(resolve('src/main/kernel/kernel-runtime.ts'), 'utf8'),
    legacyDataCleanup: readFileSync(resolve('src/main/infrastructure/legacy-data-cleanup.ts'), 'utf8'),
    renderer: readFileSync(resolve('src/renderer/App.tsx'), 'utf8')
  }
});
const distMainPath = resolve('dist/main/index.js');
const smokeTarget = resolveSmokeTarget({ packagedExe, distMainPath });

const { dataRoot, workspaceRoot, skillSourceRoot, remoteRoot } = await createSmokePaths();
seedSmokeWorkspace(workspaceRoot, remoteRoot);
seedSmokeSkillSource(skillSourceRoot);

const backgroundTaskGoal = 'Phase 6 smoke background diagnostic task';
const backgroundTaskClock = createSafeDailySmokeClock();
const backgroundTaskCronExpression = `${backgroundTaskClock.minute} ${backgroundTaskClock.hour} * * *`;
const backgroundTaskNextRunAt = nextDailyRunAtUtc(backgroundTaskClock.hour, backgroundTaskClock.minute);
const naturalLanguageTaskClock = createSafeDailySmokeClock();
const naturalLanguageTaskGoal = `每天 ${formatSmokeClock(naturalLanguageTaskClock)} 抓取 AI 新闻并写入 docx`;
const naturalLanguageTaskCronExpression = `${naturalLanguageTaskClock.minute} ${naturalLanguageTaskClock.hour} * * *`;

let app;
let smokeProvider;
const ctx = {
  artifactDir,
  packagedExe,
  releaseReadiness,
  smokeTarget,
  dataRoot,
  workspaceRoot,
  skillSourceRoot,
  remoteRoot,
  backgroundTaskGoal,
  backgroundTaskCronExpression,
  backgroundTaskNextRunAt,
  naturalLanguageTaskClock,
  naturalLanguageTaskGoal,
  naturalLanguageTaskCronExpression
};

try {
  smokeProvider = await startSmokeProvider({ taskProposalGoal: naturalLanguageTaskGoal });
  ctx.smokeProvider = smokeProvider;
  app = await electron.launch({
    executablePath: smokeTarget.executablePath,
    args: smokeTarget.launchArgs,
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: 'smoke-test-key'
    }
  });
  ctx.app = app;

  await runSmokeWindowChecks(ctx);
  await runSmokeTaskFlow(ctx);
  await runSmokeWorkspaceMemoryChecks(ctx);
  await runSmokeWorkbenchFileChecks(ctx);
  await runSmokeWorkbenchGitTerminalChecks(ctx);
  await runSmokeCapabilityViews(ctx);
  await runSmokeSettingsChecks(ctx);
  await runSmokeChatDiagnosticsChecks(ctx);
  await runSmokeBoundaryProbes(ctx);
  await runSmokeInteractionChecks(ctx);
  writeElectronSmokeResult(ctx);
} finally {
  if (app !== undefined) {
    await app.close();
  }
  if (smokeProvider !== undefined) {
    await smokeProvider.close();
  }
  spawnSync('pnpm', ['rebuild', 'better-sqlite3', '--pending=false'], {
    cwd: resolve('.'),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  await rm(dataRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(remoteRoot, { recursive: true, force: true });
  await rm(skillSourceRoot, { recursive: true, force: true });
}
