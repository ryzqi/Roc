import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { RTKBinaryManager } from '../../src/rtk-integration/binary-manager';

describe('RTKBinaryManager', () => {
  it('resolves the current platform binary from bundled resources', () => {
    const manager = new RTKBinaryManager();

    expect(manager.getRTKBinaryPath()).toContain('resources');
    expect(manager.getRTKBinaryPath()).toContain('rtk-binaries');
    expect(manager.getRTKBinaryPath()).toContain('rtk');
  });

  it('returns null for unsupported platforms', () => {
    const manager = new RTKBinaryManager({
      platform: 'freebsd',
      arch: 'x64'
    });

    expect(manager.getRTKBinaryPath()).toBeNull();
    expect(manager.isRTKAvailable()).toBe(false);
  });

  it('reports the bundled macOS binary as available in development', () => {
    const manager = new RTKBinaryManager({
      platform: 'darwin',
      arch: 'x64',
      resourceRoot: process.cwd()
    });

    expect(manager.getRTKBinaryPath()).toContain('darwin-x64');
    expect(manager.isRTKAvailable()).toBe(true);
  });

  it('resolves every supported bundled platform directory', () => {
    const cases = [
      { platform: 'darwin', arch: 'x64', expected: join('darwin-x64', 'rtk') },
      { platform: 'darwin', arch: 'arm64', expected: join('darwin-arm64', 'rtk') },
    ] as const;

    for (const platformCase of cases) {
      const manager = new RTKBinaryManager({
        platform: platformCase.platform,
        arch: platformCase.arch,
        resourcesPath: '/Applications/Roc.app/Contents/Resources'
      });

      expect(manager.getRTKBinaryPath()).toBe(join('/Applications/Roc.app/Contents/Resources', 'rtk-binaries', platformCase.expected));
    }
  });

  it('uses Electron resourcesPath when present', () => {
    const processWithResources = process as NodeJS.Process & { defaultApp?: boolean; resourcesPath?: string };
    const original = processWithResources.resourcesPath;
    const originalDefaultApp = processWithResources.defaultApp;
    processWithResources.resourcesPath = '/Electron.app/Contents/Resources';
    try {
      const manager = new RTKBinaryManager({
        platform: 'darwin',
        arch: 'x64'
      });

      expect(manager.getRTKBinaryPath()).toBe(join('/Electron.app/Contents/Resources', 'rtk-binaries', 'darwin-x64', 'rtk'));
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
    processWithResources.resourcesPath = '/Electron.app/Contents/Resources';
    processWithResources.defaultApp = true;
    try {
      const manager = new RTKBinaryManager({
        platform: 'darwin',
        arch: 'x64',
        resourceRoot: '/Users/test/Projects/Roc'
      });

      expect(manager.getRTKBinaryPath()).toBe(join('/Users/test/Projects/Roc', 'resources', 'rtk-binaries', 'darwin-x64', 'rtk'));
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
