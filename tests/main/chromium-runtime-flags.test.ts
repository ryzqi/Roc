import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyChromiumRuntimeFlags, disabledChromiumFeatures } from '../../src/main/chromium-runtime-flags';

describe('chromium runtime flags', () => {
  it('disables unused Chromium subsystems before BrowserWindow creation', () => {
    const commandLine = {
      appendSwitch: vi.fn()
    };

    applyChromiumRuntimeFlags(commandLine);

    expect(disabledChromiumFeatures).toEqual([
      'MediaRouter',
      'DialMediaRouteProvider',
      'TranslateUI',
      'HardwareMediaKeyHandling',
      'SpareRendererForSitePerProcess'
    ]);
    expect(commandLine.appendSwitch).toHaveBeenCalledWith(
      'disable-features',
      'MediaRouter,DialMediaRouteProvider,TranslateUI,HardwareMediaKeyHandling,SpareRendererForSitePerProcess'
    );
  });

  it('applies the flags at main-process startup before the window is created', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    expect(source).toContain("import { applyChromiumRuntimeFlags } from './chromium-runtime-flags';");
    expect(source).toContain('applyChromiumRuntimeFlags(app.commandLine);');
    expect(source.indexOf('applyChromiumRuntimeFlags(app.commandLine);')).toBeLessThan(source.indexOf('app.whenReady()'));
  });
});
