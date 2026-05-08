import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RocPaths } from '../../src/main/services/paths';
import { SecretService, type SafeStorageBackend } from '../../src/main/services/secret-service';

let root: string;
let paths: RocPaths;

function createBackend(): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('enc:')) {
        throw new Error('decryptString received unexpected payload');
      }
      return text.slice(4);
    }
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-secret-service-test-'));
  paths = new RocPaths(root);
  paths.ensureTree();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('SecretService', () => {
  it('persists and retrieves provider secrets through the safeStorage backend', () => {
    const backend = createBackend();
    const service = new SecretService(paths, backend);

    service.setProviderSecret('provider-openai', 'sk-test-1');

    expect(service.hasProviderSecret('provider-openai')).toBe(true);
    expect(existsSync(join(paths.secretsDir, 'provider-openai.bin'))).toBe(true);
    expect(service.getProviderSecret('provider-openai')).toBe('sk-test-1');
    expect(service.listSecretStatuses(['provider-openai', 'missing'])).toEqual([
      { providerId: 'provider-openai', stored: true },
      { providerId: 'missing', stored: false }
    ]);
  });

  it('clears stored secrets on demand', () => {
    const service = new SecretService(paths, createBackend());
    service.setProviderSecret('provider-openai', 'sk-test-1');
    service.clearProviderSecret('provider-openai');

    expect(service.hasProviderSecret('provider-openai')).toBe(false);
    expect(() => service.getProviderSecret('provider-openai')).toThrow();
  });

  it('rejects empty plaintext and invalid provider ids', () => {
    const service = new SecretService(paths, createBackend());
    expect(() => service.setProviderSecret('provider-openai', '')).toThrow();
    expect(() => service.setProviderSecret('   ', 'sk-test')).toThrow();
    expect(() => service.setProviderSecret('provider/openai', 'sk-test')).toThrow();
  });

  it('reports unavailable storage when the backend cannot encrypt', () => {
    const unavailableBackend: SafeStorageBackend = {
      ...createBackend(),
      isEncryptionAvailable: () => false
    };
    const service = new SecretService(paths, unavailableBackend);
    expect(() => service.setProviderSecret('provider-openai', 'sk-test')).toThrow(/加密存储不可用/u);
  });

  it('throws provider_credential_unavailable when reading a missing secret', () => {
    const service = new SecretService(paths, createBackend());
    expect(() => service.getProviderSecret('provider-openai')).toThrowError(/Provider 凭据未存储/u);
  });
});
