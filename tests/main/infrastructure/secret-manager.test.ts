import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabasePool } from '../../../src/main/infrastructure/database-pool';
import { SecretManager, type SafeStorageBackend } from '../../../src/main/infrastructure/secret-manager';

let root: string;
let pool: DatabasePool;

function createBackend(available = true): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('enc:')) {
        throw new Error('unexpected ciphertext');
      }
      return text.slice(4);
    }
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-secret-manager-test-'));
  pool = new DatabasePool(root);
});

afterEach(() => {
  pool.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe('SecretManager', () => {
  it('stores safeStorage-encrypted secrets in plugin scope', () => {
    const manager = new SecretManager(pool, createBackend());
    const agentSecrets = manager.createPluginSecretFacade('@roc/plugin-agent');
    const taskSecrets = manager.createPluginSecretFacade('@roc/plugin-task');

    agentSecrets.set('apiKey', 'sk-test');

    expect(agentSecrets.get('apiKey')).toBe('sk-test');
    expect(taskSecrets.get('apiKey')).toBeNull();
    expect(agentSecrets.get.length).toBe(1);
    expect(agentSecrets.set.length).toBe(2);
    expect(agentSecrets.clear.length).toBe(1);
    expect(
      pool
        .getCoreConnection()
        .prepare('SELECT ciphertext_base64 FROM plugin_secrets WHERE plugin_id = ? AND key = ?')
        .pluck()
        .get('@roc/plugin-agent', 'apiKey')
    ).toBe(Buffer.from('enc:sk-test', 'utf8').toString('base64'));
  });

  it('fails secret calls when safeStorage encryption is unavailable', () => {
    const manager = new SecretManager(pool, createBackend(false));
    const secrets = manager.createPluginSecretFacade('@roc/plugin-agent');

    expect(() => secrets.set('apiKey', 'sk-test')).toThrow(/secret_storage_unavailable/u);
    expect(() => secrets.get('apiKey')).toThrow(/secret_storage_unavailable/u);
  });

  it('clears plugin-scoped secrets', () => {
    const manager = new SecretManager(pool, createBackend());
    const secrets = manager.createPluginSecretFacade('@roc/plugin-agent');

    secrets.set('apiKey', 'sk-test');
    secrets.clear('apiKey');

    expect(secrets.get('apiKey')).toBeNull();
  });
});
