import { describe, expect, it } from 'vitest';
import { RTKBinaryManager } from '../../src/rtk-integration/binary-manager';

describe('RTKBinaryManager', () => {
  it('resolves the current platform binary from bundled resources', () => {
    const manager = new RTKBinaryManager();

    expect(manager.getRTKBinaryPath()).toContain('resources');
    expect(manager.getRTKBinaryPath()).toContain('rtk-binaries');
    expect(manager.getRTKBinaryPath()).toContain(process.platform === 'win32' ? 'rtk.exe' : 'rtk');
  });

  it('returns null for unsupported platforms', () => {
    const manager = new RTKBinaryManager({
      platform: 'freebsd',
      arch: 'x64'
    });

    expect(manager.getRTKBinaryPath()).toBeNull();
    expect(manager.isRTKAvailable()).toBe(false);
  });

  it('reports the bundled Windows binary as available in development', () => {
    const manager = new RTKBinaryManager({
      platform: 'win32',
      arch: 'x64',
      resourceRoot: process.cwd()
    });

    expect(manager.getRTKBinaryPath()).toContain('win32-x64');
    expect(manager.isRTKAvailable()).toBe(true);
  });

  it('resolves every supported bundled platform directory', () => {
    const cases = [
      { platform: 'darwin', arch: 'x64', expected: 'darwin-x64\\rtk' },
      { platform: 'darwin', arch: 'arm64', expected: 'darwin-arm64\\rtk' },
      { platform: 'linux', arch: 'x64', expected: 'linux-x64\\rtk' }
    ] as const;

    for (const platformCase of cases) {
      const manager = new RTKBinaryManager({
        platform: platformCase.platform,
        arch: platformCase.arch,
        resourcesPath: 'C:\\Packaged\\resources'
      });

      expect(manager.getRTKBinaryPath()).toBe(`C:\\Packaged\\resources\\rtk-binaries\\${platformCase.expected}`);
    }
  });

  it('uses Electron resourcesPath when present', () => {
    const processWithResources = process as NodeJS.Process & { defaultApp?: boolean; resourcesPath?: string };
    const original = processWithResources.resourcesPath;
    const originalDefaultApp = processWithResources.defaultApp;
    processWithResources.resourcesPath = 'C:\\Electron\\resources';
    try {
      const manager = new RTKBinaryManager({
        platform: 'win32',
        arch: 'x64'
      });

      expect(manager.getRTKBinaryPath()).toBe('C:\\Electron\\resources\\rtk-binaries\\win32-x64\\rtk.exe');
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(processWithResources, 'resourcesPath');
      } else {
        processWithResources.resourcesPath = original;
      }
      if (originalDefaultApp === undefined) {
        Reflect.deleteProperty(processWithResources, 'defaultApp');
      } else {
        processWithResources.defaultApp = originalDefaultApp;
      }
    }
  });

  it('ignores Electron default app resourcesPath in development', () => {
    const processWithResources = process as NodeJS.Process & { defaultApp?: boolean; resourcesPath?: string };
    const original = processWithResources.resourcesPath;
    const originalDefaultApp = processWithResources.defaultApp;
    processWithResources.resourcesPath = 'C:\\Electron\\dist\\resources';
    processWithResources.defaultApp = true;
    try {
      const manager = new RTKBinaryManager({
        platform: 'win32',
        arch: 'x64',
        resourceRoot: 'F:\\Code\\Roc'
      });

      expect(manager.getRTKBinaryPath()).toBe('F:\\Code\\Roc\\resources\\rtk-binaries\\win32-x64\\rtk.exe');
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(processWithResources, 'resourcesPath');
      } else {
        processWithResources.resourcesPath = original;
      }
      if (originalDefaultApp === undefined) {
        Reflect.deleteProperty(processWithResources, 'defaultApp');
      } else {
        processWithResources.defaultApp = originalDefaultApp;
      }
    }
  });
});
