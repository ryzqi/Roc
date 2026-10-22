import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fixedNvidiaProviderId } from '../../shared/provider-defaults';
import type { ProviderSecretStatus } from '../../shared/types';
import type { SafeStorageBackend, SafeStorageDecryptResult } from '../infrastructure/safe-storage-backend';
import { logWarn, RocDomainError } from './errors';
import type { RocPaths } from './paths';

const providerIdPattern = /^[A-Za-z0-9_-]+$/;

export class SecretService {
  constructor(
    private readonly paths: RocPaths,
    private readonly backend: SafeStorageBackend
  ) {}

  async setProviderSecret(providerId: string, plaintext: string): Promise<void> {
    const id = this.requireProviderId(providerId);
    if (plaintext.length === 0) {
      throw new RocDomainError({
        code: 'provider_secret_empty',
        message: 'Provider 凭据不能为空。',
        category: 'validation',
        retryable: false,
        userAction: '请输入有效的 API Key 后再保存。'
      });
    }
    this.validateProviderSecret(id, plaintext);
    if (!(await this.backend.isEncryptionAvailable())) {
      throw new RocDomainError({
        code: 'secret_storage_unavailable',
        message: '本机加密存储不可用，无法保存凭据。',
        category: 'degraded',
        retryable: false,
        userAction: '请确认 Roc 在 Electron 主进程中运行并启用了系统密钥环。'
      });
    }
    const encrypted = await this.backend.encryptString(plaintext);
    writeFileSync(this.secretPath(id), encrypted);
  }

  async getProviderSecret(providerId: string): Promise<string> {
    const id = this.requireProviderId(providerId);
    const target = this.secretPath(id);
    if (!existsSync(target)) {
      throw new RocDomainError({
        code: 'provider_credential_unavailable',
        message: 'Provider 凭据未存储。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页为该 Provider 录入 API Key 后再发起调用。'
      });
    }
    if (!(await this.backend.isEncryptionAvailable())) {
      throw new RocDomainError({
        code: 'secret_storage_unavailable',
        message: '本机加密存储不可用，无法读取凭据。',
        category: 'degraded',
        retryable: false,
        userAction: '请确认 Roc 在 Electron 主进程中运行并启用了系统密钥环。'
      });
    }
    const encrypted = readFileSync(target);
    let decrypted: SafeStorageDecryptResult;
    try {
      decrypted = await this.backend.decryptString(encrypted);
    } catch {
      throw new RocDomainError({
        code: 'provider_credential_unavailable',
        message: 'Provider 凭据无法解密，请重新录入。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页清除并重新录入该 Provider 的 API Key。'
      });
    }
    if (decrypted.shouldReEncrypt) {
      await this.rewriteWithRotatedKey(id, target, encrypted, decrypted.plaintext);
    }
    return decrypted.plaintext;
  }

  /**
   * 系统密钥轮转后 `decryptStringAsync` 会要求重写密文。
   *
   * ## 为什么不是直接覆盖
   *
   * `await` 会把控制权交回事件循环：这段时间里用户可能存了一份新密钥，也可能把这条凭据
   * 删了。无条件 `writeFileSync` 会把新密钥改回旧的，或者让已删除的凭据复活。所以先确认
   * 磁盘上的密文仍是本次读到的那一份，再用「同目录临时文件 + rename」原子替换；
   * 并发读者看不到半截密文。
   *
   * 写回失败不影响本次读取（明文已到手、旧密文仍可解密），但不能无声吞掉。
   */
  private async rewriteWithRotatedKey(
    providerId: string,
    target: string,
    previous: Buffer,
    plaintext: string
  ): Promise<void> {
    let current: Buffer;
    try {
      current = readFileSync(target);
    } catch {
      // 文件已经不在了：有人显式清除过这条凭据，不要复活它。
      return;
    }
    if (!current.equals(previous)) {
      return;
    }
    const temporary = `${target}.${randomUUID()}.rotating`;
    try {
      writeFileSync(temporary, await this.backend.encryptString(plaintext), { mode: 0o600 });
      renameSync(temporary, target);
    } catch {
      rmSync(temporary, { force: true });
      logWarn('Safe-storage re-encryption rewrite failed.', {
        service: 'secret',
        metadata: { providerId, code: 'provider_secret_re_encrypt_failed' }
      });
    }
  }

  clearProviderSecret(providerId: string): void {
    const id = this.requireProviderId(providerId);
    const target = this.secretPath(id);
    if (!existsSync(target)) {
      return;
    }
    rmSync(target, { force: true });
  }

  hasProviderSecret(providerId: string): boolean {
    if (!providerIdPattern.test(providerId)) {
      return false;
    }
    return existsSync(this.secretPath(providerId));
  }

  listSecretStatuses(providerIds: readonly string[]): ProviderSecretStatus[] {
    return providerIds.map((providerId) => ({
      providerId,
      stored: this.hasProviderSecret(providerId)
    }));
  }

  private secretPath(providerId: string): string {
    return join(this.paths.secretsDir, `${providerId}.bin`);
  }

  private requireProviderId(providerId: string): string {
    const trimmed = providerId.trim();
    if (trimmed.length === 0) {
      throw new RocDomainError({
        code: 'provider_id_empty',
        message: 'Provider ID 不能为空。',
        category: 'validation',
        retryable: false,
        userAction: '请提供有效的 Provider ID。'
      });
    }
    if (!providerIdPattern.test(trimmed)) {
      throw new RocDomainError({
        code: 'provider_id_invalid',
        message: 'Provider ID 含有不允许的字符。',
        category: 'validation',
        retryable: false,
        userAction: '请使用字母、数字、下划线或短横线组合的 Provider ID。'
      });
    }
    return trimmed;
  }

  private validateProviderSecret(providerId: string, plaintext: string): void {
    if (providerId !== fixedNvidiaProviderId) {
      return;
    }
    if (plaintext.startsWith('nvapi-')) {
      return;
    }
    throw new RocDomainError({
      code: 'provider_credential_format_invalid',
      message: 'NVIDIA Provider 凭据必须以 nvapi- 起始。',
      category: 'validation',
      retryable: false,
      userAction: '请到 build.nvidia.com 获取以 nvapi- 起始的 API Key 后重新录入。'
    });
  }
}
