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
    expect(commandLine.appendSwitch).not.toHaveBeenCalledWith('remote-debugging-port', expect.anything());
  });

  it('applies the flags at main-process startup before the window is created', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    expect(source).toContain("import { applyChromiumRuntimeFlags } from './chromium-runtime-flags';");
    expect(source).toContain('applyChromiumRuntimeFlags(app.commandLine);');
    expect(source.indexOf('applyChromiumRuntimeFlags(app.commandLine);')).toBeLessThan(source.indexOf('app.whenReady()'));
  });

  it('exits before Chromium setup when the host is not macOS', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    expect(source).toContain("if (process.platform !== 'darwin')");
    expect(source).toContain("console.error('Roc requires macOS.');");
    expect(source).toContain('app.exit(1);');
    expect(source.indexOf("if (process.platform !== 'darwin')")).toBeLessThan(source.indexOf('registerPdfPreviewScheme();'));
    expect(source.indexOf("if (process.platform !== 'darwin')")).toBeLessThan(source.indexOf('applyChromiumRuntimeFlags(app.commandLine);'));
  });

  it('forwards Playwright remote debugging into Chromium before app ready', () => {
    const commandLine = {
      appendSwitch: vi.fn()
    };

    applyChromiumRuntimeFlags(commandLine, {}, ['node', 'app', '--remote-debugging-port=0']);

    expect(commandLine.appendSwitch).toHaveBeenCalledWith('remote-debugging-port', '0');
  });

  it('enables Chromium remote debugging during packaged smoke even if argv is stripped', () => {
    const commandLine = {
      appendSwitch: vi.fn()
    };

    applyChromiumRuntimeFlags(commandLine, { ROC_SMOKE: '1' }, ['/Applications/Roc.app/Contents/MacOS/Roc']);

    expect(commandLine.appendSwitch).toHaveBeenCalledWith('remote-debugging-port', '0');
  });
});
