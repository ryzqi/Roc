import { beforeEach, describe, expect, it, vi } from 'vitest';

const isEncryptionAvailable = vi.fn();
const encryptString = vi.fn();
const decryptString = vi.fn();
const getAllWindows = vi.fn();
const getAppMetrics = vi.fn();

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: (...args: unknown[]) => isEncryptionAvailable(...args),
    encryptString: (...args: unknown[]) => encryptString(...args),
    decryptString: (...args: unknown[]) => decryptString(...args)
  },
  BrowserWindow: {
    getAllWindows: (...args: unknown[]) => getAllWindows(...args)
  },
  app: {
    getAppMetrics: (...args: unknown[]) => getAppMetrics(...args)
  }
}));

const { createElectronRuntimeMetricsProvider, createElectronSafeStorageBackend } = await import(
  '../../src/main/electron-runtime-adapters'
);

describe('electron runtime adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards safe storage calls to the electron safeStorage module', () => {
    const cipher = Buffer.from('cipher');
    isEncryptionAvailable.mockReturnValue(true);
    encryptString.mockReturnValue(cipher);
    decryptString.mockReturnValue('plaintext');
    const backend = createElectronSafeStorageBackend();

    expect(backend.isEncryptionAvailable()).toBe(true);
    expect(backend.encryptString('plaintext')).toBe(cipher);
    expect(encryptString).toHaveBeenCalledWith('plaintext');
    expect(backend.decryptString(cipher)).toBe('plaintext');
    expect(decryptString).toHaveBeenCalledWith(cipher);
  });

  it('reports the live browser window count on every call instead of caching it', () => {
    getAllWindows.mockReturnValueOnce([{}, {}]).mockReturnValueOnce([]);
    const provider = createElectronRuntimeMetricsProvider();

    expect(provider.getBrowserWindowCount()).toBe(2);
    expect(provider.getBrowserWindowCount()).toBe(0);
  });

  it('maps electron process metrics onto the diagnostics contract including optional fields', () => {
    getAppMetrics.mockReturnValue([
      {
        pid: 4242,
        type: 'Browser',
        name: 'main',
        serviceName: 'network.mojom.NetworkService',
        cpu: { percentCPUUsage: 12.5, idleWakeupsPerSecond: 3 },
        sandboxed: true,
        integrityLevel: 'medium',
        memory: { workingSetSize: 204800, peakWorkingSetSize: 307200, privateBytes: 102400 }
      },
      {
        pid: 99,
        type: 'Tab',
        cpu: { percentCPUUsage: 0 },
        memory: { workingSetSize: 1024, peakWorkingSetSize: 2048 }
      }
    ]);
    const provider = createElectronRuntimeMetricsProvider();

    expect(provider.getProcessMetrics()).toEqual([
      {
        pid: 4242,
        type: 'Browser',
        name: 'main',
        serviceName: 'network.mojom.NetworkService',
        cpuPercent: 12.5,
        sandboxed: true,
        integrityLevel: 'medium',
        memory: {
          workingSetSizeKb: 204800,
          peakWorkingSetSizeKb: 307200,
          privateBytesKb: 102400
        }
      },
      {
        pid: 99,
        type: 'Tab',
        name: undefined,
        serviceName: undefined,
        cpuPercent: 0,
        sandboxed: undefined,
        integrityLevel: undefined,
        memory: {
          workingSetSizeKb: 1024,
          peakWorkingSetSizeKb: 2048,
          privateBytesKb: undefined
        }
      }
    ]);
  });
});
