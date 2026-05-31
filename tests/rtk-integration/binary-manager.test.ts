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
});
