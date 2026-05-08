import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderSecretStatus } from '../../shared/types';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';

export interface SafeStorageBackend {
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isEncryptionAvailable(): boolean;
}

const providerIdPattern = /^[A-Za-z0-9_-]+$/;

export class SecretService {
  constructor(
    private readonly paths: RocPaths,
    private readonly backend: SafeStorageBackend
  ) {}

  setProviderSecret(providerId: string, plaintext: string): void {
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
    if (!this.backend.isEncryptionAvailable()) {
      throw new RocDomainError({
        code: 'secret_storage_unavailable',
        message: '本机加密存储不可用，无法保存凭据。',
        category: 'degraded',
        retryable: false,
        userAction: '请确认 Roc 在 Electron 主进程中运行并启用了系统密钥环。'
      });
    }
    const encrypted = this.backend.encryptString(plaintext);
    writeFileSync(this.secretPath(id), encrypted);
  }

  getProviderSecret(providerId: string): string {
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
    if (!this.backend.isEncryptionAvailable()) {
      throw new RocDomainError({
        code: 'secret_storage_unavailable',
        message: '本机加密存储不可用，无法读取凭据。',
        category: 'degraded',
        retryable: false,
        userAction: '请确认 Roc 在 Electron 主进程中运行并启用了系统密钥环。'
      });
    }
    const encrypted = readFileSync(target);
    return this.backend.decryptString(encrypted);
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
}
