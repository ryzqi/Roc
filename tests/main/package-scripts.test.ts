import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

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

    expect(performanceSmokeScript).toContain('nativeFeelScorecard');
    expect(performanceSmokeScript).toContain('rendererReadyMs');
    expect(performanceSmokeScript).toContain('warmQuickReopenMs');
    expect(performanceSmokeScript).toContain('processMetricsSummary');
    expect(electronSmokeScript).toContain('nativeModuleProbe');
    expect(electronSmokeScript).toContain('processMetricsSummary');
    expect(electronSmokeScript).toContain('browserWindowCount');
    expect(electronSmokeScript).toContain('materialEvidence');
    expect(electronSmokeScript).toContain('windowPlacementEvidence');
  });
});
