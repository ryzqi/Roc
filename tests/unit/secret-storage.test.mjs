import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * 密钥存储的两条实现（provider 凭据落文件、插件密钥落 SQLite）与 safeStorage 端口的合同。
 *
 * 为什么需要这份单测：Electron 45 废弃了同步 `safeStorage` API，`46` 会删除它，所以
 * `SafeStorageBackend` 变成了异步端口，两个存储的读写都改成 `await`。这一步带进来两个
 * 只在新代码里存在的窗口，而且都**不会**被 `verify:p8-settings` 抓到（它跑的是串行 UI 路径）：
 *
 *   1. `decryptStringAsync` 返回 `shouldReEncrypt: true` 时要把明文重新加密写回。`await`
 *      会把控制权交回事件循环，这期间用户可能换了新密钥、也可能把凭据删了。
 *      「重写」必须是**带守卫的**：磁盘上/表里的密文已经不是本次读到的那一份时就不许写。
 *   2. 重写失败不能影响这次读取（明文已经到手、旧密文仍可解密），但旧密文必须原样保留。
 *
 * 这里用假的 `SafeStorageBackend` 钉住这几条，不需要 Electron：真的 OSCrypt 行为由
 * `verify:p8-settings`（真应用 + 真重启）覆盖。
 */
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const { SecretService } = await importTypeScriptModule('src/main/services/secret-service.ts', {
  platform: 'node'
});
const { SecretManager } = await importTypeScriptModule('src/main/infrastructure/secret-manager.ts', {
  platform: 'node',
  // 原生模块只在这一份测试里跑，别让 esbuild 去打它的 JS。
  external: ['better-sqlite3'],
  // external 的裸模块名字需要目录基址才能解析，`data:` URL 没有，所以这一份落成仓库内临时文件。
  tempDir: join(repositoryRoot, '.runtime/tmp')
});

function createTempSecretsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'roc-secrets-'));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * 假后端：密文就是 `<版本>:<明文>`，所以「哪个版本的密文落在盘上」可以直接读字节判断。
 *
 * - `rotation` 为 true 时 `decryptString` 报 `shouldReEncrypt`（模拟系统密钥轮转）；
 * - `gate` 让我们把一次解密挂起，好在 `await` 窗口里插入别的写操作；
 * - `failEncryptFrom` 让第 N 次之后的加密失败，用来测「重写失败」。
 */
