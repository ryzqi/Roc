/**
 * 系统加密存储（Electron `safeStorage`）的端口。
 *
 * ## 为什么这个端口是异步的
 *
 * Electron 45 废弃了同步的 `isEncryptionAvailable` / `encryptString` / `decryptString`：
 * Chromium 移除了同步 OSCrypt 后端，Electron 46 会直接删掉这三个方法。异步版本
 * （`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`）用的是
 * 同一套系统密钥，磁盘上已有的密文可以原样解密。
 *
 * 端口因此没有同步形态：主进程里凡是读写密文的地方都必须 `await`，也不再提供
 * 「同步门面 + 后台预热」这种会随密钥环状态漂移的折中。持有密文的存储（provider
 * 凭据文件、插件密钥表）各自负责写回，端口只管加解密。
 *
 * ## 为什么带着 `shouldReEncrypt`
 *
 * `decryptStringAsync` 返回的是 `{ result, shouldReEncrypt }`，不是裸字符串：
 * `shouldReEncrypt` 为 `true` 表示系统密钥已轮转（或出现安全级别更高的新密钥），
 * 调用方应把 `result` 重新加密后覆盖旧密文。端口保留这个信号而不是当场丢弃，
 * 让两个存储层都能自愈，而不是让旧密文一直留在磁盘上。
 */
export type SafeStorageDecryptResult = {
  /** 明文。 */
  plaintext: string;
  /** 为 true 时调用方应把明文重新加密并覆盖旧密文。 */
  shouldReEncrypt: boolean;
};

export type SafeStorageBackend = {
  isEncryptionAvailable(): Promise<boolean>;
  encryptString(plaintext: string): Promise<Buffer>;
  decryptString(encrypted: Buffer): Promise<SafeStorageDecryptResult>;
};
