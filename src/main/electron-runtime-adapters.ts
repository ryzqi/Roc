import { BrowserWindow, app, safeStorage, type ProcessMetric } from 'electron';

import type { RuntimeMetricsProvider, RuntimeProcessMetric } from './plugins/diagnostics/runtime-metrics';
import type { SafeStorageBackend } from './infrastructure/safe-storage-backend';

export function createElectronSafeStorageBackend(): SafeStorageBackend {
  return {
    // Electron 45 废弃了同步 *EncryptionAvailable / *String，46 会删除；这里只走异步 API。
    // decryptStringAsync 返回 { result, shouldReEncrypt }，端口把后者显式传出去。
    isEncryptionAvailable: async () => await safeStorage.isAsyncEncryptionAvailable(),
    encryptString: async (plaintext) => await safeStorage.encryptStringAsync(plaintext),
    decryptString: async (encrypted) => {
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      return { plaintext: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt };
    }
  };
}

export function createElectronRuntimeMetricsProvider(): RuntimeMetricsProvider {
  return {
    getBrowserWindowCount: () => BrowserWindow.getAllWindows().length,
    getProcessMetrics: () => app.getAppMetrics().map(toRuntimeProcessMetric)
  };
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
