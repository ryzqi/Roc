import { BrowserWindow, app, safeStorage, type ProcessMetric } from 'electron';

import type { RuntimeMetricsProvider, RuntimeProcessMetric } from './plugins/diagnostics/runtime-metrics';
import type { SafeStorageBackend } from './services/secret-service';

export function createElectronSafeStorageBackend(): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plaintext) => safeStorage.encryptString(plaintext),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted)
  };
}

export function createElectronRuntimeMetricsProvider(): RuntimeMetricsProvider {
  return {
    getBrowserWindowCount: () => BrowserWindow.getAllWindows().length,
    getProcessMetrics: () => app.getAppMetrics().map(toRuntimeProcessMetric)
  };
}

export function toLogError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function toRuntimeProcessMetric(metric: ProcessMetric): RuntimeProcessMetric {
  return {
    pid: metric.pid,
    type: metric.type,
    name: metric.name,
    serviceName: metric.serviceName,
    cpuPercent: metric.cpu.percentCPUUsage,
    sandboxed: metric.sandboxed,
    integrityLevel: metric.integrityLevel,
    memory: {
      workingSetSizeKb: metric.memory.workingSetSize,
      peakWorkingSetSizeKb: metric.memory.peakWorkingSetSize,
      privateBytesKb: metric.memory.privateBytes
    }
  };
}