function createFakeBackend() {
  const state = {
    available: true,
    version: 'v1',
    rotation: false,
    gate: null,
    decryptCalls: 0,
    encryptCalls: 0,
    failEncrypt: false
  };
  const backend = {
    isEncryptionAvailable: async () => state.available,
    encryptString: async (plaintext) => {
      state.encryptCalls += 1;
      if (state.failEncrypt) {
        throw new Error('fake_encrypt_failed');
      }
      return Buffer.from(`${state.version}:${plaintext}`, 'utf8');
    },
    decryptString: async (encrypted) => {
      state.decryptCalls += 1;
      if (state.gate !== null) {
        await state.gate.promise;
      }
      const text = encrypted.toString('utf8');
      const separator = text.indexOf(':');
      return {
        plaintext: separator === -1 ? text : text.slice(separator + 1),
        shouldReEncrypt: state.rotation
      };
    }
  };
  return { state, backend };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function leftoversIn(dir) {
  return readdirSync(dir).filter((name) => name.includes('.rotating'));
}

test('密文落盘后能读回，且读回不需要轮转时不重写', async () => {
  const temp = createTempSecretsDir();
  const { state, backend } = createFakeBackend();
  try {
    const service = new SecretService({ secretsDir: temp.dir }, backend);
    await service.setProviderSecret('provider-a', 'sk-plain');
    const file = join(temp.dir, 'provider-a.bin');
    assert.equal(readFileSync(file, 'utf8'), 'v1:sk-plain');

    const encryptCallsBefore = state.encryptCalls;
    assert.equal(await service.getProviderSecret('provider-a'), 'sk-plain');
    assert.equal(state.encryptCalls, encryptCallsBefore, '没有轮转标记时不应该重写密文');
    assert.equal(readFileSync(file, 'utf8'), 'v1:sk-plain');
  } finally {
    temp.cleanup();
  }
});

test('shouldReEncrypt 时把明文按新密钥重写回去，且不留临时文件', async () => {
  const temp = createTempSecretsDir();
  const { state, backend } = createFakeBackend();
  try {
    const service = new SecretService({ secretsDir: temp.dir }, backend);
    await service.setProviderSecret('provider-a', 'sk-plain');

    state.rotation = true;
    state.version = 'v2';
    assert.equal(await service.getProviderSecret('provider-a'), 'sk-plain');
    assert.equal(readFileSync(join(temp.dir, 'provider-a.bin'), 'utf8'), 'v2:sk-plain');
    assert.deepEqual(leftoversIn(temp.dir), []);

    // 下一轮已经是最新密钥，不该再被要求轮转。
    state.rotation = false;
    const encryptCallsBefore = state.encryptCalls;
    assert.equal(await service.getProviderSecret('provider-a'), 'sk-plain');
    assert.equal(state.encryptCalls, encryptCallsBefore);
  } finally {
    temp.cleanup();
  }
});

test('轮转重写不会覆盖在 await 窗口里写入的新凭据', async () => {
  const temp = createTempSecretsDir();
  const { state, backend } = createFakeBackend();
  try {
    const service = new SecretService({ secretsDir: temp.dir }, backend);
    await service.setProviderSecret('provider-a', 'sk-old');
    state.rotation = true;
    state.version = 'v2';

    state.gate = deferred();
    const reading = service.getProviderSecret('provider-a');
    // 让 decrypt 真的进到 gate 上，再在这个窗口里写入新密钥。
    await new Promise((settle) => setImmediate(settle));
    assert.equal(state.decryptCalls, 1, '解密必须已经在飞行中，这个窗口才是真的');
    await service.setProviderSecret('provider-a', 'sk-new');
    state.gate.resolve();

    assert.equal(await reading, 'sk-old');
    assert.equal(
      readFileSync(join(temp.dir, 'provider-a.bin'), 'utf8'),
      'v2:sk-new',
      '轮转重写必须让位给用户刚存的新密钥'
    );
  } finally {
    if (state.gate !== null) state.gate.resolve();
    temp.cleanup();
  }
});

test('轮转重写不会让已经删除的凭据复活', async () => {
  const temp = createTempSecretsDir();
  const { state, backend } = createFakeBackend();
  try {
    const service = new SecretService({ secretsDir: temp.dir }, backend);
    await service.setProviderSecret('provider-a', 'sk-plain');
    state.rotation = true;

    state.gate = deferred();
    const reading = service.getProviderSecret('provider-a');
    await new Promise((settle) => setImmediate(settle));
    service.clearProviderSecret('provider-a');
    state.gate.resolve();

    assert.equal(await reading, 'sk-plain');
    assert.equal(existsSync(join(temp.dir, 'provider-a.bin')), false);
  } finally {
    if (state.gate !== null) state.gate.resolve();
    temp.cleanup();
  }
});

test('轮转重写失败时保留旧密文，读取照样成功', async () => {
  const temp = createTempSecretsDir();
  const { state, backend } = createFakeBackend();
  try {
    const service = new SecretService({ secretsDir: temp.dir }, backend);
    await service.setProviderSecret('provider-a', 'sk-plain');
    state.rotation = true;
    state.version = 'v2';
    state.failEncrypt = true;

    assert.equal(await service.getProviderSecret('provider-a'), 'sk-plain');
    assert.equal(readFileSync(join(temp.dir, 'provider-a.bin'), 'utf8'), 'v1:sk-plain');
    assert.deepEqual(leftoversIn(temp.dir), []);
  } finally {
    temp.cleanup();
  }
});

test('加密存储不可用时在碰密文之前就报错', async () => {
  const temp = createTempSecretsDir();
  const { state, backend } = createFakeBackend();
  try {
    const service = new SecretService({ secretsDir: temp.dir }, backend);
    await service.setProviderSecret('provider-a', 'sk-plain');
    writeFileSync(join(temp.dir, 'provider-a.bin'), 'v1:sk-plain');

    state.available = false;
    state.decryptCalls = 0;
    await assert.rejects(service.getProviderSecret('provider-a'), (error) => {
      assert.equal(error.code, 'secret_storage_unavailable');
      return true;
    });
    assert.equal(state.decryptCalls, 0, '不可用时不该尝试解密');
  } finally {
    temp.cleanup();
  }
});

function createSecretManagerFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plugin_secrets (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      ciphertext_base64 TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, key)
    );
  `);
  const warnings = [];
  const { state, backend } = createFakeBackend();
  const manager = new SecretManager(db, backend, {
    warn: (message, metadata) => warnings.push({ message, metadata })
  });
  return { db, state, backend, warnings, manager, facade: manager.createPluginSecretFacade('@roc/plugin-test') };
}

const storedBase64 = (db) =>
  db.prepare('SELECT ciphertext_base64 AS value FROM plugin_secrets').pluck().get();

test('插件密钥：facade 的 get/set 可 await，clear 仍是同步的', async () => {
  const { db, facade } = createSecretManagerFixture();
  const setting = facade.set('k1', 'sk-plugin');
  assert.ok(setting instanceof Promise, 'set 必须是异步的');
  await setting;

  const reading = facade.get('k1');
  assert.ok(reading instanceof Promise, 'get 必须是异步的');
  assert.equal(await reading, 'sk-plugin');

  assert.equal(facade.clear('k1'), undefined, 'clear 只删一行，不该变成异步');
  assert.equal(await facade.get('k1'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plugin_secrets').pluck().get(), 0);
});

test('插件密钥：shouldReEncrypt 时按新密钥更新那一行', async () => {
  const { db, state, facade } = createSecretManagerFixture();
  await facade.set('k1', 'sk-plugin');
  await facade.set('k2', 'sk-other');

  state.rotation = true;
  state.version = 'v2';
  assert.equal(await facade.get('k2'), 'sk-other');

  const rows = db
    .prepare('SELECT key AS k, ciphertext_base64 AS value FROM plugin_secrets ORDER BY key')
    .all();
  assert.deepEqual(rows, [
    { k: 'k1', value: Buffer.from('v1:sk-plugin').toString('base64') },
    { k: 'k2', value: Buffer.from('v2:sk-other').toString('base64') }
  ]);
});

test('插件密钥：轮转重写不会覆盖 await 窗口里写入的新值', async () => {
  const { db, state, facade } = createSecretManagerFixture();
  await facade.set('k1', 'sk-old');
  state.rotation = true;
  state.version = 'v2';

  state.gate = deferred();
  const reading = facade.get('k1');
  await new Promise((settle) => setImmediate(settle));
  await facade.set('k1', 'sk-new');
  state.gate.resolve();

  assert.equal(await reading, 'sk-old');
  assert.equal(storedBase64(db), Buffer.from('v2:sk-new').toString('base64'));
});

test('插件密钥：重写失败会留下 warn 日志，且旧密文不变', async () => {
  const { db, state, warnings, facade } = createSecretManagerFixture();
  await facade.set('k1', 'sk-old');
  const before = storedBase64(db);

  state.rotation = true;
  state.failEncrypt = true;
  assert.equal(await facade.get('k1'), 'sk-old');

  assert.equal(storedBase64(db), before);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].metadata.code, 'plugin_secret_re_encrypt_failed');
});

test('插件密钥：加密存储不可用时抛领域错误码且不碰密文', async () => {
  const { state, facade } = createSecretManagerFixture();
  await facade.set('k1', 'sk-old');
  state.available = false;
  state.decryptCalls = 0;
  await assert.rejects(facade.get('k1'), /secret_storage_unavailable/u);
  assert.equal(state.decryptCalls, 0);
});
