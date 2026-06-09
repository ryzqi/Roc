import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '../../src/main/services/config-service';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';
import { LogService } from '../../src/main/services/log-service';
import { MetricsService } from '../../src/main/services/metrics-service';
import { RocPaths } from '../../src/main/services/paths';
import { ProviderRuntimeService } from '../../src/main/services/provider-runtime-service';
import { SecretService, type SafeStorageBackend } from '../../src/main/services/secret-service';

export type ProviderTestServices = {
  root: string;
  paths: RocPaths;
  configService: ConfigService;
  secretService: SecretService;
  logService: LogService;
  metricsService: MetricsService;
  langChainModelFactory: LangChainModelFactory;
  providerRuntimeService: ProviderRuntimeService;
  cleanup(): Promise<void>;
};

export function createProviderTestServices(prefix: string): ProviderTestServices {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const paths = new RocPaths(root);
  paths.ensureTree();
  const configService = new ConfigService(paths);
  configService.initialize();
  const secretService = new SecretService(paths, createInMemorySafeStorageBackend());
  const logService = new LogService(paths);
  logService.initialize();
  const metricsService = new MetricsService();
  const langChainModelFactory = new LangChainModelFactory(configService, secretService, logService);
  const providerRuntimeService = new ProviderRuntimeService(configService, langChainModelFactory, metricsService);

  return {
    root,
    paths,
    configService,
    secretService,
    logService,
    metricsService,
    langChainModelFactory,
    providerRuntimeService,
    cleanup: async () => {
      await logService.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function createInMemorySafeStorageBackend(): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`roc-test:${plaintext}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('roc-test:')) {
        throw new Error('Encrypted payload was not produced by the in-memory safe storage backend.');
      }
      return text.slice('roc-test:'.length);
    }
  };
}
