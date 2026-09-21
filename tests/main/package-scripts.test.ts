import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

const releaseChecklistCommands = [
  'test',
  'typecheck',
  'build',
  'package:dir',
  'package:mac',
  'verify:native-packaging',
  'verify:paths',
  'smoke:mac',
  'smoke:electron',
  'smoke:performance'
];

describe('package scripts', () => {
  it('ignores non-macOS optional native packages at install time', () => {
    const workspace = readFileSync(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8');
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

    expect(packageJson.os).toEqual(['darwin']);
    expect(packageJson.cpu).toEqual(['arm64', 'x64']);
    expect(workspace).toContain("ignoredOptionalDependencies:");
    expect(workspace).toContain("'@esbuild/win32-*'");
    expect(workspace).toContain("'@esbuild/linux-*'");
    expect(workspace).toContain("'@esbuild/android-*'");
    expect(workspace).toContain("'@esbuild/freebsd-*'");
    expect(workspace).toContain("'@rolldown/binding-win32-*'");
    expect(workspace).toContain("'@rolldown/binding-linux-*'");
    expect(workspace).toContain("'@typescript/typescript-win32-*'");
    expect(workspace).toContain("'@typescript/typescript-linux-*'");
    expect(workspace).toContain("'@typescript/typescript-aix-*'");
    expect(workspace).toContain("'@typescript/typescript-freebsd-*'");
    expect(workspace).toContain("'lightningcss-win32-*'");
    expect(workspace).toContain("'lightningcss-linux-*'");
    expect(workspace).toContain("'sqlite-vec-linux-*'");
    expect(workspace).toContain("'sqlite-vec-windows-*'");
    expect(workspace).toContain("'@napi-rs/canvas-win32-*'");
    expect(workspace).toContain("'@napi-rs/canvas-linux-*'");
    expect(workspace).toContain("'@napi-rs/canvas-android-*'");
    expect(workspace).not.toContain("'@esbuild/darwin-*'");
    expect(workspace).not.toContain("'@napi-rs/canvas-darwin-*'");
  });

  it('does not expose the removed audit script anymore', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const removedScriptName = ['visual', 'audit'].join(':');
    expect(packageJson.scripts[removedScriptName]).toBeUndefined();
  });

  it('exposes a focused performance smoke gate', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const smokeScript = readFileSync(new URL('../smoke/performance-smoke.mjs', import.meta.url), 'utf8');

    expect(packageJson.scripts['smoke:performance']).toBe('node scripts/smoke-performance.mjs');
    expect(existsSync(new URL('../../scripts/smoke-performance.mjs', import.meta.url))).toBe(true);
    expect(smokeScript).toContain('performance-smoke.json');
    expect(smokeScript).toContain('window.roc.diagnostics.samplePerformance');
  });

  it('wraps pnpm dev with native module verification for Electron runtime', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const devScriptUrl = new URL('../../scripts/dev-electron.mjs', import.meta.url);
    const devScript = existsSync(devScriptUrl) ? readFileSync(devScriptUrl, 'utf8') : '';

    expect(packageJson.scripts.dev).toBe('node scripts/dev-electron.mjs');
    expect(existsSync(devScriptUrl)).toBe(true);
    expect(devScript).toContain('verifyWorkspaceBetterSqlite3');
    expect(devScript).not.toContain('restoreBetterSqlite3ForNode');
    expect(devScript).toContain('electron-vite');
    expect(devScript).toContain('runCommand(command, args, {');
    expect(devScript).toContain('cwd: options?.cwd ?? projectRoot');
    expect(devScript).toContain('env: createPackagingEnvironment(options?.env)');
    expect(devScript).not.toContain('spawnSync(');
  });

  it('records macOS native-feel fields in smoke artifacts', () => {
    const performanceSmokeScript = readFileSync(new URL('../smoke/performance-smoke.mjs', import.meta.url), 'utf8');
    const electronSmokeScript = readFileSync(new URL('../smoke/electron-smoke.mjs', import.meta.url), 'utf8');
    const electronSmokeDiagnosticsHelper = readFileSync(
      new URL('../smoke/lib/electron-smoke-chat-diagnostics.mjs', import.meta.url),
      'utf8'
    );
    const electronSmokeResultHelper = readFileSync(new URL('../smoke/lib/electron-smoke-result.mjs', import.meta.url), 'utf8');
    const releaseReadinessSmokeHelper = readFileSync(new URL('../smoke/lib/release-readiness.mjs', import.meta.url), 'utf8');

    expect(performanceSmokeScript).toContain('nativeFeelScorecard');
    expect(performanceSmokeScript).toContain('rendererReadyMs');
    expect(performanceSmokeScript).not.toContain('warmQuickReopenMs');
    expect(performanceSmokeScript).toContain('processMetricsSummary');
    expect(performanceSmokeScript).toContain('ipcSummary');
    expect(electronSmokeScript).toContain('writeElectronSmokeResult(ctx)');
    expect(electronSmokeDiagnosticsHelper).toContain('nativeModuleProbe');
    expect(electronSmokeDiagnosticsHelper).toContain('processMetricsSummary');
    expect(electronSmokeResultHelper).toContain('nativeModuleProbe');
    expect(electronSmokeResultHelper).toContain('processMetricsSummary');
    expect(electronSmokeResultHelper).toContain('ipcTopNRecorded');
    expect(electronSmokeResultHelper).toContain('browserWindowCount');
    expect(electronSmokeResultHelper).toContain('nativeWindowEvidence');
    expect(electronSmokeResultHelper).toContain('windowPlacementEvidence');
    expect(electronSmokeResultHelper).toContain('phase3WebViewEvidence');
    expect(electronSmokeScript).toContain('releaseReadiness');
    expect(electronSmokeScript).toContain('src/main/infrastructure/legacy-data-cleanup.ts');
    expect(electronSmokeScript).toContain('src/main/kernel/kernel-runtime.ts');
    expect(releaseReadinessSmokeHelper).toContain('installerSigningUpdater');
  });

  it('keeps seeded background task smoke timing dynamic', () => {
    const electronSmokeScript = readFileSync(new URL('../smoke/electron-smoke.mjs', import.meta.url), 'utf8');
    const smokeIpcHelper = readFileSync(new URL('../smoke/lib/ipc.mjs', import.meta.url), 'utf8');

    expect(smokeIpcHelper).toContain('backgroundTaskNextRunAt');
    expect(smokeIpcHelper).not.toContain('2026-05-22T01:00:00.000Z');
    expect(electronSmokeScript).toContain('backgroundTaskNextRunAt');
    expect(electronSmokeScript).not.toContain("backgroundTaskApiEvidence.tray.nextRunAt === '2026-05-22T01:00:00.000Z'");
  });

  it('builds and smoke-tests a directory app without archive artifacts', () => {
    const packageMac = readFileSync(new URL('../../scripts/package-mac.mjs', import.meta.url), 'utf8');
    expect(packageMac).toContain("'--mac', '--dir'");
    expect(packageMac).not.toContain("'--mac', 'zip'");
    expect(packageMac).toContain("scripts', 'smoke-mac.mjs");
    expect(packageMac.indexOf("'--mac', '--dir'")).toBeLessThan(packageMac.indexOf("smoke-mac.mjs"));
    expect(packageMac).not.toContain("'/usr/bin/ditto'");
    expect(packageMac).not.toContain("'/usr/bin/hdiutil'");
    expect(packageMac).toContain("rmSync(artifactPath, { force: true })");
    expect(packageMac).toContain("join(releaseDir, 'builder-debug.yml')");
    expect(packageMac).toContain("join(releaseDir, 'builder-effective-config.yaml')");
    expect(packageMac).not.toContain('createHash');
  });

  it('keeps release checklist commands aligned with package scripts', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const releaseChecklist = readFileSync(
      new URL('../../docs/release/release-candidate-checklist.md', import.meta.url),
      'utf8'
    );

    for (const command of releaseChecklistCommands) {
      expect(releaseChecklist).toContain(command);
      const scriptName = command;
      if (scriptName !== 'test') {
        expect(packageJson.scripts[scriptName]).toBeTypeOf('string');
      }
    }
  });

  it('documents owner approval before publishing or widening release scope', () => {
    const releaseChecklist = readFileSync(
      new URL('../../docs/release/release-candidate-checklist.md', import.meta.url),
      'utf8'
    );

    expect(releaseChecklist).toContain('Owner Approval');
    expect(releaseChecklist).toContain('tagging a release');
    expect(releaseChecklist).toContain('pushing to `main`');
    expect(releaseChecklist).toContain('publishing installer artifacts');
    expect(releaseChecklist).toContain('changing supported platform or architecture targets');
    expect(releaseChecklist).toContain('adding signing certificates or update server config');
  });
});
