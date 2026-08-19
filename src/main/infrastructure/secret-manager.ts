import type { Database as DatabaseConnection } from 'better-sqlite3';

import { assertPluginId } from './database-pool';

export type SafeStorageBackend = {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

type PluginSecretFacade = {
  get(key: string): string | null;
  set(key: string, plaintext: string): void;
  clear(key: string): void;
};

export class SecretManager {
  constructor(
    private readonly coreDb: DatabaseConnection,
    private readonly safeStorage: SafeStorageBackend
  ) {}

  createPluginSecretFacade(pluginId: string): PluginSecretFacade {
    assertPluginId(pluginId);
    return {
      get: (key: string): string | null => this.get(pluginId, key),
      set: (key: string, plaintext: string): void => {
        this.set(pluginId, key, plaintext);
      },
      clear: (key: string): void => {
        this.clear(pluginId, key);
      }
    };
  }

  private get(pluginId: string, key: string): string | null {
    this.requireEncryption();
    assertPluginId(pluginId);
    const ciphertext = this.coreDb
      .prepare('SELECT ciphertext_base64 FROM plugin_secrets WHERE plugin_id = ? AND key = ?')
      .pluck()
      .get(pluginId, key);
    if (typeof ciphertext !== 'string') {
      return null;
    }
    return this.safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  }

  private set(pluginId: string, key: string, plaintext: string): void {
    this.requireEncryption();
    assertPluginId(pluginId);
    const ciphertext = this.safeStorage.encryptString(plaintext).toString('base64');
    this.coreDb
      .prepare(
        `INSERT OR REPLACE INTO plugin_secrets (plugin_id, key, ciphertext_base64, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(pluginId, key, ciphertext, new Date().toISOString());
  }

  private clear(pluginId: string, key: string): void {
    assertPluginId(pluginId);
    this.coreDb
      .prepare('DELETE FROM plugin_secrets WHERE plugin_id = ? AND key = ?')
      .run(pluginId, key);
  }

  private requireEncryption(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('secret_storage_unavailable');
    }
  }
}
