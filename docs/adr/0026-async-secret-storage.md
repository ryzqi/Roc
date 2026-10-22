# 密钥存储只有异步一条路

## 背景

Electron 45 把 `safeStorage` 的同步 API（`isEncryptionAvailable` / `encryptString` /
`decryptString`）标记为废弃：Chromium 移除了同步 OSCrypt 后端，45 是弃用版，46 直接删除。
异步替代品（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`）用的是
同一套系统密钥，磁盘上已有的密文可以原样解密。

仓库里有两条各自持有密文的路径：provider API Key 落在 `<data>/secrets/<providerId>.bin`
（`src/main/services/secret-service.ts`），插件密钥落在 core 库的 `plugin_secrets` 表
（`src/main/infrastructure/secret-manager.ts`）。两者原本都是同步的，插件侧还通过
`RocPluginContext.secrets` 暴露成一个同步门面。

## 决定

### 1. 端口只有一个，且是异步的

`src/main/infrastructure/safe-storage-backend.ts` 是 `safeStorage` 的唯一接口：

```ts
type SafeStorageBackend = {
  isEncryptionAvailable(): Promise<boolean>;
  encryptString(plaintext: string): Promise<Buffer>;
  decryptString(encrypted: Buffer): Promise<{ plaintext: string; shouldReEncrypt: boolean }>;
};
```

没有同步形态，也没有「同步门面 + 后台预热」。原因是同步门面的行为会随密钥环状态漂移
（第一次调用可能还没就绪），而这类漂移只在用户的机器上出现。端口只管加解密，
「密文存在哪、怎么写回」属于两个存储自己。

### 2. 插件上下文里的 `secrets` 是 Promise

`RocPluginContext.secrets` 的 `get` / `set` 返回 Promise；`clear` 保持同步，因为它只删一行、
不碰加密。插件想读密钥就必须 `await`——这不是风格问题，是类型系统替我们守的边界。

### 3. `shouldReEncrypt` 不能丢，重写必须带守卫

`decryptStringAsync` 返回 `{ result, shouldReEncrypt }`：后者为 true 表示系统密钥轮转了，
调用方应把明文重新加密并覆盖旧密文。两个存储各自负责写回，但**都不能无条件覆盖**：

- `await` 会把控制权交回事件循环。这段时间里用户可能刚存了一份新密钥（无条件覆盖会把新
  Key 改回旧的、等于静默撤销一次密钥轮换），也可能把这条凭据删了（无条件写回会让它复活）。
- 所以文件侧先读回当前密文、与本次解密用的字节逐字节比较，再用「同目录临时文件 + rename」
  原子替换；SQLite 侧用**旧密文作 WHERE 守卫**的条件 `UPDATE`，守卫不匹配就是 0 行。

### 4. 重写失败不阻塞读取，但要留日志

明文已经到手、旧密文仍可解密，所以读取成功。但永久失败会把这条凭据一直留在旧密钥下，
因此失败要 `warn` 一次（`provider_secret_re_encrypt_failed` / `plugin_secret_re_encrypt_failed`）。

### 5. 读取不再是纯只读

轮转重写发生在 `get` 里。这是有意的自愈：只有在读取时才知道「这份密文需要重写」。
代价写在下面。

## 代价

- **任何新的密钥路径都必须异步**，包括插件能力与 IPC handler。同步函数里读密钥会拿到
  `Promise`，`pnpm typecheck` 会当场拦下（但 `Promise<Promise<T>>` 这种返回是可以通过的，
  所以 capability handler 一律写 `await`，不给隐式展平留位置）。
- **`getProviderSecret` 多了一次 `await`**：模型创建路径（`langchain-model-factory`）因此
  变成异步链。这条链本来就在 async 上下文里，改动只是传播。
- **读取可能写盘**：`get` 在轮转时会重写密文（文件走 rename，SQLite 走一条 UPDATE）。
  只读副本、只读数据目录等场景下重写会失败——失败被降级成一条 warn，读取照常返回。
- **`plugin_secrets.updated_at` 只因真实重写而变化**，不再因为「有人读了一次」而变化。
- **单测用假的 `SafeStorageBackend`**（`tests/unit/secret-storage.test.mjs`），真的 OSCrypt
  （包括跨重启能否解密）由 `pnpm verify:p8-settings` 在真 Electron 里守。
