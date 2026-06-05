import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

const releaseChecklistCommands = [
  'pnpm test',
  'pnpm typecheck',
  'pnpm build',
  'pnpm package:dir',
  'pnpm verify:native-packaging',
  'pnpm verify:paths',
  'pnpm smoke:electron',
  'pnpm smoke:performance'
];

describe('package scripts', () => {
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

  it('records Windows native-feel fields in smoke artifacts', () => {
    const performanceSmokeScript = readFileSync(new URL('../smoke/performance-smoke.mjs', import.meta.url), 'utf8');
    const electronSmokeScript = readFileSync(new URL('../smoke/electron-smoke.mjs', import.meta.url), 'utf8');
    const releaseReadinessSmokeHelper = readFileSync(new URL('../smoke/lib/release-readiness.mjs', import.meta.url), 'utf8');

    expect(performanceSmokeScript).toContain('nativeFeelScorecard');
    expect(performanceSmokeScript).toContain('rendererReadyMs');
    expect(performanceSmokeScript).not.toContain('warmQuickReopenMs');
    expect(performanceSmokeScript).toContain('processMetricsSummary');
    expect(performanceSmokeScript).toContain('ipcSummary');
    expect(electronSmokeScript).toContain('nativeModuleProbe');
    expect(electronSmokeScript).toContain('processMetricsSummary');
    expect(electronSmokeScript).toContain('ipcTopNRecorded');
    expect(electronSmokeScript).toContain('browserWindowCount');
    expect(electronSmokeScript).toContain('materialEvidence');
    expect(electronSmokeScript).toContain('windowPlacementEvidence');
    expect(electronSmokeScript).toContain('phase3WebViewEvidence');
    expect(electronSmokeScript).toContain('releaseReadiness');
    expect(electronSmokeScript).toContain('src/main/infrastructure/migration/monolith-to-plugins.ts');
    expect(electronSmokeScript).toContain('src/main/kernel/kernel-runtime.ts');
    expect(releaseReadinessSmokeHelper).toContain('installerSigningUpdater');
  });

  it('keeps release checklist commands aligned with package scripts', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const releaseChecklist = readFileSync(
      new URL('../../docs/release/release-candidate-checklist.md', import.meta.url),
      'utf8'
    );

    for (const command of releaseChecklistCommands) {
      expect(releaseChecklist).toContain(command);
      const scriptName = command.replace(/^pnpm\s+/u, '');
      if (scriptName !== 'test') {
        expect(packageJson.scripts[scriptName]).toBeTypeOf('string');
      }
    }
  });
});
