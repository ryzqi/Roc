import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { SafeStorageBackend } from './safe-storage-backend';
import { assertPluginId } from './database-pool';

type PluginSecretFacade = {
  get(key: string): Promise<string | null>;
  set(key: string, plaintext: string): Promise<void>;
  clear(key: string): void;
};

/** 只用到 warn 一条：由 kernel 传入它自己的插件日志，infrastructure 不依赖 services 层。 */
export type SecretManagerLogger = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export class SecretManager {
  constructor(
    private readonly coreDb: DatabaseConnection,
    private readonly safeStorage: SafeStorageBackend,
    private readonly logger: SecretManagerLogger | null = null
  ) {}

  createPluginSecretFacade(pluginId: string): PluginSecretFacade {
    assertPluginId(pluginId);
    return {
      get: async (key: string): Promise<string | null> => await this.get(pluginId, key),
      set: async (key: string, plaintext: string): Promise<void> => {
        await this.set(pluginId, key, plaintext);
      },
      clear: (key: string): void => {
        this.clear(pluginId, key);
      }
    };
  }

  private async get(pluginId: string, key: string): Promise<string | null> {
    await this.requireEncryption();
    assertPluginId(pluginId);
    const ciphertext = this.coreDb
      .prepare('SELECT ciphertext_base64 FROM plugin_secrets WHERE plugin_id = ? AND key = ?')
      .pluck()
      .get(pluginId, key);
    if (typeof ciphertext !== 'string') {
      return null;
    }
    const decrypted = await this.safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
    if (decrypted.shouldReEncrypt) {
      await this.rewriteWithRotatedKey(pluginId, key, ciphertext, decrypted.plaintext);
    }
    return decrypted.plaintext;
  }

  /**
   * 系统密钥轮转后重写密文。写回走「旧密文作守卫」的条件 UPDATE，而不是 `set()` 的
   * `INSERT OR REPLACE`：`await` 期间插件可能已经写了一份新密钥，无条件替换会把新值改回旧的。
   * 守卫不匹配时什么也不改（0 行受影响），下次读取会被重新标记一次。
   *
   * 失败不影响本次读取，但要留日志：永久失败会把这条凭据一直留在旧密钥下。
   */
  private async rewriteWithRotatedKey(
    pluginId: string,
    key: string,
    previousCiphertext: string,
    plaintext: string
  ): Promise<void> {
    try {
      const encrypted = await this.safeStorage.encryptString(plaintext);
      const rotated = encrypted.toString('base64');
      this.coreDb
        .prepare(
          `UPDATE plugin_secrets
           SET ciphertext_base64 = ?, updated_at = ?
           WHERE plugin_id = ? AND key = ? AND ciphertext_base64 = ?`
        )
        .run(rotated, new Date().toISOString(), pluginId, key, previousCiphertext);
    } catch {
      this.logger?.warn('Safe-storage re-encryption rewrite failed.', {
        pluginId,
        key,
        code: 'plugin_secret_re_encrypt_failed'
      });
    }
  }

  private async set(pluginId: string, key: string, plaintext: string): Promise<void> {
    await this.requireEncryption();
    assertPluginId(pluginId);
    const encrypted = await this.safeStorage.encryptString(plaintext);
    const ciphertext = encrypted.toString('base64');
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

  private async requireEncryption(): Promise<void> {
    if (!(await this.safeStorage.isEncryptionAvailable())) {
      throw new Error('secret_storage_unavailable');
    }
  }
}
